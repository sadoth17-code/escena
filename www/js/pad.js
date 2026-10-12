// A local root/fifth drone, with no major/minor third and no external samples.
export const PAD_NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export class AmbientPad {
  constructor(engine, onChange = () => {}) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.onChange = onChange;
    this.active = false;
    this.note = 0;
    this.style = 'soft';
    this.voices = new Set();
    this.currentVoice = null;
    this.level = this.ctx.createGain();
    this.level.gain.value = 0.35;
    this.level.connect(engine.mainStereo);
    this.level.connect(engine.mainMono);
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 1100;
    this.filter.Q.value = 0.5;
    this.filter.connect(this.level);
  }

  setVolume(value) {
    const volume = Math.max(0, Math.min(1, Number(value) || 0));
    this.level.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05);
  }

  createVoice(note) {
    const now = this.ctx.currentTime;
    const voice = { nodes: [], envelope: this.ctx.createGain(), released: false };
    voice.envelope.gain.setValueAtTime(0, now);
    voice.envelope.gain.linearRampToValueAtTime(1, now + 1.2);
    voice.envelope.connect(this.filter);
    // C3 root; root, fifth and octave blend softly without imposing a chord quality.
    const layers = [[48 + note, -3, 0.13], [48 + note, 3, 0.13], [55 + note, -2, 0.08], [60 + note, 2, 0.06]];
    for (const [midi, detune, gain] of layers) {
      const oscillator = this.ctx.createOscillator();
      const level = this.ctx.createGain();
      oscillator.type = this.style === 'warm' ? 'triangle' : 'sine';
      oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
      oscillator.detune.value = detune;
      level.gain.value = gain;
      oscillator.connect(level).connect(voice.envelope);
      oscillator.start(now);
      voice.nodes.push({ oscillator, level });
    }
    this.voices.add(voice);
    return voice;
  }

  releaseVoice(voice, seconds = 1.2) {
    if (!voice || voice.released) return;
    voice.released = true;
    const now = this.ctx.currentTime;
    const gain = voice.envelope.gain;
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
    else { const value = gain.value; gain.cancelScheduledValues(now); gain.setValueAtTime(value, now); }
    gain.linearRampToValueAtTime(0, now + seconds);
    voice.nodes.forEach(({ oscillator, level }) => {
      oscillator.onended = () => { oscillator.disconnect(); level.disconnect(); };
      oscillator.stop(now + seconds + 0.02);
    });
    const last = voice.nodes.at(-1).oscillator;
    const release = last.onended;
    last.onended = () => { release(); voice.envelope.disconnect(); this.voices.delete(voice); };
  }

  setNote(value) {
    const note = ((Math.round(Number(value) || 0) % 12) + 12) % 12;
    if (note === this.note) return;
    this.note = note;
    if (this.active) {
      this.releaseVoice(this.currentVoice);
      this.currentVoice = this.createVoice(note);
    }
    this.onChange();
  }

  setStyle(style) {
    const next = style === 'warm' ? 'warm' : 'soft';
    if (this.style === next) return;
    this.style = next;
    if (this.active) {
      this.releaseVoice(this.currentVoice);
      this.currentVoice = this.createVoice(this.note);
    }
    this.onChange();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.currentVoice = this.createVoice(this.note);
    this.onChange();
  }

  stop() {
    this.active = false;
    this.releaseVoice(this.currentVoice);
    this.currentVoice = null;
    this.onChange();
  }
}
