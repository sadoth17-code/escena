import { faderToGain, FADER_DEFAULT } from './util.js';
import { loadVoiceBank } from './voices.js';
import { SongPlayer } from './player.js';

export const MAX_OUTPUTS = 32;

export const OUTPUT_MODES = [
  { id: 'split', name: 'Dividido', detail: 'Click y guía a un lado, pistas al otro' },
  { id: 'monitor', name: 'Monitor + sala', detail: 'Un lado con todo para el músico, el otro solo pistas para la sala' },
  { id: 'stereo', name: 'Estéreo', detail: 'Todo en estéreo, con paneo por pista' },
  { id: 'multi', name: 'Salidas múltiples', detail: 'Tú eliges por qué salidas de tu interfaz suena cada cosa' },
];

export const ROUTE_KEYS = ['salaL', 'salaR', 'cue'];

export const DEFAULT_ROUTES = { salaL: [0], salaR: [1], cue: [2] };

export const DEFAULT_OUTPUT = {
  mode: 'split',
  swap: false,
  master: FADER_DEFAULT,
  mainLevel: FADER_DEFAULT,
  cueLevel: FADER_DEFAULT,
  limiter: true,
  cueDelayMs: 0,
  routes: DEFAULT_ROUTES,
};

export function normalizeRoutes(routes) {
  const source = routes && typeof routes === 'object' ? routes : {};
  const result = {};
  for (const key of ROUTE_KEYS) {
    const list = Array.isArray(source[key]) ? source[key] : DEFAULT_ROUTES[key];
    const clean = new Set();
    for (const value of list) {
      if (Number.isInteger(value) && value >= 0 && value < MAX_OUTPUTS) clean.add(value);
    }
    result[key] = Array.from(clean).sort((a, b) => a - b);
  }
  return result;
}

export function routeGains(routes, count) {
  const left = new Set(routes.salaL);
  const right = new Set(routes.salaR);
  const cue = new Set(routes.cue);
  const result = { salaL: [], salaR: [], cue: [] };
  for (let k = 0; k < count; k++) {
    const shared = left.has(k) && right.has(k);
    result.salaL.push(left.has(k) ? (shared ? 0.5 : 1) : 0);
    result.salaR.push(right.has(k) ? (shared ? 0.5 : 1) : 0);
    result.cue.push(cue.has(k) ? 1 : 0);
  }
  return result;
}

export function routingMatrix(mode, swap) {
  if (mode === 'monitor') {
    return swap ? { mainL: 1, cueL: 0, mainR: 1, cueR: 1 } : { mainL: 1, cueL: 1, mainR: 1, cueR: 0 };
  }
  return swap ? { mainL: 1, cueL: 0, mainR: 0, cueR: 1 } : { mainL: 0, cueL: 1, mainR: 1, cueR: 0 };
}

function monoNode(ctx) {
  const node = ctx.createGain();
  node.channelCount = 1;
  node.channelCountMode = 'explicit';
  node.channelInterpretation = 'speakers';
  return node;
}

function stereoNode(ctx) {
  const node = ctx.createGain();
  node.channelCount = 2;
  node.channelCountMode = 'explicit';
  node.channelInterpretation = 'speakers';
  return node;
}

function createLimiter(ctx) {
  const node = ctx.createDynamicsCompressor();
  node.knee.value = 0;
  node.attack.value = 0.002;
  node.release.value = 0.09;
  node.threshold.value = -1.5;
  node.ratio.value = 20;
  return node;
}

function createMeter(ctx) {
  const meter = ctx.createAnalyser();
  meter.fftSize = 512;
  meter.smoothingTimeConstant = 0;
  return meter;
}

function playEnvelope(ctx, frequency, seconds, attach) {
  const start = ctx.currentTime + 0.03;
  const oscillator = ctx.createOscillator();
  oscillator.frequency.value = frequency;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(0.3, start + 0.03);
  envelope.gain.setValueAtTime(0.3, start + seconds - 0.06);
  envelope.gain.linearRampToValueAtTime(0, start + seconds);
  oscillator.connect(envelope);
  const release = attach(envelope);
  oscillator.start(start);
  oscillator.stop(start + seconds + 0.05);
  oscillator.onended = () => {
    try {
      release();
      envelope.disconnect();
    } catch (error) {
      void error;
    }
  };
}

export class Engine {
  constructor({ ctx } = {}) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = ctx || new AudioContextClass({ latencyHint: 'playback' });
    this.offline = typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext;
    this.output = { ...DEFAULT_OUTPUT };
    this.voiceBank = null;
    this.multi = null;
    this.multiActive = false;
    this.buildGraph();
    this.applyOutput(true);
  }

  buildGraph() {
    const ctx = this.ctx;
    this.mainStereo = stereoNode(ctx);
    this.cueStereo = stereoNode(ctx);
    this.mainMono = monoNode(ctx);
    this.cueMono = monoNode(ctx);
    this.delays = {
      mainStereo: ctx.createDelay(0.5),
      cueStereo: ctx.createDelay(0.5),
      mainMono: ctx.createDelay(0.5),
      cueMono: ctx.createDelay(0.5),
    };
    this.stereoOut = stereoNode(ctx);
    this.mainStereo.connect(this.delays.mainStereo).connect(this.stereoOut);
    this.cueStereo.connect(this.delays.cueStereo).connect(this.stereoOut);
    this.matrix = {
      mainToL: ctx.createGain(),
      mainToR: ctx.createGain(),
      cueToL: ctx.createGain(),
      cueToR: ctx.createGain(),
    };
    this.mainMono.connect(this.delays.mainMono);
    this.cueMono.connect(this.delays.cueMono);
    this.delays.mainMono.connect(this.matrix.mainToL);
    this.delays.mainMono.connect(this.matrix.mainToR);
    this.delays.cueMono.connect(this.matrix.cueToL);
    this.delays.cueMono.connect(this.matrix.cueToR);
    this.leftBus = monoNode(ctx);
    this.rightBus = monoNode(ctx);
    this.matrix.mainToL.connect(this.leftBus);
    this.matrix.cueToL.connect(this.leftBus);
    this.matrix.mainToR.connect(this.rightBus);
    this.matrix.cueToR.connect(this.rightBus);
    this.merger = ctx.createChannelMerger(2);
    this.leftBus.connect(this.merger, 0, 0);
    this.rightBus.connect(this.merger, 0, 1);
    this.splitOut = stereoNode(ctx);
    this.merger.connect(this.splitOut);
    this.preMaster = stereoNode(ctx);
    this.stereoOut.connect(this.preMaster);
    this.splitOut.connect(this.preMaster);
    this.master = stereoNode(ctx);
    this.preMaster.connect(this.master);
    this.limiterSplit = ctx.createChannelSplitter(2);
    this.limiterMerge = ctx.createChannelMerger(2);
    this.limiters = [createLimiter(ctx), createLimiter(ctx)];
    this.master.connect(this.limiterSplit);
    this.limiterSplit.connect(this.limiters[0], 0);
    this.limiterSplit.connect(this.limiters[1], 1);
    this.limiters[0].connect(this.limiterMerge, 0, 0);
    this.limiters[1].connect(this.limiterMerge, 0, 1);
    this.limiterMerge.connect(ctx.destination);
    this.meterSplit = ctx.createChannelSplitter(2);
    this.limiterMerge.connect(this.meterSplit);
    this.meters = [createMeter(ctx), createMeter(ctx)];
    this.meterSplit.connect(this.meters[0], 0);
    this.meterSplit.connect(this.meters[1], 1);
    this.meterData = new Float32Array(512);
  }

  get maxChannels() {
    const value = Math.floor(Number(this.ctx.destination.maxChannelCount));
    if (!Number.isFinite(value) || value < 2) return 2;
    return Math.min(MAX_OUTPUTS, value);
  }

  get multiAvailable() {
    return this.maxChannels > 2;
  }

  get effectiveMode() {
    return this.output.mode === 'multi' && !this.multiActive ? 'split' : this.output.mode;
  }

  buildMulti(count) {
    const ctx = this.ctx;
    this.disposeMulti();
    const merger = ctx.createChannelMerger(count);
    const mainSplit = ctx.createChannelSplitter(2);
    this.delays.mainStereo.connect(mainSplit);
    const gains = { salaL: [], salaR: [], cue: [] };
    for (let k = 0; k < count; k++) {
      const left = ctx.createGain();
      const right = ctx.createGain();
      const cue = ctx.createGain();
      left.gain.value = 0;
      right.gain.value = 0;
      cue.gain.value = 0;
      mainSplit.connect(left, 0);
      mainSplit.connect(right, 1);
      this.delays.cueMono.connect(cue);
      left.connect(merger, 0, k);
      right.connect(merger, 0, k);
      cue.connect(merger, 0, k);
      gains.salaL.push(left);
      gains.salaR.push(right);
      gains.cue.push(cue);
    }
    const master = ctx.createGain();
    master.channelCount = count;
    master.channelCountMode = 'explicit';
    master.channelInterpretation = 'discrete';
    master.gain.value = 0;
    merger.connect(master);
    const limiterSplit = ctx.createChannelSplitter(count);
    const limiterMerge = ctx.createChannelMerger(count);
    const limiters = [];
    master.connect(limiterSplit);
    for (let k = 0; k < count; k++) {
      const limiter = createLimiter(ctx);
      limiterSplit.connect(limiter, k);
      limiter.connect(limiterMerge, 0, k);
      limiters.push(limiter);
    }
    limiterMerge.connect(ctx.destination);
    const meterSplit = ctx.createChannelSplitter(count);
    limiterMerge.connect(meterSplit);
    const meters = [];
    for (let k = 0; k < count; k++) {
      const meter = createMeter(ctx);
      meterSplit.connect(meter, k);
      meters.push(meter);
    }
    this.multi = { count, merger, mainSplit, gains, master, limiterSplit, limiterMerge, limiters, meterSplit, meters, routeKey: '', limiterOn: null };
  }

  disposeMulti() {
    const multi = this.multi;
    this.multi = null;
    this.multiActive = false;
    if (!multi) return;
    const detach = (fn) => {
      try {
        fn();
      } catch (error) {
        void error;
      }
    };
    detach(() => this.delays.mainStereo.disconnect(multi.mainSplit));
    for (const gain of multi.gains.cue) detach(() => this.delays.cueMono.disconnect(gain));
    detach(() => multi.limiterMerge.disconnect());
    detach(() => multi.master.disconnect());
  }

  syncChannels() {
    const wanted = this.output.mode === 'multi' && this.multiAvailable;
    const target = wanted ? this.maxChannels : 2;
    if (wanted && (!this.multi || this.multi.count !== target)) this.buildMulti(target);
    const destination = this.ctx.destination;
    if (destination.channelCount !== target) {
      try {
        destination.channelCount = target;
      } catch (error) {
        void error;
      }
    }
    const interpretation = wanted ? 'discrete' : 'speakers';
    if (destination.channelInterpretation !== interpretation) {
      try {
        destination.channelInterpretation = interpretation;
      } catch (error) {
        void error;
      }
    }
    this.multiActive = wanted && Boolean(this.multi) && destination.channelCount === target;
  }

  setOutput(patch) {
    Object.assign(this.output, patch);
    this.applyOutput(false);
  }

  applyOutput(immediate = false) {
    this.syncChannels();
    const output = this.output;
    const now = this.ctx.currentTime;
    const set = (param, value) => {
      if (immediate) param.setValueAtTime(value, now);
      else param.setTargetAtTime(value, now, 0.015);
    };
    const mode = this.effectiveMode;
    const stereo = mode === 'stereo';
    const multi = mode === 'multi';
    set(this.stereoOut.gain, stereo ? 1 : 0);
    set(this.splitOut.gain, stereo || multi ? 0 : 1);
    const matrix = routingMatrix(mode, output.swap);
    set(this.matrix.mainToL.gain, matrix.mainL);
    set(this.matrix.cueToL.gain, matrix.cueL);
    set(this.matrix.mainToR.gain, matrix.mainR);
    set(this.matrix.cueToR.gain, matrix.cueR);
    set(this.master.gain, faderToGain(output.master));
    this.applyRoutes(set, multi, immediate);
    const main = faderToGain(output.mainLevel);
    const cue = faderToGain(output.cueLevel);
    set(this.mainStereo.gain, main);
    set(this.mainMono.gain, main);
    set(this.cueStereo.gain, cue);
    set(this.cueMono.gain, cue);
    const delay = (Number(output.cueDelayMs) || 0) / 1000;
    set(this.delays.cueStereo.delayTime, Math.max(0, delay));
    set(this.delays.cueMono.delayTime, Math.max(0, delay));
    set(this.delays.mainStereo.delayTime, Math.max(0, -delay));
    set(this.delays.mainMono.delayTime, Math.max(0, -delay));
    for (const limiter of this.limiters) {
      set(limiter.threshold, output.limiter ? -1.5 : 0);
      set(limiter.ratio, output.limiter ? 20 : 1);
    }
    const chain = this.multi;
    if (chain && (immediate || chain.limiterOn !== Boolean(output.limiter))) {
      chain.limiterOn = Boolean(output.limiter);
      for (const limiter of chain.limiters) {
        set(limiter.threshold, output.limiter ? -1.5 : 0);
        set(limiter.ratio, output.limiter ? 20 : 1);
      }
    }
  }

  applyRoutes(set, active, immediate) {
    const chain = this.multi;
    if (!chain) return;
    const routes = normalizeRoutes(this.output.routes);
    const key = JSON.stringify(routes);
    if (immediate || key !== chain.routeKey) {
      chain.routeKey = key;
      const gains = routeGains(routes, chain.count);
      for (let k = 0; k < chain.count; k++) {
        set(chain.gains.salaL[k].gain, gains.salaL[k]);
        set(chain.gains.salaR[k].gain, gains.salaR[k]);
        set(chain.gains.cue[k].gain, gains.cue[k]);
      }
    }
    set(chain.master.gain, active ? faderToGain(this.output.master) : 0);
  }

  async resume() {
    if (this.offline) return;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (error) {
        console.error(error);
      }
    }
  }

  async setSinkId(id) {
    if (typeof this.ctx.setSinkId !== 'function') return false;
    this.multiActive = false;
    try {
      if (this.ctx.destination.channelCount !== 2) this.ctx.destination.channelCount = 2;
    } catch (error) {
      void error;
    }
    try {
      await this.ctx.setSinkId(id);
    } finally {
      this.applyOutput(true);
    }
    return true;
  }

  async loadVoices() {
    if (!this.voiceBank) this.voiceBank = await loadVoiceBank(this.ctx);
    return this.voiceBank;
  }

  async decode(blob) {
    const data = await blob.arrayBuffer();
    return this.ctx.decodeAudioData(data);
  }

  monoDownmix(buffer) {
    if (buffer.numberOfChannels < 2) return buffer;
    const mono = this.ctx.createBuffer(1, buffer.length, buffer.sampleRate);
    const out = mono.getChannelData(0);
    const channels = buffer.numberOfChannels;
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += data[i] / channels;
    }
    return mono;
  }

  padBuffer(buffer, length) {
    if (buffer.length >= length) return buffer;
    const padded = this.ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) padded.getChannelData(c).set(buffer.getChannelData(c));
    return padded;
  }

  createPlayer(song, buffers, voices) {
    let longest = 0;
    for (const buffer of buffers.values()) longest = Math.max(longest, buffer.length);
    for (const [id, buffer] of buffers) buffers.set(id, this.padBuffer(buffer, longest));
    return new SongPlayer(this, song, { buffers, voices });
  }

  peakOf(analyser) {
    analyser.getFloatTimeDomainData(this.meterData);
    let max = 0;
    for (let j = 0; j < this.meterData.length; j++) {
      const value = Math.abs(this.meterData[j]);
      if (value > max) max = value;
    }
    return max;
  }

  readLevels() {
    if (this.multiActive && this.multi) {
      const chain = this.multi;
      const routes = normalizeRoutes(this.output.routes);
      const peaks = new Map();
      const level = (list) => {
        let max = 0;
        for (const k of list) {
          if (k >= chain.count) continue;
          if (!peaks.has(k)) peaks.set(k, this.peakOf(chain.meters[k]));
          max = Math.max(max, peaks.get(k));
        }
        return max;
      };
      return [level(routes.cue), level([...routes.salaL, ...routes.salaR])];
    }
    return [this.peakOf(this.meters[0]), this.peakOf(this.meters[1])];
  }

  playTone(side, seconds = 1.2) {
    const ctx = this.ctx;
    const panner = ctx.createStereoPanner();
    panner.pan.value = side === 'L' ? -1 : side === 'R' ? 1 : 0;
    panner.connect(this.preMaster);
    playEnvelope(ctx, side === 'both' ? 523.25 : 440, seconds, (envelope) => {
      envelope.connect(panner);
      return () => panner.disconnect();
    });
  }

  playChannelTone(index, seconds = 1.2) {
    const chain = this.multi;
    if (!this.multiActive || !chain || !(index >= 0 && index < chain.count)) return false;
    playEnvelope(this.ctx, 440, seconds, (envelope) => {
      envelope.connect(chain.merger, 0, index);
      return () => {};
    });
    return true;
  }

  async previewBuffer(buffer, dest = 'cue') {
    await this.resume();
    const gain = this.ctx.createGain();
    gain.gain.value = 0.8;
    gain.connect(dest === 'cue' ? this.cueStereo : this.mainStereo);
    gain.connect(dest === 'cue' ? this.cueMono : this.mainMono);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(this.ctx.currentTime + 0.02);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
  }

  playPreview(buffer, track) {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(track.input);
    source.start(this.ctx.currentTime + 0.02);
    source.onended = () => source.disconnect();
  }
}
