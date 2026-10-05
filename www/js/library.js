import { uid, naturalCompare, normalizeName, PALETTE, FADER_DEFAULT } from './util.js';
import { listZip, extractEntry } from './zip.js';
import { normalizeTempoEntries } from './tempo.js';

export const AUDIO_PATTERN = /\.(wav|wave|mp3|m4a|aac|flac|ogg|oga|opus|aif|aiff|caf)$/i;
const CLICK_PATTERN = /(^|[^a-z])(click|clic|metronomo|metro)([^a-z]|$)/;
const GUIDE_PATTERN = /(^|[^a-z])(cue|cues|guia|guias|guide|guides|voz guia|count|conteo|cuenta)([^a-z]|$)/;

export const isAudioName = (name) => AUDIO_PATTERN.test(name);
export const isClickName = (name) => CLICK_PATTERN.test(normalizeName(name));
export const isGuideName = (name) => GUIDE_PATTERN.test(normalizeName(name));
export const isCueName = (name) => isClickName(name) || isGuideName(name);

export const DEFAULT_CLICK = {
  id: 'click',
  name: 'Click',
  vol: FADER_DEFAULT,
  pan: 0,
  mute: false,
  solo: false,
  dest: 'cue',
  sound: 'madera',
  subdivision: 1,
  countIn: 1,
};

export const DEFAULT_GUIDE = {
  id: 'guide',
  name: 'Guía de voz',
  voiceBank: 'classic',
  vol: FADER_DEFAULT,
  pan: 0,
  mute: false,
  solo: false,
  dest: 'cue',
  leadBars: 1,
  counting: true,
};

export function stripExtension(name) {
  return name.replace(/\.[^.\\/]+$/, '');
}

function baseName(path) {
  return path.split(/[\\/]/).pop();
}

export async function gatherAudio(fileList, onProgress) {
  const items = [];
  const skipped = [];
  const entries = Array.from(fileList).map((entry) => (entry.file ? entry : { file: entry, path: entry.webkitRelativePath || '' }));
  let index = 0;
  for (const { file, path } of entries) {
    index++;
    if (onProgress) onProgress(index, entries.length, file.name);
    if (/\.zip$/i.test(file.name)) {
      const listing = await listZip(file);
      for (const entry of listing) {
        const name = baseName(entry.name);
        if (entry.directory || entry.name.startsWith('__MACOSX/') || name.startsWith('._') || !isAudioName(name)) continue;
        const blob = await extractEntry(file, entry);
        items.push({ name, path: entry.name, blob: new Blob([blob], { type: guessMime(name) }), origin: stripExtension(file.name) });
      }
    } else if (isAudioName(file.name)) {
      items.push({ name: file.name, path: path || file.name, blob: file, origin: path ? path.split('/')[0] : '' });
    } else {
      skipped.push(file.name);
    }
  }
  items.sort((a, b) => naturalCompare(a.path, b.path));
  return { items, skipped };
}

export async function readDropped(dataTransfer) {
  const out = [];
  const readEntries = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      out.push({ file: await fileOf(entry), path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await readEntries(reader);
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  const roots = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) roots.push(entry);
    else if (item.getAsFile()) out.push({ file: item.getAsFile(), path: '' });
  }
  for (const entry of roots) await walk(entry, '');
  if (!out.length) for (const file of Array.from(dataTransfer.files || [])) out.push({ file, path: '' });
  return out;
}

export function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    const parts = item.path.split(/[\\/]/);
    parts.pop();
    const dir = parts.join('/');
    const key = `${item.origin || ''}|${dir}`;
    if (!groups.has(key)) groups.set(key, { key, dir, origin: item.origin || '', items: [] });
    groups.get(key).items.push(item);
  }
  const list = Array.from(groups.values());
  for (const group of list) {
    const last = group.dir.split('/').filter(Boolean).pop();
    const own = list.length > 1 ? last || group.origin : '';
    group.title = (own || guessTitle(group.items)).replace(/[_]+/g, ' ').trim();
  }
  return list;
}

export function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    wav: 'audio/wav',
    wave: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    aif: 'audio/aiff',
    aiff: 'audio/aiff',
    caf: 'audio/x-caf',
  };
  return map[ext] || 'application/octet-stream';
}

export function commonPrefix(names) {
  if (names.length < 2) return '';
  let prefix = names[0];
  for (const name of names) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i].toLowerCase() === name[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  const cut = prefix.search(/[\s._-][^\s._-]*$/);
  if (cut > 2 && prefix.length - cut < prefix.length) prefix = prefix.slice(0, cut + 1);
  return prefix.length >= 4 ? prefix : '';
}

export function cleanTrackName(stem, prefix) {
  let name = stem;
  if (prefix && name.toLowerCase().startsWith(prefix.toLowerCase())) name = name.slice(prefix.length);
  name = name.replace(/^[\s._-]*\d{1,3}[\s._-]+/, '').replace(/[_]+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '').trim();
  return name || stem;
}

export function guessTitle(items) {
  const origin = items.find((item) => item.origin)?.origin;
  if (origin) return origin.replace(/[_]+/g, ' ').trim();
  const stems = items.map((item) => stripExtension(item.name));
  const prefix = commonPrefix(stems).replace(/[\s._-]+$/, '').replace(/^\d+[\s._-]*/, '');
  if (prefix) return prefix;
  return stems.length === 1 ? stems[0] : 'Canción nueva';
}

export function draftTracks(items) {
  const stems = items.map((item) => stripExtension(item.name));
  const prefix = commonPrefix(stems);
  return items.map((item, index) => {
    const name = cleanTrackName(stems[index], prefix);
    const click = isClickName(name) || isClickName(stems[index]);
    const guide = isGuideName(name) || isGuideName(stems[index]);
    return {
      key: uid(),
      item,
      name,
      click,
      guide,
      dest: click || guide ? 'cue' : 'main',
      mono: false,
      keep: true,
    };
  });
}

export function createSong(title, tracks) {
  const now = Date.now();
  return normalizeSong({
    id: uid(),
    title: title || 'Canción nueva',
    artist: '',
    key: '',
    offsetMs: 0,
    tempoMap: [{ bar: 1, bpm: 120, num: 4, den: 4 }],
    markers: [],
    click: { sound: 'sample-classic' },
    guide: { voiceBank: 'samples-es' },
    tracks,
    createdAt: now,
    updatedAt: now,
  });
}

export function createTrackDef(draft, fileId, index) {
  return {
    id: uid(),
    name: draft.name,
    fileId,
    color: draft.dest === 'cue' ? '#ffb020' : PALETTE[index % PALETTE.length],
    dest: draft.dest,
    vol: FADER_DEFAULT,
    pan: 0,
    mute: false,
    solo: false,
    mono: Boolean(draft.mono),
    bytes: draft.item.blob.size,
    duration: 0,
  };
}

export function normalizeSong(raw) {
  const song = { ...raw };
  song.title = String(song.title || 'Sin título');
  song.artist = String(song.artist || '');
  song.key = String(song.key || '');
  song.offsetMs = Number(song.offsetMs) || 0;
  song.tempoMap = normalizeTempoEntries(song.tempoMap);
  song.markers = (song.markers || [])
    .map((marker) => ({
      id: marker.id || uid(),
      name: String(marker.name || 'Sección'),
      bar: Math.max(1, Math.round(Number(marker.bar) || 1)),
      voice: marker.voice || '',
      color: marker.color || '#35c9ff',
    }))
    .sort((a, b) => a.bar - b.bar);
  song.tracks = (song.tracks || []).map((track, index) => ({
    id: track.id || uid(),
    name: String(track.name || `Pista ${index + 1}`),
    fileId: track.fileId,
    color: track.color || PALETTE[index % PALETTE.length],
    dest: track.dest === 'cue' ? 'cue' : 'main',
    vol: typeof track.vol === 'number' ? track.vol : FADER_DEFAULT,
    pan: typeof track.pan === 'number' ? track.pan : 0,
    mute: Boolean(track.mute),
    solo: false,
    mono: Boolean(track.mono),
    bytes: Number(track.bytes) || 0,
    duration: Number(track.duration) || 0,
  }));
  song.click = { ...DEFAULT_CLICK, ...(song.click || {}), id: 'click', solo: false };
  song.guide = { ...DEFAULT_GUIDE, ...(song.guide || {}), id: 'guide', solo: false };
  song.createdAt = song.createdAt || Date.now();
  song.updatedAt = song.updatedAt || song.createdAt;
  return song;
}

export function serializableSong(song) {
  const clone = JSON.parse(JSON.stringify(song));
  for (const track of clone.tracks) track.solo = false;
  clone.click.solo = false;
  clone.guide.solo = false;
  return clone;
}

export function songDuration(song) {
  return song.tracks.reduce((max, track) => Math.max(max, track.duration || 0), 0);
}

export function songBytes(song) {
  return song.tracks.reduce((sum, track) => sum + (track.bytes || 0), 0);
}

export function createSetlist(name) {
  return { id: uid(), name: name || 'Setlist', songIds: [], createdAt: Date.now() };
}
