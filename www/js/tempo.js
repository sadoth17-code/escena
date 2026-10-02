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
  const onsets = [];
  let last = -minGap;
  for (let f = 0; f < frames - 1; f++) {
    const before = f > 0 ? envelope[f - 1] : 0;
    if (envelope[f] >= threshold && envelope[f] >= before && envelope[f] >= envelope[f + 1] && f - last >= minGap) {
      onsets.push(f);
      last = f;
    }
  }
  if (onsets.length < 6) return null;
  const times = onsets.map((frame) => (frame * hop) / rate);
  const intervals = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const consistent = intervals.filter((value) => Math.abs(value - median) < median * 0.06);
  if (consistent.length < intervals.length * 0.5) return null;
  const first = times[0];
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const time of times) {
    const index = Math.round((time - first) / median);
    if (Math.abs(time - (first + index * median)) > median * 0.08) continue;
    count++;
    sumX += index;
    sumY += time;
    sumXX += index * index;
    sumXY += index * time;
  }
  const denominator = count * sumXX - sumX * sumX;
  if (count < 4 || denominator === 0) return null;
  const slope = (count * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / count;
  let bpm = 60 / slope;
  let adjusted = false;
  while (bpm < 60) {
    bpm *= 2;
    adjusted = true;
  }
  while (bpm > 200) {
    bpm /= 2;
    adjusted = true;
  }
  const span = Math.floor(rate * 0.03);
  const amplitudes = [];
  const crossings = [];
  for (const frame of onsets) {
    const from = frame * hop;
    const to = Math.min(length, from + span);
    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const channel = data[c];
      for (let i = from; i < to; i++) {
        const v = Math.abs(channel[i]);
        if (v > peak) peak = v;
      }
    }
    let zero = 0;
    const first = data[0];
    for (let i = from + 1; i < to; i++) if (first[i] >= 0 !== first[i - 1] >= 0) zero++;
    amplitudes.push(peak);
    crossings.push(zero / Math.max(1e-3, (to - from) / rate));
  }
  const meter = adjusted ? null : accentPattern(amplitudes, true) || accentPattern(crossings, false);
  const origin = intercept + (meter ? meter.phase * slope : 0);
  return {
    bpm: Math.round(bpm * 100) / 100,
    offsetMs: Math.max(0, Math.round(origin * 1000)),
    onsets: times.length,
    num: meter ? meter.num : null,
  };
}
