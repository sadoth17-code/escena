// Paquete para llevar un programa del DJ a otra computadora.
//
// Las canciones del DJ se guardan solo en el dispositivo donde se añadieron (IndexedDB): no se suben a ningún
// servidor. Para usar el mismo programa en otra PC se genera un archivo, se copia (USB, correo, tu nube
// personal…) y se abre allá:
//   - Paquete completo (.zip): las canciones tal cual (sin recomprimir) y un archivo escena-dj.json con el programa.
//   - Solo el programa (.json): el mismo escena-dj.json sin audio. En la otra PC cada participante queda esperando
//     su canción y se vincula por el NOMBRE DEL ARCHIVO cuando se añaden las canciones.
//
// Este módulo no toca el DOM ni IndexedDB: arma y lee el paquete. Lo que trae el archivo se considera NO confiable
// (puede venir de cualquier lado): se valida todo, se limitan los tamaños y los números, y nunca se usan los
// identificadores que trae (la importación crea los suyos).

import { listZip, extractEntry } from './zip.js';
import { ACTIONS, MAX_SLOTS, acceptsTrigger, slotAction, slotNumber } from './dj-midi.js';
import { fadeSeconds } from './dj-math.js';

export const PACKAGE_FORMAT = 'escena-dj';
export const PACKAGE_VERSION = 1;
export const MANIFEST_NAME = 'escena-dj.json';
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
// Sin ZIP64 las posiciones del ZIP caben en 32 bits: el paquete completo no puede pasar de unos 4 GB.
export const ZIP_MAX_BYTES = 4000000000;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
export const LIMITS = Object.freeze({ programs: 60, items: 2000, tracks: 4000, triggers: 8 });

const encoder = new TextEncoder();

// ---------------------------------------------------------------- utilidades de texto y números

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const limited = (value, min, max, fallback = min) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};
const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

export const baseName = (path) => String(path || '').replace(/\\/g, '/').split('/').pop();

// Para reconocer "el mismo archivo" entre dos computadoras: sin mayúsculas ni diferencias de acentos (Mac y Windows
// guardan los acentos de forma distinta).
export function relinkKey(name) {
  return baseName(name).normalize('NFC').trim().toLowerCase();
}

// Nombre seguro para guardar dentro del ZIP o para descargar: sin carpetas ni símbolos que Windows no admite.
export function safeFileName(text, fallback = 'archivo', max = 120) {
  const clean = String(text ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!clean) return fallback;
  if (clean.length <= max) return clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 && clean.length - dot <= 8 ? clean.slice(dot) : '';
  return clean.slice(0, max - extension.length).trimEnd() + extension;
}

const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm', webm: 'audio/webm', mp4: 'audio/mp4', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf' };

export function guessAudioType(fileName) {
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(String(fileName || ''));
  return (match && AUDIO_TYPES[match[1].toLowerCase()]) || '';
}

export function entryNameFor(index, fileName) {
  return `audio/${String(index + 1).padStart(3, '0')}-${safeFileName(baseName(fileName), 'cancion')}`;
}

export function packageFileName(programNames, { audio }) {
  const base = programNames.length === 1 ? programNames[0] : `${programNames.length} programas`;
  return `Escena DJ - ${safeFileName(base, 'programa', 80)}${audio ? '' : ' (solo programa)'}.${audio ? 'zip' : 'json'}`;
}

export const estimatePackageBytes = (sizes) => sizes.reduce((total, size) => total + (Number(size) || 0) + 140, 8192);

// ---------------------------------------------------------------- CRC-32 (el que usa el formato ZIP)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

// `previous` permite seguir un cálculo por tramos: crc32(b, crc32(a)) == crc32(a + b).
export function crc32(bytes, previous = 0) {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// CRC de un archivo grande sin cargarlo entero en memoria (por tramos).
export async function crc32Blob(blob, { chunk = 4 * 1024 * 1024 } = {}) {
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += chunk) {
    const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunk)).arrayBuffer());
    crc = crc32(bytes, crc);
  }
  return crc;
}

// ---------------------------------------------------------------- escribir el ZIP

function dosStamp(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    day: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

function localHeader(nameBytes, crc, size, stamp) {
  const out = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // versión mínima para abrirlo
  view.setUint16(6, 0x0800, true); // nombres en UTF-8
  view.setUint16(8, 0, true); // sin comprimir: el audio ya viene comprimido, y así no se copia dos veces
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.day, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  out.set(nameBytes, 30);
  return out;
}

function centralHeader(record, stamp) {
  const out = new Uint8Array(46 + record.nameBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, stamp.time, true);
  view.setUint16(14, stamp.day, true);
  view.setUint32(16, record.crc, true);
  view.setUint32(20, record.size, true);
  view.setUint32(24, record.size, true);
  view.setUint16(28, record.nameBytes.length, true);
  view.setUint32(42, record.offset, true);
  out.set(record.nameBytes, 46);
  return out;
}

// Arma un ZIP sin comprimir. `files`: [{ name, blob | bytes, crc? }]. No copia el audio: el resultado es un Blob que
// apunta a los archivos originales, así que un paquete grande no ocupa memoria dos veces.
export async function buildZip(files, { date = new Date(), onProgress } = {}) {
  if (files.length > 0xfffe) throw new Error('Hay demasiados archivos para un solo paquete.');
  const stamp = dosStamp(date);
  const parts = [];
  const records = [];
  let offset = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const blob = file.blob || new Blob([file.bytes || new Uint8Array(0)]);
    if (blob.size >= 0xffffffff) throw new Error(`«${file.name}» es demasiado grande para el paquete.`);
    if (onProgress) onProgress({ index, total: files.length, name: file.name });
    const crc = file.crc !== undefined ? file.crc : file.bytes ? crc32(file.bytes) : await crc32Blob(blob);
    const nameBytes = encoder.encode(file.name);
    const header = localHeader(nameBytes, crc, blob.size, stamp);
    records.push({ nameBytes, crc, size: blob.size, offset });
    parts.push(header, blob);
    offset += header.length + blob.size;
    if (offset >= 0xffffffff) throw new Error('El paquete pasaría de 4 GB. Lleva menos canciones (un programa a la vez) o usa «Solo el programa».');
  }
  const central = records.map((record) => centralHeader(record, stamp));
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  if (offset + centralSize + 22 >= 0xffffffff) throw new Error('El paquete pasaría de 4 GB. Lleva menos canciones (un programa a la vez) o usa «Solo el programa».');
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, records.length, true);
  view.setUint16(10, records.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// ---------------------------------------------------------------- el programa (escena-dj.json)

// `programs`: [{ name, items: [{ track: ref, label, start, maxDur, gainDb }] }]
// `tracks`:   [{ ref, name, file, type, size, duration, entry }]   (entry: ruta dentro del ZIP, '' si no trae audio)
// `settings`: { fade, autoAdvance, bindings } | null
export function buildManifest({ programs, tracks, settings = null, audio = false, created = new Date() }) {
  const manifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    app: 'Escena DJ',
    created: created.toISOString(),
    audio: Boolean(audio),
    programs: programs.map((entry) => ({
      name: entry.name,
      items: entry.items.map((item) => ({ track: item.track, label: item.label || '', start: round(item.start, 3), maxDur: round(item.maxDur, 3), gainDb: round(item.gainDb, 1) })),
    })),
    tracks: tracks.map((track) => ({ ref: track.ref, name: track.name, file: track.file, type: track.type || '', size: track.size || 0, duration: round(track.duration, 3), entry: track.entry || '' })),
  };
  if (settings) {
    manifest.settings = {};
    if (settings.fade !== undefined) manifest.settings.fade = settings.fade;
    if (settings.autoAdvance !== undefined) manifest.settings.autoAdvance = Boolean(settings.autoAdvance);
    if (settings.bindings) {
      manifest.settings.bindings = {};
      for (const [action, triggers] of Object.entries(settings.bindings)) manifest.settings.bindings[action] = Array.from(triggers || []);
    }
  }
  return manifest;
}

export const serializeManifest = (manifest) => JSON.stringify(manifest, null, 2);

export function readmeText() {
  return [
    'Paquete de Escena DJ',
    '',
    'Este archivo guarda un programa del DJ de Escena (participantes, orden, tiempos y pads) con sus canciones.',
    'No lo descomprimas: ábrelo desde Escena. En la otra computadora entra a la pestaña DJ, pulsa «Llevar a otra PC»',
    'y, en «Traer a esta PC», elige «Elegir un paquete…» (o arrastra este archivo a la pantalla del DJ).',
    'Las canciones se guardan en ese dispositivo y no se suben a ningún servidor.',
    '',
    'escena-dj.json  = el programa.   audio/  = las canciones.',
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------- leer y validar el programa

const MIME = /^(?:audio|video)\/[a-z0-9.+-]{1,60}$/i;

function validTrigger(value) {
  if (typeof value !== 'string' || value.length > 48) return false;
  if (value.startsWith('k:')) return /^k:[^\u0000-\u001f\u007f]{1,40}$/.test(value);
  let match = /^[ncp]:(\d{1,2}):(\d{1,3})$/.exec(value);
  if (match) return Number(match[1]) >= 1 && Number(match[1]) <= 16 && Number(match[2]) <= 127;
  match = /^b:(\d{1,2})$/.exec(value);
  return Boolean(match) && Number(match[1]) >= 1 && Number(match[1]) <= 16;
}

function validAction(id) {
  if (ACTIONS.some((action) => action.id === id)) return true;
  const number = slotNumber(id);
  return number >= 1 && number <= MAX_SLOTS && slotAction(number) === id;
}

// Asignaciones de pads/teclas: solo acciones conocidas y disparadores bien formados; un botón hace una sola cosa.
function cleanBindings(raw) {
  if (!isObject(raw)) return null;
  const out = {};
  const used = new Set();
  let any = false;
  for (const id of Object.keys(raw)) {
    if (!validAction(id)) continue;
    const triggers = [];
    const list = Array.isArray(raw[id]) ? raw[id].slice(0, 32) : [];
    for (const trigger of list) {
      if (triggers.length >= LIMITS.triggers) break;
      if (!validTrigger(trigger) || used.has(trigger) || !acceptsTrigger(id, trigger)) continue;
      used.add(trigger);
      triggers.push(trigger);
    }
    out[id] = triggers;
    if (triggers.length) any = true;
  }
  return any ? out : null;
}

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  throw error;
}

// Devuelve el programa ya limpio. Lanza un Error con un mensaje claro si el archivo no sirve.
export function parseManifest(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input.replace(/^﻿/, ''));
    } catch {
      fail('Ese archivo no es un paquete de Escena DJ (no se pudo leer).');
    }
  }
  if (!isObject(data) || data.format !== PACKAGE_FORMAT) fail('Ese archivo no es un paquete de Escena DJ.');
  const version = data.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) fail('Ese paquete no indica de qué versión es. Vuelve a crearlo desde Escena.');
  if (version > PACKAGE_VERSION) fail('Ese paquete se creó con una versión más nueva de Escena DJ. Actualiza Escena en este equipo y vuelve a intentarlo.');

  const rawTracks = Array.isArray(data.tracks) ? data.tracks : [];
  const rawPrograms = Array.isArray(data.programs) ? data.programs : [];
  if (rawTracks.length > LIMITS.tracks) fail('El paquete trae demasiadas canciones para abrirlo.');
  if (rawPrograms.length > LIMITS.programs) fail('El paquete trae demasiados programas para abrirlo.');

  const tracks = [];
  const refs = new Set();
  for (const raw of rawTracks) {
    if (!isObject(raw)) continue;
    const ref = cleanText(raw.ref, 64);
    if (!ref || refs.has(ref)) continue;
    refs.add(ref);
    const file = baseName(cleanText(raw.file, 255));
    const name = cleanText(raw.name, 120) || file.replace(/\.[A-Za-z0-9]{2,5}$/, '') || 'Canción';
    tracks.push({
      ref,
      name,
      file: file || name,
      type: typeof raw.type === 'string' && MIME.test(raw.type.trim()) ? raw.type.trim().toLowerCase() : '',
      size: Math.floor(limited(raw.size, 0, Number.MAX_SAFE_INTEGER, 0)),
      duration: round(limited(raw.duration, 0, 86400, 0), 3),
      entry: cleanText(raw.entry, 512),
    });
  }

  let dropped = 0;
  const programs = [];
  for (const raw of rawPrograms) {
    if (!isObject(raw) || !Array.isArray(raw.items)) continue;
    if (raw.items.length > LIMITS.items) fail('Un programa del paquete trae demasiados participantes para abrirlo.');
    const items = [];
    for (const entry of raw.items) {
      if (!isObject(entry)) continue;
      const ref = cleanText(entry.track, 64);
      if (!refs.has(ref)) {
        dropped++;
        continue;
      }
      items.push({
        track: ref,
        label: cleanText(entry.label, 80),
        start: round(limited(entry.start, 0, 86400, 0), 3),
        maxDur: round(limited(entry.maxDur, 0, 86400, 0), 3),
        gainDb: round(limited(entry.gainDb, -24, 12, 0), 1),
      });
    }
    programs.push({ name: cleanText(raw.name, 60) || 'Programa importado', items });
  }
  if (!programs.length) fail('El paquete no trae ningún programa.');

  let settings = null;
  if (isObject(data.settings)) {
    settings = {};
    if (typeof data.settings.fade === 'number' && Number.isFinite(data.settings.fade)) settings.fade = data.settings.fade <= 0 ? 0 : round(fadeSeconds(data.settings.fade), 2);
    if (typeof data.settings.autoAdvance === 'boolean') settings.autoAdvance = data.settings.autoAdvance;
    const bindings = cleanBindings(data.settings.bindings);
    if (bindings) settings.bindings = bindings;
    if (!Object.keys(settings).length) settings = null;
  }

  return {
    version,
    created: typeof data.created === 'string' && !Number.isNaN(Date.parse(data.created)) ? data.created : '',
    audio: data.audio === true,
    programs,
    tracks,
    settings,
    dropped,
  };
}

// ---------------------------------------------------------------- abrir un paquete (.zip o .json)

// Lee los CRC guardados en el directorio central del ZIP (zip.js no los entrega). Sin ellos no se verifica, pero se puede abrir.
async function readCentralCrcs(blob) {
  const crcs = new Map();
  try {
    const size = blob.size;
    const tailLength = Math.min(size, 65557);
    const tail = new DataView(await blob.slice(size - tailLength, size).arrayBuffer());
    let end = -1;
    for (let index = tailLength - 22; index >= 0; index--) {
      if (tail.getUint32(index, true) === 0x06054b50) {
        end = index;
        break;
      }
    }
    if (end < 0) return crcs;
    const total = tail.getUint16(end + 10, true);
    const centralSize = tail.getUint32(end + 12, true);
    const centralOffset = tail.getUint32(end + 16, true);
    const central = new DataView(await blob.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
    let pointer = 0;
    for (let n = 0; n < total && pointer + 46 <= central.byteLength; n++) {
      if (central.getUint32(pointer, true) !== 0x02014b50) break;
      crcs.set(central.getUint32(pointer + 42, true), central.getUint32(pointer + 16, true));
      pointer += 46 + central.getUint16(pointer + 28, true) + central.getUint16(pointer + 30, true) + central.getUint16(pointer + 32, true);
    }
  } catch {
    // sin CRC no se verifica
  }
  return crcs;
}

const entryKey = (name) => String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFC').toLowerCase();

async function readZipPackage(file) {
  let entries;
  try {
    entries = await listZip(file);
  } catch (error) {
    fail((error && error.message) || 'No se pudo abrir el ZIP.');
  }
  const files = entries.filter((entry) => !entry.directory);
  const manifests = files.filter((entry) => baseName(entry.name).toLowerCase() === MANIFEST_NAME);
  if (!manifests.length) fail(`Ese ZIP no es un paquete de Escena DJ: no trae «${MANIFEST_NAME}». Los paquetes se crean con «Llevar a otra PC» en la pestaña DJ.`);
  // Si el paquete se volvió a comprimir dentro de una carpeta, se usa el programa más cercano a la raíz.
  manifests.sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  const manifestEntry = manifests[0];
  if (manifestEntry.size > MAX_MANIFEST_BYTES) fail('El programa que trae el paquete es demasiado grande para abrirlo.');
  let manifest;
  try {
    manifest = parseManifest(await (await extractEntry(file, manifestEntry)).text());
  } catch (error) {
    fail((error && error.message) || 'No se pudo leer el programa del paquete.');
  }
  const prefix = manifestEntry.name.replace(/\\/g, '/').slice(0, manifestEntry.name.replace(/\\/g, '/').lastIndexOf('/') + 1);
  const byKey = new Map();
  for (const entry of files) byKey.set(entryKey(entry.name), entry);
  const find = (track) => {
    if (!track.entry) return null;
    const wanted = track.entry.replace(/\\/g, '/').replace(/^\/+/, '');
    return byKey.get(entryKey(prefix + wanted)) || byKey.get(entryKey(wanted)) || null;
  };
  const crcs = await readCentralCrcs(file);
  return {
    kind: 'zip',
    fileName: file.name || '',
    manifest,
    // Tamaño del audio de esa canción dentro del paquete (null si el paquete no la trae).
    audioSize(track) {
      const entry = find(track);
      return entry ? entry.size : null;
    },
    // El audio, ya comprobado contra su CRC: un paquete a medio copiar o alterado se detecta aquí.
    async readAudio(track) {
      const entry = find(track);
      if (!entry) return null;
      if (entry.size > MAX_ENTRY_BYTES) fail(`«${track.file}» es demasiado grande.`);
      const data = await extractEntry(file, entry);
      const expected = crcs.get(entry.headerOffset);
      if (expected !== undefined && (await crc32Blob(data)) !== expected) {
        fail(`«${track.file}» llegó dañada en el paquete (la copia se interrumpió o el archivo cambió). Vuelve a copiar el paquete.`, 'damaged');
      }
      return data;
    },
  };
}

export async function readPackage(file) {
  if (!file || typeof file.slice !== 'function') fail('No se pudo leer el archivo.');
  if (!file.size) fail('El archivo está vacío.');
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) return readZipPackage(file);
  if (file.size > MAX_MANIFEST_BYTES) fail('Ese archivo no es un paquete de Escena DJ (es demasiado grande para ser solo el programa).');
  const manifest = parseManifest(await file.text());
  return {
    kind: 'json',
    fileName: file.name || '',
    manifest,
    audioSize: () => null,
    readAudio: async () => null,
  };
}
