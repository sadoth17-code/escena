import { TempoMap } from './tempo.js';
import { renderClickBuffer, renderGuideBuffer, renderCountIn, renderClickRange, renderGuideRange } from './synth.js';
import { faderToGain, clamp } from './util.js';
import { normalizePitch, defaultPitchEnabled } from './pitch-utils.js';
import { renderPitchBuffer } from './pitch-render.js';
import { StreamSource } from './stream-source.js';
import { createGeneratedAudio } from './generated-audio.js';
import { computeStreamWaveform } from './stream-waveform.js';

// Margen mínimo y máximo entre «ahora» y el instante en que arrancan todas las pistas a la vez.
const START_LEAD_MIN = 0.07;
const START_LEAD_MAX = 0.3;
const SPLICE = 0.003;
const END_EPSILON = 0.004;
// Fade-out del final natural de cada pista. Muchos stems terminan cortados en seco (la última muestra
// no es cero) y ese salto de golpe a silencio se oye como un golpe seco. 50 ms bastan para que no se
// oiga y no tocan la música.
const END_FADE = 0.05;
const WAVE_BLOCK = 256;
const WAVE_SLICE = 3000000;

function yieldNow() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

export class TrackNode {
  constructor(engine, def, buffer, kind) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.def = def;
    this.kind = kind;
    this.buffer = buffer;
    this.originalBuffer = kind === 'file' ? buffer : null;
    this.silenced = false;
    this.input = this.ctx.createGain();
    this.level = this.ctx.createGain();
    this.panner = this.ctx.createStereoPanner();
    this.meter = this.ctx.createAnalyser();
    this.meter.fftSize = 512;
    this.meter.smoothingTimeConstant = 0;
    this.meterData = new Float32Array(this.meter.fftSize);
    this.input.connect(this.level);
    this.level.connect(this.panner);
    this.level.connect(this.meter);
    this.stereoTarget = null;
    this.monoTarget = null;
    this.route();
    this.applyGain(true);
    this.applyPan(true);
  }

  route() {
    const engine = this.engine;
    const cue = this.def.dest === 'cue';
    const stereo = cue ? engine.cueStereo : engine.mainStereo;
    const mono = cue ? engine.cueMono : engine.mainMono;
    if (this.stereoTarget === stereo && this.monoTarget === mono) return;
    if (this.stereoTarget) {
      this.panner.disconnect(this.stereoTarget);
      this.level.disconnect(this.monoTarget);
    }
    this.panner.connect(stereo);
    this.level.connect(mono);
    this.stereoTarget = stereo;
    this.monoTarget = mono;
  }

  effectiveGain() {
    return this.def.mute || this.silenced ? 0 : faderToGain(this.def.vol);
  }

  applyGain(immediate = false) {
    const gate = this.input.gain;
    const level = this.level.gain;
    const now = this.ctx.currentTime;
    const open = this.def.mute || this.silenced ? 0 : 1;
    const value = faderToGain(this.def.vol);
    if (immediate) {
      gate.setValueAtTime(open, now);
      level.setValueAtTime(value, now);
    } else {
      gate.setTargetAtTime(open, now, 0.012);
      level.setTargetAtTime(value, now, 0.012);
    }
  }

  applyPan(immediate = false) {
    const param = this.panner.pan;
    const now = this.ctx.currentTime;
    const value = clamp(Number(this.def.pan) || 0, -1, 1);
    if (immediate) param.setValueAtTime(value, now);
    else param.setTargetAtTime(value, now, 0.012);
  }

  peak() {
    this.meter.getFloatTimeDomainData(this.meterData);
    let max = 0;
    for (let i = 0; i < this.meterData.length; i++) {
      const value = Math.abs(this.meterData[i]);
      if (value > max) max = value;
    }
    return max;
  }

  dispose() {
    const streams = new Set([this.buffer, this.originalBuffer, this.streamBuffer]);
    try {
      this.input.disconnect();
      this.level.disconnect();
      this.panner.disconnect();
      this.meter.disconnect();
    } catch (error) {
      void error;
    }
    this.buffer = null;
    for (const buffer of streams) if (buffer?.stream) buffer.dispose();
    this.originalBuffer = null;
  }
}

export class SongPlayer {
  constructor(engine, song, { buffers, voices }) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.song = song;
    this.voices = voices;
    this.streaming = Array.from(buffers.values()).some(buffer => buffer.stream);
    this.listeners = new Map();
    let longest = 0;
    for (const buffer of buffers.values()) longest = Math.max(longest, buffer.duration);
    this.duration = Math.max(longest, 1);
    this.fileTracks = song.tracks.filter((def) => buffers.has(def.id)).map((def) => new TrackNode(engine, def, buffers.get(def.id), 'file'));
    this.waveRevision = 0;
    for (const track of this.fileTracks) if (track.buffer.stream) track.buffer.onChunk = () => { this.waveRevision++; };
    this.click = new TrackNode(engine, song.click, null, 'click');
    this.guide = new TrackNode(engine, song.guide, null, 'guide');
    this.state = 'stopped';
    this.run = null;
    this.pending = null;
    this.pausedAt = 0;
    this.loop = null;
    this.countInSources = [];
    this.sectionCache = null;
    this.peakCache = null;
    this.disposed = false;
    this.playRequest = 0;
    this.seekRequest = 0;
    this.waveEpoch = 0;
    this.pitchSemitones = 0;
    this.pitchBusy = false;
    this.pitchController = null;
    this.refreshAll();
    this.refreshSolo();
  }

  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name).delete(fn);
  }

  emit(name, ...args) {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(...args);
      } catch (error) {
        console.error(error);
      }
    }
  }

  allTracks() {
    return [...this.fileTracks, this.click, this.guide];
  }

  cancelPitch() {
    this.pitchController?.abort();
  }

  async setPitch(value, { enabled = {}, signal, onProgress = () => {} } = {}) {
    if (this.disposed) throw new DOMException('Canción descargada', 'AbortError');
    if (this.state === 'playing') throw new Error('Pausa la canción antes de cambiar la tonalidad');
    if (this.pitchBusy) throw new Error('Espera a que termine el cambio de tonalidad');
    const semitones = normalizePitch(value);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const check = () => {
      if (controller.signal.aborted || this.disposed) throw new DOMException('Cambio de tonalidad cancelado', 'AbortError');
    };
    this.pitchController = controller;
    this.pitchBusy = true;
    const rendered = [];
    let committed = false;
    this.playRequest++; // Invalidate a pending engine.resume() before rendering.
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    this.emit('pitch');
    try {
      check();
      for (let index = 0; index < this.fileTracks.length; index++) {
        const track = this.fileTracks[index];
        const previous = track.def.pitchEnabled ?? defaultPitchEnabled(track.def);
        const include = typeof enabled[track.def.id] === 'boolean' ? enabled[track.def.id] : previous;
        let buffer = track.originalBuffer;
        const report = fraction => onProgress({ done: index + fraction, total: this.fileTracks.length, label: track.def.name });
        report(0);
        if (semitones && include) {
          if (semitones === this.pitchSemitones && previous) buffer = track.buffer;
          else if (track.originalBuffer.stream) buffer = await track.originalBuffer.reprocess(semitones, { pitchEnabled: include, signal: controller.signal, onProgress: report });
          else buffer = await renderPitchBuffer(this.ctx, track.originalBuffer, semitones, { signal: controller.signal, onProgress: report });
        } else if (track.originalBuffer.stream && (this.pitchSemitones !== semitones || previous !== include)) {
          buffer = await track.originalBuffer.reprocess(semitones, { pitchEnabled: include, signal: controller.signal, onProgress: report });
        }
        if (buffer.stream) buffer.playbackDuration = this.duration;
        check();
        rendered.push({ track, buffer, include });
        report(1);
      }
      check();
      // Commit together: cancellation/errors must never leave tracks in different keys.
      for (const { track, buffer, include } of rendered) {
        if (track.buffer?.stream && track.buffer !== buffer) track.buffer.dispose();
        track.buffer = buffer;
        if (buffer.stream) track.originalBuffer = buffer;
        if (buffer.stream) buffer.onChunk = () => { this.waveRevision++; };
        track.def.pitchEnabled = include;
      }
      committed = true;
      this.pitchSemitones = semitones;
      this.song.pitchSemitones = semitones;
      this.peakCache = null;
      this.waveEpoch++;
      this.wavePromise = null;
      this.waveKey = '';
    } finally {
      if (!committed) for (const { track, buffer } of rendered) if (buffer?.stream && buffer !== track.buffer) buffer.dispose();
      signal?.removeEventListener('abort', cancel);
      this.pitchController = null;
      this.pitchBusy = false;
      this.emit('pitch');
    }
  }

  // Firmas de lo que se usó para dibujar cada búfer. Una canción que espera lista en memoria puede
  // editarse mientras tanto (tempo, marcadores, click…): al ponerla en escena se comparan y solo se
  // vuelve a dibujar lo que cambió (ver syncWithSong).
  tempoSignature() {
    return JSON.stringify([this.song.tempoMap, this.song.offsetMs]);
  }

  clickSignature() {
    const click = this.song.click;
    return JSON.stringify([this.tempoSignature(), click.sound, click.subdivision, Boolean(this.engine.clickBank)]);
  }

  guideSignature() {
    const guide = this.song.guide;
    return JSON.stringify([this.tempoSignature(), this.song.markers, guide.leadBars, guide.counting]);
  }

  refreshTempo() {
    this.tempo = new TempoMap(this.song.tempoMap);
    this.offset = (Number(this.song.offsetMs) || 0) / 1000;
    this.sectionCache = null;
    this.tempoKey = this.tempoSignature();
  }

  refreshClick() {
    const options = {
      duration: this.duration,
      offset: this.offset,
      sound: this.song.click.sound,
      subdivision: this.song.click.subdivision,
      bank: this.engine.clickBank,
    };
    this.click.buffer = this.streaming
      ? createGeneratedAudio(this.ctx, { duration: this.duration, renderRange: range => renderClickRange(this.ctx, this.tempo, { ...options, ...range }) })
      : renderClickBuffer(this.ctx, this.tempo, options);
    this.click.streamBuffer = this.click.buffer?.stream ? this.click.buffer : null;
    this.clickKey = this.clickSignature();
  }

  // Cambia la voz de la guía (otro idioma) y vuelve a dibujarla sin detener la canción.
  setVoices(voices) {
    this.voices = voices;
    this.refreshGuide();
    this.resync();
  }

  refreshGuide() {
    this.sectionCache = null;
    const options = {
      duration: this.duration,
      offset: this.offset,
      leadBars: this.song.guide.leadBars,
      counting: this.song.guide.counting,
    };
    this.guide.buffer = this.streaming
      ? createGeneratedAudio(this.ctx, { duration: this.duration, renderRange: range => renderGuideRange(this.ctx, this.tempo, this.song.markers, this.voices, { ...options, ...range }) })
      : renderGuideBuffer(this.ctx, this.tempo, this.song.markers, this.voices, options);
    this.guide.streamBuffer = this.guide.buffer?.stream ? this.guide.buffer : null;
    this.guideKey = this.guideSignature();
  }

  refreshAll() {
    this.refreshTempo();
    this.refreshClick();
    this.refreshGuide();
  }

  // Pone al día un reproductor que esperó en memoria mientras se editaba la canción: vuelve a dibujar
  // solo lo que cambió (tempo, click, guía o la voz de la guía) y relee volumen, panorama, destino y
  // solos de cada pista. No toca los audios decodificados, que son lo caro. Devuelve true si rehízo algo.
  syncWithSong(voices = null) {
    if (this.disposed) return false;
    let changed = false;
    const newVoices = voices && voices !== this.voices ? voices : null;
    if (this.tempoKey !== this.tempoSignature()) {
      if (newVoices) this.voices = newVoices;
      this.refreshAll();
      changed = true;
    } else {
      if (this.clickKey !== this.clickSignature()) {
        this.refreshClick();
        changed = true;
      }
      if (newVoices || this.guideKey !== this.guideSignature()) {
        if (newVoices) this.voices = newVoices;
        this.refreshGuide();
        changed = true;
      }
    }
    for (const track of this.allTracks()) {
      track.route();
      track.applyGain(true);
      track.applyPan(true);
    }
    this.refreshSolo();
    return changed;
  }

  refreshSolo() {
    for (const dest of ['main', 'cue']) {
      const group = this.allTracks().filter((track) => track.def.dest === dest);
      const anySolo = group.some((track) => track.def.solo);
      for (const track of group) {
        track.silenced = anySolo && !track.def.solo;
        track.applyGain();
      }
    }
  }

  barTime(bar) {
    return clamp(this.tempo.barStart(bar) + this.offset, 0, this.duration);
  }

  sections() {
    if (this.sectionCache) return this.sectionCache;
    const markers = this.song.markers.filter((marker) => marker.bar >= 1).sort((a, b) => a.bar - b.bar);
    const list = [];
    if (!markers.length || markers[0].bar > 1) {
      list.push({ id: 'implicit', name: markers.length ? 'Inicio' : 'Canción', bar: 1, start: 0, color: '#64748b', voice: '', implicit: true });
    }
    for (const marker of markers) {
      const start = this.barTime(marker.bar);
      if (start < this.duration - 0.05) list.push({ ...marker, start });
    }
    list.forEach((section, index) => {
      section.index = index;
      section.end = index + 1 < list.length ? list[index + 1].start : this.duration;
    });
    this.sectionCache = list;
    return list;
  }

  sectionAt(time) {
    const list = this.sections();
    let found = list[0];
    for (const section of list) {
      if (section.start <= time + 0.01) found = section;
      else break;
    }
    return found;
  }

  markerAtBar(bar) {
    return this.song.markers.find((marker) => marker.bar === bar) || null;
  }

  settleRun(now) {
    if (this.pending && now >= this.pending.ctxStart) {
      this.run = this.pending;
      this.pending = null;
    }
    return this.run;
  }

  position(now = this.ctx.currentTime) {
    if (this.state === 'playing') {
      const run = this.pending && now >= this.pending.ctxStart ? this.pending : this.run;
      if (run) {
        if (now <= run.ctxStart) return run.songStart;
        let position = run.songStart + (now - run.ctxStart);
        if (run.loop && position > run.loop.b) {
          position = run.loop.a + ((position - run.loop.a) % (run.loop.b - run.loop.a));
        }
        return Math.min(position, this.duration);
      }
    }
    return this.pausedAt;
  }

  // Instante del reloj del audio en que termina lo que se oye antes del primer compás de la
  // reproducción: el final del pre-conteo o, si no lo hay, el arranque de la música. Con el pre-conteo
  // la música puede haber entrado ya (arrancar antes del compás 1 deja un silencio de entrada que
  // suena mientras caen los últimos tiempos del conteo), así que no es lo mismo que `ctxStart`.
  readyTime(run) {
    return Math.max(run.ctxStart, run.countEnd || 0);
  }

  isCountingIn(now = this.ctx.currentTime) {
    return this.state === 'playing' && this.run !== null && now < this.readyTime(this.run);
  }

  countIn(now = this.ctx.currentTime) {
    const run = this.run;
    if (this.state !== 'playing' || !run || !run.countStart || now >= run.countEnd) return null;
    // Si el silencio de entrada es más largo que el conteo, la música arranca primero y el conteo
    // empieza justo antes del compás 1: hasta entonces no hay nada que contar.
    if (now < run.countStart && run.countStart > run.ctxStart) return null;
    const segment = this.tempo.segmentAtTime(Math.max(0, run.songStart - this.offset));
    const index = Math.floor(Math.max(0, now - run.countStart) / segment.beatDur);
    return {
      beat: (index % segment.num) + 1,
      beats: segment.num,
      bar: Math.floor(index / segment.num) + 1,
      bars: Math.max(1, Number(this.song.click.countIn) || 1),
    };
  }

  jumpTarget() {
    return this.pending ? this.pending.songStart : null;
  }

  timeToEnd(now = this.ctx.currentTime) {
    const run = this.pending || this.run;
    if (this.state !== 'playing' || !run || run.loop) return Infinity;
    return run.ctxStart + (this.duration - run.songStart) - now;
  }

  endContextTime() {
    const run = this.pending || this.run;
    return run.ctxStart + (this.duration - run.songStart);
  }

  // Margen entre «ahora» y el arranque. El reloj del audio avanza a saltos del tamaño del búfer de
  // la salida (baseLatency): si el arranque queda más cerca que ese salto, o el hilo principal tarda
  // en programarlo, cada pista empieza en un bloque de render distinto y se desfasa unos milisegundos
  // del click y de las demás.
  startLead() {
    const latency = Number(this.ctx.baseLatency);
    const buffer = Number.isFinite(latency) && latency > 0 ? latency : 0.02;
    return clamp(0.03 + 2 * buffer, START_LEAD_MIN, START_LEAD_MAX);
  }

  // Crea y conecta los nodos de todas las pistas, el click y la guía, sin arrancarlos. Es la parte
  // lenta (con muchas pistas puede pasar de 50 ms en un móvil), así que se hace ANTES de leer el
  // reloj para fijar el instante de arranque: ese tiempo ya no le resta margen al arranque.
  prepareSources(position, loop, { fadeIn = 0 } = {}) {
    const entries = [];
    for (const track of this.allTracks()) {
      if (!track.buffer) continue;
      if (!loop && position >= track.buffer.duration) continue;
      const src = track.buffer.stream ? new StreamSource(this.ctx, track.buffer) : this.ctx.createBufferSource();
      if (track.buffer.stream) track.buffer.onUnderrun = detail => this.emit('buffering', detail);
      else src.buffer = track.buffer;
      if (loop) {
        src.loopStart = loop.a;
        src.loopEnd = loop.b;
        src.loop = true;
      }
      const fade = this.ctx.createGain();
      if (fadeIn > 0) fade.gain.value = 0;
      src.connect(fade);
      fade.connect(track.input);
      entries.push({ src, fade, track, duration: track.buffer.duration, endFadeAt: null });
    }
    return entries;
  }

  // Arranca todos los nodos preparados en el mismo instante y en el mismo punto de la canción. Solo
  // hace llamadas ligeras: no se crea ningún nodo aquí, para que nada pueda retrasar a las últimas.
  commitSources(entries, when, position, { preroll = 0, fadeIn = 0 } = {}) {
    let startAt = when;
    let offset = position;
    if (preroll > 0 && position - preroll >= 0) {
      startAt = when - preroll;
      offset = position - preroll;
    }
    for (const entry of entries) {
      const { src, fade } = entry;
      if (fadeIn > 0) {
        fade.gain.setValueAtTime(0, startAt);
        fade.gain.linearRampToValueAtTime(1, startAt + fadeIn);
      }
      src.start(startAt, offset);
      src.onended = () => {
        try {
          src.disconnect();
          fade.disconnect();
        } catch (error) {
          void error;
        }
      };
    }
    // El final natural de cada pista cae a cero con un fade corto. Se programa después de arrancar
    // todas las fuentes, para que nada pueda retrasar a las últimas.
    const begin = Math.max(startAt, this.ctx.currentTime);
    for (const entry of entries) this.scheduleEndFade(entry, begin + (entry.duration - offset), begin + fadeIn);
    // Para diagnóstico y pruebas: cuánto margen quedó entre terminar de programar y el arranque.
    this.lastStart = { when: startAt, slack: startAt - this.ctx.currentTime, tracks: entries.length };
    return entries;
  }

  // Programa el fade-out del final natural de una fuente. `endAt` es el instante del reloj del audio en
  // que se acaba su búfer; `notBefore`, el primer instante en que el fade puede empezar (así no se pisa
  // un fade-in ni se programa sobre algo que ya sonó). Una fuente en repetición no tiene final natural.
  scheduleEndFade(source, endAt, notBefore = 0) {
    if (source.endFadeAt != null || source.src.loop || !Number.isFinite(endAt)) return;
    const fadeAt = endAt - END_FADE;
    if (!(fadeAt > notBefore)) return;
    const gain = source.fade.gain;
    gain.setValueAtTime(1, fadeAt);
    gain.linearRampToValueAtTime(0, endAt);
    source.endFadeAt = fadeAt;
  }

  // Quita el fade-out del final: se usa al activar una repetición, que no debe quedar en silencio.
  cancelEndFade(source) {
    if (source.endFadeAt == null) return;
    const at = source.endFadeAt;
    source.endFadeAt = null;
    // Solo desde el inicio del fade: el fade-in de arranque, si lo hay, queda intacto.
    source.fade.gain.cancelScheduledValues(at);
  }

  spawnSources(when, position, loop, options = {}) {
    return this.commitSources(this.prepareSources(position, loop, options), when, position, options);
  }

  // Pre-conteo: click y guía listos pero sin arrancar.
  prepareCountIn(intro) {
    const nodes = [];
    const clickSource = this.ctx.createBufferSource();
    clickSource.buffer = intro.clickBuffer;
    clickSource.connect(this.click.level);
    nodes.push(clickSource);
    if (intro.guideBuffer) {
      const guideSource = this.ctx.createBufferSource();
      guideSource.buffer = intro.guideBuffer;
      guideSource.connect(this.guide.level);
      nodes.push(guideSource);
    }
    return nodes;
  }

  releaseRun(run, when, fade = 0.01) {
    if (!run) return;
    for (const source of run.sources) {
      const gain = source.fade.gain;
      // Replace an earlier queued jump without leaving its old fade behind.
      gain.cancelScheduledValues(this.ctx.currentTime);
      source.endFadeAt = null;
      gain.setValueAtTime(1, this.ctx.currentTime);
      gain.setValueAtTime(1, when);
      gain.linearRampToValueAtTime(0, when + fade);
      try {
        source.src.stop(when + fade + 0.002);
      } catch (error) {
        void error;
      }
    }
  }

  stopCountIn() {
    for (const source of this.countInSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (error) {
        void error;
      }
    }
    this.countInSources = [];
  }

  startOffsetIsBarAligned(position) {
    return this.tempo.isBarAligned(position - this.offset);
  }

  audioReady(position) {
    return this.allTracks().every(track => {
      const buffer = track.buffer;
      if (!buffer?.stream || position >= buffer.duration) return true;
      return Boolean(buffer.peekChunk(Math.floor(position * buffer.sampleRate / buffer.framesPerChunk)));
    });
  }

  async ensureAudio(position) {
    const tasks = [];
    for (const track of this.allTracks()) {
      const buffer = track.buffer;
      if (!buffer?.stream || position >= buffer.duration) continue;
      const index = Math.floor(position * buffer.sampleRate / buffer.framesPerChunk);
      if (!buffer.peekChunk(index)) tasks.push(buffer.ensure(position));
    }
    if (tasks.length) await Promise.all(tasks);
  }

  trimAudio() {
    for (const track of this.allTracks()) if (track.buffer?.stream) track.buffer.trimToHead?.();
  }

  async play({ countIn = false } = {}) {
    if (this.pitchBusy) throw new Error('Espera a que termine el cambio de tonalidad');
    const request = ++this.playRequest;
    await this.engine.resume();
    if (request !== this.playRequest || this.state === 'playing' || this.disposed || this.pitchBusy) return;
    const ctx = this.ctx;
    let position = this.pausedAt;
    if (position >= this.duration - 0.02) position = this.loop ? this.loop.a : 0;
    if (this.loop && position < this.loop.a) position = this.loop.a;
    const loop = this.loop && position < this.loop.b ? this.loop : null;
    // El inicio ya está en RAM; reanudar en otro punto solo solicita ese bloque.
    await this.ensureAudio(position);
    if (request !== this.playRequest || this.disposed || this.state === 'playing') return;
    this.stopCountIn();
    const bars = Number(this.song.click.countIn) || 0;
    // Primero todo lo lento: render del pre-conteo y nodos de todas las pistas. El reloj se lee
    // después, y el pre-conteo, las pistas, el click y la guía arrancan juntos desde el mismo instante.
    let intro = null;
    if (countIn && bars > 0) {
      const grid = Math.max(0, position - this.offset);
      const barNumber = Math.round(this.tempo.barFloat(grid));
      const marker = this.startOffsetIsBarAligned(position) ? this.markerAtBar(barNumber) : null;
      intro = renderCountIn(ctx, this.tempo, grid, {
        bars,
        sound: this.song.click.sound,
        bank: this.engine.clickBank,
        marker: this.song.guide.mute ? null : marker,
        voices: this.voices,
        leadBars: this.song.guide.leadBars,
        counting: this.song.guide.counting,
      });
    }
    const fadeIn = position > 0.01 ? 0.004 : 0;
    const entries = this.prepareSources(position, loop, { fadeIn });
    const countNodes = intro ? this.prepareCountIn(intro) : [];
    const when = ctx.currentTime + this.startLead();
    // El pre-conteo tiene que acabar justo un tiempo antes del primer tiempo fuerte de la cuadrícula.
    // Si se arranca dentro del silencio de entrada (antes del compás 1, que empieza en `offset`), ese
    // primer tiempo fuerte llega `lead` segundos después de que la música empiece, y el conteo debe
    // acabar ahí y no en el arranque de la música: así el compás 1 cae justo en el tiempo siguiente
    // al último del conteo. Arrancando desde el compás 1 en adelante `lead` es 0 y todo queda igual.
    const lead = Math.max(0, this.offset - position);
    const countEnd = intro ? when + Math.max(intro.duration, lead) : 0;
    const countStart = intro ? countEnd - intro.duration : 0;
    const songStart = intro ? countEnd - lead : when;
    for (const node of countNodes) node.start(countStart);
    this.countInSources.push(...countNodes);
    const sources = this.commitSources(entries, songStart, position, { fadeIn });
    this.run = { ctxStart: songStart, songStart: position, loop, sources, countStart, countEnd };
    this.pending = null;
    this.state = 'playing';
    this.emit('state');
  }

  // Arranque en un instante exacto del reloj (paso a la siguiente canción sin hueco).
  playAt(when) {
    if (this.disposed || this.pitchBusy) return;
    this.stopCountIn();
    const entries = this.prepareSources(0, null);
    const ctx = this.ctx;
    // Si el instante ya casi pasó (el hilo principal se atrasó), las pistas arrancan juntas un poco
    // después en vez de repartirse entre bloques de render distintos.
    if (!this.engine.offline && when < ctx.currentTime + 0.01) when = ctx.currentTime + this.startLead();
    const sources = this.commitSources(entries, when, 0, {});
    this.run = { ctxStart: when, songStart: 0, loop: null, sources };
    this.pending = null;
    this.pausedAt = 0;
    this.state = 'playing';
    this.emit('state');
  }

  halt(resetTo) {
    this.seekRequest++;
    const now = this.ctx.currentTime;
    const position = this.position(now);
    this.releaseRun(this.run, now);
    this.releaseRun(this.pending, now);
    this.stopCountIn();
    this.run = null;
    this.pending = null;
    this.pausedAt = resetTo === null ? position : resetTo;
  }

  pause() {
    this.playRequest++;
    if (this.state !== 'playing') return;
    this.halt(null);
    this.state = 'paused';
    this.emit('state');
  }

  stop() {
    this.playRequest++;
    if (this.state === 'stopped' && this.pausedAt === 0) return;
    if (this.state === 'playing') this.halt(0);
    else this.pausedAt = 0;
    this.state = 'stopped';
    this.emit('state');
  }

  // Deja el reproductor como recién creado (en el inicio, sin repetición ni pre-conteo) para guardarlo
  // listo en memoria. A diferencia de stop(), no avisa a nadie: la canción ya no es la actual.
  rewind() {
    this.cancelPitch();
    if (this.disposed) return;
    this.playRequest++;
    this.seekRequest++;
    if (this.state === 'playing') this.halt(0);
    this.stopCountIn();
    this.run = null;
    this.pending = null;
    this.pausedAt = 0;
    this.loop = null;
    this.state = 'stopped';
    this.trimAudio();
    this.waveEpoch++;
    this.wavePromise = null;
    this.waveKey = '';
  }

  // Salta a otro punto de la canción: ya mismo ('now'), en el siguiente tiempo ('beat') o compás ('bar').
  // Con follow = true la canción sigue sonando sin saltar: sirve para rehacer las fuentes cuando
  // cambian el click o la guía, y el punto de destino es donde estaría la música en ese instante.
  seek(target, mode = 'now', { follow = false } = {}) {
    let time = clamp(target, 0, Math.max(0, this.duration - 0.01));
    const request = ++this.seekRequest;
    if (this.streaming && !this.audioReady(time)) {
      const playRequest = this.playRequest;
      if (this.state !== 'playing') {
        this.pausedAt = time;
        this.emit('state');
      }
      this.ensureAudio(time).then(() => {
        if (this.disposed || request !== this.seekRequest || playRequest !== this.playRequest) return;
        this.seek(time, mode, { follow });
      }).catch(error => { if (!this.disposed && request === this.seekRequest) this.emit('buffering', { error }); });
      return;
    }
    if (this.state !== 'playing') {
      this.pausedAt = time;
      this.emit('state');
      return;
    }
    const ctx = this.ctx;
    if (this.loop && !(time >= this.loop.a - 1e-6 && time < this.loop.b)) {
      this.loop = null;
      this.emit('loop');
    }
    // Primero lo lento (crear los nodos de todas las pistas); el reloj se lee después, así que ese
    // tiempo no le quita margen al arranque y todas las fuentes empiezan en la misma muestra.
    const entries = this.prepareSources(time, this.loop, { fadeIn: SPLICE * 2 });
    const now = ctx.currentTime;
    this.settleRun(now);
    if (this.pending) {
      this.releaseRun(this.pending, now);
      this.pending = null;
    }
    const lead = this.startLead();
    const old = this.run;
    // `waiting`: la música aún no ha entrado. `counting`: todavía suena el pre-conteo, y la música
    // puede haber entrado ya si se arrancó antes del compás 1 (ver play()).
    const waiting = now < old.ctxStart;
    const counting = now < this.readyTime(old);
    let when;
    if (mode === 'now') {
      when = now + lead;
    } else if (counting) {
      // Preserve the count-in; the selected section enters on its downbeat.
      when = Math.max(this.readyTime(old), now + lead);
    } else {
      const lookahead = now + lead;
      const here = this.position(lookahead);
      let boundary = this.tempo.nextBoundary(here - this.offset, mode === 'beat' ? 'beat' : 'bar', 0) + this.offset;
      if (this.run.loop && boundary > this.run.loop.b) boundary = this.run.loop.b;
      when = lookahead + Math.max(0, boundary - here);
    }
    if (follow) time = clamp(this.position(when), 0, Math.max(0, this.duration - 0.01));
    const immediate = waiting && mode === 'now';
    if (immediate) {
      this.stopCountIn();
      this.releaseRun(this.run, now);
    } else if (counting && mode === 'now' && !follow) {
      // Salto inmediato con la música ya sonando mientras caían los últimos tiempos del conteo.
      this.stopCountIn();
    }
    this.switchRun(when, time, immediate, entries);
    // Un reajuste sin salto no interrumpe el pre-conteo: la pista nueva sigue sabiendo que aún suena.
    if (follow && counting && this.pending && old.countEnd) {
      this.pending.countStart = old.countStart;
      this.pending.countEnd = old.countEnd;
    }
  }

  switchRun(when, target, immediateStop = false, entries = null) {
    const loop = this.loop;
    const ready = entries || this.prepareSources(target, loop, { fadeIn: SPLICE * 2 });
    const sources = this.commitSources(ready, when, target, { preroll: SPLICE, fadeIn: SPLICE * 2 });
    if (!immediateStop) this.releaseRun(this.run, when - SPLICE, SPLICE * 2);
    this.pending = { ctxStart: when, songStart: target, loop, sources };
    this.emit('state');
  }

  seekToSection(index, mode = 'bar') {
    const section = this.sections()[index];
    if (!section) return;
    this.seek(section.start, this.state === 'playing' ? mode : 'now');
  }

  armLoop(range) {
    this.loop = range && range.b - range.a > 0.05 ? { a: range.a, b: Math.min(range.b, this.duration) } : null;
    this.emit('loop');
  }

  applyLoopFlags(run) {
    const now = this.ctx.currentTime;
    for (const source of run.sources) {
      if (run.loop) {
        source.src.loopStart = run.loop.a;
        source.src.loopEnd = run.loop.b;
        source.src.loop = true;
        // Dentro de una repetición no hay final natural: el fade-out del final no puede caer en ella.
        this.cancelEndFade(source);
      } else {
        source.src.loop = false;
        // Sin repetición la pista vuelve a terminar sola, así que recupera su fade-out del final.
        this.scheduleEndFade(source, run.ctxStart + (source.duration - run.songStart), now);
      }
    }
  }

  setLoop(range) {
    const loop = range && range.b - range.a > 0.05 ? { a: range.a, b: Math.min(range.b, this.duration) } : null;
    this.loop = loop;
    if (this.state === 'playing') {
      const now = this.ctx.currentTime;
      this.settleRun(now);
      if (this.pending) {
        this.pending.loop = loop && this.pending.songStart < loop.b ? loop : null;
        this.applyLoopFlags(this.pending);
      }
      const run = this.run;
      if (run && now >= run.ctxStart) {
        const here = this.position(now);
        if (loop && here >= loop.b) {
          this.seek(loop.a, 'bar');
        } else {
          run.songStart = here;
          run.ctxStart = now;
          run.loop = loop;
          this.applyLoopFlags(run);
        }
      } else if (run) {
        run.loop = loop && run.songStart < loop.b ? loop : null;
        this.applyLoopFlags(run);
      }
    }
    this.emit('loop');
  }

  poll() {
    if (this.state !== 'playing' || this.disposed) return;
    const now = this.ctx.currentTime;
    const run = this.settleRun(now);
    if (!run || now < run.ctxStart || run.loop) return;
    if (this.position(now) >= this.duration - END_EPSILON) {
      this.run = null;
      this.pending = null;
      this.pausedAt = 0;
      this.state = 'stopped';
      this.emit('state');
      this.emit('ended');
    }
  }

  peaks(buckets = 1600) {
    if (this.streaming) {
      const out = new Float32Array(buckets);
      for (const track of this.waveSources()) {
        const peaks = track.buffer.peaks;
        if (!peaks) continue;
        const scale = track.buffer.duration / this.duration;
        for (let index = 0; index < peaks.length; index++) {
          const at = Math.min(buckets - 1, Math.floor(index / peaks.length * scale * buckets));
          out[at] = Math.max(out[at], peaks[index]);
        }
      }
      let top = 0;
      for (const value of out) top = Math.max(top, value);
      if (top) for (let index = 0; index < out.length; index++) out[index] = Math.pow(out[index] / top, 0.7);
      return out;
    }
    if (this.peakCache && this.peakCache.length === buckets) return this.peakCache;
    const out = new Float32Array(buckets);
    let sources = this.fileTracks.filter((track) => track.def.dest !== 'cue' && track.buffer);
    if (!sources.length) sources = this.fileTracks.filter((track) => track.buffer);
    for (const track of sources) {
      const buffer = track.buffer;
      const step = buffer.length / buckets;
      const stride = Math.max(1, Math.floor(step / 384));
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < buckets; i++) {
          const start = Math.floor(i * step);
          const end = Math.min(buffer.length, Math.floor((i + 1) * step));
          let max = 0;
          for (let j = start; j < end; j += stride) {
            const value = Math.abs(data[j]);
            if (value > max) max = value;
          }
          if (max > out[i]) out[i] = max;
        }
      }
    }
    let top = 0;
    for (let i = 0; i < buckets; i++) if (out[i] > top) top = out[i];
    if (top > 0) for (let i = 0; i < buckets; i++) out[i] = Math.pow(out[i] / top, 0.7);
    this.peakCache = out;
    return out;
  }

  resync() {
    if (this.state !== 'playing' || this.disposed || !this.run || this.pending) return;
    const now = this.ctx.currentTime;
    if (now < this.run.ctxStart) return;
    this.seek(this.position(now + this.startLead()), 'now', { follow: true });
  }

  waveSources() {
    let sources = this.fileTracks.filter((track) => track.def.dest !== 'cue' && track.buffer);
    if (!sources.length) sources = this.fileTracks.filter((track) => track.buffer);
    return sources;
  }

  prepareWaveform() {
    const sources = this.waveSources();
    const key = sources.map((track) => track.def.id).join('|');
    if (!this.wavePromise || this.waveKey !== key) {
      this.waveKey = key;
      this.wavePromise = this.computeWaveform(sources);
    }
    return this.wavePromise;
  }

  async computeWaveform(sources) {
    if (this.streaming) {
      const epoch = this.waveEpoch;
      return computeStreamWaveform(sources, { duration: this.duration, cancelled: () => this.disposed || epoch !== this.waveEpoch, pause: yieldNow });
    }
    const channels = [];
    let length = 0;
    let rate = this.ctx.sampleRate;
    for (const track of sources) {
      rate = track.buffer.sampleRate || rate;
      length = Math.max(length, track.buffer.length);
      for (let c = 0; c < track.buffer.numberOfChannels; c++) channels.push(track.buffer.getChannelData(c));
    }
    const data = new Float32Array(Math.max(1, Math.ceil(length / WAVE_BLOCK)));
    let spent = 0;
    for (const samples of channels) {
      const count = Math.ceil(samples.length / WAVE_BLOCK);
      for (let b = 0; b < count; b++) {
        const end = Math.min(samples.length, (b + 1) * WAVE_BLOCK);
        let max = data[b];
        for (let i = b * WAVE_BLOCK; i < end; i += 2) {
          const value = samples[i];
          const level = value < 0 ? -value : value;
          if (level > max) max = level;
        }
        data[b] = max;
        spent += WAVE_BLOCK >> 1;
        if (spent >= WAVE_SLICE) {
          spent = 0;
          await yieldNow();
          if (this.disposed) return null;
        }
      }
    }
    let top = 0;
    for (let b = 0; b < data.length; b++) if (data[b] > top) top = data[b];
    return { rate, block: WAVE_BLOCK, data, top: top || 1, channels, length };
  }

  memoryBytes() {
    let total = 0;
    for (const track of this.allTracks()) {
      if (track.buffer) total += track.buffer.stream ? track.buffer.memoryBytes() : track.buffer.length * track.buffer.numberOfChannels * 4;
      if (track.originalBuffer && track.originalBuffer !== track.buffer) total += track.originalBuffer.stream ? track.originalBuffer.memoryBytes() : track.originalBuffer.length * track.originalBuffer.numberOfChannels * 4;
    }
    return total;
  }

  dispose() {
    if (this.disposed) return;
    this.cancelPitch();
    this.seekRequest++;
    this.waveEpoch++;
    this.disposed = true;
    for (const run of [this.run, this.pending]) {
      if (!run) continue;
      for (const source of run.sources) {
        try {
          source.src.stop();
        } catch (error) {
          void error;
        }
      }
    }
    this.stopCountIn();
    for (const track of this.allTracks()) track.dispose();
    this.run = null;
    this.pending = null;
    this.state = 'stopped';
    this.listeners.clear();
    this.wavePromise = null;
    this.peakCache = null;
    this.sectionCache = null;
  }
}
