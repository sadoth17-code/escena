import { accentLevel } from './tempo.js';

const LEVEL_GAIN = [1, 0.82, 0.64];
const LEVEL_KIND = ['accent', 'medium', 'normal'];
const SUB_GAIN = 0.38;

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
}

function normalizeVoice(data, peak) {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
  if (max === 0) return data;
  const scale = peak / max;
  for (let i = 0; i < data.length; i++) data[i] *= scale;
  return data;
}

function woodVoice(rate, kind) {
  const base = { accent: 1900, medium: 1500, normal: 1150, sub: 1300 }[kind];
  const length = Math.floor(rate * 0.09);
  const out = new Float32Array(length);
  const noise = seeded(7);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const body = Math.sin(2 * Math.PI * base * t) * Math.exp(-t / 0.011);
    const knock = 0.45 * Math.sin(2 * Math.PI * base * 2.76 * t) * Math.exp(-t / 0.005);
    const tick = 0.25 * noise() * Math.exp(-t / 0.0015);
    out[i] = body + knock + tick;
  }
  return normalizeVoice(out, 0.95);
}

function beepVoice(rate, kind) {
  const base = { accent: 1568, medium: 1318, normal: 1046, sub: 880 }[kind];
  const length = Math.floor(rate * 0.07);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const attack = Math.min(1, t / 0.002);
    out[i] = Math.sin(2 * Math.PI * base * t) * attack * Math.exp(-t / 0.022);
  }
  return normalizeVoice(out, 0.9);
}

function cowbellVoice(rate, kind) {
  const scale = { accent: 1.19, medium: 1.06, normal: 1, sub: 0.94 }[kind];
  const length = Math.floor(rate * 0.22);
  const out = new Float32Array(length);
  const partials = [562 * scale, 845 * scale];
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    let sum = 0;
    for (const freq of partials) {
      for (let k = 1; k <= 7; k += 2) {
        if (freq * k > rate * 0.45) break;
        sum += Math.sin(2 * Math.PI * freq * k * t) / k;
      }
    }
    out[i] = sum * Math.exp(-t / 0.07) * Math.min(1, t / 0.0008);
  }
  return normalizeVoice(out, 0.9);
}

function hatVoice(rate, kind) {
  const decay = { accent: 0.04, medium: 0.03, normal: 0.022, sub: 0.016 }[kind];
  const length = Math.floor(rate * 0.1);
  const out = new Float32Array(length);
  const noise = seeded(kind === 'accent' ? 11 : 13);
  let previous = 0;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const n = noise();
    out[i] = (n - previous * 0.9) * Math.exp(-t / decay);
    previous = n;
  }
  return normalizeVoice(out, 0.9);
}

const PRESETS = {
  madera: { name: 'Madera', make: woodVoice },
  beep: { name: 'Beep', make: beepVoice },
  cencerro: { name: 'Cencerro', make: cowbellVoice },
  hihat: { name: 'Hi-hat', make: hatVoice },
};

export const CLICK_SOUNDS = Object.entries(PRESETS).map(([id, preset]) => ({ id, name: preset.name }));

const voiceCache = new Map();

function getVoice(sound, kind, rate) {
  const key = `${sound}|${kind}|${rate}`;
  if (!voiceCache.has(key)) {
    const preset = PRESETS[sound] || PRESETS.madera;
    voiceCache.set(key, preset.make(rate, kind));
  }
  return voiceCache.get(key);
}

function addVoice(data, voice, index, gain) {
  if (index >= data.length || index + voice.length <= 0) return;
  const start = Math.max(0, index);
  const end = Math.min(data.length, index + voice.length);
  for (let i = start; i < end; i++) data[i] += voice[i - index] * gain;
}

function fadeTail(source, rate) {
  const out = new Float32Array(source);
  const fade = Math.min(out.length, Math.floor(rate * 0.012));
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
}

function placeCue(data, rate, voices, key, time, segment, counting) {
  const word = voices.get(key);
  if (!word) return;
  addVoice(data, word, Math.round(time * rate), 1);
  if (!counting || segment.beatDur < 0.3) return;
  const wordDuration = word.length / rate;
  const firstNumber = Math.max(2, Math.ceil(wordDuration / segment.beatDur - 0.15) + 1);
  for (let beat = firstNumber; beat <= Math.min(segment.num, 12); beat++) {
    const number = voices.get(`n${beat}`);
    if (!number) continue;
    const maxLength = Math.floor(segment.beatDur * rate * 0.98);
    const voice = number.length > maxLength ? fadeTail(number.subarray(0, maxLength), rate) : number;
    addVoice(data, voice, Math.round((time + (beat - 1) * segment.beatDur) * rate), 0.95);
  }
}

export function renderClickBuffer(ctx, tempo, { duration, offset, sound, subdivision }) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.ceil(duration * rate));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  const divisions = Math.max(1, Math.min(4, Math.round(subdivision || 1)));
  const beats = tempo.beats(Math.max(0, duration - offset + 0.5));
  for (const beat of beats) {
    const at = beat.t + offset;
    if (at >= duration) break;
    if (at >= -0.1) addVoice(data, getVoice(sound, LEVEL_KIND[beat.level], rate), Math.round(at * rate), LEVEL_GAIN[beat.level]);
    for (let k = 1; k < divisions; k++) {
      const sub = at + (beat.beatDur * k) / divisions;
      if (sub >= 0 && sub < duration) addVoice(data, getVoice(sound, 'sub', rate), Math.round(sub * rate), SUB_GAIN);
    }
  }
  return buffer;
}

export function renderGuideBuffer(ctx, tempo, markers, voices, { duration, offset, leadBars, counting }) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.ceil(duration * rate));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  const lead = Math.max(0, Math.round(leadBars));
  for (const marker of markers) {
    if (!marker.voice) continue;
    const bar = marker.bar - lead;
    if (bar < 1) continue;
    const time = tempo.barStart(bar) + offset;
    if (time < 0 || time >= duration) continue;
    placeCue(data, rate, voices, marker.voice, time, tempo.segmentAtBar(bar), counting);
  }
  return buffer;
}

export function renderCountIn(ctx, tempo, gridStart, { bars, sound, marker, voices, leadBars, counting }) {
  const rate = ctx.sampleRate;
  const segment = tempo.segmentAtTime(Math.max(0, gridStart));
  const beats = Math.max(1, Math.round(bars)) * segment.num;
  const total = beats * segment.beatDur;
  const length = Math.ceil((total + 0.3) * rate);
  const clickBuffer = ctx.createBuffer(1, length, rate);
  const clickData = clickBuffer.getChannelData(0);
  for (let k = 0; k < beats; k++) {
    const level = accentLevel(segment, (k % segment.num) + 1);
    addVoice(clickData, getVoice(sound, LEVEL_KIND[level], rate), Math.round(k * segment.beatDur * rate), LEVEL_GAIN[level]);
  }
  let guideBuffer = null;
  if (marker && marker.voice && voices) {
    guideBuffer = ctx.createBuffer(1, length, rate);
    const lead = Math.min(Math.max(1, Math.round(leadBars)), Math.round(bars));
    const start = (Math.round(bars) - lead) * segment.barDur;
    placeCue(guideBuffer.getChannelData(0), rate, voices, marker.voice, start, segment, counting);
  }
  return { clickBuffer, guideBuffer, duration: total };
}

export function renderPreview(ctx, sound) {
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.ceil(rate * 0.4), rate);
  const data = buffer.getChannelData(0);
  addVoice(data, getVoice(sound, 'accent', rate), 0, 1);
  addVoice(data, getVoice(sound, 'normal', rate), Math.round(rate * 0.2), LEVEL_GAIN[2]);
  return buffer;
}
