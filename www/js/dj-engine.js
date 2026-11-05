// Motor de audio de la pestaña DJ. Es independiente del motor multitrack de Escena.
//
// Hay varias "bandejas" (decks). Cada una es un reproductor <audio> que lee el archivo directamente
// (no se descodifica la canción entera en memoria) y pasa por su propio volumen:
//
//   <audio> -> trim (volumen de la canción) -> fade (la mezcla) -> bus -> volumen general -> limitador -> salida
//
// Mezclar es programar en el reloj de audio una rampa de potencia constante: la canción que entra sube
// mientras la que sale baja, sin hundir el volumen en el medio. Si se pide otra mezcla en pleno fundido,
// las rampas se recalculan desde el nivel exacto en que estaban, sin saltos.

import { resumeAudioContext } from './audio-session.js';
import { createEmitter } from './util.js';
import { PAUSE_FADE, clamp, dbToGain, fadePoints, fadeSeconds, makeLimiterCurve, makePlan, planDone, planLevel } from './dj-math.js';

const DECKS = 4;
const LOAD_TIMEOUT = 9000;
const AUDIBLE = 0.003;
const LIMITER_CURVE = makeLimiterCurve();

export class DeckAbort extends Error {
  constructor() {
    super('Preparación cancelada');
    this.name = 'AbortError';
  }
}

export class NoDeckError extends Error {
  constructor() {
    super('No hay un reproductor libre para preparar esta canción');
    this.name = 'NoDeckError';
  }
}

function mediaError(audio) {
  const code = audio.error && audio.error.code;
  if (code === 4) return new Error('El navegador no puede reproducir este formato de audio');
  if (code === 3) return new Error('El archivo de audio está dañado');
  return new Error('No se pudo leer el archivo de audio');
}

function waitFor(audio, events, timeout = LOAD_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      for (const name of events) audio.removeEventListener(name, onOk);
      audio.removeEventListener('error', onError);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(mediaError(audio));
    };
    for (const name of events) audio.addEventListener(name, onOk);
    audio.addEventListener('error', onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('La canción tardó demasiado en prepararse'));
    }, timeout);
  });
}

// Lee la duración (y comprueba que el navegador entiende el formato) sin guardar nada.
export function probeAudio(file, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    const url = URL.createObjectURL(file);
    let timer = 0;
    const done = (settle, value) => {
      clearTimeout(timer);
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch {
        // nada que liberar
      }
      URL.revokeObjectURL(url);
      settle(value);
    };
    audio.addEventListener('loadedmetadata', () => done(resolve, { duration: Number.isFinite(audio.duration) ? audio.duration : 0 }), { once: true });
    audio.addEventListener('error', () => done(reject, mediaError(audio)), { once: true });
    timer = setTimeout(() => done(reject, new Error('No se pudo leer el audio a tiempo')), timeout);
    audio.src = url;
  });
}

class Deck {
  constructor(engine, index) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.index = index;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.loop = false;
    this.audio.setAttribute('playsinline', '');
    this.source = ctx.createMediaElementSource(this.audio);
    this.trim = ctx.createGain();
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    this.source.connect(this.trim);
    this.trim.connect(this.fade);
    this.fade.connect(engine.bus);
    this.token = 0;
    this.clear();
    this.audio.addEventListener('ended', () => engine.onEnded(this));
  }

  clear() {
    this.key = null;
    this.sourceId = null;
    this.url = null;
    this.state = 'empty'; // empty | loading | ready | playing | paused | ended
    this.plan = null;
    this.level = 0;
    this.after = null; // qué hacer cuando termine el fundido: dispose | pause | stop
    this.start = 0;
    this.gainDb = 0;
    this.duration = 0;
    this.promise = null;
  }

  // Suelta la canción y el archivo para no gastar memoria.
  reset() {
    this.token++;
    const audio = this.audio;
    try {
      audio.pause();
    } catch {
      // ya estaba detenido
    }
    if (this.url) {
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch {
        // nada que liberar
      }
      URL.revokeObjectURL(this.url);
    }
    this.clear();
    const gain = this.fade.gain;
    const now = this.engine.ctx.currentTime;
    gain.cancelScheduledValues(0);
    gain.setValueAtTime(0, now);
  }
}

export class DjEngine {
  constructor({ decks = DECKS, AudioContextClass = null, latencyHint = 'balanced' } = {}) {
    this.deckCount = decks;
    this.AudioContextClass = AudioContextClass;
    this.latencyHint = latencyHint;
    this.ctx = null;
    this.decks = [];
    this.wanted = [];
    this.current = null;
    this.mix = null;
    this.volume = 1;
    this.ticker = 0;
    this.sinkId = '';
    this.events = createEmitter();
    this.on = this.events.on;
    this.emit = this.events.emit;
  }

  // Crea el audio la primera vez que hace falta (el navegador lo deja "en pausa" hasta que la persona toca la pantalla).
  ensure() {
    if (this.ctx) return this.ctx;
    const Context = this.AudioContextClass || globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw new Error('Este navegador no puede reproducir audio con Web Audio');
    let ctx;
    try {
      ctx = new Context({ latencyHint: this.latencyHint });
    } catch {
      ctx = new Context();
    }
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const pre = ctx.createGain();
    pre.gain.value = 0.5;
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = LIMITER_CURVE;
    this.shaper.oversample = '2x';
    const post = ctx.createGain();
    post.gain.value = 2;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.bus.connect(this.master);
    this.master.connect(pre);
    pre.connect(this.shaper);
    this.shaper.connect(post);
    post.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    for (let index = 0; index < this.deckCount; index++) this.decks.push(new Deck(this, index));
    ctx.addEventListener('statechange', () => this.emit('audio', ctx.state));
    if (this.sinkId) this.setSink(this.sinkId).catch(() => {});
    return ctx;
  }

  get state() {
    return this.ctx ? this.ctx.state : 'none';
  }

  // Debe llamarse desde un toque o un clic (o después de haber tocado la página alguna vez).
  async unlock() {
    this.ensure();
    if (this.ctx.state === 'running') return true;
    try {
      await resumeAudioContext(this.ctx, 1500);
      return true;
    } catch {
      return this.ctx.state === 'running';
    }
  }

  setVolume(gain) {
    this.volume = clamp(Number(gain) || 0, 0, 4);
    if (!this.ctx) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  setLimiter(on) {
    if (this.shaper) this.shaper.curve = on ? LIMITER_CURVE : null;
  }

  async setSink(id) {
    this.sinkId = id || '';
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return false;
    await this.ctx.setSinkId(this.sinkId);
    return true;
  }

  // Claves de las canciones que conviene tener a mano (la que sigue y la siguiente de esa).
  setWanted(keys) {
    this.wanted = Array.from(keys || []);
  }

  // ---------------------------------------------------------- consultas

  deckFor(key) {
    return this.decks.find((deck) => deck.key === key && deck.state !== 'empty') || null;
  }

  isReady(key) {
    const deck = this.deckFor(key);
    return Boolean(deck) && (deck.state === 'ready' || deck.state === 'playing' || deck.state === 'paused');
  }

  isLoading(key) {
    const deck = this.deckFor(key);
    return Boolean(deck) && deck.state === 'loading';
  }

  levelOf(deck, time) {
    return deck.plan ? planLevel(deck.plan, time) : deck.level;
  }

  isAudible(deck, time = this.ctx ? this.ctx.currentTime : 0) {
    return deck.state === 'playing' && (this.levelOf(deck, time) > AUDIBLE || Boolean(deck.plan && deck.plan.to > 0));
  }

  get playing() {
    return this.decks.some((deck) => deck.state === 'playing');
  }

  // ---------------------------------------------------------- cargar

  // Prepara una canción en una bandeja libre, ya colocada en su segundo de inicio y lista para sonar al instante.
  async load(key, blob, { sourceId = key, start = 0, gainDb = 0, force = false } = {}) {
    this.ensure();
    const same = this.decks.find((deck) => deck.key === key && deck.sourceId === sourceId && deck.state !== 'empty');
    if (same) {
      this.touch(same, start, gainDb);
      return same.promise || same;
    }
    let deck = this.acquire(force);
    if (!deck && force) deck = await this.stealAudible();
    if (!deck) throw new NoDeckError();
    deck.reset();
    deck.key = key;
    deck.sourceId = sourceId;
    deck.start = Math.max(0, Number(start) || 0);
    deck.gainDb = gainDb;
    deck.state = 'loading';
    deck.trim.gain.value = dbToGain(gainDb);
    deck.url = URL.createObjectURL(blob);
    const token = deck.token;
    deck.promise = this.prepare(deck, token).then(
      () => {
        this.emit('change');
        return deck;
      },
      (error) => {
        if (deck.token === token) {
          deck.reset();
          if (this.current === deck) this.current = null;
          this.emit('change');
        }
        throw error;
      }
    );
    this.emit('change');
    return deck.promise;
  }

  async prepare(deck, token) {
    const audio = deck.audio;
    audio.src = deck.url;
    audio.load();
    await waitFor(audio, ['loadedmetadata']);
    if (deck.token !== token) throw new DeckAbort();
    deck.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (deck.duration) deck.start = clamp(deck.start, 0, Math.max(0, deck.duration - 1));
    if (deck.start > 0.01) {
      audio.currentTime = deck.start;
      await waitFor(audio, ['seeked']);
      if (deck.token !== token) throw new DeckAbort();
    }
    if (audio.readyState < 3) await waitFor(audio, ['canplay', 'canplaythrough']);
    if (deck.token !== token) throw new DeckAbort();
    deck.state = 'ready';
  }

  // Ajusta una bandeja que ya tiene esa canción (otro segundo de inicio u otro volumen).
  touch(deck, start, gainDb) {
    deck.gainDb = gainDb;
    deck.trim.gain.value = dbToGain(gainDb);
    const wanted = Math.max(0, Number(start) || 0);
    if (deck.state === 'ended' || deck.state === 'ready') {
      deck.start = wanted;
      this.rewind(deck);
      if (deck.state === 'ended') deck.state = 'ready';
    }
  }

  rewind(deck) {
    try {
      const target = deck.duration ? clamp(deck.start, 0, Math.max(0, deck.duration - 1)) : deck.start;
      if (Math.abs(deck.audio.currentTime - target) > 0.05) deck.audio.currentTime = target;
    } catch {
      // aún sin metadatos: se colocará al terminar de cargar
    }
  }

  acquire(force) {
    const free = (deck) => deck !== this.current && (deck.state === 'ready' || deck.state === 'loading') && !this.wanted.includes(deck.key);
    const pick = this.decks.find((deck) => deck.state === 'empty') || this.decks.find((deck) => deck.state === 'ended' && deck !== this.current) || this.decks.find(free);
    if (pick || !force) return pick || null;
    // Hay que sonar ya y no queda ninguna libre: se toma la que menos se nota perder.
    const rank = (deck) => this.wanted.indexOf(deck.key);
    const spare = this.decks.filter((deck) => deck !== this.current && (deck.state === 'ready' || deck.state === 'loading')).sort((a, b) => rank(b) - rank(a))[0];
    if (spare) return spare;
    return this.decks.find((deck) => deck.state === 'ended') || this.decks.find((deck) => deck.state === 'paused' && deck !== this.current) || null;
  }

  // Último recurso: bajar en un instante la bandeja que sale con menos nivel y reutilizarla.
  async stealAudible() {
    const now = this.ctx.currentTime;
    const outgoing = this.decks
      .filter((deck) => deck !== this.current && deck.state === 'playing' && deck.plan && deck.plan.to === 0)
      .sort((a, b) => this.levelOf(a, now) - this.levelOf(b, now))[0];
    if (!outgoing) return null;
    this.fadeDeck(outgoing, now, 0.03, 0, 'dispose');
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.tick();
    return outgoing.state === 'empty' ? outgoing : null;
  }

  // ---------------------------------------------------------- rampas

  schedule(deck, plan) {
    const gain = deck.fade.gain;
    gain.cancelScheduledValues(plan.t0);
    gain.setValueAtTime(plan.from, plan.t0);
    for (const [offset, value] of fadePoints(plan)) gain.linearRampToValueAtTime(value, plan.t0 + offset);
    deck.plan = plan;
    deck.level = plan.from;
  }

  fadeDeck(deck, t0, seconds, to, after) {
    const from = this.levelOf(deck, t0);
    deck.after = after;
    this.schedule(deck, makePlan(t0, seconds, from, to));
    this.startTicker();
  }

  // Todo lo que no sea la canción que entra, baja a cero y se suelta al terminar.
  bringOut(deck, t0, seconds) {
    if (deck.state === 'paused') {
      this.dispose(deck);
      return;
    }
    if (deck.state !== 'playing') return;
    if (this.levelOf(deck, t0) < 0.001) {
      this.dispose(deck);
      return;
    }
    this.fadeDeck(deck, t0, seconds, 0, 'dispose');
  }

  bringIn(deck, t0, seconds) {
    const from = deck.state === 'playing' ? this.levelOf(deck, t0) : 0;
    deck.after = null;
    deck.state = 'playing';
    this.schedule(deck, makePlan(t0, seconds, from, 1));
    this.playDeck(deck);
    this.startTicker();
  }

  playDeck(deck) {
    const result = deck.audio.play();
    if (result && result.catch) result.catch((error) => this.playFailed(deck, error));
  }

  playFailed(deck, error) {
    if (error && error.name === 'AbortError') return; // lo interrumpió una pausa o un cambio de canción
    if (deck.state !== 'playing') return;
    const key = deck.key;
    this.dispose(deck);
    this.emit('error', { key, error, blocked: Boolean(error && error.name === 'NotAllowedError') });
    this.emit('change');
  }

  // Suelta la canción de esa clave (por ejemplo, cuando se quita del programa).
  drop(key) {
    const deck = this.deckFor(key);
    if (!deck) return;
    if (this.ctx && this.isAudible(deck)) {
      this.fadeDeck(deck, this.ctx.currentTime, 0.05, 0, 'dispose');
      return;
    }
    if (this.current === deck) this.current = null;
    deck.reset();
    this.emit('change');
  }

  // ---------------------------------------------------------- acciones

  // Mezcla hacia la canción `key` (que debe estar cargada). Devuelve false si no lo está.
  mixTo(key, { duration = 4 } = {}) {
    const ctx = this.ctx;
    if (!ctx) return false;
    const deck = this.decks.find((item) => item.key === key && (item.state === 'ready' || item.state === 'paused' || item.state === 'playing' || item.state === 'ended'));
    if (!deck) return false;
    const seconds = fadeSeconds(duration);
    const t0 = ctx.currentTime;
    // Si ya suena entera y no se está apagando, no se vuelve a lanzar (un toque doble no la reinicia).
    if (deck === this.current && deck.state === 'playing' && this.levelOf(deck, t0) > 0.98 && !(deck.plan && deck.plan.to === 0)) return true;
    for (const other of this.decks) if (other !== deck) this.bringOut(other, t0, seconds);
    if (deck.state === 'ended') deck.state = 'ready';
    this.rewindIfIdle(deck);
    this.bringIn(deck, t0, seconds);
    this.current = deck;
    this.mix = { t0, dur: seconds };
    this.emit('change');
    return true;
  }

  rewindIfIdle(deck) {
    if (deck.state === 'ready') this.rewind(deck);
  }

  // Pausa con un fundido corto (la posición se conserva).
  pause(seconds = PAUSE_FADE) {
    const ctx = this.ctx;
    if (!ctx) return false;
    const t0 = ctx.currentTime;
    let any = false;
    for (const deck of this.decks) {
      if (deck.state !== 'playing') continue;
      any = true;
      this.fadeDeck(deck, t0, seconds, 0, deck === this.current ? 'pause' : 'dispose');
    }
    this.mix = null;
    this.emit('change');
    return any;
  }

  // Reanuda lo que se pausó, también con un fundido corto.
  resume(seconds = PAUSE_FADE) {
    const ctx = this.ctx;
    const deck = this.current;
    if (!ctx || !deck) return false;
    const t0 = ctx.currentTime;
    if (deck.state === 'playing' && deck.plan && deck.plan.to === 0) {
      // Se estaba apagando y se cambia de idea: sube desde donde estaba.
      this.bringIn(deck, t0, seconds);
      this.emit('change');
      return true;
    }
    if (deck.state !== 'paused') return false;
    this.bringIn(deck, t0, seconds);
    this.emit('change');
    return true;
  }

  // Baja todo hasta el silencio y detiene. La canción actual queda lista al principio.
  stopAll({ duration = 4 } = {}) {
    const ctx = this.ctx;
    if (!ctx) return false;
    const seconds = fadeSeconds(duration);
    const t0 = ctx.currentTime;
    for (const deck of this.decks) {
      if (deck.state === 'paused') {
        if (deck === this.current) this.settleStopped(deck);
        else this.dispose(deck);
        continue;
      }
      if (deck.state !== 'playing') continue;
      this.fadeDeck(deck, t0, seconds, 0, deck === this.current ? 'stop' : 'dispose');
    }
    this.mix = { t0, dur: seconds };
    this.emit('change');
    return true;
  }

  // ---------------------------------------------------------- fin de fundidos

  settleStopped(deck) {
    try {
      deck.audio.pause();
    } catch {
      // ya estaba detenido
    }
    deck.plan = null;
    deck.level = 0;
    deck.after = null;
    deck.state = 'ready';
    deck.fade.gain.cancelScheduledValues(0);
    deck.fade.gain.setValueAtTime(0, this.ctx.currentTime);
    this.rewind(deck);
  }

  dispose(deck) {
    const keep = Boolean(deck.url) && this.wanted.includes(deck.key);
    if (keep && deck.state !== 'loading') {
      this.settleStopped(deck);
      return;
    }
    if (this.current === deck) this.current = null;
    deck.reset();
  }

  finish(deck) {
    const after = deck.after;
    deck.after = null;
    if (after === 'pause') {
      try {
        deck.audio.pause();
      } catch {
        // ya estaba detenido
      }
      deck.state = 'paused';
      return true;
    }
    if (after === 'stop') {
      this.settleStopped(deck);
      return true;
    }
    if (after === 'dispose') {
      this.dispose(deck);
      return true;
    }
    return false;
  }

  onEnded(deck) {
    if (deck.state !== 'playing') return;
    const wasCurrent = deck === this.current;
    const key = deck.key;
    deck.plan = null;
    deck.level = 0;
    deck.after = null;
    deck.fade.gain.cancelScheduledValues(0);
    deck.fade.gain.setValueAtTime(0, this.ctx.currentTime);
    if (wasCurrent) deck.state = 'ended';
    else this.dispose(deck);
    this.emit('ended', { key, current: wasCurrent });
    this.emit('change');
  }

  startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), 50);
  }

  stopTicker() {
    clearInterval(this.ticker);
    this.ticker = 0;
  }

  tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    let changed = false;
    let busy = false;
    for (const deck of this.decks) {
      if (deck.plan) {
        if (planDone(deck.plan, now)) {
          deck.level = deck.plan.to;
          deck.plan = null;
          changed = this.finish(deck) || changed;
        } else {
          deck.level = planLevel(deck.plan, now);
        }
      }
      if (deck.plan || deck.state === 'playing') busy = true;
    }
    if (this.mix && now >= this.mix.t0 + this.mix.dur) {
      this.mix = null;
      changed = true;
    }
    if (changed) this.emit('change');
    if (!busy && !this.mix) this.stopTicker();
  }

  // ---------------------------------------------------------- estado para la pantalla

  info(deck, now) {
    if (!deck || deck.state === 'empty') return null;
    return {
      key: deck.key,
      state: deck.state,
      position: deck.audio.currentTime || 0,
      duration: deck.duration || (Number.isFinite(deck.audio.duration) ? deck.audio.duration : 0),
      level: this.levelOf(deck, now),
    };
  }

  snapshot() {
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    let mixing = { active: false, progress: 1, seconds: 0 };
    if (this.mix && ctx) {
      const progress = clamp((now - this.mix.t0) / this.mix.dur, 0, 1);
      mixing = { active: progress < 1, progress, seconds: this.mix.dur };
    }
    return {
      audio: this.state,
      current: this.info(this.current, now),
      decks: this.decks.map((deck) => this.info(deck, now)),
      mixing,
    };
  }

  // Nivel máximo reciente de la salida (0 a 1) para el medidor.
  peak() {
    if (!this.analyser) return 0;
    if (!this.meterBuffer) this.meterBuffer = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(this.meterBuffer);
    let max = 0;
    for (let index = 0; index < this.meterBuffer.length; index++) {
      const value = Math.abs(this.meterBuffer[index]);
      if (value > max) max = value;
    }
    return max;
  }

  destroy() {
    this.stopTicker();
    for (const deck of this.decks) deck.reset();
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.decks = [];
    this.current = null;
    this.ctx = null;
  }
}
