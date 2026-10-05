import { normalizeName } from './util.js';

// Voz original de Escena (sintética): un solo WAV con el inicio y la duración de cada palabra.
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

// Idiomas de guía. «orig» es la voz sintética que ya traía Escena.
export const DEFAULT_GUIDE_LANG = 'es';
export const GUIDE_LANGUAGES = [
  { id: 'es', name: 'Español' },
  { id: 'en', name: 'English' },
  { id: 'pt', name: 'Português' },
  { id: 'fr', name: 'Français' },
  { id: 'orig', name: 'Voz original de Escena (sintética)' },
];
export const isGuideLanguage = (id) => GUIDE_LANGUAGES.some((language) => language.id === id);
export const guideLanguageName = (id) => (GUIDE_LANGUAGES.find((language) => language.id === id) || GUIDE_LANGUAGES[0]).name;

// Lista de voces que se pueden asignar a una sección. La clave es la misma en todos los
// idiomas; el audio que suena depende del idioma elegido en Ajustes.
export const VOICE_GROUPS = [
  { id: 'sections', label: 'Secciones' },
  { id: 'numbered', label: 'Secciones con número' },
  { id: 'cues', label: 'Indicaciones' },
];

const SECTION_LABELS = [
  ['intro', 'Intro'],
  ['verso', 'Verso'],
  ['precoro', 'Pre-coro'],
  ['coro', 'Coro'],
  ['postcoro', 'Post-coro'],
  ['puente', 'Puente'],
  ['solo', 'Solo'],
  ['interludio', 'Interludio'],
  ['instrumental', 'Instrumental'],
  ['estribillo', 'Estribillo'],
  ['breakdown', 'Breakdown'],
  ['final', 'Final'],
  ['outro', 'Outro'],
  ['tag', 'Tag'],
  ['turnaround', 'Turnaround'],
  ['vamp', 'Vamp'],
  ['rap', 'Rap'],
  ['exhortacion', 'Exhortación'],
  ['acapella', 'A capella'],
];

const NUMBERED = [
  ['verso', 'Verso', 6],
  ['precoro', 'Pre-coro', 4],
  ['coro', 'Coro', 4],
  ['puente', 'Puente', 4],
];

const CUE_LABELS = [
  ['break', 'Break'],
  ['build', 'Build'],
  ['slowbuild', 'Build lento'],
  ['swell', 'Swell'],
  ['hold', 'Hold'],
  ['hits', 'Hits'],
  ['softly', 'Suave'],
  ['allin', 'Toda la banda'],
  ['drums', 'Batería'],
  ['drumsin', 'Entra batería'],
  ['bass', 'Bajo'],
  ['guitar', 'Guitarra'],
  ['keys', 'Teclado'],
  ['pad', 'Pad'],
  ['lasttime', 'Última vez'],
  ['bigending', 'Final grande'],
  ['keyup', 'Sube tono'],
  ['keydown', 'Baja tono'],
  ['adlib', 'Ad lib'],
  ['freely', 'Adoración libre'],
  ['parada', 'Parada'],
  ['cambio', 'Cambio'],
  ['repite', 'Repite'],
];

export const VOICE_CATALOG = [
  ...SECTION_LABELS.map(([key, label]) => ({ key, label, group: 'sections' })),
  ...NUMBERED.flatMap(([key, label, count]) =>
    Array.from({ length: count }, (_, i) => ({ key: `${key}${i + 1}`, label: `${label} ${i + 1}`, group: 'numbered', base: key, number: i + 1 }))
  ),
  ...CUE_LABELS.map(([key, label]) => ({ key, label, group: 'cues' })),
];

export const SECTION_VOICES = VOICE_CATALOG;
const CATALOG_KEYS = new Set(VOICE_CATALOG.map((voice) => voice.key));

export const voiceLabel = (key) => {
  const found = VOICE_CATALOG.find((voice) => voice.key === key);
  return found ? found.label : '';
};

const ALIASES = [
  ['postcoro', ['postcoro', 'post coro', 'post-coro', 'postchorus', 'post chorus', 'post-chorus']],
  ['precoro', ['precoro', 'pre coro', 'prechorus', 'pre chorus', 'pre-coro', 'pre-chorus']],
  ['estribillo', ['estribillo', 'refrain']],
  ['coro', ['coro', 'chorus', 'ritornelo']],
  ['verso', ['verso', 'verse', 'estrofa']],
  ['puente', ['puente', 'bridge']],
  ['interludio', ['interludio', 'interlude']],
  ['instrumental', ['instrumental']],
  ['intro', ['intro', 'introduccion']],
  ['solo', ['solo']],
  ['breakdown', ['breakdown', 'baja intensidad']],
  ['acapella', ['acapella', 'a capella', 'a cappella']],
  ['exhortacion', ['exhortacion', 'exhortation']],
  ['turnaround', ['turnaround', 'retorno']],
  ['vamp', ['vamp']],
  ['rap', ['rap']],
  ['outro', ['outro']],
  ['break', ['break', 'quiebre', 'pausa']],
  ['final', ['final', 'ending', 'fin', 'cierre']],
  ['tag', ['tag']],
  ['parada', ['parada', 'stop']],
  ['cambio', ['cambio', 'change']],
  ['repite', ['repite', 'repeat']],
];

// Palabras cortas: se buscan como palabra completa para no confundir «rápido» con «rap».
const WHOLE_WORD = new Set(['rap', 'tag', 'fin', 'vamp', 'stop', 'solo', 'outro']);

function hasWord(text, word) {
  if (!WHOLE_WORD.has(word)) return text.includes(word);
  return new RegExp(`(^|[^a-z-])${word}([^a-z-]|$)`).test(text);
}

// Indicaciones dinámicas: nombres con los que alguien podría escribirlas. Las frases de varias
// palabras se comprueban antes que las secciones («Big ending» no es «Final»); las de una sola
// palabra, después («Verso bajo» sigue siendo un verso).
const CUE_ALIASES = [
  ['slowbuild', ['slow build', 'slowly build', 'build lento']],
  ['drumsin', ['drums in', 'entra bateria']],
  ['allin', ['all in', 'toda la banda']],
  ['lasttime', ['last time', 'ultima vez']],
  ['bigending', ['big ending', 'final grande']],
  ['keyup', ['key up', 'sube tono', 'subir tono']],
  ['keydown', ['key down', 'baja tono', 'bajar tono']],
  ['freely', ['worship freely', 'adoracion libre']],
  ['build', ['build', 'crescendo']],
  ['swell', ['swell']],
  ['hold', ['hold', 'sostener', 'sostenido']],
  ['hits', ['hits', 'golpes']],
  ['softly', ['softly', 'suave', 'suavemente']],
  ['drums', ['drums', 'bateria']],
  ['bass', ['bass', 'bajo']],
  ['guitar', ['guitar', 'guitarra']],
  ['keys', ['keys', 'teclado', 'teclas']],
  ['pad', ['pad']],
  ['adlib', ['ad lib', 'adlib']],
];

const phraseRegexes = new Map();
function hasPhrase(text, phrase) {
  if (!phraseRegexes.has(phrase)) phraseRegexes.set(phrase, new RegExp(`(^|[^a-z-])${phrase}([^a-z-]|$)`));
  return phraseRegexes.get(phrase).test(text);
}

const cueMatches = (text, multiWord) => {
  for (const [key, words] of CUE_ALIASES) {
    if (words.some((word) => word.includes(' ') === multiWord && hasPhrase(text, word))) return key;
  }
  return '';
};

const squash = (text) => text.replace(/\s+/g, ' ').trim();
// El nombre exacto de una voz del catálogo (por ejemplo «Build lento» o «Pre-coro 2») la elige sin ambigüedad.
const LABEL_KEYS = new Map(VOICE_CATALOG.map((voice) => [squash(normalizeName(voice.label)), voice.key]));

export function voiceKeyForName(name) {
  const normalized = normalizeName(name);
  const exact = LABEL_KEYS.get(squash(normalized));
  if (exact) return exact;
  const text = squash(normalized.replace(/[0-9]+/g, ' ').replace(/[^a-z\- ]/g, ' '));
  const phrase = cueMatches(text, true);
  if (phrase) return phrase;
  for (const [key, words] of ALIASES) {
    if (words.some((word) => hasWord(text, word))) {
      const number = (normalized.match(/[0-9]+/) || [''])[0];
      const numbered = number ? `${key}${Number(number)}` : '';
      return numbered && CATALOG_KEYS.has(numbered) ? numbered : key;
    }
  }
  return cueMatches(text, false);
}

export const SECTION_COLORS = (() => {
  const base = {
    intro: '#35c9ff',
    verso: '#3ddc84',
    precoro: '#f5e663',
    postcoro: '#f5e663',
    coro: '#ff8a3d',
    estribillo: '#ff8a3d',
    puente: '#a78bfa',
    solo: '#ff6b8b',
    rap: '#ff6b8b',
    interludio: '#5eead4',
    instrumental: '#5eead4',
    turnaround: '#5eead4',
    break: '#94a3b8',
    breakdown: '#94a3b8',
    final: '#94a3b8',
    outro: '#94a3b8',
    acapella: '#38bdf8',
    vamp: '#f472b6',
    tag: '#f472b6',
    exhortacion: '#ff8a3d',
    parada: '#ff5d5d',
    cambio: '#ffb020',
    repite: '#ffb020',
  };
  const colors = { ...base };
  for (const voice of VOICE_CATALOG) {
    if (colors[voice.key]) continue;
    colors[voice.key] = voice.base ? base[voice.base] : '#ffb020';
  }
  return colors;
})();

async function decodeUrl(ctx, url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo cargar ${url.pathname.split('/').pop()}`);
  return ctx.decodeAudioData(await response.arrayBuffer());
}

function sliceSprite(sprite, entries) {
  const channel = sprite.getChannelData(0);
  const rate = sprite.sampleRate;
  const bank = new Map();
  for (const [key, [start, duration]] of entries) {
    const from = Math.floor(start * rate);
    const to = Math.min(channel.length, Math.ceil((start + duration) * rate));
    if (to > from) bank.set(key, channel.slice(from, to));
  }
  return bank;
}

async function loadLegacyBank(ctx) {
  const sprite = await decodeUrl(ctx, new URL('../audio/voces.wav', import.meta.url));
  return sliceSprite(sprite, VOICE_INDEX.map((voice) => [voice.key, [voice.start, voice.duration]]));
}

async function loadPack(ctx, lang) {
  const response = await fetch(new URL(`../audio/guias/${lang}.json`, import.meta.url));
  if (!response.ok) throw new Error(`No se pudo cargar la guía «${lang}»`);
  const index = await response.json();
  const sprite = await decodeUrl(ctx, new URL(`../audio/guias/${lang}.wav`, import.meta.url));
  return sliceSprite(sprite, Object.entries(index.voices || {}));
}

// Devuelve un Map clave -> audio mono. `bank.lang` dice qué voz quedó cargada: si el idioma
// pedido no se puede leer (por ejemplo sin internet y sin haberlo descargado antes), se usa
// la voz original para que la guía nunca quede muda.
export async function loadVoiceBank(ctx, lang = DEFAULT_GUIDE_LANG) {
  const wanted = isGuideLanguage(lang) ? lang : DEFAULT_GUIDE_LANG;
  let pack = null;
  if (wanted !== 'orig') pack = await loadPack(ctx, wanted).catch(() => null);
  const legacy = await loadLegacyBank(ctx).catch(() => null);
  if (!pack && !legacy) throw new Error('No se pudieron cargar las voces de guía');
  const bank = pack || new Map();
  if (legacy) {
    for (const [key, data] of legacy) {
      // La voz original completa lo que el idioma no tiene (Parada, Cambio, Repite). Sus números
      // solo completan el español (8 a 12): en otros idiomas se oirían en otra lengua.
      const foreignNumber = pack && wanted !== 'es' && /^n\d+$/.test(key);
      if (!bank.has(key) && !foreignNumber) bank.set(key, data);
    }
  }
  // Una sección con número sin audio propio suena como la sección sin número.
  for (const voice of VOICE_CATALOG) {
    if (voice.base && !bank.has(voice.key) && bank.has(voice.base)) bank.set(voice.key, bank.get(voice.base));
  }
  bank.lang = pack ? wanted : 'orig';
  bank.requested = wanted;
  return bank;
}
