// Detección automática de acordes: escucha las pistas de la canción y escribe el cifrado en el mismo
// formato que se edita a mano (ver chart.js). Es un borrador para revisar, no una verdad.
//
// Cómo funciona, en corto:
//  1. Audio → espectro (FFT de ~0.4 s) → «cromagrama»: cuánta energía hay en cada una de las 12 notas.
//     Se guarda con 5 casillas por semitono para poder corregir después una afinación distinta de La = 440 Hz.
//  2. Los cuadros se reparten en cuartos de compás con la rejilla de compases de Escena.
//  3. Cada cuarto se compara con plantillas de acordes mayor y menor; el bajo ayuda a decidir la raíz.
//     Con «extended», al final se revisa cada acorde: si la 7ª suena con claridad se escribe 7, m7 o maj7.
//  4. Un Viterbi elige la secuencia más probable: los acordes tienden a durar y cambian sobre el tiempo
//     fuerte del compás. Las secciones que se repiten se apoyan entre sí.
//  5. Se estima el tono, se repite el Viterbi favoreciendo los acordes del tono y se escribe el texto.
//
// Es matemática pura: no usa DOM. Solo `LiveListener` y `decodeToMono` tocan Web Audio, y solo en el navegador.
import { prefersFlats } from './chart.js';

export const SLOTS = 4; // partes de cada compás que se analizan por separado (por defecto, cuartos)
export const FINE = 5; // casillas por semitono en el cromagrama fino
const NFINE = 12 * FINE;

const NOTE_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const TYPES = [
  { id: 'maj', suffix: '', base: 'maj', tones: { 0: 1, 4: 0.9, 7: 0.9 } },
  { id: 'min', suffix: 'm', base: 'min', tones: { 0: 1, 3: 0.9, 7: 0.9 } },
];

const TEMPLATES = TYPES.map(type => Array.from({ length: 12 }, (_, root) => {
  const t = new Float32Array(12);
  for (const [interval, weight] of Object.entries(type.tones)) t[(root + Number(interval)) % 12] = weight;
  let norm = 0;
  for (const v of t) norm += v * v;
  norm = Math.sqrt(norm);
  for (let i = 0; i < 12; i++) t[i] /= norm;
  return t;
}));

const BASS_WEIGHT = 0.12; // cuánto pesa que el bajo toque la raíz
// Coste de cambiar de acorde en cada parte del compás: lo más barato en el tiempo fuerte, y algo menos a la mitad.
const lambdaFor = n => Array.from({ length: n }, (_, i) => (i === 0 ? 0.12 : n % 2 === 0 && i === n / 2 ? 0.18 : n % 2 === 0 ? 0.35 : 0.32));

// En cuántas partes iguales dividir un compás según su numerador (4/4 → 4, 3/4 → 3, 6/8 → 2, 9/8 → 3, 12/8 → 4…).
export function meterSlots(beats) {
  const n = Math.round(Number(beats)) || 4;
  if (n === 6) return 2;
  if (n === 9) return 3;
  if (n === 12) return 4;
  return n >= 2 && n <= 5 ? n : 4;
}
const KEY_BONUS = 0.08; // ventaja de los acordes que pertenecen al tono
const SILENCE = 0.2; // por debajo de este nivel (respecto al 90 % de la canción) se considera silencio
const DOUBT = 0.05; // margen mínimo para dar un compás por seguro
const VOTE_BONUS = 0.12; // apoyo que recibe, en una sección repetida, el acorde que eligieron las otras veces
const TUNING_MIN = 0.15; // concentración mínima de las notas para fiarse de la afinación estimada
// Umbrales (respecto a la media de raíz, tercera y quinta) para dar por buena una 7ª. Las armónicas de una triada
// ya dejan energía en esas notas (hasta ~0.7 en la maj7 y ~0.5 en la m7), así que se exige bastante más.
const SEVENTH = { dominant: 0.4, minor: 0.68, major: 0.95, sus: 0.7, susThird: 0.35 };
 // concentración mínima de las notas para fiarse de la afinación estimada

const yieldNow = () => new Promise(resolve => setTimeout(resolve, 0));

// ───────── Qué pistas sirven para detectar acordes ─────────
// Según el nombre: el bajo marca la raíz, las pistas armónicas dan el acorde, y se dejan fuera la
// percusión, las voces, el click y la guía.
const NOT_BASS = /bass\s*drum|kick|bombo/i;
const BASS = /\bbass\b|\bbajo\b|\bsub\b|contrabaj/i;
const SKIP = /click|metr[oó]nomo|gu[ií]a|guide|\bcue\b|count|bater[ií]a|drum|\bkick\b|bombo|snare|redoblante|\bcaja\b|\bhats?\b|hi-?hat|platillo|cymbal|percus|\bperc\b|shaker|pandero|tamb|\bloops?\b|\bvox\b|\bvoz\b|voces|vocal|\bcoros?\b|\bbv\b|backing|cantante|singer|choir|\bfx\b|efecto|sfx/i;

export function classifyTrack(name = '') {
  const text = String(name);
  if (NOT_BASS.test(text)) return 'skip';
  if (BASS.test(text)) return 'bass';
  if (SKIP.test(text)) return 'skip';
  return 'harm';
}

// ───────── FFT ─────────
const plans = new Map();
function plan(n) {
  let found = plans.get(n);
  if (found) return found;
  const levels = Math.round(Math.log2(n));
  if (1 << levels !== n) throw new Error('FFT: el tamaño debe ser una potencia de 2');
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  found = { n, rev, cos, sin };
  plans.set(n, found);
  return found;
}

// Transformada de Fourier directa, en el sitio. `re` e `im` deben tener un tamaño potencia de 2.
export function fft(re, im) {
  const { n, rev, cos, sin } = plan(re.length);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cos[w] - im[b] * sin[w];
        const ti = re[b] * sin[w] + im[b] * cos[w];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// Reduce la frecuencia de muestreo a ~22 kHz con un filtro paso bajo (ventana de Blackman).
// `cancelled` se consulta de vez en cuando; en ese caso devuelve null.
export async function decimate(samples, rate, target = 22050, { cancelled } = {}) {
  const factor = Math.max(1, Math.round(rate / target));
  if (factor === 1) return { data: samples, rate };
  const taps = factor * 16 + 1;
  const mid = (taps - 1) / 2;
  const cutoff = 0.45 / factor;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const win = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * win;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const length = Math.floor(samples.length / factor);
  const out = new Float32Array(length);
  const chunk = 1 << 18;
  for (let from = 0; from < length; from += chunk) {
    if (from > 0) await yieldNow();
    if (cancelled?.()) return null;
    const to = Math.min(length, from + chunk);
    for (let i = from; i < to; i++) {
      const centre = i * factor - mid;
      let acc = 0;
      if (centre >= 0 && centre + taps <= samples.length) {
        for (let k = 0; k < taps; k++) acc += h[k] * samples[centre + k];
      } else {
        for (let k = 0; k < taps; k++) { const at = centre + k; if (at >= 0 && at < samples.length) acc += h[k] * samples[at]; }
      }
      out[i] = acc;
    }
  }
  return { data: out, rate: rate / factor };
}

// Un AudioBuffer (o algo con su forma) → un solo canal a ~22 kHz.
export async function bufferToMono(buffer, options) {
  const channels = buffer.numberOfChannels || 1;
  const first = buffer.getChannelData(0);
  let mono = first;
  if (channels > 1) {
    mono = new Float32Array(first.length);
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / channels;
    }
  }
  return decimate(mono, buffer.sampleRate, 22050, options);
}

// ───────── Espectro → cromagrama fino ─────────
const TREBLE_LO = 130;
const TREBLE_HI = 3200;
const BASS_LO = 45;
const BASS_HI = 260;

// `mags`: magnitudes lineales de un espectro de 0 a Nyquist; `binHz`: ancho de cada casilla. Llena `treble`
// (130 Hz–3.2 kHz) y `bass` (45–260 Hz), de 5 casillas por semitono, con la energía de los picos del espectro
// y devuelve la energía total de la zona aguda. Solo cuentan los picos que sobresalen de su entorno, así el ruido
// y los golpes de percusión casi no aportan.
export function spectrumToFine(mags, binHz, treble, bass, scratch) {
  treble.fill(0);
  bass.fill(0);
  const n = mags.length;
  const kLo = Math.max(2, Math.floor(BASS_LO / binHz));
  const kHi = Math.min(n - 2, Math.ceil(TREBLE_HI / binHz));
  if (kHi <= kLo + 4) return 0;
  const sums = scratch && scratch.length >= n + 1 ? scratch : new Float64Array(n + 1);
  sums[0] = 0;
  for (let k = 0; k < n; k++) sums[k + 1] = sums[k] + mags[k];
  let top = 0;
  for (let k = kLo; k <= kHi; k++) if (mags[k] > top) top = mags[k];
  if (!(top > 1e-9)) return 0;
  const floor = top * 0.003;
  let energy = 0;
  for (let k = kLo; k <= kHi; k++) {
    const m = mags[k];
    if (m <= floor || m <= mags[k - 1] || m < mags[k + 1]) continue;
    const reach = Math.max(3, Math.round(k * 0.1));
    const lo = Math.max(0, k - reach);
    const hi = Math.min(n - 1, k + reach);
    const env = (sums[hi + 1] - sums[lo]) / (hi - lo + 1);
    if (m < 1.8 * env) continue;
    const a = Math.log(mags[k - 1] + 1e-12);
    const b = Math.log(m);
    const c = Math.log(mags[k + 1] + 1e-12);
    const denom = a - 2 * b + c;
    const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    const freq = (k + shift) * binHz;
    const pitch = 69 + 12 * Math.log2(freq / 440);
    const at = (((pitch % 12) + 12) % 12) * FINE;
    const i0 = Math.floor(at);
    const frac = at - i0;
    const weight = Math.sqrt(m);
    if (freq >= TREBLE_LO && freq <= TREBLE_HI) {
      treble[i0 % NFINE] += weight * (1 - frac);
      treble[(i0 + 1) % NFINE] += weight * frac;
      energy += weight;
    }
    if (freq >= BASS_LO && freq <= BASS_HI) {
      bass[i0 % NFINE] += weight * (1 - frac);
      bass[(i0 + 1) % NFINE] += weight * frac;
    }
  }
  return energy;
}

// Cuadros de cromagrama en el tiempo. `half`: medio ancho (s) que representa cada cuadro; `hop`: separación (s).
export class FrameBuffer {
  constructor({ half, hop, capacity = 1024 }) {
    this.half = half;
    this.hop = hop;
    this.count = 0;
    this.t = new Float32Array(capacity);
    this.energy = new Float32Array(capacity);
    this.treble = new Float32Array(capacity * NFINE);
    this.bass = new Float32Array(capacity * NFINE);
  }

  push(t, treble, bass, energy) {
    if (this.count === this.t.length) this.grow();
    const i = this.count++;
    this.t[i] = t;
    this.energy[i] = energy;
    this.treble.set(treble, i * NFINE);
    this.bass.set(bass, i * NFINE);
  }

  grow() {
    const size = Math.max(16, this.t.length * 2);
    const bigger = (old, per) => { const next = new Float32Array(size * per); next.set(old); return next; };
    this.t = bigger(this.t, 1);
    this.energy = bigger(this.energy, 1);
    this.treble = bigger(this.treble, NFINE);
    this.bass = bigger(this.bass, NFINE);
  }
}

const hann = size => Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
const windowFor = rate => 2 ** Math.ceil(Math.log2(0.3 * rate));

// Audio mono → cuadros de cromagrama. Ventana de ~0.35 s, un cuadro cada cuarto de ventana.
export async function analyzePCM(samples, rate, { onProgress, cancelled } = {}) {
  const size = windowFor(rate);
  const hop = size / 4;
  const total = Math.max(0, Math.floor((samples.length - size) / hop) + 1);
  const frames = new FrameBuffer({ half: size / (4 * rate), hop: hop / rate, capacity: total + 4 });
  const window = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const mags = new Float32Array(size / 2 + 1);
  const scratch = new Float64Array(size / 2 + 2);
  const treble = new Float32Array(NFINE);
  const bass = new Float32Array(NFINE);
  const binHz = rate / size;
  for (let f = 0; f < total; f++) {
    const start = f * hop;
    for (let i = 0; i < size; i++) { re[i] = samples[start + i] * window[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) mags[k] = (Math.sqrt(re[k] * re[k] + im[k] * im[k]) * 2) / size;
    frames.push((start + size / 2) / rate, treble, bass, spectrumToFine(mags, binHz, treble, bass, scratch));
    if ((f & 31) === 31) {
      onProgress?.(f / total);
      await yieldNow();
      if (cancelled?.()) return null;
    }
  }
  onProgress?.(1);
  return frames;
}

// Une el cromagrama agudo de unas pistas con el grave de otras (por ejemplo, las armónicas y el bajo).
export function mergeFrames(trebleFrames, bassFrames) {
  const count = Math.min(trebleFrames.count, bassFrames.count);
  const out = new FrameBuffer({ half: trebleFrames.half, hop: trebleFrames.hop, capacity: count + 1 });
  out.count = count;
  out.t.set(trebleFrames.t.subarray(0, count));
  out.energy.set(trebleFrames.energy.subarray(0, count));
  out.treble.set(trebleFrames.treble.subarray(0, count * NFINE));
  out.bass.set(bassFrames.bass.subarray(0, count * NFINE));
  return out;
}

// Suma de pistas de un mismo tipo (armónicas, o bajo) ya en mono y a la misma frecuencia de muestreo.
export class PCMGroup {
  constructor() { this.data = null; this.rate = 0; this.count = 0; }

  add(samples, rate) {
    if (!this.data) { this.data = new Float32Array(samples.length); this.rate = rate; }
    else if (samples.length > this.data.length) { const bigger = new Float32Array(samples.length); bigger.set(this.data); this.data = bigger; }
    const data = this.data;
    for (let i = 0; i < samples.length; i++) data[i] += samples[i];
    this.count++;
  }
}

export async function framesFromGroups({ harm, bass }, options = {}) {
  const both = Boolean(harm?.data && bass?.data);
  const part = (from, to) => (options.onProgress ? { ...options, onProgress: p => options.onProgress(from + p * (to - from)) } : options);
  const treble = harm?.data ? await analyzePCM(harm.data, harm.rate, part(0, both ? 0.5 : 1)) : null;
  if (harm?.data && !treble) return null;
  const low = bass?.data ? await analyzePCM(bass.data, bass.rate, part(both ? 0.5 : 0, 1)) : null;
  if (bass?.data && !low) return null;
  if (treble && low) return mergeFrames(treble, low);
  return treble || low;
}

// ───────── Afinación ─────────
// Las notas de una grabación no siempre caen en La = 440 Hz. Se mide cuánto se apartan, en promedio, de la
// rejilla de semitonos (media circular) y se corrige antes de repartir la energía entre las 12 notas.
export function estimateTuning(frames) {
  let c = 0;
  let s = 0;
  let total = 0;
  for (let f = 0; f < frames.count; f++) {
    for (let i = 0; i < NFINE; i++) {
      const w = frames.treble[f * NFINE + i] + frames.bass[f * NFINE + i];
      if (!(w > 0)) continue;
      const angle = (2 * Math.PI * (i % FINE)) / FINE;
      c += w * Math.cos(angle);
      s += w * Math.sin(angle);
      total += w;
    }
  }
  if (!(total > 0) || Math.hypot(c, s) / total < TUNING_MIN) return 0;
  return Math.atan2(s, c) / (2 * Math.PI);
}

// Cromagrama fino → 12 notas, ya con la afinación corregida. Devuelve { treble, bass } de `count * 12`.
export function foldFrames(frames, tune = 0) {
  const out = { treble: new Float64Array(frames.count * 12), bass: new Float64Array(frames.count * 12) };
  const where = Array.from({ length: NFINE }, (_, i) => {
    let at = i / FINE - tune;
    at = ((at % 12) + 12) % 12;
    const i0 = Math.floor(at);
    return { i0: i0 % 12, i1: (i0 + 1) % 12, frac: at - i0 };
  });
  for (const [source, target] of [[frames.treble, out.treble], [frames.bass, out.bass]]) {
    for (let f = 0; f < frames.count; f++) {
      for (let i = 0; i < NFINE; i++) {
        const w = source[f * NFINE + i];
        if (!(w > 0)) continue;
        const spot = where[i];
        target[f * 12 + spot.i0] += w * (1 - spot.frac);
        target[f * 12 + spot.i1] += w * spot.frac;
      }
    }
  }
  return out;
}

// ───────── Cuadros → compases y acordes ─────────
// Bordes (s) de cada cuarto de compás: `bars` trae el inicio de cada compás.
export function slotEdges(song, n = SLOTS) {
  const bars = song.bars || [];
  const edges = [];
  for (let i = 0; i < bars.length; i++) {
    const a = bars[i];
    // El último compás dura lo mismo que el anterior; lo que suene después (la cola) no cuenta como compás.
    const b = i + 1 < bars.length ? bars[i + 1] : a + (i > 0 ? a - bars[i - 1] : Math.max(0.5, (song.duration || a + 2) - a));
    for (let j = 0; j < n; j++) edges.push(a + ((b - a) * j) / n);
    if (i + 1 === bars.length) edges.push(b);
  }
  return edges;
}

function firstAfter(edges, value) {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Reparte cada cuadro entre los cuartos de compás que toca, en proporción a cuánto se solapan.
function accumulate(frames, folded, edges) {
  const S = edges.length - 1;
  const X = new Float64Array(S * 12);
  const B = new Float64Array(S * 12);
  const W = new Float64Array(S);
  const En = new Float64Array(S);
  for (let f = 0; f < frames.count; f++) {
    const a = frames.t[f] - frames.half;
    const b = frames.t[f] + frames.half;
    let s = Math.max(0, firstAfter(edges, a) - 1);
    for (; s < S && edges[s] < b; s++) {
      const lo = Math.max(a, edges[s]);
      const hi = Math.min(b, edges[s + 1]);
      if (hi <= lo) continue;
      const w = (hi - lo) / (2 * frames.half);
      for (let c = 0; c < 12; c++) {
        X[s * 12 + c] += w * folded.treble[f * 12 + c];
        B[s * 12 + c] += w * folded.bass[f * 12 + c];
      }
      En[s] += w * frames.energy[f];
      W[s] += w;
    }
  }
  return { X, B, W, En, S };
}

const norm = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const baseName = text => norm(text).replace(/\s+(\d+|i|ii|iii|iv|v)$/, '');

// Secciones con el mismo nombre base y la misma duración: sus cuartos de compás se corresponden.
function repeatGroups(song, n) {
  const sections = song.sections || [];
  const total = (song.bars || []).length;
  const groups = new Map();
  sections.forEach((s, i) => {
    const end = sections[i + 1] ? sections[i + 1].b : total + 1;
    const slots = Math.max(0, end - s.b) * n;
    if (!slots) return;
    const key = `${baseName(s.n)}|${slots}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ start: (s.b - 1) * n, slots });
  });
  return [...groups.values()].filter(list => list.length > 1);
}

// En las secciones que se repiten, cada vez recibe un apoyo para el acorde que eligieron las otras. Es un
// voto, no un promedio: promediar las puntuaciones inventa acordes intermedios (entre D y G sale Bm).
function support(E, valid, K, groups, S) {
  const best = new Int16Array(S).fill(-1);
  for (let s = 0; s < S; s++) {
    if (!valid[s]) continue;
    let top = 0;
    for (let k = 1; k < K; k++) if (E[s * K + k] > E[s * K + top]) top = k;
    best[s] = top;
  }
  const bonus = new Float32Array(S * K);
  for (const list of groups) {
    for (let rel = 0; rel < list[0].slots; rel++) {
      const at = list.map(item => item.start + rel).filter(s => s < S && best[s] >= 0);
      if (at.length < 2) continue;
      for (const s of at) {
        for (const other of at) if (other !== s) bonus[s * K + best[other]] += VOTE_BONUS / (at.length - 1);
      }
    }
  }
  for (let i = 0; i < bonus.length; i++) E[i] += bonus[i];
}

// Viterbi con coste de cambio uniforme (modelo de Potts): quedarse en un acorde es gratis; cambiar cuesta
// LAMBDA según el cuarto del compás. Los cuartos no válidos (silencio) no aportan nada y mantienen el acorde.
function viterbi(E, valid, S, K, lambda) {
  const delta = new Float64Array(K);
  const next = new Float64Array(K);
  const back = new Int16Array(S * K);
  for (let s = 0; s < S; s++) {
    let best = 0;
    for (let k = 1; k < K; k++) if (delta[k] > delta[best]) best = k;
    const jump = delta[best] - lambda[s % lambda.length];
    for (let k = 0; k < K; k++) {
      const stay = delta[k];
      const keep = s === 0 || stay >= jump;
      back[s * K + k] = keep ? k : best;
      next[k] = (s === 0 ? 0 : keep ? stay : jump) + (valid[s] ? E[s * K + k] : 0);
    }
    delta.set(next);
  }
  let state = 0;
  for (let k = 1; k < K; k++) if (delta[k] > delta[state]) state = k;
  const path = new Int16Array(S);
  for (let s = S - 1; s >= 0; s--) { path[s] = state; state = back[s * K + state]; }
  return path;
}

// ───────── Tono ─────────
const MAJOR_DEGREES = { maj: [0, 5, 7], min: [2, 4, 9] };
const MINOR_DEGREES = { maj: [3, 8, 10], min: [0, 5, 7] };

// 1 si el acorde es de la armadura del tono (I, IV, V, ii, iii, vi en mayor; i, iv, v, III, VI, VII en menor).
function fit(tonic, minor, root, type) {
  const rel = (root - tonic + 12) % 12;
  if ((minor ? MINOR_DEGREES : MAJOR_DEGREES)[type.base].includes(rel)) return 1;
  if (minor && type.base === 'maj' && rel === 7) return 1; // V mayor del menor armónico
  return 0;
}

function estimateKey(path, valid, kinds) {
  const counts = new Map();
  let total = 0;
  for (let s = 0; s < path.length; s++) {
    if (!valid[s]) continue;
    const state = path[s];
    const key = `${kinds[Math.floor(state / 12)]}:${state % 12}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    total++;
  }
  if (!total) return null;
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      let score = 0;
      for (const [key, count] of counts) {
        const [ti, root] = key.split(':').map(Number);
        const type = TYPES[ti];
        const f = fit(tonic, minor, root, type);
        score += count * (f > 0 ? f : -0.4);
        if (root === tonic && type.base === (minor ? 'min' : 'maj')) score += 1.5 * count;
        if (root === (tonic + 7) % 12 && type.base !== 'sus') score += 0.6 * count;
      }
      score /= total;
      if (!best || score > best.score + 1e-9) best = { tonic, minor, score };
    }
  }
  return best;
}

// ───────── Salida: texto del cifrado ─────────
function symbolOf(state, kinds, flats, upgrade = '') {
  if (state < 0) return '';
  const type = TYPES[kinds[Math.floor(state / 12)]];
  return (flats ? NOTE_FLAT : NOTE_SHARP)[state % 12] + (upgrade || type.suffix);
}

// Revisa cada acorde (tramo de cuartos seguidos con la misma triada) y mira si la 7ª o la 4ª suenan con claridad.
function seventhPass(states, X, valid, kinds) {
  const S = states.length;
  const suffix = new Array(S).fill('');
  for (let s = 0; s < S;) {
    if (states[s] < 0) { s++; continue; }
    let e = s;
    while (e + 1 < S && states[e + 1] === states[s]) e++;
    const sum = new Float64Array(12);
    for (let i = s; i <= e; i++) if (valid[i]) for (let c = 0; c < 12; c++) sum[c] += X[i * 12 + c];
    const type = TYPES[kinds[Math.floor(states[s] / 12)]];
    const root = states[s] % 12;
    const minor = type.base === 'min';
    const third = (root + (minor ? 3 : 4)) % 12;
    const ref = (sum[root] + sum[third] + sum[(root + 7) % 12]) / 3;
    let up = '';
    if (ref > 0) {
      const flat7 = sum[(root + 10) % 12] / ref;
      const major7 = sum[(root + 11) % 12] / ref;
      if (sum[third] / ref < SEVENTH.susThird && sum[(root + 5) % 12] / ref > SEVENTH.sus) up = 'sus4';
      else if (minor) { if (flat7 > SEVENTH.minor) up = 'm7'; }
      else if (flat7 > SEVENTH.dominant && flat7 >= major7) up = '7';
      else if (major7 > SEVENTH.major) up = 'maj7';
    }
    if (up) for (let i = s; i <= e; i++) suffix[i] = up;
    s = e + 1;
  }
  return suffix;
}

// Las partes de un compás → el texto del compás: «G», «C G», «C . . D»… Se escribe con las menos partes posibles:
// si cada mitad (o tercio…) empieza con un acorde y lo sostiene, basta con un acorde por mitad (o tercio…).
export function barText(symbols) {
  const n = symbols.length;
  if (symbols.every(sym => !sym)) return '';
  const tokens = symbols.map((sym, i) => (!sym || (i > 0 && sym === symbols[i - 1]) ? '.' : sym));
  for (let parts = 1; parts < n; parts++) {
    if (n % parts) continue;
    const size = n / parts;
    let simple = true;
    for (let i = 0; i < n && simple; i++) if (i % size && tokens[i] !== '.') simple = false;
    if (simple) return tokens.filter((t, i) => i % size === 0).join(' ');
  }
  return tokens.join(' ');
}

// Detección completa. `frames`: FrameBuffer; `song`: { bars, duration, sections: [{ n, b }] } como el de cifrado.js.
// Devuelve { text, key, bars: [{ slots, symbols, text, margin }], uncertain: [número de compás…], covered,
// confidence, tuning } o null si no hay nada que analizar.
export function detectChart(frames, song, { extended = false, unifyRepeats = true, slots = SLOTS } = {}) {
  const n = Math.max(2, Math.min(8, Math.round(slots) || SLOTS));
  const edges = slotEdges(song, n);
  const S = edges.length - 1;
  if (S < 1 || !frames || !frames.count) return null;
  const kinds = TYPES.map((type, i) => i);
  const K = kinds.length * 12;
  const tuning = estimateTuning(frames);
  const acc = accumulate(frames, foldFrames(frames, tuning), edges);

  const level = new Float64Array(S);
  const cover = new Float64Array(S);
  for (let s = 0; s < S; s++) {
    const expected = (edges[s + 1] - edges[s]) / frames.hop;
    level[s] = acc.En[s] / expected;
    cover[s] = acc.W[s] / expected;
  }
  const heard = Array.from(level).filter((v, s) => cover[s] > 0.3).sort((a, b) => a - b);
  const reference = heard.length ? heard[Math.floor(heard.length * 0.9)] : 0;
  if (!(reference > 0)) return null;
  const valid = new Uint8Array(S);
  for (let s = 0; s < S; s++) valid[s] = cover[s] > 0.3 && level[s] > reference * SILENCE ? 1 : 0;

  const E = new Float32Array(S * K);
  for (let s = 0; s < S; s++) {
    if (!valid[s]) continue;
    let sq = 0;
    for (let c = 0; c < 12; c++) sq += acc.X[s * 12 + c] ** 2;
    if (!(sq > 0)) { valid[s] = 0; continue; }
    const inv = 1 / Math.sqrt(sq);
    let bassTop = 0;
    for (let c = 0; c < 12; c++) bassTop = Math.max(bassTop, acc.B[s * 12 + c]);
    for (let a = 0; a < kinds.length; a++) {
      for (let root = 0; root < 12; root++) {
        const template = TEMPLATES[kinds[a]][root];
        let dot = 0;
        for (let c = 0; c < 12; c++) dot += acc.X[s * 12 + c] * inv * template[c];
        const bass = bassTop > 0 ? acc.B[s * 12 + root] / bassTop : 0;
        E[s * K + a * 12 + root] = dot + BASS_WEIGHT * bass;
      }
    }
  }
  const lambda = lambdaFor(n);
  if (unifyRepeats) support(E, valid, K, repeatGroups(song, n), S);

  let path = viterbi(E, valid, S, K, lambda);
  const key = estimateKey(path, valid, kinds);
  if (key) {
    for (let s = 0; s < S; s++) {
      if (!valid[s]) continue;
      for (let a = 0; a < kinds.length; a++) {
        const type = TYPES[kinds[a]];
        for (let root = 0; root < 12; root++) if (fit(key.tonic, key.minor, root, type) >= 1) E[s * K + a * 12 + root] += KEY_BONUS;
      }
    }
    path = viterbi(E, valid, S, K, lambda);
  }

  // Antes del primer sonido y después del último no hay acorde; en medio, el silencio mantiene el anterior.
  let first = 0;
  while (first < S && !valid[first]) first++;
  let last = S - 1;
  while (last >= 0 && !valid[last]) last--;
  const keyText = key ? `${NOTE_SHARP[key.tonic]}${key.minor ? 'm' : ''}` : '';
  const flats = key ? prefersFlats(keyText, 0) : false;
  const states = Array.from(path, (state, s) => (s < first || s > last ? -1 : state));
  const upgrades = extended ? seventhPass(states, acc.X, valid, kinds) : new Array(S).fill('');

  const bars = [];
  const doubtful = [];
  const barCount = Math.floor(S / n);
  let marginSum = 0;
  for (let bar = 0; bar < barCount; bar++) {
    const symbols = [];
    let margin = 0;
    let counted = 0;
    for (let j = 0; j < n; j++) {
      const s = bar * n + j;
      symbols.push(symbolOf(states[s], kinds, flats, upgrades[s]));
      if (valid[s] && states[s] >= 0) {
        let other = -Infinity;
        for (let k = 0; k < K; k++) if (k !== states[s] && E[s * K + k] > other) other = E[s * K + k];
        margin += E[s * K + states[s]] - other;
        counted++;
      }
    }
    margin = counted ? margin / counted : 0;
    marginSum += margin;
    if (counted && margin < DOUBT) doubtful.push(bar + 1);
    bars.push({ slots: states.slice(bar * n, bar * n + n), symbols, text: barText(symbols), margin });
  }

  const sections = song.sections && song.sections.length ? song.sections : [{ n: 'Cifrado', b: 1 }];
  const blocks = sections.map((s, i) => {
    const end = sections[i + 1] ? sections[i + 1].b : barCount + 1;
    const own = bars.slice(s.b - 1, Math.max(s.b - 1, end - 1));
    const rows = [];
    for (let k = 0; k < own.length; k += 4) rows.push(`| ${own.slice(k, k + 4).map(bar => (bar.text || '').padEnd(6)).join(' | ')} |`);
    return { name: s.n, body: rows.join('\n') };
  });
  // Una sección que se repite con el mismo nombre y exactamente el mismo texto se escribe una sola vez.
  const occurrences = new Map();
  for (const block of blocks) occurrences.set(norm(block.name), [...(occurrences.get(norm(block.name)) || []), block.body]);
  const written = new Set();
  const kept = [];
  for (const block of blocks) {
    const all = occurrences.get(norm(block.name));
    if (all.length > 1 && all.every(body => body === all[0])) {
      if (written.has(norm(block.name))) continue;
      written.add(norm(block.name));
    }
    kept.push(block);
  }
  const keyLine = key ? `Tono: ${flats ? NOTE_FLAT[key.tonic] : NOTE_SHARP[key.tonic]}${key.minor ? 'm' : ''}` : '';
  const text = [keyLine, ...kept.map(block => `[${block.name}]\n${block.body}`)].filter(Boolean).join('\n\n');
  const heardBars = new Set();
  for (let s = 0; s < S; s++) if (cover[s] > 0.3) heardBars.add(Math.floor(s / n));
  return {
    text,
    key: key ? { tonic: key.tonic, minor: key.minor, text: `${flats ? NOTE_FLAT[key.tonic] : NOTE_SHARP[key.tonic]}${key.minor ? 'm' : ''}` } : null,
    bars,
    uncertain: doubtful,
    covered: heardBars.size / Math.max(1, barCount),
    confidence: barCount ? marginSum / barCount : 0,
    tuning,
    slots: n,
  };
}

// ───────── Navegador: leer archivos y escuchar mientras suena ─────────
export async function decodeToMono(data, options = {}) {
  const bytes = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const context = new Offline(1, 1, 22050);
  const buffer = await new Promise((resolve, reject) => {
    const promise = context.decodeAudioData(bytes, resolve, reject);
    if (promise && promise.then) promise.then(resolve, reject);
  });
  return bufferToMono(buffer, options);
}

// Escucha las pistas de un reproductor de Escena mientras suena y junta cuadros de cromagrama. No cambia el
// audio: solo añade, mientras dura, una conexión de cada pista a un analizador que no suena.
export class LiveListener {
  // `roleOf(track)` puede devolver 'bass' para las pistas de bajo; si no se da, se decide por el nombre de la pista.
  constructor(player, { tracks, roleOf, interval = 60, onFrame } = {}) {
    this.player = player;
    this.tracks = tracks;
    this.roleOf = roleOf;
    this.interval = interval;
    this.onFrame = onFrame;
    this.frames = null;
    this.heard = new Set();
    this.taps = [];
    this.timer = 0;
    this.running = false;
  }

  start(song) {
    if (this.running) return;
    const ctx = this.player.ctx;
    this.song = song;
    this.sampleRate = ctx.sampleRate;
    this.fftSize = Math.min(32768, 2 ** Math.ceil(Math.log2(0.3 * this.sampleRate)));
    this.binHz = this.sampleRate / this.fftSize;
    this.frames = new FrameBuffer({ half: this.fftSize / (4 * this.sampleRate), hop: this.interval / 1000, capacity: 4096 });
    const groups = { harm: [], bass: [] };
    for (const track of this.tracks) groups[(this.roleOf ? this.roleOf(track) : classifyTrack(track.def?.name)) === 'bass' ? 'bass' : 'harm'].push(track);
    for (const role of ['harm', 'bass']) {
      if (!groups[role].length) continue;
      const mix = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = this.fftSize;
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -140;
      analyser.maxDecibels = 0;
      const silent = ctx.createGain();
      silent.gain.value = 0;
      mix.connect(analyser);
      analyser.connect(silent);
      silent.connect(ctx.destination);
      for (const track of groups[role]) track.level.connect(mix);
      this.taps.push({ role, mix, analyser, silent, tracks: groups[role], data: new Float32Array(analyser.frequencyBinCount) });
    }
    this.mags = new Float32Array(this.fftSize / 2 + 1);
    this.scratch = new Float64Array(this.fftSize / 2 + 2);
    this.treble = new Float32Array(NFINE);
    this.bass = new Float32Array(NFINE);
    this.lowOnly = new Float32Array(NFINE);
    this.rotatedTreble = new Float32Array(NFINE);
    this.rotatedBass = new Float32Array(NFINE);
    this.running = true;
    this.timer = setInterval(() => this.poll(), this.interval);
  }

  spectrum(tap) {
    tap.analyser.getFloatFrequencyData(tap.data);
    const mags = this.mags;
    for (let k = 0; k < tap.data.length; k++) {
      const db = tap.data[k];
      mags[k] = db > -139 ? 10 ** (db / 20) : 0;
    }
    mags[mags.length - 1] = 0;
    return mags;
  }

  // Si el tono está subido o bajado, las pistas suenan transportadas; se deshace al guardar para que el
  // cifrado quede en el tono original de la canción.
  static unshift(vector, semitones, into) {
    const shift = ((Math.round(semitones) % 12) + 12) % 12;
    for (let i = 0; i < NFINE; i++) into[(i - shift * FINE + NFINE) % NFINE] = vector[i];
    return into;
  }

  poll() {
    const player = this.player;
    if (!this.running || player.state !== 'playing') return;
    const live = typeof player.liveState === 'function' ? player.liveState() : null;
    if (live && live.wait > 0) return;
    const pos = live ? live.pos : player.position();
    const t = pos - this.fftSize / (2 * this.sampleRate);
    if (!(t >= 0)) return;
    const harm = this.taps.find(tap => tap.role === 'harm');
    const low = this.taps.find(tap => tap.role === 'bass');
    let energy = 0;
    this.treble.fill(0);
    this.bass.fill(0);
    if (harm) energy = spectrumToFine(this.spectrum(harm), this.binHz, this.treble, this.bass, this.scratch);
    if (low) {
      const lowEnergy = spectrumToFine(this.spectrum(low), this.binHz, this.lowOnly, this.bass, this.scratch);
      if (!harm) { this.treble.set(this.lowOnly); energy = lowEnergy; }
    }
    const moved = Math.round(player.pitchSemitones || 0);
    const affected = this.tracks.filter(track => track.def?.pitchEnabled !== false).length * 2 > this.tracks.length;
    if (moved && affected) {
      this.frames.push(t, LiveListener.unshift(this.treble, moved, this.rotatedTreble), LiveListener.unshift(this.bass, moved, this.rotatedBass), energy);
    } else {
      this.frames.push(t, this.treble, this.bass, energy);
    }
    const bars = this.song?.bars || [];
    let lo = 0;
    let hi = bars.length - 1;
    let index = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid] <= pos + 0.005) { index = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (index >= 0) this.heard.add(index);
    this.onFrame?.({ pos, bar: index + 1, heard: this.heard.size, total: bars.length, energy });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    for (const tap of this.taps) {
      for (const track of tap.tracks) { try { track.level.disconnect(tap.mix); } catch { /* ya desconectado */ } }
      try { tap.mix.disconnect(); tap.analyser.disconnect(); tap.silent.disconnect(); } catch { /* ya desconectado */ }
    }
    this.taps = [];
  }
}
