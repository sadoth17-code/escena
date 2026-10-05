import { clamp } from './util.js';

export const DEFAULT_TEMPO_ENTRY = { bar: 1, bpm: 120, num: 4, den: 4 };
export const DENOMINATORS = [2, 4, 8, 16];

export function normalizeTempoEntries(entries) {
  const list = (entries || []).map((entry) => ({
    bar: Math.max(1, Math.round(Number(entry.bar) || 1)),
    bpm: clamp(Number(entry.bpm) || 120, 20, 400),
    num: clamp(Math.round(Number(entry.num) || 4), 1, 32),
    den: DENOMINATORS.includes(Number(entry.den)) ? Number(entry.den) : 4,
  }));
  list.sort((a, b) => a.bar - b.bar);
  const unique = [];
  for (const entry of list) {
    if (unique.length && unique[unique.length - 1].bar === entry.bar) unique[unique.length - 1] = entry;
    else unique.push(entry);
  }
  if (!unique.length) unique.push({ ...DEFAULT_TEMPO_ENTRY });
  if (unique[0].bar !== 1) unique.unshift({ ...unique[0], bar: 1 });
  return unique;
}

export function groupSize(segment) {
  if (segment.den === 8 && segment.num >= 6 && segment.num % 3 === 0) return 3;
  return 0;
}

export function accentLevel(segment, beat) {
  if (beat === 1) return 0;
  const group = groupSize(segment);
  if (group && (beat - 1) % group === 0) return 1;
  return 2;
}

export class TempoMap {
  constructor(entries) {
    this.entries = normalizeTempoEntries(entries);
    this.segments = [];
    let start = 0;
    this.entries.forEach((entry, index) => {
      const next = this.entries[index + 1];
      const beatDur = 60 / entry.bpm;
      const barDur = beatDur * entry.num;
      this.segments.push({
        ...entry,
        startBar: entry.bar,
        endBar: next ? next.bar : Infinity,
        start,
        beatDur,
        barDur,
      });
      if (next) start += (next.bar - entry.bar) * barDur;
    });
  }

  segmentAtBar(bar) {
    let found = this.segments[0];
    for (const segment of this.segments) {
      if (segment.startBar <= bar) found = segment;
      else break;
    }
    return found;
  }

  segmentAtTime(time) {
    let found = this.segments[0];
    for (const segment of this.segments) {
      if (segment.start <= time + 1e-9) found = segment;
      else break;
    }
    return found;
  }

  barStart(bar) {
    const segment = this.segmentAtBar(bar);
    return segment.start + (bar - segment.startBar) * segment.barDur;
  }

  barFloat(time) {
    const segment = this.segmentAtTime(time);
    return segment.startBar + (time - segment.start) / segment.barDur;
  }

  position(time) {
    const t = Math.max(0, time);
    const segment = this.segmentAtTime(t);
    const bars = Math.max(0, (t - segment.start) / segment.barDur);
    const barIndex = Math.floor(bars + 1e-9);
    const inBar = (bars - barIndex) * segment.num;
    const beatIndex = Math.min(segment.num - 1, Math.floor(inBar + 1e-9));
    return { bar: segment.startBar + barIndex, beat: beatIndex + 1, fraction: inBar - beatIndex, segment };
  }

  nextBoundary(time, unit, margin = 0.04) {
    const t = Math.max(0, time) + margin;
    const segment = this.segmentAtTime(t);
    const step = unit === 'beat' ? segment.beatDur : segment.barDur;
    const index = Math.ceil((t - segment.start) / step - 1e-9);
    let boundary = segment.start + index * step;
    if (segment.endBar !== Infinity) {
      const segmentEnd = segment.start + (segment.endBar - segment.startBar) * segment.barDur;
      if (boundary > segmentEnd + 1e-9) boundary = segmentEnd;
    }
    return boundary;
  }

  nearestBarStart(time) {
    const bar = Math.max(1, Math.round(this.barFloat(Math.max(0, time))));
    return this.barStart(bar);
  }

  isBarAligned(time, tolerance = 0.03) {
    const segment = this.segmentAtTime(Math.max(0, time));
    const bars = (Math.max(0, time) - segment.start) / segment.barDur;
    return Math.abs(bars - Math.round(bars)) * segment.barDur < tolerance;
  }

  beats(endTime) {
    const out = [];
    for (const segment of this.segments) {
      const segmentEnd =
        segment.endBar === Infinity ? endTime : Math.min(endTime, segment.start + (segment.endBar - segment.startBar) * segment.barDur);
      for (let k = 0; ; k++) {
        const t = segment.start + k * segment.beatDur;
        if (t >= segmentEnd - 1e-9) break;
        const beat = (k % segment.num) + 1;
        out.push({
          t,
          bar: segment.startBar + Math.floor(k / segment.num),
          beat,
          level: accentLevel(segment, beat),
          beatDur: segment.beatDur,
        });
      }
    }
    return out;
  }

  barCount(duration) {
    return Math.max(1, Math.ceil(this.barFloat(Math.max(0, duration)) - 1e-9) - 1);
  }

  describe(time) {
    const segment = this.segmentAtTime(Math.max(0, time));
    return { bpm: segment.bpm, signature: `${segment.num}/${segment.den}`, segment };
  }
}

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1) + 0.5)))];
}

function accentPattern(values, upwardOnly) {
  const count = values.length;
  for (let n = 2; n <= 12; n++) {
    if (count < n * 2) break;
    for (let phase = 0; phase < n; phase++) {
      const accent = [];
      const rest = [];
      for (let i = 0; i < count; i++) (i % n === phase ? accent : rest).push(values[i]);
      if (accent.length < 2 || rest.length < 2) continue;
      const louder = percentile(accent, 0.1) > percentile(rest, 0.9) * 1.12;
      const softer = !upwardOnly && percentile(accent, 0.9) * 1.12 < percentile(rest, 0.1);
      if (louder || softer) return { num: n, phase };
    }
  }
  return null;
}

// Ajuste de una recta  tiempo = origen + periodo × índice  por mínimos cuadrados.
export function fitLine(points) {
  const count = points.length;
  let meanX = 0;
  let meanY = 0;
  for (const [x, y] of points) {
    meanX += x;
    meanY += y;
  }
  meanX /= count;
  meanY /= count;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - meanX) * (x - meanX);
    sxy += (x - meanX) * (y - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let squares = 0;
  let worst = 0;
  for (const [x, y] of points) {
    const miss = y - (intercept + slope * x);
    squares += miss * miss;
    if (Math.abs(miss) > worst) worst = Math.abs(miss);
  }
  const sigma = Math.sqrt(squares / Math.max(1, count - 2));
  return { slope, intercept, sigma, worst, count, slopeError: sigma / Math.sqrt(sxx) };
}

// El BPM sale de una recta ajustada a cientos de golpes, así que es mucho más fino que dos decimales.
// Si el valor cae dentro de su margen de error sobre un número «redondo» (120, 93,5, 93,37) se usa ese;
// si no, se conservan decimales de sobra para que el click no se vaya separando de la pista en canciones largas.
export function roundBpm(value, error) {
  const limit = Math.min(0.004, Math.max(0.0006, 2.5 * error));
  for (const decimals of [0, 1, 2]) {
    const scale = 10 ** decimals;
    const snapped = Math.round(value * scale) / scale;
    if (Math.abs(snapped - value) <= limit) return snapped;
  }
  const scale = error < 0.001 ? 10000 : 1000;
  return Math.round(value * scale) / scale;
}

export function detectTempoFromBuffer(buffer) {
  const rate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const hop = Math.max(1, Math.floor(rate * 0.002));
  const frames = Math.floor(length / hop);
  const envelope = new Float32Array(frames);
  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let previous = 0;
  for (let f = 0; f < frames; f++) {
    let peak = 0;
    const start = f * hop;
    for (let c = 0; c < channels; c++) {
      const channel = data[c];
      for (let i = start; i < start + hop; i++) {
        const v = Math.abs(channel[i]);
        if (v > peak) peak = v;
      }
    }
    envelope[f] = Math.max(0, peak - previous * 0.85);
    previous = peak;
  }
  let max = 0;
  for (let f = 0; f < frames; f++) if (envelope[f] > max) max = envelope[f];
  if (max < 0.02) return null;
  const threshold = max * 0.35;
  const minGap = Math.floor(0.12 / (hop / rate));
  const candidates = [];
  let last = -minGap;
  for (let f = 0; f < frames - 1; f++) {
    const before = f > 0 ? envelope[f - 1] : 0;
    if (envelope[f] >= threshold && envelope[f] >= before && envelope[f] >= envelope[f + 1] && f - last >= minGap) {
      candidates.push(f);
      last = f;
    }
  }
  if (candidates.length < 6) return null;

  // Los bloques de 2 ms solo dicen «por aquí hay un golpe». Para colocar el compás 1 con precisión
  // se busca la muestra exacta en la que el golpe empieza a sonar (10 % de su pico, sin silencio
  // de por medio): así la posición no depende del bloque ni de lo lento que sea el ataque.
  const peakSpan = Math.floor(rate * 0.03);
  const backSpan = Math.floor(rate * 0.03);
  const holdSpan = Math.max(1, Math.floor(rate * 0.0015));
  const level = (i) => {
    let v = 0;
    for (let c = 0; c < channels; c++) {
      const x = Math.abs(data[c][i]);
      if (x > v) v = x;
    }
    return v;
  };
  const refine = (frame) => {
    const coarse = frame * hop;
    const end = Math.min(length, coarse + peakSpan);
    let peak = 0;
    let peakAt = coarse;
    for (let i = coarse; i < end; i++) {
      const v = level(i);
      if (v > peak) {
        peak = v;
        peakAt = i;
      }
    }
    if (peak <= 0) return { start: coarse, peak: 0 };
    const gate = peak * 0.1;
    const floor = Math.max(0, peakAt - backSpan);
    let start = peakAt;
    let quiet = 0;
    let i = peakAt;
    while (i > floor) {
      i--;
      if (level(i) >= gate) {
        start = i;
        quiet = 0;
      } else if (++quiet >= holdSpan) break;
    }
    // Si hasta el límite no hubo ni 1,5 ms de silencio (material denso, no un click limpio),
    // no se afina: se queda la posición del bloque, como siempre.
    if (quiet < holdSpan && floor > 0) return { start: coarse, peak };
    return { start, peak };
  };
  const refined = candidates.map(refine);
  const times = refined.map((item) => item.start / rate);
  const intervals = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const consistent = intervals.filter((value) => Math.abs(value - median) < median * 0.06);
  if (consistent.length < intervals.length * 0.5) return null;

  // Rejilla de golpes regulares. El periodo inicial es el promedio de los intervalos coherentes
  // (la mediana sola oscila entre dos valores vecinos cuando el acento y el tiempo no atacan igual).
  let period = consistent.reduce((sum, value) => sum + value, 0) / consistent.length;
  // El primer golpe detectado puede ser un ruido suelto antes del click: se toma como punto de
  // partida, entre los primeros, el que más golpes alinea con la rejilla.
  let origin = times[0];
  let bestScore = -1;
  for (let a = 0; a < Math.min(times.length, 16); a++) {
    let score = 0;
    for (const time of times) {
      const index = Math.round((time - times[a]) / period);
      if (Math.abs(time - (times[a] + index * period)) <= period * 0.05) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      origin = times[a];
    }
  }
  // Cada vuelta usa la recta de la anterior para repartir los golpes por todo el archivo: la primera
  // solo se fía de los primeros compases y las siguientes ya ajustan a lo largo de toda la canción,
  // que es lo que fija el BPM con decimales.
  let sigma = period * 0.04;
  let fit = null;
  let inliers = [];
  for (let pass = 0; pass < 8; pass++) {
    const tolerance = pass === 0 ? period * 0.08 : Math.min(period * 0.08, Math.max(0.0015, 4 * sigma));
    const points = [];
    const picked = [];
    times.forEach((time, k) => {
      const index = Math.round((time - origin) / period);
      if (Math.abs(time - (origin + index * period)) > tolerance) return;
      points.push([index, time]);
      picked.push(k);
    });
    if (points.length < 4) {
      if (!fit) return null;
      break;
    }
    const next = fitLine(points);
    if (!next || !(next.slope > 0)) {
      if (!fit) return null;
      break;
    }
    const settled = fit && picked.length === inliers.length && Math.abs(next.slope - period) < period * 1e-10;
    fit = { ...next, points };
    inliers = picked;
    period = next.slope;
    origin = next.intercept;
    sigma = next.sigma;
    if (settled) break;
  }
  if (!fit) return null;

  let bpm = 60 / fit.slope;
  let bpmError = (bpm * fit.slopeError) / fit.slope;
  let adjusted = false;
  // Los límites llevan un margen del 0,3 %: un click de exactamente 60 o 200 BPM mide 59,9999 o 200,0001
  // y no debe doblarse ni partirse por eso.
  while (bpm < 60 * 0.997) {
    bpm *= 2;
    bpmError *= 2;
    adjusted = true;
  }
  while (bpm > 200 * 1.003) {
    bpm /= 2;
    bpmError /= 2;
    adjusted = true;
  }
  const span = Math.floor(rate * 0.03);
  const amplitudes = [];
  const crossings = [];
  for (const k of inliers) {
    const from = refined[k].start;
    const to = Math.min(length, from + span);
    let zero = 0;
    const first = data[0];
    for (let i = from + 1; i < to; i++) if (first[i] >= 0 !== first[i - 1] >= 0) zero++;
    amplitudes.push(refined[k].peak);
    crossings.push(zero / Math.max(1e-3, (to - from) / rate));
  }
  const meter = adjusted ? null : accentPattern(amplitudes, true) || accentPattern(crossings, false);
  const firstIndex = fit.points[0][0];
  const downbeat = fit.intercept + (firstIndex + (meter ? meter.phase : 0)) * fit.slope;
  return {
    bpm: roundBpm(bpm, bpmError),
    offsetMs: Math.max(0, Math.round(downbeat * 10000) / 10),
    onsets: times.length,
    num: meter ? meter.num : null,
    // Cuánto se aleja el golpe más desviado de la rejilla perfecta (0 con un click de ordenador;
    // decenas de ms con una batería tocada a mano o un tempo que cambia dentro de la pista).
    deviationMs: Math.round(fit.worst * 10000) / 10,
    used: inliers.length,
  };
}

// Para la interfaz: ¿el pulso de la pista es lo bastante exacto como para que el click del programa la acompañe?
// Un click hecho en ordenador se desvía menos de 1 ms; una batería tocada a mano o un tempo que cambia, decenas.
export function tempoIsShaky(result) {
  if (!result) return false;
  const deviation = Number(result.deviationMs) || 0;
  const onsets = Number(result.onsets) || 0;
  const used = Number(result.used);
  return deviation >= 6 || (onsets > 0 && Number.isFinite(used) && used < onsets * 0.4);
}

export function tempoWarning(result) {
  if (!tempoIsShaky(result)) return '';
  const deviation = Number(result.deviationMs) || 0;
  if (deviation >= 6) {
    return `. Aviso: los golpes de esa pista se separan hasta ${deviation >= 10 ? Math.round(deviation) : deviation.toFixed(1)} ms de un pulso fijo (tempo tocado a mano o con cambios), así que el click del programa puede no coincidir con ella`;
  }
  return `. Aviso: solo ${result.used} de ${result.onsets} golpes de esa pista siguen un pulso fijo. Si no es la pista de click, elige otra para detectar el tempo`;
}
