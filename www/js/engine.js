import { faderToGain, FADER_DEFAULT } from './util.js';
import { loadVoiceBank } from './voices.js';
import { SongPlayer } from './player.js';

export const OUTPUT_MODES = [
  { id: 'split', name: 'Dividido', detail: 'Click y guía a un lado, pistas al otro' },
  { id: 'monitor', name: 'Monitor + sala', detail: 'Un lado con todo para el músico, el otro solo pistas para la sala' },
  { id: 'stereo', name: 'Estéreo', detail: 'Todo en estéreo, con paneo por pista' },
];

export const DEFAULT_OUTPUT = {
  mode: 'split',
  swap: false,
  master: FADER_DEFAULT,
  mainLevel: FADER_DEFAULT,
  cueLevel: FADER_DEFAULT,
  limiter: true,
  cueDelayMs: 0,
};

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

export class Engine {
  constructor({ ctx } = {}) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = ctx || new AudioContextClass({ latencyHint: 'playback' });
    this.offline = typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext;
    this.output = { ...DEFAULT_OUTPUT };
    this.voiceBank = null;
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
    this.meters = [ctx.createAnalyser(), ctx.createAnalyser()];
    for (const meter of this.meters) {
      meter.fftSize = 512;
      meter.smoothingTimeConstant = 0;
    }
    this.meterSplit.connect(this.meters[0], 0);
    this.meterSplit.connect(this.meters[1], 1);
    this.meterData = new Float32Array(512);
  }

  setOutput(patch) {
    Object.assign(this.output, patch);
    this.applyOutput(false);
  }

  applyOutput(immediate = false) {
    const output = this.output;
    const now = this.ctx.currentTime;
    const set = (param, value) => {
      if (immediate) param.setValueAtTime(value, now);
      else param.setTargetAtTime(value, now, 0.015);
    };
    const stereo = output.mode === 'stereo';
    set(this.stereoOut.gain, stereo ? 1 : 0);
    set(this.splitOut.gain, stereo ? 0 : 1);
    const matrix = routingMatrix(output.mode, output.swap);
    set(this.matrix.mainToL.gain, matrix.mainL);
    set(this.matrix.cueToL.gain, matrix.cueL);
    set(this.matrix.mainToR.gain, matrix.mainR);
    set(this.matrix.cueToR.gain, matrix.cueR);
    set(this.master.gain, faderToGain(output.master));
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
    if (typeof this.ctx.setSinkId === 'function') await this.ctx.setSinkId(id);
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

  readLevels() {
    const levels = [0, 0];
    for (let i = 0; i < 2; i++) {
      this.meters[i].getFloatTimeDomainData(this.meterData);
      let max = 0;
      for (let j = 0; j < this.meterData.length; j++) {
        const value = Math.abs(this.meterData[j]);
        if (value > max) max = value;
      }
      levels[i] = max;
    }
    return levels;
  }

  playTone(side, seconds = 1.2) {
    const ctx = this.ctx;
    const start = ctx.currentTime + 0.03;
    const oscillator = ctx.createOscillator();
    oscillator.frequency.value = side === 'both' ? 523.25 : 440;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(0.3, start + 0.03);
    envelope.gain.setValueAtTime(0.3, start + seconds - 0.06);
    envelope.gain.linearRampToValueAtTime(0, start + seconds);
    const panner = ctx.createStereoPanner();
    panner.pan.value = side === 'L' ? -1 : side === 'R' ? 1 : 0;
    oscillator.connect(envelope);
    envelope.connect(panner);
    panner.connect(this.preMaster);
    oscillator.start(start);
    oscillator.stop(start + seconds + 0.05);
    oscillator.onended = () => {
      try {
        panner.disconnect();
        envelope.disconnect();
      } catch (error) {
        void error;
      }
    };
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
