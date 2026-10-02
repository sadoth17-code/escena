import { uid } from './util.js';
import { SECTION_COLORS } from './voices.js';

const RATE = 44100;
const BPM = 100;
const BARS = 16;
const STEP = 60 / BPM / 4;
const TOTAL = Math.round(BARS * 16 * STEP * RATE);
const ROOTS = [33, 29, 36, 31];
const CHORDS = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];
const SECTIONS = [
  { name: 'Intro', bar: 1, voice: 'intro' },
  { name: 'Verso', bar: 5, voice: 'verso' },
  { name: 'Coro', bar: 9, voice: 'coro' },
  { name: 'Final', bar: 13, voice: 'final' },
];

const hz = (note) => 440 * Math.pow(2, (note - 69) / 12);

function sectionOf(bar) {
  if (bar < 4) return 0;
  if (bar < 8) return 1;
  if (bar < 12) return 2;
  return 3;
}

function noiseSource() {
  let seed = 12345;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
}

function addKick(out, at, level) {
  const length = Math.round(RATE * 0.3);
  let phase = 0;
  for (let i = 0; i < length && at + i < out.length; i++) {
    const t = i / RATE;
    const freq = 45 + 90 * Math.exp(-t * 28);
    phase += (2 * Math.PI * freq) / RATE;
    out[at + i] += Math.sin(phase) * Math.exp(-t * 9) * level;
  }
}

function addSnare(out, at, level, random) {
  const length = Math.round(RATE * 0.22);
  for (let i = 0; i < length && at + i < out.length; i++) {
    const t = i / RATE;
    const tone = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 26) * 0.5;
    out[at + i] += (random() * Math.exp(-t * 20) * 0.7 + tone) * level;
  }
}

function addHat(out, at, level, random, decay) {
  const length = Math.round(RATE * (decay > 20 ? 0.08 : 0.5));
  let previous = 0;
  for (let i = 0; i < length && at + i < out.length; i++) {
    const t = i / RATE;
    const value = random();
    out[at + i] += (value - previous) * 0.5 * Math.exp(-t * decay) * level;
    previous = value;
  }
}

function drums() {
  const out = new Float32Array(TOTAL);
  const random = noiseSource();
  for (let bar = 0; bar < BARS; bar++) {
    const section = sectionOf(bar);
    for (let step = 0; step < 16; step++) {
      const at = Math.round((bar * 16 + step) * STEP * RATE);
      const last = bar === BARS - 1;
      if (last && step > 4) continue;
      if (section === 0) {
        if (step % 2 === 0) addHat(out, at, step % 4 === 0 ? 0.3 : 0.18, random, 60);
        if (bar === 3 && step >= 12) addSnare(out, at, 0.5, random);
        continue;
      }
      if (step === 0 || step === 8 || (section >= 2 && step === 10)) addKick(out, at, 0.9);
      if (step === 4 || step === 12) addSnare(out, at, 0.7, random);
      if (section === 1 ? step % 2 === 0 : true) addHat(out, at, step % 4 === 0 ? 0.28 : 0.16, random, 60);
      if (section >= 2 && step === 0 && bar % 4 === 0) addHat(out, at, 0.5, random, 6);
    }
  }
  return out;
}

function addNote(out, at, seconds, freq, level, shape) {
  const length = Math.round(seconds * RATE);
  for (let i = 0; i < length && at + i < out.length; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / shape.attack);
    const release = Math.min(1, (seconds - t) / shape.release);
    const envelope = attack * Math.max(0, release) * Math.exp(-t * shape.decay);
    let sample = Math.sin(2 * Math.PI * freq * t);
    sample += shape.second * Math.sin(4 * Math.PI * freq * t);
    sample += shape.third * Math.sin(6 * Math.PI * freq * t);
    out[at + i] += sample * envelope * level;
  }
}

function bass() {
  const out = new Float32Array(TOTAL);
  for (let bar = 0; bar < BARS; bar++) {
    const section = sectionOf(bar);
    const root = hz(ROOTS[bar % 4]);
    const steps = section === 0 ? [0] : section === 1 ? [0, 4, 8, 12] : [0, 2, 4, 6, 8, 10, 12, 14];
    if (bar === BARS - 1) steps.splice(1);
    for (const step of steps) {
      const at = Math.round((bar * 16 + step) * STEP * RATE);
      const length = section === 0 ? 16 * STEP : (section === 1 ? 3.5 : 1.7) * STEP;
      addNote(out, at, length, root, 0.5, { attack: 0.01, release: 0.05, decay: section === 0 ? 0.4 : 3, second: 0.5, third: 0.25 });
    }
  }
  return out;
}

function pad() {
  const out = new Float32Array(TOTAL);
  for (let bar = 0; bar < BARS; bar++) {
    const chord = CHORDS[bar % 4];
    const at = Math.round(bar * 16 * STEP * RATE);
    const length = bar === BARS - 1 ? 3.5 : 16 * STEP;
    for (const note of chord) addNote(out, at, length, hz(note), 0.12, { attack: 0.5, release: 0.6, decay: 0, second: 0.3, third: 0.1 });
  }
  return out;
}

function lead() {
  const out = new Float32Array(TOTAL);
  for (let bar = 4; bar < BARS; bar++) {
    const section = sectionOf(bar);
    const chord = CHORDS[bar % 4];
    const steps = section === 1 ? [0, 4, 8, 12] : [0, 2, 4, 6, 8, 10, 12, 14];
    if (bar === BARS - 1) steps.splice(1);
    steps.forEach((step, index) => {
      const note = chord[(index + (section === 3 ? 1 : 0)) % 3] + 12;
      const at = Math.round((bar * 16 + step) * STEP * RATE);
      addNote(out, at, 4 * STEP, hz(note), 0.3, { attack: 0.005, release: 0.05, decay: 5, second: 0.4, third: 0.15 });
    });
  }
  return out;
}

function encodeWav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = peak > 0.85 ? 0.85 / peak : 1;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i] * gain)) * 32767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function buildDemo() {
  const stems = [
    { name: 'Batería', render: drums },
    { name: 'Bajo', render: bass },
    { name: 'Pad', render: pad },
    { name: 'Melodía', render: lead },
  ];
  const drafts = [];
  for (const stem of stems) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    drafts.push({
      key: uid(),
      item: { name: `${stem.name}.wav`, blob: encodeWav(stem.render()) },
      name: stem.name,
      click: false,
      guide: false,
      dest: 'main',
      mono: false,
      keep: true,
    });
  }
  return {
    title: 'Canción de prueba',
    drafts,
    tempo: { bpm: BPM, num: 4, den: 4, offsetMs: 0 },
    markers: SECTIONS.map((section) => ({ ...section, color: SECTION_COLORS[section.voice] })),
  };
}
