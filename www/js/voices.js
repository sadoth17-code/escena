import { normalizeName } from './util.js';
import { SAMPLE_GUIDES } from './sample-index.js';
import { loadSampleSprite } from './sample-bank.js';

export const VOICE_INDEX = [
  {"key": "intro", "label": "Intro", "start": 0.0, "duration": 0.444},
  {"key": "verso", "label": "Verso", "start": 0.564, "duration": 0.5262},
  {"key": "precoro", "label": "Pre-coro", "start": 1.2102, "duration": 0.7167},
  {"key": "coro", "label": "Coro", "start": 2.0469, "duration": 0.3776},
  {"key": "puente", "label": "Puente", "start": 2.5445, "duration": 0.5017},
  {"key": "solo", "label": "Solo", "start": 3.1663, "duration": 0.4454},
  {"key": "interludio", "label": "Interludio", "start": 3.7316, "duration": 0.903},
  {"key": "instrumental", "label": "Instrumental", "start": 4.7546, "duration": 0.9667},
  {"key": "estribillo", "label": "Estribillo", "start": 5.8414, "duration": 0.8282},
  {"key": "break", "label": "Break", "start": 6.7895, "duration": 0.3569},
  {"key": "final", "label": "Final", "start": 7.2664, "duration": 0.6107},
  {"key": "tag", "label": "Tag", "start": 7.9971, "duration": 0.3524},
  {"key": "parada", "label": "Parada", "start": 8.4695, "duration": 0.5322},
  {"key": "cambio", "label": "Cambio", "start": 9.1217, "duration": 0.5978},
  {"key": "repite", "label": "Repite", "start": 9.8395, "duration": 0.5854},
  {"key": "n1", "label": "1", "start": 10.5449, "duration": 0.35},
  {"key": "n2", "label": "2", "start": 11.0149, "duration": 0.3597},
  {"key": "n3", "label": "3", "start": 11.4946, "duration": 0.3921},
  {"key": "n4", "label": "4", "start": 12.0066, "duration": 0.4893},
  {"key": "n5", "label": "5", "start": 12.616, "duration": 0.5257},
  {"key": "n6", "label": "6", "start": 13.2617, "duration": 0.4685},
  {"key": "n7", "label": "7", "start": 13.8502, "duration": 0.5154},
  {"key": "n8", "label": "8", "start": 14.4856, "duration": 0.4112},
  {"key": "n9", "label": "9", "start": 15.0168, "duration": 0.4819},
  {"key": "n10", "label": "10", "start": 15.6187, "duration": 0.421},
  {"key": "n11", "label": "11", "start": 16.1597, "duration": 0.4525},
  {"key": "n12", "label": "12", "start": 16.7322, "duration": 0.4158},
];

export const SECTION_VOICES = VOICE_INDEX.filter((voice) => !/^n\d+$/.test(voice.key));

const ALIASES = [
  ['precoro', ['precoro', 'pre coro', 'prechorus', 'pre chorus', 'pre-coro']],
  ['estribillo', ['estribillo']],
  ['coro', ['coro', 'chorus', 'ritornelo']],
  ['verso', ['verso', 'verse', 'estrofa']],
  ['puente', ['puente', 'bridge']],
  ['interludio', ['interludio', 'interlude']],
  ['instrumental', ['instrumental']],
  ['intro', ['intro', 'introduccion']],
  ['solo', ['solo']],
  ['break', ['break', 'quiebre']],
  ['final', ['final', 'outro', 'ending', 'fin', 'cierre']],
  ['tag', ['tag']],
  ['parada', ['parada', 'stop']],
  ['cambio', ['cambio', 'change']],
  ['repite', ['repite', 'repeat']],
];

export function voiceKeyForName(name, bankId = 'classic') {
  const exact = normalizeName(name).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const options = sectionVoices(bankId);
  const match = options.find(item => normalizeName(item.label).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() === exact);
  if (match) return match.key;
  const number = String(name).match(/\b(\d+)\b/)?.[1] || '';
  const text = normalizeName(name).replace(/[0-9]+/g, ' ').replace(/[^a-z\- ]/g, ' ').trim();
  for (const [key, words] of ALIASES) {
    if (words.some((word) => text.includes(word))) {
      if (number && options.some(item => item.key === key + number)) return key + number;
      return options.some(item => item.key === key) ? key : '';
    }
  }
  return '';
}

export const SECTION_COLORS = {
  intro: '#35c9ff',
  verso: '#3ddc84',
  precoro: '#f5e663',
  coro: '#ff8a3d',
  estribillo: '#ff8a3d',
  puente: '#a78bfa',
  solo: '#ff6b8b',
  interludio: '#5eead4',
  instrumental: '#5eead4',
  break: '#94a3b8',
  final: '#94a3b8',
  tag: '#f472b6',
  parada: '#ff5d5d',
  cambio: '#ffb020',
  repite: '#ffb020',
};

async function loadClassicVoices(ctx) {
  const response = await fetch(new URL('../audio/voces.wav', import.meta.url));
  if (!response.ok) throw new Error('No se pudieron cargar las voces de guía');
  const sprite = await ctx.decodeAudioData(await response.arrayBuffer());
  const channel = sprite.getChannelData(0);
  const bank = new Map();
  for (const voice of VOICE_INDEX) {
    const start = Math.floor(voice.start * sprite.sampleRate);
    const end = Math.min(channel.length, Math.ceil((voice.start + voice.duration) * sprite.sampleRate));
    bank.set(voice.key, channel.slice(start, end));
  }
  return bank;
}

export const GUIDE_BANKS = [
  ...Object.entries(SAMPLE_GUIDES).map(([id, bank]) => ({ id, name: bank.label })),
  { id: 'classic', name: 'Español · voz clásica de Escena' },
];

const COMPATIBLE_KEYS = { repite: 'tag', parada: 'break' };

export function sectionVoices(bankId = 'classic') {
  const pack = SAMPLE_GUIDES[bankId];
  if (!pack) return SECTION_VOICES;
  const items = pack.index.filter(item => !/^n\d+$/.test(item.key)).map(({ key, label }) => ({ key, label }));
  for (const [key, source] of Object.entries(COMPATIBLE_KEYS)) {
    if (items.some(item => item.key === source)) items.push({ key, label: SECTION_VOICES.find(item => item.key === key).label });
  }
  if (bankId === 'samples-es') {
    for (const item of SECTION_VOICES) if (!items.some(x => x.key === item.key)) items.push({ ...item, label: item.label + ' · clásica' });
  }
  return items;
}

const bankCache = new WeakMap();
export async function loadVoiceBank(ctx, bankId = 'classic') {
  const id = SAMPLE_GUIDES[bankId] ? bankId : 'classic';
  let cache = bankCache.get(ctx);
  if (!cache) { cache = new Map(); bankCache.set(ctx, cache); }
  if (!cache.has(id)) {
    const pending = (async () => {
      if (id === 'classic') return loadClassicVoices(ctx);
      const samples = await loadSampleSprite(ctx, SAMPLE_GUIDES[id]);
      // Spanish keeps legacy cues and numbers 8–12 that are absent from the ZIP.
      const result = id === 'samples-es' ? new Map(await loadVoiceBank(ctx, 'classic')) : new Map();
      for (const [key, data] of samples) result.set(key, data);
      for (const [key, source] of Object.entries(COMPATIBLE_KEYS)) if (samples.has(source)) result.set(key, samples.get(source));
      return result;
    })();
    cache.set(id, pending);
    pending.catch(() => { if (cache.get(id) === pending) cache.delete(id); });
  }
  return cache.get(id);
}

for (const pack of Object.values(SAMPLE_GUIDES)) {
  for (const item of pack.index) {
    const base = item.key.replace(/\d+$/, '');
    if (!SECTION_COLORS[item.key] && SECTION_COLORS[base]) SECTION_COLORS[item.key] = SECTION_COLORS[base];
  }
}
