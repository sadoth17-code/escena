// Cifrado de la canción: lectura del texto, transposición, nombres de notas y ubicación en el tiempo.
// No usa DOM ni audio: lo comparten el panel de Escena, la transmisión en vivo y la página de los músicos.
//
// Formato del texto (una sección por bloque, un compás entre barras, varios acordes en un compás se
// reparten en partes iguales):
//
//   Tono: G
//   [Intro]
//   | G | D | Em | C |
//   [Verso 1]
//   | G | D/F# | Em7 | C . . D |
//   Letra o notas opcionales (cualquier línea sin barras)
//   [Coro]
//   | C | G | Am | F | x2
//
// «%» repite el compás anterior; «.» o un compás vacío sostiene el acorde; «xN» al final repite la línea.
// Los acordes se leen en letras (C D E…) o en nombres (Do Re Mi…), con # o b, calidad y bajo (Am7/G).

const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, Do: 0, Re: 2, Mi: 4, Fa: 5, Sol: 7, La: 9, Si: 11 };
const ABC_NAT = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
const LAT_NAT = { 0: 'Do', 2: 'Re', 4: 'Mi', 5: 'Fa', 7: 'Sol', 9: 'La', 11: 'Si' };
const TABLES = {
  abc: {
    sharp: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
    flat: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'],
  },
  latino: {
    sharp: ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'],
    flat: ['Do', 'Reb', 'Re', 'Mib', 'Mi', 'Fa', 'Solb', 'Sol', 'Lab', 'La', 'Sib', 'Si'],
  },
};
// Lo que puede ir detrás de la nota: m, 7, maj7, sus4, add9, dim, aug, (b5), +, °, ø, Δ…
const QUALITY = /^(?:maj|min|dim|aug|sus|add|alt|m|M|\+|-|°|º|ø|Δ|∆|\d|\(|\)|#|b|♯|♭|,)*$/;
const SECTION_WORD = /^(intro|introducci[oó]n|verso|estrofa|pre[- ]?coro|coro|estribillo|puente|interludio|instrumental|solo|final|outro|tag|coda|verse|chorus|pre[- ]?chorus|bridge|interlude|ending|turnaround)\b/i;
const HOLD = new Set(['.', '-', '–', '·']);
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1]); // F, Bb, Eb, Ab, Db
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]); // Dm, Gm, Cm, Fm, Bbm, Ebm

const accidental = a => (a === '♯' ? '#' : a === '♭' ? 'b' : a);
const offset = a => (a === '#' ? 1 : a === 'b' ? -1 : 0);
const pitch = n => (((n.nat + offset(n.acc)) % 12) + 12) % 12;

function roots(text) {
  const found = [];
  const latin = /^(Sol|Do|Re|Mi|Fa|La|Si)([#b♯♭]?)/.exec(text);
  if (latin) found.push(latin);
  const letter = /^([A-G])([#b♯♭]?)/.exec(text);
  if (letter) found.push(letter);
  return found;
}

function parseNote(text) {
  for (const m of roots(text)) if (m[0].length === text.length) return { nat: NATURAL[m[1]], acc: accidental(m[2]) };
  return null;
}

// Devuelve { nat, acc, q, bass } o null si el texto no es un acorde («Fadd9» es F + add9, no Fa + dd9).
export function parseChord(token) {
  if (!token || token.length > 24) return null;
  for (const m of roots(token)) {
    const parts = token.slice(m[0].length).split('/');
    if (parts.length > 2 || !QUALITY.test(parts[0])) continue;
    let bass = null;
    if (parts.length === 2) {
      bass = parseNote(parts[1]);
      if (!bass) continue;
    }
    return { nat: NATURAL[m[1]], acc: accidental(m[2]), q: parts[0], bass };
  }
  return null;
}

function formatNote(note, shift, notation, flats) {
  const s = ((Math.round(shift) % 12) + 12) % 12;
  if (s === 0) return (notation === 'latino' ? LAT_NAT : ABC_NAT)[note.nat] + note.acc;
  return TABLES[notation === 'latino' ? 'latino' : 'abc'][flats ? 'flat' : 'sharp'][(pitch(note) + s) % 12];
}

export function formatChord(chord, { shift = 0, notation = 'abc', flats = false } = {}) {
  return formatNote(chord, shift, notation, flats) + chord.q + (chord.bass ? `/${formatNote(chord.bass, shift, notation, flats)}` : '');
}

const isMinor = q => /^(m(?!aj)|min|-)/.test(q);

// ¿Conviene escribir bemoles tras transponer? Se decide por el tono, o por los acordes si no hay tono.
export function prefersFlats(keyText, shift, chords = []) {
  const key = parseChord(String(keyText || '').trim());
  if (key) {
    const pc = (pitch(key) + (((Math.round(shift) % 12) + 12) % 12)) % 12;
    return isMinor(key.q) ? FLAT_MINOR.has(pc) : FLAT_MAJOR.has(pc);
  }
  let flats = 0;
  let sharps = 0;
  for (const chord of chords) for (const note of [chord, chord.bass]) {
    if (note?.acc === 'b') flats++;
    else if (note?.acc === '#') sharps++;
  }
  return flats > sharps;
}

// Tono tal como se muestra: «G» → «A» al subir un tono.
export function formatKey(keyText, opts = {}) {
  const key = parseChord(String(keyText || '').trim());
  if (!key) return String(keyText || '').trim();
  return formatChord(key, { ...opts, flats: prefersFlats(keyText, opts.shift || 0) });
}

const barOf = text => ({ chords: text.split(/\s+/).filter(Boolean).map(raw => ({ raw, chord: parseChord(raw) })) });
const isChordLike = t => Boolean(parseChord(t)) || t === '%' || t === 'N.C.' || t === 'NC' || HOLD.has(t);

function pushBars(section, bars, times) {
  const all = [];
  for (let i = 0; i < times; i++) all.push(...bars);
  section.rows.push({ type: 'bars', from: section.bars.length, count: all.length });
  section.bars.push(...all);
}

// Texto → { key, sections: [{ name, rows, bars }] }. Nunca falla: lo que no se entiende queda como texto.
export function parseChart(text) {
  const chart = { key: '', sections: [] };
  let section = null;
  const open = name => { section = { name, rows: [], bars: [] }; chart.sections.push(section); };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\t/g, ' ').trim();
    if (!line) continue;
    const key = /^(?:tono|tonalidad|key|clave)\s*[:=]\s*(.+)$/i.exec(line);
    if (key) { chart.key = key[1].trim(); continue; }
    const head = /^\[([^\]]+)\]\s*$/.exec(line) || /^#{1,3}\s*(.+?)\s*$/.exec(line) || (SECTION_WORD.test(line) ? /^(.+?)\s*:\s*$/.exec(line) : null);
    if (head) { open(head[1].trim()); continue; }
    if (!section) open('');
    if (line.includes('|')) {
      const parts = line.split('|').map(part => part.trim());
      if (parts[0] === '') parts.shift();
      if (parts.length && parts[parts.length - 1] === '') parts.pop();
      let times = 1;
      const repeat = parts.length ? /^x\s*(\d{1,2})$/i.exec(parts[parts.length - 1]) : null;
      if (repeat) { times = Math.min(16, Math.max(1, Number(repeat[1]))); parts.pop(); }
      if (parts.length) { pushBars(section, parts.map(barOf), times); continue; }
    }
    const tokens = line.split(/\s+/);
    const lone = tokens.length === 1 && /^(Sol|Do|Re|Mi|Fa|La|Si|A)$/.test(tokens[0]);
    if (!line.includes('|') && !lone && tokens.every(isChordLike) && tokens.some(t => parseChord(t) || t === '%')) {
      pushBars(section, tokens.map(barOf), 1);
      continue;
    }
    section.rows.push({ type: 'text', text: line });
  }
  return chart;
}

const norm = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const baseName = text => norm(text).replace(/\s+(\d+|i|ii|iii|iv|v)$/, '');

function pick(named, name, used) {
  let list = named.filter(block => norm(block.name) === norm(name));
  if (!list.length) list = named.filter(block => baseName(block.name) === baseName(name));
  if (!list.length) return null;
  const key = norm(name);
  const seen = used.get(key) || 0;
  used.set(key, seen + 1);
  return list[Math.min(seen, list.length - 1)];
}

// Resuelve «%», «.» y compases vacíos. Cada compás se divide en tantas partes iguales como símbolos tenga
// («C . . D» son cuatro tiempos: C, C, C, D). `slots[j]` es el acorde que suena en la parte j y `src[j]`
// el símbolo del compás que lo origina, para resaltarlo.
function resolve(block) {
  const bars = [];
  let last = null;
  let previous = null;
  for (const bar of block ? block.bars : []) {
    const tokens = bar.chords;
    let slots = [];
    let src = [];
    if (tokens.length === 1 && tokens[0].raw === '%' && previous) {
      slots = previous.slots;
      src = previous.slots.map(() => 0);
    } else if (!tokens.length) {
      if (last) { slots = [last]; src = [0]; }
    } else {
      let from = -1;
      tokens.forEach((token, j) => {
        if (!HOLD.has(token.raw) && token.raw !== '%') { last = token; from = j; }
        if (last) { slots.push(last); src.push(Math.max(0, from)); }
      });
    }
    if (slots.length) last = slots[slots.length - 1];
    previous = { slots };
    bars.push({ show: tokens.length ? tokens : [{ raw: '.', chord: null }], slots, src });
  }
  return bars;
}

// Une el cifrado con la estructura de la canción. `song` trae { bars, sections: [{ n, c, b }] }.
// Cada sección de la canción recibe el bloque del cifrado con su nombre (o el más parecido); un bloque
// escrito una sola vez sirve para todas las veces que la sección se repite («Coro» tres veces).
export function buildLayout(song, chart) {
  const sections = song.sections || [];
  const total = (song.bars || []).length;
  const blocks = chart.sections.filter(block => block.bars.length || block.rows.length);
  const named = blocks.filter(block => block.name);
  const headless = blocks.find(block => !block.name);
  const items = [];
  const notes = [];
  if (headless && !named.length && headless.bars.length) {
    items.push({ name: 'Cifrado', color: '#64748b', section: -1, startBar: 1, endBar: total + 1, rows: headless.rows, bars: resolve(headless) });
  } else {
    if (headless) for (const row of headless.rows) if (row.type === 'text') notes.push(row.text);
    const used = new Map();
    sections.forEach((s, i) => {
      const block = pick(named, s.n, used);
      items.push({
        name: s.n, color: s.c, section: i, startBar: s.b, endBar: sections[i + 1] ? sections[i + 1].b : total + 1,
        rows: block ? block.rows : [], bars: resolve(block),
      });
    });
  }
  for (const item of items) item.span = Math.max(0, Math.min(item.bars.length, item.endBar - item.startBar));
  return { key: chart.key, items, notes, hasChords: items.some(item => item.bars.length > 0) };
}

export function allChords(layout) {
  const list = [];
  for (const item of layout.items) for (const bar of item.bars) for (const c of bar.slots) if (c.chord) list.push(c.chord);
  return list;
}

// Dónde cae un número de compás dentro del cifrado: { item, k, bar } o null.
export function barAt(layout, barNo) {
  for (const item of layout.items) {
    if (barNo >= item.startBar && barNo < item.startBar + item.span) {
      const k = barNo - item.startBar;
      return { item, k, bar: item.bars[k] };
    }
  }
  return null;
}

// Acorde que suena y el siguiente distinto (hasta ocho compases adelante), ya con tono y notación.
// `index` es el símbolo del compás que hay que resaltar.
export function chordNow(layout, barNo, frac, opts) {
  const show = chord => (chord.chord ? formatChord(chord.chord, opts) : chord.raw);
  const here = barAt(layout, barNo);
  if (!here || !here.bar.slots.length) return { now: '', next: '', index: -1 };
  const slots = here.bar.slots;
  const slot = Math.min(slots.length - 1, Math.floor(Math.max(0, Math.min(0.9999, frac)) * slots.length));
  const now = show(slots[slot]);
  let next = '';
  for (let step = 0; step <= 8 && !next; step++) {
    const target = step === 0 ? here : barAt(layout, barNo + step);
    if (!target) break;
    for (let j = step === 0 ? slot + 1 : 0; j < target.bar.slots.length; j++) {
      const text = show(target.bar.slots[j]);
      if (text !== now) { next = text; break; }
    }
  }
  return { now, next, index: here.bar.src[slot] };
}

// Compás, avance dentro del compás y sección para un instante (segundos) de la canción.
export function locate(song, pos) {
  const bars = song.bars || [];
  let lo = 0;
  let hi = bars.length - 1;
  let index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid] <= pos + 0.005) { index = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const sections = song.sections || [];
  let section = 0;
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].s <= pos + 0.01) section = i; else break;
  }
  let frac = 0;
  if (index >= 0) {
    const start = bars[index];
    const end = index + 1 < bars.length ? bars[index + 1] : Math.max(start + 0.001, song.duration || start + 1);
    frac = Math.max(0, Math.min(1, (pos - start) / Math.max(0.001, end - start)));
  }
  return { bar: index + 1, frac, section };
}

// Posición de la canción ahora mismo a partir del último estado recibido del director.
// `live.at` es el reloj local (ms) en que llegó, `wait` lo que faltaba para que la música arrancara
// (pre-conteo) y `oneWay` el retraso estimado de la red, en segundos.
export function extrapolate(live, nowMs, oneWay = 0) {
  if (!live) return 0;
  // Un mensaje retenido (`fresh === false`) es una foto vieja del servidor: no avanza solo.
  if (live.fresh === false || live.state !== 'playing') return live.pos || 0;
  const elapsed = (nowMs - live.at) / 1000 + oneWay - (live.wait || 0);
  if (elapsed <= 0) return live.pos || 0;
  let pos = (live.pos || 0) + elapsed;
  const loop = live.loop;
  if (loop && loop.b > loop.a && pos > loop.b) pos = loop.a + ((pos - loop.a) % (loop.b - loop.a));
  return Math.min(pos, live.duration || pos);
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Esqueleto del cifrado con una sección por marcador y el número exacto de compases de cada una.
export function templateFor(song) {
  const sections = song.sections || [];
  const total = (song.bars || []).length;
  return sections.map((s, i) => {
    const count = Math.max(0, (sections[i + 1] ? sections[i + 1].b : total + 1) - s.b);
    const lines = [`[${s.n}]`];
    for (let k = 0; k < count; k += 4) lines.push(`|${'     |'.repeat(Math.min(4, count - k))}`);
    return lines.join('\n');
  }).join('\n\n');
}
