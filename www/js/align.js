// Herramientas para colocar la cuadrícula del compás sobre el audio real de una canción:
// pegar el compás 1 al golpe más cercano (imán), encontrar el primer golpe de la canción y afinar
// tempo e inicio con todos los golpes. No usan el DOM ni WebAudio: reciben los canales de audio
// (Float32Array) y la frecuencia de muestreo, así se pueden probar fuera del navegador.

import { fitLine, roundBpm } from './tempo.js';

// Un «golpe» es una subida brusca de la energía de los agudos (la diferencia entre muestras vecinas
// quita el bajo y el sonido sostenido, y deja el ataque de la batería, el click, una guitarra rasgueada…).
// La energía se mide cada milisegundo, en logaritmo, para que un golpe flojo sobre una mezcla fuerte
// cuente igual que uno fuerte sobre silencio.
const FLOOR = 1e-7; // energía por muestra por debajo de la cual todo es «silencio» (unos -75 dBFS)
const BEFORE = 8; // milisegundos de «antes» con los que se compara cada instante
const AFTER = 3; // milisegundos de «después»
const MIN_RISE = 0.8; // subida mínima de energía (logaritmo natural) para llamarlo golpe: algo más del doble
const PEAK_RADIUS = 8; // un golpe es el máximo de la subida en ±8 ms
const START_LEVEL = 6.5; // sin milisegundos anteriores (inicio del archivo) solo cuenta un sonido fuerte, no el ruido de fondo

const hopSize = (rate) => Math.max(1, Math.round(rate / 1000));

function longest(channels) {
  let length = 0;
  for (const data of channels) if (data.length > length) length = data.length;
  return length;
}

// Escribe en out[from..from+count) la energía (logaritmo) de cada milisegundo a partir de la muestra start.
function fillLogEnergies(out, offset, count, channels, hop, start) {
  for (let f = 0; f < count; f++) {
    const from = start + f * hop;
    let sum = 0;
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c];
      const end = Math.min(data.length, from + hop);
      if (from >= end) continue;
      let previous = from > 0 ? data[from - 1] : 0;
      for (let i = from; i < end; i++) {
        const value = data[i];
        const diff = value - previous;
        sum += diff * diff;
        previous = value;
      }
    }
    out[offset + f] = Math.log1p(sum / hop / FLOOR);
  }
}

// Subida de la energía en el marco j: lo que suben los AFTER marcos siguientes sobre los BEFORE anteriores.
function riseAt(l, j, firstValid) {
  if (j < firstValid) return 0;
  const n = l.length;
  const to = Math.min(n, j + AFTER);
  if (to <= j) return 0;
  let after = 0;
  for (let i = j; i < to; i++) after += l[i];
  after /= to - j;
  const from = Math.max(0, j - BEFORE);
  // Primer milisegundo del archivo: no hay nada con qué comparar. Un ruido de fondo que ya estaba ahí no es un
  // golpe; uno que arranca con fuerza (la música empieza en la muestra 0) sí.
  if (j === from) return after >= START_LEVEL ? after : 0;
  let before = 0;
  for (let i = from; i < j; i++) before += l[i];
  before /= j - from;
  const rise = after - before;
  return rise > 0 ? rise : 0;
}

function localMaximum(s, j, radius) {
  const value = s[j];
  const from = Math.max(0, j - radius);
  const to = Math.min(s.length - 1, j + radius);
  for (let i = from; i <= to; i++) {
    if (i === j) continue;
    if (s[i] > value || (s[i] === value && i < j)) return false;
  }
  return true;
}

// Muestra exacta en la que empieza a sonar un golpe cercano a la muestra approx: se busca el pico del
// ataque y se retrocede hasta donde el nivel de los agudos aún no llega al 12 % de ese pico sobre el fondo.
export function refineAttack(channels, rate, approx) {
  const ms = rate / 1000;
  const length = longest(channels);
  const low = Math.max(1, Math.round(approx - 28 * ms));
  const end = Math.min(length, Math.round(approx + 14 * ms));
  const fail = { sample: Math.max(0, Math.round(approx)), clear: false, peak: 0 };
  if (end - low < 16) return fail;
  const count = end - low;
  const raw = new Float32Array(count);
  for (const data of channels) {
    const top = Math.min(end, data.length);
    for (let i = low; i < top; i++) {
      const diff = data[i] - data[i - 1];
      raw[i - low] += diff * diff;
    }
  }
  const prefix = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i] + Math.sqrt(raw[i]);
  const w = Math.max(2, Math.round(0.1 * ms));
  const level = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(count, i + w + 1);
    level[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  const searchFrom = Math.max(0, Math.round(approx - 3 * ms) - low);
  const searchTo = Math.min(count, Math.round(approx + 12 * ms) - low);
  if (searchTo - searchFrom < 4) return fail;
  let peak = 0;
  let peakAt = searchFrom;
  for (let i = searchFrom; i < searchTo; i++) {
    if (level[i] > peak) {
      peak = level[i];
      peakAt = i;
    }
  }
  if (peak <= 0) return fail;
  // Fondo: el milisegundo más tranquilo del tramo anterior al golpe.
  const block = Math.max(2, Math.round(ms));
  let floor = Infinity;
  for (let a = 0; a + block <= searchFrom; a += block) {
    const mean = (prefix[a + block] - prefix[a]) / block;
    if (mean < floor) floor = mean;
  }
  if (!Number.isFinite(floor)) floor = 0;
  if (peak < 2 * floor) return fail;
  const gate = floor + 0.12 * (peak - floor);
  const hold = Math.max(2, Math.round(0.5 * ms));
  let start = peakAt;
  let quiet = 0;
  for (let i = peakAt - 1; i >= 0; i--) {
    if (level[i] >= gate) {
      start = i;
      quiet = 0;
    } else if (++quiet >= hold) break;
  }
  // Si hasta el borde de la ventana no hubo medio milisegundo de calma, no es un ataque limpio.
  if (start <= 1 && quiet < hold && low > 1) return fail;
  return { sample: low + start, clear: true, peak };
}

// Golpe más cercano a `time` (segundos) dentro de ±radius. Devuelve su instante exacto o null si no hay
// ningún golpe claro por ahí. «Claro» = al menos el 40 % de lo fuerte que es el mayor golpe de esa zona.
export function snapToHit(channels, rate, time, { radius = 0.04, minRise = MIN_RISE } = {}) {
  if (!channels.length) return null;
  const hop = hopSize(rate);
  const length = longest(channels);
  const centre = Math.round(time * rate);
  const reach = Math.max(hop, Math.round(radius * rate));
  const start = Math.max(0, centre - reach - (BEFORE + 1) * hop);
  const stop = Math.min(length, centre + reach + (AFTER + 2) * hop);
  const frames = Math.floor((stop - start) / hop);
  if (frames < BEFORE + AFTER + 2) return null;
  const l = new Float32Array(frames);
  fillLogEnergies(l, 0, frames, channels, hop, start);
  const firstValid = start === 0 ? 0 : BEFORE;
  const s = new Float32Array(frames);
  for (let j = 0; j < frames; j++) s[j] = riseAt(l, j, firstValid);
  const lowFrame = Math.max(0, Math.ceil((centre - reach - start) / hop));
  const highFrame = Math.min(frames - 1, Math.floor((centre + reach - start) / hop));
  let top = 0;
  for (let j = lowFrame; j <= highFrame; j++) if (s[j] > top) top = s[j];
  if (top < minRise) return null;
  const gate = Math.max(minRise, 0.4 * top);
  let best = -1;
  let bestMiss = Infinity;
  for (let j = lowFrame; j <= highFrame; j++) {
    if (s[j] < gate || !localMaximum(s, j, PEAK_RADIUS)) continue;
    const miss = Math.abs(start + j * hop - centre);
    if (miss < bestMiss) {
      bestMiss = miss;
      best = j;
    }
  }
  if (best < 0) return null;
  const refined = refineAttack(channels, rate, start + best * hop);
  return { time: refined.sample / rate, strength: s[best], clear: refined.clear };
}

// Primer golpe de la canción: la primera subida brusca cuyo sonido llega a una parte apreciable
// del volumen máximo (así no cuentan un chasquido suelto ni el ruido de fondo antes de empezar).
export function findFirstHit(channels, rate, { top = 0, maxSeconds = 90, minRise = 1.5, minLevel = 0.03 } = {}) {
  if (!channels.length) return null;
  const hop = hopSize(rate);
  const length = longest(channels);
  let loudest = top;
  if (!(loudest > 0)) {
    for (const data of channels) for (let i = 0; i < data.length; i += 2) if (Math.abs(data[i]) > loudest) loudest = Math.abs(data[i]);
  }
  if (!(loudest > 0)) return null;
  const frames = Math.min(Math.floor(length / hop), Math.round(maxSeconds * 1000));
  if (frames < BEFORE + AFTER + 2) return null;
  const l = new Float32Array(frames + AFTER);
  const chunk = 2000;
  let computed = 0;
  const ensure = (upTo) => {
    const goal = Math.min(frames + AFTER, upTo);
    if (goal <= computed) return;
    fillLogEnergies(l, computed, goal - computed, channels, hop, computed * hop);
    computed = goal;
  };
  const span = Math.round(0.012 * rate);
  for (let j = 0; j < frames; j++) {
    if (j + AFTER >= computed) ensure(j + chunk);
    const rise = riseAt(l, j, 0);
    if (rise < minRise) continue;
    // El sonido que sigue debe ser audible, no un chasquido minúsculo.
    const from = j * hop;
    const to = Math.min(length, from + span);
    let level = 0;
    for (const data of channels) {
      const stop = Math.min(to, data.length);
      for (let i = from; i < stop; i++) {
        const value = data[i] < 0 ? -data[i] : data[i];
        if (value > level) level = value;
      }
    }
    if (level < minLevel * loudest) continue;
    const refined = refineAttack(channels, rate, from);
    return { time: refined.sample / rate, strength: rise, level: level / loudest, clear: refined.clear };
  }
  return null;
}

// Curva de golpes de toda la canción (un valor por milisegundo) y sus picos. Se calcula una vez por canción;
// `pause` (opcional) permite ceder el control a la pantalla entre tramos.
export async function computeOnsetCurve(channels, rate, { pause = null, slice = 3000000 } = {}) {
  const hop = hopSize(rate);
  const length = longest(channels);
  const frames = Math.floor(length / hop);
  const l = new Float32Array(Math.max(1, frames));
  const step = 1000;
  let work = 0;
  for (let f = 0; f < frames; f += step) {
    const count = Math.min(step, frames - f);
    fillLogEnergies(l, f, count, channels, hop, f * hop);
    work += count * hop * Math.max(1, channels.length);
    if (pause && work >= slice) {
      work = 0;
      await pause();
    }
  }
  const s = new Float32Array(l.length);
  for (let j = 0; j < l.length; j++) s[j] = riseAt(l, j, 0);
  const found = [];
  for (let j = 0; j < s.length; j++) {
    if (s[j] >= MIN_RISE && localMaximum(s, j, PEAK_RADIUS)) found.push(j);
  }
  const sorted = found.map((j) => s[j]).sort((a, b) => a - b);
  const q = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0;
  const gate = Math.max(MIN_RISE, 0.2 * q);
  const peaks = found.filter((j) => s[j] >= gate);
  return {
    hop,
    rate,
    frames: l.length,
    peaks: Int32Array.from(peaks),
    strengths: Float32Array.from(peaks, (j) => s[j]),
  };
}

const curves = new WeakMap();

// Igual que computeOnsetCurve pero la guarda: la lista de canales identifica la canción.
export async function cachedOnsetCurve(channels, rate, options) {
  let promise = curves.get(channels);
  if (!promise) {
    promise = computeOnsetCurve(channels, rate, options);
    curves.set(channels, promise);
    promise.catch(() => curves.delete(channels));
  }
  return promise;
}

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

// Ajusta el BPM y el inicio del compás 1 a los golpes de toda la canción, partiendo de los valores actuales.
// Recorre los tiempos de la rejilla de uno en uno buscando en cada uno el golpe más fuerte y más cercano,
// vuelve a calcular la rejilla con los últimos que encontró (así sigue a un BPM que está un poco desviado) y
// al final ajusta una sola recta a todos los golpes, afinados a la muestra. Devuelve null si no hay datos.
export async function fitGridToAudio(channels, rate, { bpm, offset, duration, until = Infinity, curve = null, pause = null }) {
  if (!channels.length || !(bpm > 0)) return null;
  const data = curve || (await cachedOnsetCurve(channels, rate, { pause }));
  const hopSeconds = data.hop / rate;
  const count = data.peaks.length;
  if (count < 6) return null;
  const timeOf = (i) => data.peaks[i] * hopSeconds;
  const limit = Math.min(duration - 0.05, until);
  const period0 = 60 / bpm;
  const lowerBound = (time) => {
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (timeOf(mid) < time) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  let period = period0;
  let origin = offset;
  const matched = [];
  for (let k = 0; origin + k * period <= limit + 1e-9; k++) {
    const predicted = origin + k * period;
    if (predicted < -0.02) continue;
    const tolerance = matched.length < 3 ? clampNumber(0.06 * period, 0.02, 0.05) : clampNumber(0.025 * period, 0.01, 0.02);
    let best = -1;
    let bestScore = 0;
    for (let i = lowerBound(predicted - tolerance); i < count; i++) {
      const miss = timeOf(i) - predicted;
      if (miss > tolerance) break;
      const score = data.strengths[i] * (1 - (0.5 * Math.abs(miss)) / tolerance);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) continue;
    matched.push({ k, time: timeOf(best) });
    if (matched.length >= 3) {
      const tail = matched.slice(-24).map((item) => [item.k, item.time]);
      const local = fitLine(tail);
      if (local && local.slope > period0 * 0.9 && local.slope < period0 * 1.1) {
        period = local.slope;
        origin = local.intercept;
      }
    }
  }
  if (matched.length < 6) return null;
  // La posición de 1 ms de cada golpe se afina a la muestra en la que empieza a sonar.
  let points = matched.map((item) => {
    const refined = refineAttack(channels, rate, Math.round(item.time * rate));
    return [item.k, refined.sample / rate];
  });
  let fit = null;
  for (let pass = 0; pass < 8; pass++) {
    fit = fitLine(points);
    if (!fit) return null;
    const bound = Math.max(0.0015, 2.5 * fit.sigma);
    const keep = points.filter(([k, time]) => Math.abs(time - (fit.intercept + fit.slope * k)) <= bound);
    if (keep.length === points.length || keep.length < 6) break;
    points = keep;
  }
  if (!fit || !(fit.slope > 0)) return null;
  const first = points[0][0];
  const last = points[points.length - 1][0];
  const beats = last - first + 1;
  const value = 60 / fit.slope;
  const error = (value * fit.slopeError) / fit.slope;
  return {
    bpm: roundBpm(value, error),
    exactBpm: value,
    offsetMs: Math.max(0, Math.round(fit.intercept * 10000) / 10),
    sigmaMs: Math.round(fit.sigma * 10000) / 10,
    deviationMs: Math.round(fit.worst * 10000) / 10,
    used: points.length,
    beats,
    coverage: points.length / Math.max(1, beats),
    // Con un BPM de partida equivocado (p. ej. 120 sobre una canción de 90) la mitad de los tiempos todavía cae
    // sobre algún golpe: solo se da por fiable si la gran mayoría de los tiempos de la rejilla tiene golpe.
    reliable: points.length >= 10 && fit.sigma <= 0.006 && points.length / Math.max(1, beats) >= 0.6,
  };
}

// BPM que hace que el compás `bars` (contando desde el compás 1) caiga en `markTime`, con el compás 1 en `offset`.
export function bpmFromMark({ offset, markTime, bars, beatsPerBar }) {
  const span = markTime - offset;
  if (!(span > 0) || !(bars > 0)) return null;
  return (60 * beatsPerBar * bars) / span;
}
