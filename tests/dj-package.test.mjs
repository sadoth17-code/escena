// Pruebas del paquete para llevar un programa del DJ a otra PC (sin navegador).
// Ejecutar: node --test tests/dj-package.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmitter } from '../www/js/util.js';
import { listZip, extractEntry } from '../www/js/zip.js';
import { createMemoryDjStore } from '../www/js/dj-store.js';
import { createDj } from '../www/js/dj.js';
import { DEFAULT_BINDINGS } from '../www/js/dj-midi.js';
import * as pack from '../www/js/dj-package.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => new TextEncoder().encode(value);
const readText = async (blob) => new TextDecoder().decode(await blob.arrayBuffer());

const abiertos = [];
after(() => abiertos.forEach((dj) => dj.destroy()));

// ------------------------------------------------------------------ CRC-32

test('crc32: valores conocidos y cálculo por tramos', async () => {
  assert.equal(pack.crc32(text('')), 0);
  assert.equal(pack.crc32(text('123456789')), 0xcbf43926);
  assert.equal(pack.crc32(text('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  const whole = pack.crc32(text('Escena DJ: mezcla suave entre canciones'));
  const parts = pack.crc32(text(' mezcla suave entre canciones'), pack.crc32(text('Escena DJ:')));
  assert.equal(parts, whole);
  const big = new Uint8Array(300001).map((_, index) => (index * 31 + 7) & 255);
  assert.equal(await pack.crc32Blob(new Blob([big]), { chunk: 4096 }), pack.crc32(big));
  assert.equal(await pack.crc32Blob(new Blob([big]), { chunk: 1024 * 1024 }), pack.crc32(big));
  assert.equal(await pack.crc32Blob(new Blob([])), 0);
});

// ------------------------------------------------------------------ ZIP

test('buildZip: lo que escribe lo leen zip.js y el programa unzip del sistema, con acentos y archivos vacíos', async () => {
  const audio = new Uint8Array(70000).map((_, index) => (index * 13) & 255);
  const zip = await pack.buildZip([
    { name: 'escena-dj.json', bytes: text('{"hola":"mundo"}') },
    { name: 'audio/001-Entrada ñandú - Año.mp3', blob: new Blob([audio]) },
    { name: 'audio/002-vacío.wav', blob: new Blob([]) },
    { name: 'LEEME.txt', bytes: text('texto') },
  ]);
  const entries = await listZip(zip);
  assert.deepEqual(entries.map((entry) => entry.name), ['escena-dj.json', 'audio/001-Entrada ñandú - Año.mp3', 'audio/002-vacío.wav', 'LEEME.txt']);
  assert.ok(entries.every((entry) => entry.method === 0 && !entry.directory));
  assert.equal(await readText(await extractEntry(zip, entries[0])), '{"hola":"mundo"}');
  const back = new Uint8Array(await (await extractEntry(zip, entries[1])).arrayBuffer());
  assert.equal(back.length, audio.length);
  assert.equal(pack.crc32(back), pack.crc32(audio));
  assert.equal((await extractEntry(zip, entries[2])).size, 0);

  // Un ZIP bien hecho lo abre cualquier programa: se comprueba con unzip (si está instalado), incluidos los CRC.
  const folder = mkdtempSync(join(tmpdir(), 'dj-zip-'));
  try {
    const file = join(folder, 'paquete.zip');
    writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
    const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
    if (probe.error) return;
    const checked = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout, /No errors detected/);
    const python = spawnSync('python3', ['-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print(len(z.namelist()))', file], { encoding: 'utf8' });
    if (!python.error) assert.equal(python.stdout.trim(), 'None\n4');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('buildZip: límites claros en vez de un ZIP roto', async () => {
  await assert.rejects(pack.buildZip([{ name: 'a.bin', blob: { size: 0xffffffff, slice: () => new Blob([]) }, crc: 0 }]), /demasiado grande/);
  const progress = [];
  await pack.buildZip([{ name: 'a', bytes: text('1') }, { name: 'b', bytes: text('2') }], { onProgress: (event) => progress.push(event.name) });
  assert.deepEqual(progress, ['a', 'b']);
});

// ------------------------------------------------------------------ nombres

test('nombres: seguros para Windows y comparables entre Mac y Windows', () => {
  assert.equal(pack.safeFileName('Boda: "Ana/Luis" <final>?.zip'), 'Boda Ana Luis final .zip');
  assert.equal(pack.safeFileName('   ...   ', 'x'), 'x');
  assert.equal(pack.safeFileName('a'.repeat(300) + '.mp3', 'x', 50).length, 50);
  assert.ok(pack.safeFileName('a'.repeat(300) + '.mp3', 'x', 50).endsWith('.mp3'));
  assert.equal(pack.entryNameFor(0, 'C:\\música\\01 Novios.mp3'), 'audio/001-01 Novios.mp3');
  assert.equal(pack.entryNameFor(11, 'Año.m4a'), 'audio/012-Año.m4a');
  // Mac guarda "é" como e + acento; Windows como una sola letra: para vincular son el mismo archivo.
  assert.equal(pack.relinkKey('Canción 01.MP3'), pack.relinkKey('Canción 01.mp3'.normalize('NFD')));
  assert.equal(pack.relinkKey('carpeta/sub\\Canción.mp3'), pack.relinkKey('canción.MP3'));
  assert.equal(pack.packageFileName(['Boda Ana y Luis'], { audio: true }), 'Escena DJ - Boda Ana y Luis.zip');
  assert.equal(pack.packageFileName(['Boda'], { audio: false }), 'Escena DJ - Boda (solo programa).json');
  assert.equal(pack.packageFileName(['A', 'B', 'C'], { audio: true }), 'Escena DJ - 3 programas.zip');
  assert.equal(pack.guessAudioType('x.FLAC'), 'audio/flac');
  assert.equal(pack.guessAudioType('x.txt'), '');
});

// ------------------------------------------------------------------ programa (validación)

const base = (extra = {}) => ({
  format: 'escena-dj',
  version: 1,
  tracks: [{ ref: 't1', name: 'Novios', file: '01 Novios.mp3', type: 'audio/mpeg', size: 1000, duration: 200, entry: 'audio/001-01 Novios.mp3' }],
  programs: [{ name: 'Boda', items: [{ track: 't1', label: 'Entrada', start: 12.5, maxDur: 90, gainDb: -3 }] }],
  ...extra,
});

test('parseManifest: acepta un programa bueno y lo devuelve limpio', () => {
  const manifest = pack.parseManifest(JSON.stringify(base({ settings: { fade: 6, autoAdvance: true, bindings: { next: ['n:1:36', 'k:ArrowRight'], volume: ['c:1:7'], 'slot:1': ['n:1:40'] } } })));
  assert.equal(manifest.programs[0].name, 'Boda');
  assert.deepEqual(manifest.programs[0].items[0], { track: 't1', label: 'Entrada', start: 12.5, maxDur: 90, gainDb: -3 });
  assert.equal(manifest.tracks[0].file, '01 Novios.mp3');
  assert.deepEqual(manifest.settings, { fade: 6, autoAdvance: true, bindings: { next: ['n:1:36', 'k:ArrowRight'], volume: ['c:1:7'], 'slot:1': ['n:1:40'] } });
  assert.equal(pack.parseManifest(`\uFEFF${JSON.stringify(base())}`).programs.length, 1, 'con marca BOM de Windows');
});

test('parseManifest: rechaza lo que no es un paquete, con mensajes claros', () => {
  assert.throws(() => pack.parseManifest('esto no es json'), /no es un paquete de Escena DJ/);
  assert.throws(() => pack.parseManifest('[]'), /no es un paquete de Escena DJ/);
  assert.throws(() => pack.parseManifest(JSON.stringify({ ...base(), format: 'otra-cosa' })), /no es un paquete de Escena DJ/);
  assert.throws(() => pack.parseManifest(JSON.stringify({ ...base(), version: 2 })), /versión más nueva/);
  assert.throws(() => pack.parseManifest(JSON.stringify({ ...base(), version: 'uno' })), /versión/);
  assert.throws(() => pack.parseManifest(JSON.stringify({ ...base(), programs: [] })), /ningún programa/);
  assert.throws(() => pack.parseManifest(JSON.stringify({ ...base(), programs: Array.from({ length: 61 }, () => ({ name: 'x', items: [] })) })), /demasiados programas/);
  assert.throws(() => pack.parseManifest(JSON.stringify({ ...base(), programs: [{ name: 'x', items: Array.from({ length: 2001 }, () => ({ track: 't1' })) }] })), /demasiados participantes/);
});

test('parseManifest: números fuera de rango, textos largos y referencias rotas quedan controlados', () => {
  const sucio = base({
    tracks: [
      { ref: 't1', name: 'N'.repeat(500), file: '../../etc/pasa\\wd/01 Novios.mp3', type: 'text/html', size: -5, duration: 99999999, entry: 'audio/x.mp3' },
      { ref: 't1', name: 'repetida', file: 'otra.mp3' },
      { ref: '', name: 'sin ref' },
      'basura',
      { ref: 't2', name: 'Sin archivo' },
    ],
    programs: [
      {
        name: ' \u0000 ' + 'P'.repeat(200),
        items: [
          { track: 't1', label: 'L'.repeat(400), start: -9, maxDur: 'mucho', gainDb: 999 },
          { track: 'no-existe', label: 'x' },
          { track: 't2', start: 1e12, gainDb: -999 },
          null,
        ],
      },
      { name: 'sin lista', items: 'no' },
    ],
  });
  const manifest = pack.parseManifest(sucio);
  assert.equal(manifest.tracks.length, 2, 'la repetida, la vacía y la basura se descartan');
  const [uno, dos] = manifest.tracks;
  assert.equal(uno.file, '01 Novios.mp3', 'sin carpetas ni rutas');
  assert.equal(uno.name.length, 120);
  assert.equal(uno.type, '', 'un tipo que no es de audio se ignora');
  assert.equal(uno.size, 0);
  assert.equal(uno.duration, 86400);
  assert.equal(dos.file, 'Sin archivo');
  assert.equal(manifest.programs.length, 1);
  const programa = manifest.programs[0];
  assert.ok(programa.name.length <= 60 && !programa.name.includes('\u0000'));
  assert.equal(programa.items.length, 2);
  assert.deepEqual(programa.items[0], { track: 't1', label: 'L'.repeat(80), start: 0, maxDur: 0, gainDb: 12 });
  assert.equal(programa.items[1].start, 86400);
  assert.equal(programa.items[1].gainDb, -24);
  assert.equal(manifest.dropped, 1);
});

test('parseManifest: las asignaciones se filtran (acciones, botones, volumen, repetidos, __proto__)', () => {
  const bindings = JSON.parse(
    '{"__proto__":["n:1:1"],"constructor":["n:1:2"],"next":["n:1:36","n:1:36","n:17:5","n:1:200","x:1:2","k:' + 'A'.repeat(60) + '","k:Space"],' +
      '"prev":["n:1:36","c:2:9"],"volume":["n:1:50","c:1:7","b:3"],"slot:0":["n:1:60"],"slot:65":["n:1:61"],"slot:07":["n:1:62"],"slot:3":["n:1:63"],"ataque":["n:1:64"],"panic":"n:1:65"}'
  );
  const manifest = pack.parseManifest(JSON.stringify(base({ settings: { bindings } })));
  assert.deepEqual(manifest.settings.bindings, {
    next: ['n:1:36', 'k:Space'],
    prev: ['c:2:9'],
    volume: ['c:1:7', 'b:3'],
    'slot:3': ['n:1:63'],
    panic: [],
  });
  assert.equal(Object.getPrototypeOf(manifest.settings.bindings), Object.prototype);
  assert.equal({}.polluted, undefined);
  const sin = pack.parseManifest(JSON.stringify(base({ settings: { bindings: { next: [] }, fade: 'rápido', autoAdvance: 'sí' } })));
  assert.equal(sin.settings, null, 'sin nada válido no hay ajustes que aplicar');
  const corte = pack.parseManifest(JSON.stringify(base({ settings: { fade: 0 } })));
  assert.equal(corte.settings.fade, 0, 'fade 0 es "corte"');
  assert.equal(pack.parseManifest(JSON.stringify(base({ settings: { fade: 500 } }))).settings.fade, 12);
});

test('buildManifest + parseManifest: ida y vuelta sin perder nada', () => {
  const manifest = pack.buildManifest({
    audio: true,
    created: new Date('2026-11-05T12:00:00Z'),
    programs: [{ name: 'Desfile', items: [{ track: 't1', label: 'Escuela 1', start: 1.23456, maxDur: 60, gainDb: -2.26 }] }],
    tracks: [{ ref: 't1', name: 'Marcha', file: 'marcha.mp3', type: 'audio/mpeg', size: 5, duration: 100.12345, entry: 'audio/001-marcha.mp3' }],
    settings: { fade: 3, autoAdvance: false, bindings: DEFAULT_BINDINGS },
  });
  assert.equal(manifest.created, '2026-11-05T12:00:00.000Z');
  assert.equal(manifest.programs[0].items[0].start, 1.235);
  assert.equal(manifest.programs[0].items[0].gainDb, -2.3);
  const back = pack.parseManifest(pack.serializeManifest(manifest));
  assert.equal(back.audio, true);
  assert.deepEqual(back.programs, manifest.programs);
  assert.deepEqual(back.tracks, manifest.tracks);
  assert.equal(back.settings.fade, 3);
  assert.deepEqual(back.settings.bindings.playPause, ['k:Space']);
  assert.deepEqual(back.settings.bindings['slot:9'], ['k:Digit9', 'k:Numpad9']);
});

// ------------------------------------------------------------------ abrir paquetes

async function zipWith(manifest, extra = [], { prefix = '' } = {}) {
  return pack.buildZip([{ name: `${prefix}escena-dj.json`, bytes: text(typeof manifest === 'string' ? manifest : JSON.stringify(manifest)) }, ...extra.map((file) => ({ ...file, name: `${prefix}${file.name}` }))]);
}

test('readPackage: abre el .json suelto, el ZIP y el ZIP vuelto a comprimir dentro de una carpeta', async () => {
  const audio = new Uint8Array(5000).map((_, index) => index & 255);
  const json = await pack.readPackage(new File([JSON.stringify(base())], 'programa.json', { type: 'application/json' }));
  assert.equal(json.kind, 'json');
  assert.equal(json.audioSize(json.manifest.tracks[0]), null);
  assert.equal(await json.readAudio(json.manifest.tracks[0]), null);

  const zip = await zipWith(base(), [{ name: 'audio/001-01 Novios.mp3', blob: new Blob([audio]) }]);
  const normal = await pack.readPackage(new File([zip], 'p.zip'));
  assert.equal(normal.kind, 'zip');
  const track = normal.manifest.tracks[0];
  assert.equal(normal.audioSize(track), 5000);
  const data = new Uint8Array(await (await normal.readAudio(track)).arrayBuffer());
  assert.equal(pack.crc32(data), pack.crc32(audio));

  // Otro programa lo volvió a comprimir dentro de una carpeta, con barras de Windows y la letra "ó" descompuesta.
  const nested = await zipWith(base(), [{ name: 'audio/001-01 Novios.mp3', blob: new Blob([audio]) }], { prefix: 'Boda Ana\\' });
  const dentro = await pack.readPackage(new File([nested], 'otro.zip'));
  assert.equal(dentro.audioSize(dentro.manifest.tracks[0]), 5000);

  const acentos = base({ tracks: [{ ref: 't1', name: 'x', file: 'x.mp3', entry: 'audio/001-Canción.mp3' }] });
  const descompuesto = await zipWith(acentos, [{ name: 'audio/001-Canción.mp3'.normalize('NFD'), blob: new Blob([audio]) }]);
  const mac = await pack.readPackage(new File([descompuesto], 'mac.zip'));
  assert.equal(mac.audioSize(mac.manifest.tracks[0]), 5000);
});

test('readPackage: detecta paquetes dañados, truncados y archivos que no son un paquete', async () => {
  const audio = new Uint8Array(20000).map((_, index) => (index * 7) & 255);
  const zip = await zipWith(base(), [{ name: 'audio/001-01 Novios.mp3', blob: new Blob([audio]) }]);

  // un byte cambiado dentro de la canción (copia dañada): el resto del paquete sigue abriendo, pero esa canción se reporta
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const where = bytes.length - 4000;
  const dañado = bytes.slice();
  dañado[where] ^= 0xff;
  const abierto = await pack.readPackage(new File([dañado], 'dañado.zip'));
  await assert.rejects(abierto.readAudio(abierto.manifest.tracks[0]), /llegó dañada/);

  // truncado: falta el final del ZIP
  await assert.rejects(pack.readPackage(new File([bytes.slice(0, bytes.length - 100)], 'cortado.zip')), /ZIP no es válido|dañado/);
  // un ZIP cualquiera
  const otro = await pack.buildZip([{ name: 'foto.jpg', bytes: text('x') }]);
  await assert.rejects(pack.readPackage(new File([otro], 'otro.zip')), /no trae «escena-dj.json»/);
  // vacío, texto cualquiera y programa de otro formato
  await assert.rejects(pack.readPackage(new File([], 'vacio.json')), /vacío/);
  await assert.rejects(pack.readPackage(new File(['hola'], 'nota.txt')), /no es un paquete de Escena DJ/);
  await assert.rejects(pack.readPackage(new File([JSON.stringify({ format: 'setlist' })], 'x.json')), /no es un paquete de Escena DJ/);
  await assert.rejects(pack.readPackage(new File([new Uint8Array(9 * 1024 * 1024).fill(32)], 'enorme.json')), /demasiado grande/);
  // programa dentro del ZIP con un tamaño absurdo declarado
  const absurdo = await zipWith('{"format":"escena-dj","version":1,"tracks":[],"programs":[{"name":"x","items":[]}]}', []);
  const leido = await pack.readPackage(new File([absurdo], 'a.zip'));
  assert.equal(leido.manifest.programs[0].items.length, 0);
});

// ------------------------------------------------------------------ controlador con un motor falso

function fakeEngine() {
  const events = createEmitter();
  const calls = [];
  const ready = new Set();
  const engine = {
    calls,
    on: events.on,
    async unlock() {
      return true;
    },
    async load(key) {
      ready.add(key);
      return { duration: 200 };
    },
    isReady: (key) => ready.has(key),
    isLoading: () => false,
    mixTo(key, options) {
      calls.push(['mixTo', key, options.duration]);
      engine.playingFlag = true;
      engine.current = { key, state: 'playing', position: 0, duration: 200, level: 1 };
      return true;
    },
    pause() {
      return true;
    },
    resume() {
      return true;
    },
    stopAll() {
      engine.playingFlag = false;
      return true;
    },
    current: null,
    snapshot: () => ({ audio: 'running', current: engine.current, decks: [], mixing: { active: false, progress: 1, seconds: 0 } }),
    setVolume() {},
    setWanted() {},
    drop: (key) => ready.delete(key),
    get playing() {
      return Boolean(engine.playingFlag);
    },
    peak: () => 0,
    setSink: async () => {},
    destroy() {},
  };
  return engine;
}

let clock = 1000000;
const tick = () => (clock += 1000);

// Contenido distinto y reconocible para cada canción.
const songBytes = (seed, size = 4000 + seed * 100) => new Uint8Array(size).map((_, index) => (index * (seed + 3) + seed * 17) & 255);
const song = (name, seed) => new File([songBytes(seed)], name, { type: 'audio/mpeg' });
const NAMES = ['01 Novios.mp3', '02 Madrina.mp3', '03 Padrinos.mp3', '04 Cierre.mp3'];
const songs = () => NAMES.map((name, index) => song(name, index + 1));

async function fixture({ store = createMemoryDjStore(), probe = async () => ({ duration: 200 }), files = null, init = true } = {}) {
  const engine = fakeEngine();
  const toasts = [];
  const dj = createDj({ store, engine, now: tick, probe, host: { toast: (message, kind) => toasts.push([message, kind || 'info']) } });
  abiertos.push(dj);
  if (init) await dj.init();
  if (files) await dj.importFiles(files);
  dj.setActive(true);
  await sleep(0);
  const last = () => (toasts.length ? toasts[toasts.length - 1][0] : '');
  const hasToast = (pattern, kind) => toasts.some(([message, k]) => pattern.test(message) && (!kind || k === kind));
  return { dj, engine, store, toasts, last, hasToast };
}

const contentOf = async (store, trackId) => {
  const row = await store.get('blobs', trackId);
  return pack.crc32(new Uint8Array(await row.blob.arrayBuffer()));
};

// Un programa de boda armado como lo haría una persona: nombres, tiempos, volumen, ajustes y un pad.
async function weddingProgram() {
  const source = await fixture({ files: songs() });
  const { dj } = source;
  dj.renameProgram(dj.program().id, 'Boda Ana y Luis');
  const [a, b, c, d] = dj.items();
  dj.updateItem(a.id, { label: 'Entrada de los novios', start: 12.5, maxDur: 90, gainDb: -3 });
  dj.updateItem(b.id, { label: 'Madrina Rosa', maxDur: 45 });
  dj.updateItem(d.id, { gainDb: 2.5 });
  dj.setFade(6);
  dj.setAutoAdvance(true);
  const learned = dj.learn('slot:1', { replace: true });
  dj.router.handleMessage([0x90, 36, 100]);
  await learned;
  return { ...source, ids: [a.id, b.id, c.id, d.id] };
}

test('paquete completo: lo que sale de una PC entra igual en otra (canciones, orden, tiempos, pads y mezcla)', async () => {
  const source = await weddingProgram();
  const out = await source.dj.exportPackage({ audio: true });
  assert.equal(out.fileName, 'Escena DJ - Boda Ana y Luis.zip');
  assert.deepEqual([out.programs, out.participants, out.songs, out.withAudio, out.waiting, out.skipped], [1, 4, 4, 4, 0, 0]);
  assert.equal(source.dj.state.exporting, null);
  const entries = await listZip(out.blob);
  assert.deepEqual(entries.map((entry) => entry.name.split('-')[0]), ['escena', 'LEEME.txt', 'audio/001', 'audio/002', 'audio/003', 'audio/004']);

  const target = await fixture();
  const opened = await target.dj.openPackage(new File([out.blob], out.fileName));
  assert.ok(opened);
  const { summary } = opened;
  assert.deepEqual([summary.songs, summary.withAudio, summary.reused, summary.linked, summary.waiting, summary.participants], [4, 4, 0, 0, 0, 4]);
  assert.equal(summary.audioBytes, songs().reduce((total, file) => total + file.size, 0));
  assert.deepEqual([summary.hasSettings, summary.hasBindings, summary.customBindings], [true, true, false]);
  assert.deepEqual(summary.programs, [{ name: 'Boda Ana y Luis', participants: 4 }]);

  const before = target.dj.state.programs.length;
  const report = await target.dj.importPackage(opened.opened, { applySettings: true });
  assert.deepEqual([report.programs, report.participants, report.saved, report.reused, report.waiting, report.selected], [1, 4, 4, 0, 0, true]);
  assert.equal(target.dj.state.programs.length, before + 1);
  assert.equal(target.dj.state.importing, null);
  assert.equal(target.dj.program().name, 'Boda Ana y Luis', 'queda abierto el programa que llegó');

  // canciones idénticas, byte a byte
  assert.equal(target.dj.state.tracks.length, 4);
  for (const [index, track] of target.dj.state.tracks.entries()) {
    assert.equal(await contentOf(target.store, track.id), pack.crc32(songBytes(NAMES.indexOf(track.file) + 1)), track.file);
    assert.equal(track.type, 'audio/mpeg');
    assert.equal(track.size, songs()[NAMES.indexOf(track.file)].size);
    assert.equal(track.duration, 200);
    assert.ok(track.id && track.id !== source.dj.state.tracks[index].id, 'identificadores nuevos');
  }
  const items = target.dj.items();
  assert.deepEqual(items.map((item) => item.title), ['Entrada de los novios', 'Madrina Rosa', '03 Padrinos', '04 Cierre']);
  assert.deepEqual(items.map((item) => item.trackName), ['01 Novios', '02 Madrina', '03 Padrinos', '04 Cierre']);
  assert.deepEqual(items.map((item) => [item.start, item.maxDur, item.gainDb]), [[12.5, 90, -3], [0, 45, 0], [0, 0, 0], [0, 0, 2.5]]);
  assert.ok(items.every((item) => !item.missing));
  // ajustes: mezcla y pad
  assert.equal(target.dj.state.settings.fade, 6);
  assert.equal(target.dj.state.settings.autoAdvance, true);
  assert.ok(target.dj.effectiveBindings()['slot:1'].includes('n:1:36'));
  target.dj.router.setActive(true);
  target.dj.router.handleMessage([0x90, 36, 100]);
  await sleep(10);
  assert.deepEqual(target.engine.calls.filter((call) => call[0] === 'mixTo').map((call) => call[1]), [items[0].id], 'el pad traído toca al primer participante');
  assert.equal(target.dj.state.transport, 'playing');

  // y lo que se guardó sobrevive a cerrar y volver a abrir
  await target.dj.flush();
  const again = await fixture({ store: target.store });
  assert.equal(again.dj.state.tracks.length, 4);
  assert.deepEqual(again.dj.items().map((item) => item.title), ['Entrada de los novios', 'Madrina Rosa', '03 Padrinos', '04 Cierre']);
});

test('paquete: sin marcar los ajustes no se tocan los pads ni la mezcla de esta PC; traerlo dos veces no duplica canciones', async () => {
  const source = await weddingProgram();
  const out = await source.dj.exportPackage();
  const target = await fixture();
  target.dj.setFade(2);
  const first = await target.dj.openPackage(new File([out.blob], out.fileName));
  await target.dj.importPackage(first.opened, { applySettings: false });
  assert.equal(target.dj.state.settings.fade, 2);
  assert.equal(target.dj.state.settings.autoAdvance, false);
  assert.equal(target.dj.state.settings.bindings, null);

  const second = await target.dj.openPackage(new File([out.blob], out.fileName));
  assert.deepEqual([second.summary.reused, second.summary.withAudio], [4, 0], 'se avisa que esas canciones ya están');
  const report = await target.dj.importPackage(second.opened);
  assert.deepEqual([report.saved, report.reused], [0, 4]);
  await target.dj.importPackage((await target.dj.openPackage(new File([out.blob], out.fileName))).opened);
  assert.equal(target.dj.state.tracks.length, 4, 'las canciones no se guardan otra vez');
  assert.deepEqual(target.dj.state.programs.map((entry) => entry.name).slice(-3), ['Boda Ana y Luis', 'Boda Ana y Luis (2)', 'Boda Ana y Luis (3)']);
  const ids = new Set(target.dj.state.programs.flatMap((entry) => entry.items.map((item) => item.trackId)));
  assert.equal(ids.size, 4);
  assert.equal(new Set(target.dj.state.programs.flatMap((entry) => entry.items.map((item) => item.id))).size, 12, 'cada participante lleva un identificador propio');
});

test('solo el programa: llega esperando sus archivos y se vincula por el nombre al añadir las canciones', async () => {
  const source = await weddingProgram();
  const out = await source.dj.exportPackage({ audio: false });
  assert.equal(out.fileName, 'Escena DJ - Boda Ana y Luis (solo programa).json');
  assert.ok(out.blob.size < 4000, `liviano: ${out.blob.size} bytes`);
  assert.deepEqual([out.withAudio, out.songs], [0, 4]);
  assert.equal(JSON.parse(await out.blob.text()).audio, false);

  const target = await fixture();
  const opened = await target.dj.openPackage(new File([out.blob], out.fileName, { type: 'application/json' }));
  assert.deepEqual([opened.summary.waiting, opened.summary.withAudio, opened.summary.linked], [4, 0, 0]);
  const report = await target.dj.importPackage(opened.opened);
  assert.deepEqual([report.programs, report.saved, report.waiting], [1, 0, 4]);
  assert.ok(target.hasToast(/Faltan 4 canciones\. Añádelas con «Añadir canciones»: se vinculan solas por el nombre del archivo/));
  assert.equal(target.dj.state.tracks.length, 0);

  let items = target.dj.items();
  assert.ok(items.every((item) => item.missing));
  assert.deepEqual(items.map((item) => item.title), ['Entrada de los novios', 'Madrina Rosa', '03 Padrinos', '04 Cierre'], 'se ve quién es cada uno aunque falte el audio');
  assert.deepEqual(items.map((item) => item.trackName), NAMES.map((name) => `Falta «${name}»`), 'dice qué archivo hay que añadir');
  assert.equal(target.dj.itemStatus(target.dj.program().items[0]), 'missing');

  // mientras falte el audio nada suena ni se traba
  assert.equal(await target.dj.next(), false);
  assert.equal(await target.dj.playPause(), false);
  assert.equal(await target.dj.jump(items[2].id), false);
  assert.equal(target.engine.calls.length, 0);
  target.dj.cue(items[1].id);
  assert.equal(target.dj.state.cueId, null, 'un participante sin archivo no se marca como "Sigue"');
  assert.ok(target.hasToast(/Falta el archivo «02 Madrina.mp3»/, 'error'));

  // se añaden las canciones: desordenadas, con otras mayúsculas y con una que no era de este programa
  const added = await target.dj.importFiles([song('04 CIERRE.MP3', 4), song('Extra aparte.mp3', 9), song('02 Madrina.mp3', 2), song('01 Novios.mp3', 1), song('03 Padrinos.mp3', 3)]);
  assert.equal(added.length, 5);
  items = target.dj.items();
  assert.equal(items.length, 5, 'solo la canción que no esperaba nadie se agrega como participante nuevo');
  assert.deepEqual(items.map((item) => item.title), ['Entrada de los novios', 'Madrina Rosa', '03 Padrinos', '04 CIERRE', 'Extra aparte'], 'sin nombre propio, el título es el del archivo añadido');
  assert.ok(items.every((item) => !item.missing));
  assert.equal(target.dj.program().items.filter((item) => item.want).length, 0, 'ya no quedan marcas de espera');
  assert.ok(target.hasToast(/4 participantes recuperaron su canción/));
  assert.deepEqual([items[0].start, items[0].maxDur, items[0].gainDb], [12.5, 90, -3], 'los tiempos del paquete se conservan');

  // ahora suena
  await target.dj.next();
  assert.deepEqual(target.engine.calls.filter((call) => call[0] === 'mixTo').map((call) => call[1]), [items[0].id]);
});

test('solo el programa: si las canciones ya estaban en esta PC se vinculan al traerlo, y un programa traído se puede volver a llevar', async () => {
  const source = await weddingProgram();
  const out = await source.dj.exportPackage({ audio: false });

  const target = await fixture({ files: [song('02 Madrina.mp3', 2), song('01 Novios.mp3', 1)] });
  const library = target.dj.state.tracks.length;
  const opened = await target.dj.openPackage(new File([out.blob], out.fileName));
  assert.deepEqual([opened.summary.linked, opened.summary.waiting], [2, 2]);
  const report = await target.dj.importPackage(opened.opened);
  assert.deepEqual([report.linked, report.waiting], [2, 2]);
  assert.equal(target.dj.state.tracks.length, library);
  assert.deepEqual(target.dj.items().map((item) => item.missing), [false, false, true, true]);

  // lo que todavía espera su archivo también viaja en un nuevo paquete
  const again = await target.dj.exportPackage({ audio: true });
  assert.deepEqual([again.songs, again.withAudio, again.waiting], [4, 2, 2]);
  const third = await fixture();
  const reopened = await third.dj.openPackage(new File([again.blob], again.fileName));
  assert.deepEqual([reopened.summary.withAudio, reopened.summary.waiting], [2, 2]);
  await third.dj.importPackage(reopened.opened);
  assert.deepEqual(third.dj.items().map((item) => item.trackName), ['01 Novios', '02 Madrina', 'Falta «03 Padrinos.mp3»', 'Falta «04 Cierre.mp3»']);
  assert.equal(third.dj.items()[2].title, '03 Padrinos');
});

test('participante sin archivo: "Siguiente", "Anterior" y la preparación lo saltan en vez de trabarse', async () => {
  const source = await weddingProgram();
  const out = await source.dj.exportPackage({ audio: false });
  const target = await fixture({ files: [song('01 Novios.mp3', 1), song('04 Cierre.mp3', 4)] });
  await target.dj.importPackage((await target.dj.openPackage(new File([out.blob], out.fileName))).opened);
  const items = target.dj.items();
  assert.deepEqual(items.map((item) => item.missing), [false, true, true, false]);

  assert.equal(await target.dj.next(), true);
  assert.equal(target.dj.state.nowId, items[0].id);
  assert.equal(target.dj.nextItem().id, items[1].id, 'la pantalla muestra al que sigue por orden');
  assert.equal(target.dj.playableNext().id, items[3].id, 'pero suena el siguiente que sí tiene archivo');
  assert.equal(await target.dj.next(), true);
  assert.equal(target.dj.state.nowId, items[3].id);
  assert.ok(target.hasToast(/Se saltaron 2 participantes sin archivo/));
  assert.equal(await target.dj.prev(), true);
  assert.equal(target.dj.state.nowId, items[0].id, 'hacia atrás también');
  assert.equal(await target.dj.jump(items[2].id), false, 'un pad de un participante sin archivo avisa y no toca otra cosa');
  assert.equal(target.dj.state.nowId, items[0].id);
  assert.ok(target.hasToast(/falta el archivo «03 Padrinos.mp3»/));
  await target.dj.jump(items[3].id);
  assert.equal(await target.dj.next(), false, 'al final del programa');
});

test('paquete dañado: se guarda lo sano, la canción dañada queda esperando y se avisa', async () => {
  const source = await weddingProgram();
  const out = await source.dj.exportPackage();
  const bytes = new Uint8Array(await out.blob.arrayBuffer());
  const entries = await listZip(out.blob);
  const second = entries.find((entry) => entry.name.startsWith('audio/002'));
  bytes[second.headerOffset + 30 + new TextEncoder().encode(second.name).length + 100] ^= 0xff;

  const target = await fixture();
  const opened = await target.dj.openPackage(new File([bytes], 'copiado.zip'));
  assert.ok(opened, 'el paquete abre: la canción dañada se detecta al guardarla');
  const report = await target.dj.importPackage(opened.opened);
  assert.deepEqual([report.saved, report.waiting, report.damaged.length], [3, 1, 1]);
  assert.ok(target.hasToast(/llegó dañada/, 'error'));
  assert.ok(target.hasToast(/Falta 1 canción\. Añádela con «Añadir canciones»: se vincula sola por el nombre del archivo/));
  assert.deepEqual(target.dj.items().map((item) => item.missing), [false, true, false, false]);
  assert.equal(target.dj.state.tracks.length, 3);
  assert.equal(target.dj.state.importing, null);
  // la repara añadiendo el archivo bueno
  await target.dj.importFiles([song('02 Madrina.mp3', 2)]);
  assert.deepEqual(target.dj.items().map((item) => item.missing), [false, false, false, false]);
  assert.equal(target.dj.items().length, 4);
});

test('paquete: archivos que no sirven se rechazan con un aviso y no cambian nada', async () => {
  const target = await fixture({ files: songs() });
  const before = [target.dj.state.tracks.length, target.dj.state.programs.length];
  assert.equal(await target.dj.openPackage(new File(['hola'], 'nota.txt')), null);
  assert.equal(await target.dj.openPackage(new File([JSON.stringify({ format: 'otro' })], 'x.json')), null);
  const noPack = await pack.buildZip([{ name: 'foto.jpg', bytes: new TextEncoder().encode('x') }]);
  assert.equal(await target.dj.openPackage(new File([noPack], 'fotos.zip')), null);
  assert.equal(await target.dj.openPackage(new File([JSON.stringify({ format: 'escena-dj', version: 9, programs: [{ name: 'x', items: [] }] })], 'nuevo.json')), null);
  assert.ok(target.hasToast(/no es un paquete de Escena DJ/, 'error'));
  assert.ok(target.hasToast(/versión más nueva/, 'error'));
  assert.ok(target.hasToast(/no trae «escena-dj.json»/, 'error'));
  assert.deepEqual([target.dj.state.tracks.length, target.dj.state.programs.length], before);
});

test('paquete: no se trae un programa mientras suena la música, ni dos cosas a la vez', async () => {
  const source = await weddingProgram();
  const out = await source.dj.exportPackage({ audio: false });
  const target = await fixture({ files: songs() });
  const opened = (await target.dj.openPackage(new File([out.blob], out.fileName))).opened;
  await target.dj.next();
  assert.equal(target.dj.state.transport, 'playing');
  const programs = target.dj.state.programs.length;
  assert.equal(await target.dj.importPackage(opened), null);
  assert.ok(target.hasToast(/Detén la música antes de traer un programa/, 'error'));
  assert.equal(target.dj.state.programs.length, programs);

  // en pausa sí: se guarda, pero no se cambia el programa que está abierto
  const current = target.dj.state.programId;
  await target.dj.pause();
  const report = await target.dj.importPackage(opened);
  assert.equal(report.programs, 1);
  assert.equal(report.selected, false);
  assert.equal(target.dj.state.programId, current);
  assert.equal(target.dj.state.programs.length, programs + 1);
  assert.ok(target.hasToast(/Elígelo en la lista de programas/));

  // dos paquetes a la vez: el segundo espera
  const slowStore = createMemoryDjStore();
  const slowPut = slowStore.put.bind(slowStore);
  slowStore.put = async (name, value) => {
    await sleep(15);
    return slowPut(name, value);
  };
  const slow = await fixture({ store: slowStore });
  const full = await weddingProgram();
  const zip = await full.dj.exportPackage();
  const two = (await slow.dj.openPackage(new File([zip.blob], zip.fileName))).opened;
  const running = slow.dj.importPackage(two);
  await sleep(1);
  assert.ok(slow.dj.state.importing && slow.dj.state.importing.label);
  assert.equal(await slow.dj.importPackage(two), null);
  assert.equal((await slow.dj.importFiles([song('Otra.mp3', 5)])).length, 0, 'tampoco se añaden canciones sueltas a la mitad');
  await running;
  assert.equal(slow.dj.state.importing, null);
  assert.equal(slow.dj.state.tracks.length, 4);
});

test('exportar todos los programas: una canción usada en varios se guarda una sola vez', async () => {
  const source = await weddingProgram();
  const { dj } = source;
  const shared = dj.state.tracks[0];
  await dj.createProgram('Desfile');
  dj.addItem(shared.id, { label: 'Banda escolar' });
  dj.addItem(dj.state.tracks[2].id);
  dj.selectProgram(dj.state.programs[0].id);
  const only = await dj.exportPackage({ scope: 'current' });
  assert.deepEqual([only.programs, only.songs], [1, 4]);
  const all = await dj.exportPackage({ scope: 'all' });
  assert.equal(all.fileName, 'Escena DJ - 2 programas.zip');
  assert.deepEqual([all.programs, all.participants, all.songs, all.withAudio], [2, 6, 4, 4]);
  assert.equal((await listZip(all.blob)).filter((entry) => entry.name.startsWith('audio/')).length, 4);

  const target = await fixture();
  const report = await target.dj.importPackage((await target.dj.openPackage(new File([all.blob], all.fileName))).opened);
  assert.deepEqual([report.programs, report.participants, report.saved], [2, 6, 4]);
  assert.deepEqual(target.dj.state.programs.map((entry) => entry.name).slice(-2), ['Boda Ana y Luis', 'Desfile']);
  const desfile = target.dj.state.programs.find((entry) => entry.name === 'Desfile');
  assert.equal(desfile.items[0].label, 'Banda escolar');
  assert.equal(desfile.items[0].trackId, target.dj.state.programs.find((entry) => entry.name === 'Boda Ana y Luis').items[0].trackId, 'misma canción, un solo archivo guardado');
});

test('exportar: los participantes sin canción, el exceso de tamaño y las canciones sin audio se manejan con claridad', async () => {
  const { dj } = await fixture({ files: songs() });
  // un participante cuya canción desapareció y no se sabe cuál era
  dj.program().items.push({ id: 'zz', trackId: 'no-existe', label: 'Huérfano', start: 0, maxDur: 0, gainDb: 0 });
  const out = await dj.exportPackage({ audio: false });
  assert.deepEqual([out.participants, out.skipped], [4, 1]);

  // una "canción" de 4,5 GB: no cabe en un ZIP sin ZIP64 y se avisa en vez de generar un archivo roto
  const store = createMemoryDjStore();
  await store.put('tracks', { id: 'big', name: 'Enorme', file: 'enorme.wav', type: 'audio/wav', size: 4500000000, duration: 600, added: 1 });
  await store.put('blobs', { id: 'big', blob: { size: 4500000000, slice: () => new Blob([]) } });
  await store.put('programs', { id: 'p', name: 'Gigante', items: [{ id: 'i', trackId: 'big', label: '', start: 0, maxDur: 0, gainDb: 0 }], created: 1, updated: 1 });
  const huge = await fixture({ store });
  assert.equal(await huge.dj.exportPackage({ audio: true }), null);
  assert.equal(huge.dj.state.exporting, null);
  assert.ok(huge.hasToast(/pesan más de 4 GB/, 'error'));
  const solo = await huge.dj.exportPackage({ audio: false });
  assert.ok(solo && solo.blob.size < 2000, 'sin audio sí se puede llevar el programa');

  // el archivo de una canción ya no está en el dispositivo
  await store.put('blobs', { id: 'big' });
  const lost = await fixture({ store });
  assert.equal(await lost.dj.exportPackage({ audio: true }), null);
  assert.ok(lost.hasToast(/No se encontró en este dispositivo el archivo/, 'error'));
});

test('exportar: un solo paquete a la vez y el progreso se informa a la pantalla', async () => {
  const source = await weddingProgram();
  const seen = [];
  source.dj.on('change', () => {
    if (source.dj.state.exporting) seen.push(`${source.dj.state.exporting.done}/${source.dj.state.exporting.total}`);
  });
  const first = source.dj.exportPackage();
  const second = await source.dj.exportPackage();
  assert.equal(second, null);
  assert.ok(source.hasToast(/Ya se está preparando un paquete/));
  await first;
  await sleep(0);
  assert.ok(seen.length > 0 && seen.some((text) => /^\d+\/4$/.test(text)), seen.join(','));
});

test('importar: si no hay espacio o falla el guardado de una canción, las demás sí se traen y esa queda esperando', async () => {
  const source = await weddingProgram();
  const out = await source.dj.exportPackage();
  const store = createMemoryDjStore();
  const originalPut = store.put.bind(store);
  store.put = async (name, value) => {
    if (name === 'blobs' && value.blob && value.blob.size === songs()[2].size) throw new Error('No hay espacio suficiente en este dispositivo para guardar la canción.');
    return originalPut(name, value);
  };
  const target = await fixture({ store });
  const report = await target.dj.importPackage((await target.dj.openPackage(new File([out.blob], out.fileName))).opened);
  assert.deepEqual([report.saved, report.waiting, report.failed.length], [3, 1, 1]);
  assert.ok(target.hasToast(/No hay espacio suficiente/, 'error'));
  assert.deepEqual(target.dj.items().map((item) => item.missing), [false, false, true, false]);
  assert.equal((await store.all('blobs')).length, 3, 'no queda audio huérfano');
  assert.equal(target.dj.state.tracks.length, 3);
});

test('lo que espera su archivo sobrevive a cerrar y volver a abrir Escena', async () => {
  const source = await weddingProgram();
  const out = await source.dj.exportPackage({ audio: false });
  const store = createMemoryDjStore();
  const first = await fixture({ store });
  await first.dj.importPackage((await first.dj.openPackage(new File([out.blob], out.fileName))).opened);
  await first.dj.flush();
  first.dj.destroy();

  const second = await fixture({ store });
  assert.deepEqual(second.dj.items().map((item) => item.trackName), NAMES.map((name) => `Falta «${name}»`));
  await second.dj.importFiles(songs());
  assert.deepEqual(second.dj.items().map((item) => item.missing), [false, false, false, false]);
  assert.equal(second.dj.items().length, 4);
  await second.dj.flush();
  const third = await fixture({ store });
  assert.ok(third.dj.items().every((item) => !item.missing && item.trackName));
  assert.equal(third.dj.program().items.filter((item) => item.want).length, 0);
});
