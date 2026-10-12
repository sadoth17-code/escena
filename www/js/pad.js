// Local pads: synthesized soft/shimmer textures and a compact user-supplied audio bank.
export const PAD_NOTES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
export const PAD_STYLES = [
  { id: 'soft', name: 'Suave', detail: 'Textura cálida y discreta' },
  { id: 'shimmer', name: 'Shimmer', detail: 'Brillo de octavas con ambiente amplio' },
  { id: 'ambient', name: 'Ambient · tus audios', detail: 'Banco local del paquete que adjuntaste' },
];
export const normalizePadStyle = value => ['soft', 'shimmer', 'ambient'].includes(value) ? value : 'soft';
const normalizeNote = value => ((Math.round(Number(value) || 0) % 12) + 12) % 12;
const bankUrl = note => new URL(`../audio/pads/${String(note).padStart(2, '0')}.mp3`, import.meta.url);

// Overlap the first/last two seconds. At the wrap point both sides continue the
// same original segment, avoiding an MP3 boundary click without repeated fades.
export function makePadLoop(ctx, source) {
  const overlap = Math.min(Math.round(source.sampleRate * 2), Math.floor(source.length / 4));
  if (overlap < 2) return source;
  const length = source.length - overlap;
  const loop = ctx.createBuffer(source.numberOfChannels, length, source.sampleRate);
  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const original = source.getChannelData(channel);
    const data = loop.getChannelData(channel);
    data.set(original.subarray(overlap, length), overlap);
    for (let i = 0; i < overlap; i++) {
      const phase = i / (overlap - 1) * Math.PI / 2;
      data[i] = original[length + i] * Math.cos(phase) + original[i] * Math.sin(phase);
    }
  }
  return loop;
}

export class AmbientPad {
  constructor(engine, onChange = () => {}) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.onChange = onChange;
    this.active = false;
    this.loading = false;
    this.error = '';
    this.note = 0;
    this.style = 'soft';
    this.fade = 2;
    this.voices = new Set();
    this.currentVoice = null;
    this.requestId = 0;
    this.buffers = new Map();
    this.loads = new Map();
    this.impulse = null;
    this.level = this.ctx.createGain();
    this.level.gain.value = 0.35;
    this.level.connect(engine.mainStereo);
    this.level.connect(engine.mainMono);
  }

  setVolume(value) {
    const volume = Math.max(0, Math.min(1, Number(value) || 0));
    this.level.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05);
  }

  setFade(value) {
    this.fade = [1, 2, 4].includes(Number(value)) ? Number(value) : 2;
  }

  async loadNote(note) {
    if (this.buffers.has(note)) {
      const buffer = this.buffers.get(note);
      this.buffers.delete(note);
      this.buffers.set(note, buffer);
      return buffer;
    }
    if (!this.loads.has(note)) {
      const pending = (async () => {
        const response = await fetch(bankUrl(note));
        if (!response.ok) throw new Error('No se pudo abrir el banco Ambient. Usa Suave o Shimmer y revisa la instalación.');
        const original = await this.ctx.decodeAudioData(await response.arrayBuffer());
        const buffer = makePadLoop(this.ctx, original);
        this.buffers.set(note, buffer);
        // Keep a few recent notes ready without retaining all twelve PCM files.
        while (this.buffers.size > 3) this.buffers.delete(this.buffers.keys().next().value);
        return buffer;
      })().finally(() => this.loads.delete(note));
      this.loads.set(note, pending);
    }
    return this.loads.get(note);
  }

  reverbImpulse() {
    if (this.impulse) return this.impulse;
    const rate = this.ctx.sampleRate;
    const length = Math.round(rate * 2.8);
    const impulse = this.ctx.createBuffer(2, length, rate);
    // Deterministic diffused stereo tail; no downloaded impulse responses.
    let seed = 173;
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      let smooth = 0;
      for (let i = 0; i < length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        const noise = (seed >>> 0) / 2147483648 - 1;
        smooth = smooth * 0.62 + noise * 0.38;
        data[i] = smooth * Math.pow(1 - i / length, 2.4) * Math.min(1, i / (rate * 0.018));
      }
    }
    this.impulse = impulse;
    return impulse;
  }

  createVoice(note, style = this.style, buffer = null) {
    const now = this.ctx.currentTime;
    const voice = { note, style, nodes: [], sources: [], envelope: this.ctx.createGain(), released: false, startedAt: now, fadeIn: this.fade };
    voice.envelope.gain.setValueAtTime(0, now);
    voice.envelope.gain.linearRampToValueAtTime(1, now + this.fade);
    voice.envelope.connect(this.level);
    if (buffer) {
      const source = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      source.buffer = buffer;
      source.loop = true;
      // The supplied recording has ample headroom; match the generated textures.
      gain.gain.value = 2;
      source.connect(gain).connect(voice.envelope);
      source.start(now);
      voice.sources.push(source);
      voice.nodes.push(source, gain);
    } else {
      const input = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.min(this.ctx.sampleRate * 0.45, style === 'shimmer' ? 4200 : 1600);
      filter.Q.value = 0.35;
      input.connect(filter);
      const dry = this.ctx.createGain();
      const wet = this.ctx.createGain();
      const reverb = this.ctx.createConvolver();
      reverb.buffer = this.reverbImpulse();
      dry.gain.value = style === 'shimmer' ? 0.6 : 0.75;
      wet.gain.value = style === 'shimmer' ? 0.62 : 0.45;
      filter.connect(dry).connect(voice.envelope);
      filter.connect(reverb).connect(wet).connect(voice.envelope);
      voice.nodes.push(input, filter, dry, wet, reverb);
      // Root/fifth/octave only: compatible with either major or minor songs.
      const layers = [[48,-5,.065,-.5],[48,5,.065,.5],[55,-3,.035,-.3],[55,3,.035,.3],[60,-6,.04,-.7],[60,6,.04,.7]];
      if (style === 'shimmer') layers.push([72,-7,.022,-.8],[72,7,.022,.8],[79,-4,.012,-.4],[84,4,.009,.4]);
      else layers.push([60,-1,.023,0]);
      for (const [midi, detune, gain, pan] of layers) {
        const oscillator = this.ctx.createOscillator();
        const level = this.ctx.createGain();
        const panner = this.ctx.createStereoPanner();
        oscillator.type = style === 'soft' && midi >= 60 ? 'triangle' : 'sine';
        oscillator.frequency.value = 440 * 2 ** ((midi + note - 69) / 12);
        oscillator.detune.value = detune;
        level.gain.value = gain;
        panner.pan.value = pan;
        oscillator.connect(level).connect(panner).connect(input);
        oscillator.start(now);
        voice.sources.push(oscillator);
        voice.nodes.push(oscillator, level, panner);
      }
    }
    this.voices.add(voice);
    return voice;
  }

  releaseVoice(voice, seconds = this.fade) {
    if (!voice || voice.released) return;
    voice.released = true;
    const now = this.ctx.currentTime;
    const gain = voice.envelope.gain;
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
    else {
      // AudioParam.value is not reliable during an automation ramp in all hosts.
      const held = Math.min(1, Math.max(0, (now - voice.startedAt) / voice.fadeIn));
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(held, now);
    }
    gain.linearRampToValueAtTime(0, now + seconds);
    let remaining = voice.sources.length;
    for (const source of voice.sources) {
      source.onended = () => {
        if (--remaining) return;
        voice.nodes.forEach(node => node.disconnect());
        voice.envelope.disconnect();
        this.voices.delete(voice);
        this.onChange();
      };
      source.stop(now + seconds + 0.02);
    }
  }

  async transition() {
    const request = ++this.requestId;
    const note = this.note, style = this.style;
    this.loading = style === 'ambient' && !this.buffers.has(note);
    this.error = '';
    this.onChange();
    try {
      const buffer = style === 'ambient' ? await this.loadNote(note) : null;
      if (!this.active || request !== this.requestId) return false;
      const previous = this.currentVoice;
      this.currentVoice = this.createVoice(note, style, buffer);
      this.releaseVoice(previous);
      return true;
    } catch (error) {
      if (request !== this.requestId) return false;
      this.error = error.message || 'No se pudo preparar el pad';
      if (!this.currentVoice) this.active = false;
      return false;
    } finally {
      if (request === this.requestId) { this.loading = false; this.onChange(); }
    }
  }

  setNote(value) {
    const note = normalizeNote(value);
    if (note === this.note) return;
    this.note = note;
    if (this.active) this.transition();
    else this.onChange();
  }

  setStyle(style) {
    const next = normalizePadStyle(style);
    if (this.style === next) return;
    this.style = next;
    if (this.active) this.transition();
    else this.onChange();
  }

  async start() {
    if (this.active) return true;
    this.active = true;
    return this.transition();
  }

  stop() {
    this.active = false;
    this.loading = false;
    this.error = '';
    this.requestId++;
    this.releaseVoice(this.currentVoice);
    this.currentVoice = null;
    this.onChange();
  }
}
