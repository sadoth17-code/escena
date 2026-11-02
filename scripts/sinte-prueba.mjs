// Canciones sintéticas para probar el detector de acordes: bajo, teclado, guitarra arpegiada, melodía y batería,
// con armónicos, ligeras desafinaciones y ruido. Se sabe de antemano qué acorde suena en cada cuarto de compás.
// Sirve a scripts/test-detectar.mjs y a la prueba de navegador; no forma parte de la app.

const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const SHAPES = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus4: [0, 5, 7],
};

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// «F#m7» → { root: 6, tones: [6, 9, 1, 4], name }
export function chordInfo(symbol) {
  const m = /^([A-G][#b]?)(m7|maj7|m|7|sus4)?$/.exec(symbol);
  if (!m) throw new Error(`Acorde de prueba no válido: ${symbol}`);
  const root = PC[m[1]];
  return { root, tones: SHAPES[m[2] || ''].map(i => (root + i) % 12), name: symbol };
}

// Acorde de la forma [60, 72) más cercana a `centre` para cada nota del acorde.
function voice(tones, low, high) {
  const out = [];
  for (const t of tones) {
    let midi = low + ((t - low) % 12 + 12) % 12;
    while (midi < high) { out.push(midi); midi += 12; }
  }
  return out.sort((a, b) => a - b);
}

let DETUNE = 0; // desafinación global en semitonos, la fija makeSong
function note(out, rate, start, dur, midi, amp, rand, { harmonics = 8, attack = 0.012, decay = 2, tilt = 1.1 } = {}) {
  const f0 = 440 * 2 ** ((midi - 69 + DETUNE + (rand() - 0.5) * 0.08) / 12);
  const n0 = Math.floor(start * rate);
  if (n0 >= out.length) return;
  const release = 0.12;
  const n = Math.min(out.length - n0, Math.floor((dur + release) * rate));
  for (let h = 1; h <= harmonics; h++) {
    const f = f0 * h;
    if (f > rate * 0.45) break;
    const a = amp / h ** tilt;
    const w = (2 * Math.PI * f) / rate;
    const phase = rand() * 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const env = (t < attack ? t / attack : 1) * Math.exp(-decay * t) * (t > dur ? Math.max(0, 1 - (t - dur) / release) : 1);
      out[n0 + i] += a * env * Math.sin(w * i + phase);
    }
  }
}

function noiseBurst(out, rate, start, dur, amp, rand, { low = false } = {}) {
  const n0 = Math.floor(start * rate);
  const n = Math.min(out.length - n0, Math.floor(dur * rate));
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const white = rand() * 2 - 1;
    prev = low ? 0.9 * prev + 0.1 * white : white - 0.95 * prev; // bajo-pasante o alto-pasante
    out[n0 + i] += amp * prev * Math.exp((-5 * i) / n);
  }
}

// plan: [{ name, bars: ['G', 'D', ['Em', 'C'], …] }]. Cada compás es un acorde o una lista de 2 o 4 acordes.
export function makeSong({ plan, bpm = 100, beats = 4, rate = 22050, seed = 7, silentBars = 0, melody = true, tail = 1.2, detune = 0, power = false } = {}) {
  const rand = rng(seed);
  DETUNE = detune / 100;
  const barSec = (60 / bpm) * beats;
  const bars = [];
  const truth = []; // por compás, 4 cuartos
  const sections = [];
  for (const part of plan) {
    sections.push({ n: part.name, b: bars.length + silentBars + 1 });
    for (const bar of part.bars) {
      const list = Array.isArray(bar) ? bar : [bar];
      const parts = beats === 3 ? 3 : 4; // partes en que se divide el compás al cifrar
      const slots = list.length === 1 ? Array(parts).fill(list[0]) : list.length === 2 && parts === 4 ? [list[0], list[0], list[1], list[1]] : list;
      truth.push(slots);
      bars.push(list);
    }
  }
  const total = (bars.length + silentBars) * barSec + tail;
  const length = Math.ceil(total * rate);
  const stems = { bass: new Float32Array(length), keys: new Float32Array(length), guitar: new Float32Array(length), lead: new Float32Array(length), drums: new Float32Array(length) };
  bars.forEach((list, n) => {
    const t0 = (n + silentBars) * barSec;
    const span = barSec / list.length;
    list.forEach((symbol, j) => {
      const info = chordInfo(symbol);
      const start = t0 + j * span;
      // Bajo: raíz en la octava grave, a cada pulso, con la quinta de paso en el último.
      const rootMidi = 33 + ((info.root - 33) % 12 + 12) % 12;
      const hits = Math.max(1, Math.round((span / barSec) * beats));
      for (let b = 0; b < hits; b++) {
        const fifth = hits > 2 && b === hits - 1 && rand() < 0.4;
        note(stems.bass, rate, start + b * (span / hits), (span / hits) * 0.9, fifth ? rootMidi + 7 : rootMidi, 0.5, rand, { harmonics: 5, decay: 2.5, tilt: 1.3 });
      }
      // Teclado: acorde sostenido.
      if (!power) for (const midi of voice(info.tones, 55, 72)) note(stems.keys, rate, start, span * 0.98, midi, 0.16, rand, { harmonics: 6, attack: 0.06, decay: 0.25 });
      // Guitarra: arpegio a corcheas.
      const arp = voice(info.tones, 52, 79);
      const eighths = Math.round((span / barSec) * beats * 2);
      const low = 45 + ((info.root - 45) % 12 + 12) % 12;
      for (let e = 0; e < eighths; e++) {
        const at = start + e * (span / eighths);
        if (power) {
          // Acordes de potencia: raíz, quinta y octava a la vez, sin tercera.
          for (const midi of [low, low + 7, low + 12]) note(stems.guitar, rate, at, (span / eighths) * 0.9, midi, 0.18, rand, { harmonics: 7, decay: 5 });
        } else {
          const pattern = [0, 2, 1, 2, 0, 2, 1, 2];
          const midi = arp[(pattern[e % 8] + Math.floor(e / 8)) % arp.length] || arp[0];
          note(stems.guitar, rate, at, (span / eighths) * 1.6, midi, 0.2, rand, { harmonics: 7, decay: 4 });
        }
      }
      // Melodía con notas de paso que no siempre son del acorde.
      if (melody) {
        for (let b = 0; b < Math.max(1, hits); b++) {
          const passing = rand() < 0.35;
          const pc = passing ? (info.root + [2, 5, 9][Math.floor(rand() * 3)]) % 12 : info.tones[Math.floor(rand() * 3)];
          const midi = 72 + ((pc - 72) % 12 + 12) % 12;
          note(stems.lead, rate, start + b * (span / hits), (span / hits) * 0.8, midi, 0.14, rand, { harmonics: 4, decay: 1.2 });
        }
      }
    });
    // Batería: bombo en 1 y 3, caja en 2 y 4, hi-hat a corcheas.
    for (let b = 0; b < beats; b++) {
      const tb = t0 + (b * barSec) / beats;
      if (b % 2 === 0) noiseBurst(stems.drums, rate, tb, 0.18, 0.7, rand, { low: true });
      else noiseBurst(stems.drums, rate, tb, 0.14, 0.35, rand);
      noiseBurst(stems.drums, rate, tb, 0.04, 0.12, rand);
      noiseBurst(stems.drums, rate, tb + barSec / beats / 2, 0.04, 0.1, rand);
    }
  });
  const floor = new Float32Array(length);
  for (let i = 0; i < length; i++) floor[i] = (rand() * 2 - 1) * 0.0008;
  const mix = new Float32Array(length);
  for (const name of Object.keys(stems)) for (let i = 0; i < length; i++) mix[i] += stems[name][i];
  for (let i = 0; i < length; i++) mix[i] += floor[i];
  let top = 0;
  for (let i = 0; i < length; i++) top = Math.max(top, Math.abs(mix[i]));
  const gain = top > 0 ? 0.9 / top : 1;
  for (const name of [...Object.keys(stems), 'mix']) { const arr = name === 'mix' ? mix : stems[name]; for (let i = 0; i < length; i++) arr[i] *= gain; }
  const starts = Array.from({ length: bars.length + silentBars }, (_, n) => n * barSec);
  return { rate, bpm, beats, barSec, slots: beats === 3 ? 3 : 4, duration: length / rate, bars: starts, truth, sections, stems: { ...stems, mix }, silentBars };
}

// Estructura tal como la entrega ui/cifrado.js: { bars, duration, sections: [{ n, b }] }.
export const songInfo = song => ({ bars: song.bars, duration: song.duration, sections: song.sections });

// WAV de 16 bits. Con `channels` = 2 escribe el mismo audio en los dos canales (estéreo).
export function wavBytes(samples, rate, channels = 1) {
  const bytes = new Uint8Array(44 + samples.length * 2 * channels);
  const view = new DataView(bytes.buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2 * channels, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2 * channels, true); view.setUint16(32, 2 * channels, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2 * channels, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i])) * 32767;
    for (let c = 0; c < channels; c++) view.setInt16(44 + (i * channels + c) * 2, value, true);
  }
  return bytes;
}

// Progresiones de prueba.
export const SONGS = {
  sol: {
    bpm: 96,
    plan: [
      { name: 'Intro', bars: ['G', 'G'] },
      { name: 'Verso', bars: ['G', 'D', 'Em', 'C', 'G', 'D', 'C', 'C'] },
      { name: 'Coro', bars: ['C', 'G', 'D', 'Em', 'C', 'G', 'D', 'D'] },
      { name: 'Verso', bars: ['G', 'D', 'Em', 'C', 'G', 'D', 'C', 'C'] },
      { name: 'Coro', bars: ['C', 'G', 'D', 'Em', 'C', 'G', 'D', 'G'] },
    ],
  },
  lam: {
    bpm: 84,
    plan: [
      { name: 'Verso', bars: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'E'] },
      { name: 'Coro', bars: ['F', 'C', 'G', 'Am', 'F', 'C', 'E', 'Am'] },
      { name: 'Verso', bars: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'E'] },
    ],
  },
  sib: {
    bpm: 110,
    plan: [
      { name: 'Verso', bars: ['Bb', 'Gm', 'Eb', 'F', 'Bb', 'Gm', 'Eb', 'F'] },
      { name: 'Coro', bars: ['Eb', 'Bb', 'F', 'Gm', 'Eb', ['Bb', 'F'], 'Gm', 'F'] },
    ],
  },
  dos: {
    bpm: 90,
    plan: [
      { name: 'A', bars: [['C', 'G'], ['Am', 'F'], ['C', 'G'], ['F', 'C'], ['D', 'A'], ['Bm', 'G'], ['D', 'A'], ['G', 'D']] },
    ],
  },
  jazz: {
    bpm: 80,
    plan: [
      { name: 'Verso', bars: ['Cmaj7', 'Am7', 'Dm7', 'G7', 'Cmaj7', 'Am7', 'Dm7', 'G7'] },
      { name: 'Coro', bars: ['Fmaj7', 'Em7', 'Dm7', 'G7', 'Cmaj7', 'Am7', 'Dm7', 'G7'] },
    ],
  },
  vals: {
    bpm: 108,
    beats: 3,
    plan: [
      { name: 'Verso', bars: ['G', 'C', ['G', 'G', 'D'], 'G', 'Em', 'C', ['D', 'D', 'G'], 'G'] },
      { name: 'Coro', bars: ['C', 'G', 'D', 'G', 'C', ['G', 'D', 'D'], 'G', 'G'] },
    ],
  },
  ritmo: {
    bpm: 128,
    plan: [
      { name: 'Verso', bars: ['E', 'B', 'C#m', 'A', 'E', 'B', 'A', 'A'] },
      { name: 'Coro', bars: ['A', 'E', 'B', 'C#m', 'A', 'E', 'B', 'B'] },
    ],
  },
};
