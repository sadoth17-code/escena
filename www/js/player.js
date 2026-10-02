import { TempoMap } from './tempo.js';
import { renderClickBuffer, renderGuideBuffer, renderCountIn } from './synth.js';
import { faderToGain, clamp } from './util.js';

const START_LEAD = 0.07;
const SPLICE = 0.003;
const END_EPSILON = 0.004;
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
    try {
      this.input.disconnect();
      this.level.disconnect();
      this.panner.disconnect();
      this.meter.disconnect();
    } catch (error) {
      void error;
    }
    this.buffer = null;
  }
}

export class SongPlayer {
  constructor(engine, song, { buffers, voices }) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.song = song;
    this.voices = voices;
    this.listeners = new Map();
    let longest = 0;
    for (const buffer of buffers.values()) longest = Math.max(longest, buffer.duration);
    this.duration = Math.max(longest, 1);
    this.fileTracks = song.tracks.filter((def) => buffers.has(def.id)).map((def) => new TrackNode(engine, def, buffers.get(def.id), 'file'));
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

  refreshTempo() {
    this.tempo = new TempoMap(this.song.tempoMap);
    this.offset = (Number(this.song.offsetMs) || 0) / 1000;
    this.sectionCache = null;
  }

  refreshClick() {
    this.click.buffer = renderClickBuffer(this.ctx, this.tempo, {
      duration: this.duration,
      offset: this.offset,
      sound: this.song.click.sound,
      subdivision: this.song.click.subdivision,
    });
  }

  refreshGuide() {
    this.sectionCache = null;
    this.guide.buffer = renderGuideBuffer(this.ctx, this.tempo, this.song.markers, this.voices, {
      duration: this.duration,
      offset: this.offset,
      leadBars: this.song.guide.leadBars,
      counting: this.song.guide.counting,
    });
  }

  refreshAll() {
    this.refreshTempo();
    this.refreshClick();
    this.refreshGuide();
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

  isCountingIn(now = this.ctx.currentTime) {
    return this.state === 'playing' && this.run !== null && now < this.run.ctxStart;
  }

  countIn(now = this.ctx.currentTime) {
    const run = this.run;
    if (this.state !== 'playing' || !run || !run.countStart || now >= run.ctxStart) return null;
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

  spawnSources(when, position, loop, { preroll = 0, fadeIn = 0 } = {}) {
    const sources = [];
    for (const track of this.allTracks()) {
      if (!track.buffer) continue;
      if (!loop && position >= track.buffer.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = track.buffer;
      if (loop) {
        src.loopStart = loop.a;
        src.loopEnd = loop.b;
        src.loop = true;
      }
      const fade = this.ctx.createGain();
      if (fadeIn > 0) fade.gain.value = 0;
      src.connect(fade);
      fade.connect(track.input);
      let startAt = when;
      let offset = position;
      if (preroll > 0 && position - preroll >= 0) {
        startAt = when - preroll;
        offset = position - preroll;
      }
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
      sources.push({ src, fade, track });
    }
    return sources;
  }

  releaseRun(run, when, fade = 0.01) {
    if (!run) return;
    for (const source of run.sources) {
      const gain = source.fade.gain;
      gain.cancelScheduledValues(when);
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

  async play({ countIn = false } = {}) {
    await this.engine.resume();
    if (this.state === 'playing' || this.disposed) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    let position = this.pausedAt;
    if (position >= this.duration - 0.02) position = this.loop ? this.loop.a : 0;
    if (this.loop && position < this.loop.a) position = this.loop.a;
    const loop = this.loop && position < this.loop.b ? this.loop : null;
    const when = now + START_LEAD;
    let songStart = when;
    this.stopCountIn();
    const bars = Number(this.song.click.countIn) || 0;
    let countStart = 0;
    if (countIn && bars > 0) {
      countStart = when;
      const grid = Math.max(0, position - this.offset);
      const barNumber = Math.round(this.tempo.barFloat(grid));
      const marker = this.startOffsetIsBarAligned(position) ? this.markerAtBar(barNumber) : null;
      const intro = renderCountIn(ctx, this.tempo, grid, {
        bars,
        sound: this.song.click.sound,
        marker: this.song.guide.mute ? null : marker,
        voices: this.voices,
        leadBars: this.song.guide.leadBars,
        counting: this.song.guide.counting,
      });
      const clickSource = ctx.createBufferSource();
      clickSource.buffer = intro.clickBuffer;
      clickSource.connect(this.click.level);
      clickSource.start(when);
      this.countInSources.push(clickSource);
      if (intro.guideBuffer) {
        const guideSource = ctx.createBufferSource();
        guideSource.buffer = intro.guideBuffer;
        guideSource.connect(this.guide.level);
        guideSource.start(when);
        this.countInSources.push(guideSource);
      }
      songStart = when + intro.duration;
    }
    const sources = this.spawnSources(songStart, position, loop, { fadeIn: position > 0.01 ? 0.004 : 0 });
    this.run = { ctxStart: songStart, songStart: position, loop, sources, countStart };
    this.pending = null;
    this.state = 'playing';
    this.emit('state');
  }

  playAt(when) {
    if (this.disposed) return;
    this.stopCountIn();
    const sources = this.spawnSources(when, 0, null, {});
    this.run = { ctxStart: when, songStart: 0, loop: null, sources };
    this.pending = null;
    this.pausedAt = 0;
    this.state = 'playing';
    this.emit('state');
  }

  halt(resetTo) {
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
    if (this.state !== 'playing') return;
    this.halt(null);
    this.state = 'paused';
    this.emit('state');
  }

  stop() {
    if (this.state === 'stopped' && this.pausedAt === 0) return;
    if (this.state === 'playing') this.halt(0);
    else this.pausedAt = 0;
    this.state = 'stopped';
    this.emit('state');
  }

  seek(target, mode = 'now') {
    const time = clamp(target, 0, Math.max(0, this.duration - 0.01));
    if (this.state !== 'playing') {
      this.pausedAt = time;
      this.emit('state');
      return;
    }
    const now = this.ctx.currentTime;
    this.settleRun(now);
    if (this.pending) {
      this.releaseRun(this.pending, now);
      this.pending = null;
    }
    const counting = now < this.run.ctxStart;
    let when;
    if (counting || mode === 'now') {
      when = now + 0.03;
    } else {
      const lookahead = now + 0.04;
      const here = this.position(lookahead);
      let boundary = this.tempo.nextBoundary(here - this.offset, mode === 'beat' ? 'beat' : 'bar', 0) + this.offset;
      if (this.run.loop && boundary > this.run.loop.b) boundary = this.run.loop.b;
      when = lookahead + Math.max(0, boundary - here);
    }
    if (counting) {
      this.stopCountIn();
      this.releaseRun(this.run, now);
    }
    this.switchRun(when, time, counting);
  }

  switchRun(when, target, immediateStop = false) {
    if (this.loop && !(target >= this.loop.a - 1e-6 && target < this.loop.b)) {
      this.loop = null;
      this.emit('loop');
    }
    const loop = this.loop;
    const sources = this.spawnSources(when, target, loop, { preroll: SPLICE, fadeIn: SPLICE * 2 });
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
    for (const source of run.sources) {
      if (run.loop) {
        source.src.loopStart = run.loop.a;
        source.src.loopEnd = run.loop.b;
        source.src.loop = true;
      } else {
        source.src.loop = false;
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
    this.seek(this.position(now + 0.03), 'now');
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
      if (track.buffer) total += track.buffer.length * track.buffer.numberOfChannels * 4;
    }
    return total;
  }

  dispose() {
    if (this.disposed) return;
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
  }
}
