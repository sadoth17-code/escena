// Programas del DJ en la nube, de punta a punta: dos o más equipos con la app real (cloud.js + dj.js + dj-cloud.js)
// contra el Worker real (server/worker.mjs) con R2 en memoria. Nada sale de este proceso y todas las claves son de prueba.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { createEmitter } from '../www/js/util.js';
import { createMemoryDjStore } from '../www/js/dj-store.js';
import { createDj } from '../www/js/dj.js';
import { crc32 } from '../www/js/dj-package.js';
import { OLD_WORKER, contentId, createDjCloud, readCloudProgram, sha256 } from '../www/js/dj-cloud.js';
import { API, CHUNK, MASTER, world } from './helpers/cloud-world.mjs';

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const abiertos = [];
after(() => abiertos.forEach((equipo) => equipo.dj.destroy()));

// ------------------------------------------------------------------ equipos de prueba

function fakeEngine() {
  const events = createEmitter();
  const ready = new Set();
  const engine = {
    calls: [],
    on: events.on,
    unlock: async () => true,
    async load(key) {
      ready.add(key);
      return { duration: 200 };
    },
    isReady: (key) => ready.has(key),
    isLoading: () => false,
    mixTo(key, options) {
      engine.calls.push(['mixTo', key, options.duration]);
      engine.current = { key, state: 'playing', position: 0, duration: 200, level: 1 };
      return true;
    },
    pause: () => true,
    resume: () => true,
    stopAll: () => true,
    current: null,
    dropped: [],
    snapshot: () => ({ audio: 'running', current: engine.current, decks: [], mixing: { active: false, progress: 1, seconds: 0 } }),
    setVolume() {},
    setWanted() {},
    drop(key) {
      engine.dropped.push(key);
      ready.delete(key);
    },
    playing: false,
    peak: () => 0,
    setSink: async () => {},
    destroy() {},
  };
  return engine;
}

let clock = 5000000;
const tick = () => (clock += 1000);
const songBytes = (seed, size = 4000 + seed * 100) => new Uint8Array(size).map((_, index) => (index * (seed + 3) + seed * 17) & 255);
const song = (name, seed, size) => new File([songBytes(seed, size)], name, { type: 'audio/mpeg' });
const NAMES = ['01 Novios.mp3', '02 Madrina.mp3', '03 Padrinos.mp3', '04 Cierre.mp3'];
const songs = () => NAMES.map((name, index) => song(name, index + 1));
const seedOf = (file) => NAMES.indexOf(file) + 1;

// Un equipo: la app conectada a la nube con una clave, más su pestaña DJ.
async function equipo(w, key, { files = null, cloud = null } = {}) {
  const device = cloud ? null : await w.device(key);
  const toasts = [];
  const store = createMemoryDjStore();
  const engine = fakeEngine();
  const dj = createDj({ store, engine, now: tick, probe: async () => ({ duration: 200 }), host: { toast: (message, kind) => toasts.push([message, kind || 'info']) } });
  await dj.init();
  if (files) await dj.importFiles(files);
  dj.setActive(true);
  const link = cloud || device.cloud;
  const djCloud = createDjCloud({ dj, cloud: link });
  const out = {
    dj, store, engine, toasts, djCloud, cloud: link, device,
    has: (pattern, kind) => toasts.some(([message, k]) => pattern.test(message) && (!kind || k === kind)),
    last: () => (toasts.length ? toasts[toasts.length - 1][0] : ''),
    errors: () => toasts.filter(([, kind]) => kind === 'error').map(([message]) => message),
  };
  abiertos.push(out);
  return out;
}

const contentOf = async (store, trackId) => crc32(new Uint8Array(await (await store.get('blobs', trackId)).blob.arrayBuffer()));

// El programa de boda de siempre: nombres, tiempos, volumen, mezcla y un pad.
async function armarBoda(equipoA) {
  const { dj } = equipoA;
  dj.renameProgram(dj.program().id, 'Boda Ana y Luis');
  const [a, b, , d] = dj.items();
  dj.updateItem(a.id, { label: 'Entrada de los novios', start: 12.5, maxDur: 90, gainDb: -3 });
  dj.updateItem(b.id, { label: 'Madrina Rosa', maxDur: 45 });
  dj.updateItem(d.id, { gainDb: 2.5 });
  dj.setFade(6);
  dj.setAutoAdvance(true);
  const learned = dj.learn('slot:1', { replace: true });
  dj.router.handleMessage([0x90, 36, 100]);
  await learned;
  return dj.program().id;
}

// Subidas por partes que se empezaron y no se terminaron (en el R2 de prueba las terminadas siguen anotadas).
const abiertas = (w) => [...w.bucket.uploads.values()].filter((upload) => !w.bucket.rows.has(upload.key)).map((upload) => upload.key);
const cloudAudio = (w) => [...w.bucket.rows.keys()].filter((key) => key.startsWith('dj/audio/'));
const cloudPrograms = (w) => [...w.bucket.rows.keys()].filter((key) => key.startsWith('dj/programs/'));
const rows = (equipoX) => equipoX.dj.items().map((item) => [item.title, item.trackName, item.start, item.maxDur, item.gainDb]);

// ------------------------------------------------------------------ ida y vuelta

test('un programa se sube desde un equipo y se trae completo en otro, con todo lo que lo hace tuyo', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  const programId = await armarBoda(a);
  const mark = w.requests.length;
  const seen = [];
  a.djCloud.on('change', () => seen.push(a.djCloud.state.busy && { ...a.djCloud.state.busy }));

  const result = await a.djCloud.upload(programId);
  assert.ok(result && result.id && result.revision);
  assert.deepEqual([result.uploaded, result.reused], [4, 0]);
  assert.equal(w.count(mark, '/v1/dj/uploads/part'), 4);
  assert.equal(w.count(mark, `/v1/dj/programs/${result.id}/publish`), 1);
  assert.ok(a.has(/«Boda Ana y Luis» está en tu nube: 4 canciones \(4 subidas ahora\)/));
  assert.equal(a.djCloud.state.busy, null);
  assert.equal(cloudAudio(w).length, 4);
  assert.equal(cloudPrograms(w).length, 1);

  // La pantalla puede seguir el avance: primero la preparación, luego las subidas, al final todo completo.
  const phases = [...new Set(seen.filter(Boolean).map((busy) => busy.phase))];
  assert.deepEqual(phases, ['prepare', 'hash', 'upload', 'publish']);
  const sizes = songs().reduce((total, file) => total + file.size, 0);
  const uploads = seen.filter((busy) => busy && busy.phase === 'upload');
  assert.equal(uploads[uploads.length - 1].bytesDone, sizes);
  assert.ok(uploads.every((busy, index) => index === 0 || busy.bytesDone >= uploads[index - 1].bytesDone), 'el avance nunca retrocede');

  // El programa de este equipo queda vinculado al de la nube y sin cambios pendientes.
  const mine = a.dj.program();
  assert.deepEqual([mine.cloud.endpoint, mine.cloud.id, mine.cloud.revision], [API, result.id, result.revision]);
  assert.deepEqual(a.djCloud.statusOf(mine), { linked: true, remote: a.djCloud.state.programs[0], gone: false, localChanges: false, behind: false });

  // Otro equipo, con una clave de músico: ve la lista y trae el programa.
  const playerKey = await w.createPlayer('Luis');
  const b = await equipo(w, playerKey);
  assert.equal(await b.djCloud.refresh(), true);
  assert.equal(b.djCloud.canUpload, false);
  assert.equal(b.djCloud.canRead, true);
  assert.deepEqual(b.djCloud.state.programs.map((entry) => [entry.name, entry.participants, entry.songs, entry.by]), [['Boda Ana y Luis', 4, 4, 'Propietario']]);
  assert.equal(b.djCloud.state.programs[0].size, sizes);

  const found = await b.djCloud.inspect(b.djCloud.state.programs[0]);
  assert.ok(found);
  const { summary } = found;
  assert.deepEqual([summary.kind, summary.songs, summary.withAudio, summary.reused, summary.linked, summary.waiting, summary.participants], ['cloud', 4, 4, 0, 0, 0, 4]);
  assert.equal(summary.audioBytes, sizes);
  assert.deepEqual([summary.hasSettings, summary.hasBindings, summary.customBindings], [true, true, false]);
  assert.equal(found.linked, null);

  const before = b.dj.state.programs.length;
  const report = await b.djCloud.download(found.opened, { applySettings: true });
  assert.deepEqual([report.programs, report.participants, report.saved, report.reused, report.waiting, report.aborted], [1, 4, 4, 0, 0, false]);
  assert.equal(b.dj.state.programs.length, before + 1);
  assert.equal(b.djCloud.state.busy, null);
  assert.equal(b.dj.state.importing, null);
  assert.ok(b.has(/Programa «Boda Ana y Luis» traído: 4 participantes · 4 canciones guardadas/));

  // Canciones idénticas, byte a byte; el programa, igual de armado.
  assert.equal(b.dj.state.tracks.length, 4);
  for (const track of b.dj.state.tracks) {
    assert.equal(await contentOf(b.store, track.id), crc32(songBytes(seedOf(track.file))), track.file);
    assert.equal(track.type, 'audio/mpeg');
    assert.equal(track.size, songs()[NAMES.indexOf(track.file)].size);
  }
  assert.deepEqual(rows(b), rows(a));
  assert.deepEqual(rows(b).map((row) => row[0]), ['Entrada de los novios', 'Madrina Rosa', '03 Padrinos', '04 Cierre']);
  assert.equal(b.dj.state.settings.fade, 6);
  assert.equal(b.dj.state.settings.autoAdvance, true);
  assert.ok(b.dj.effectiveBindings()['slot:1'].includes('n:1:36'));
  assert.deepEqual([b.dj.program().cloud.endpoint, b.dj.program().cloud.id, b.dj.program().cloud.revision], [API, result.id, result.revision]);
  assert.equal(b.djCloud.statusOf(b.dj.program()).localChanges, false);

  // Y sobrevive a cerrar y volver a abrir.
  await b.dj.flush();
  const again = await equipo(w, playerKey);
  assert.ok(again);
  const saved = (await b.store.all('programs')).find((entry) => entry.name === 'Boda Ana y Luis');
  assert.equal(saved.cloud.id, result.id);
});

test('una canción de dos partes (más de 8 MiB) llega idéntica', async () => {
  const w = world();
  const big = song('Himno largo.mp3', 9, CHUNK + 1234);
  const a = await equipo(w, MASTER, { files: [big, song('Corta.mp3', 2)] });
  const mark = w.requests.length;
  const result = await a.djCloud.upload(a.dj.program().id);
  assert.deepEqual([result.uploaded, w.count(mark, '/v1/dj/uploads/part')], [2, 3], 'la grande va en dos partes y la corta en una');
  const b = await equipo(w, MASTER);
  await b.djCloud.refresh();
  const found = await b.djCloud.inspect(b.djCloud.state.programs[0]);
  await b.djCloud.download(found.opened);
  const track = b.dj.state.tracks.find((item) => item.file === 'Himno largo.mp3');
  assert.equal(track.size, CHUNK + 1234);
  assert.equal(await contentOf(b.store, track.id), crc32(songBytes(9, CHUNK + 1234)));
  assert.equal(w.requests.slice(mark).filter((item) => item.path.startsWith('/v1/dj/audio/')).length, 3);
});

test('las canciones que ya están en la nube no se vuelven a subir, aunque las use otro programa', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  await armarBoda(a);
  const first = await a.djCloud.upload(a.dj.program().id);
  assert.equal(first.uploaded, 4);

  // Otro programa que repite dos canciones y trae una nueva.
  const [t1, t2] = a.dj.state.tracks;
  await a.dj.createProgram('Desfile');
  a.dj.addItem(t1.id);
  a.dj.addItem(t2.id);
  await a.dj.importFiles([song('05 Banda.mp3', 5)]);
  const mark = w.requests.length;
  const second = await a.djCloud.upload(a.dj.program().id);
  assert.deepEqual([second.uploaded, second.reused], [1, 2]);
  assert.equal(w.count(mark, '/v1/dj/uploads/part'), 1);
  assert.ok(a.has(/«Desfile» está en tu nube: 3 canciones \(1 subida ahora, 2 ya estaban\)/));
  assert.equal(cloudAudio(w).length, 5);
  assert.deepEqual(a.djCloud.state.programs.map((entry) => entry.name).sort(), ['Boda Ana y Luis', 'Desfile']);

  // Subir otra vez el mismo programa sin tocarlo cuesta casi nada y deja una versión nueva.
  const mark2 = w.requests.length;
  const third = await a.djCloud.upload(a.dj.program().id);
  assert.deepEqual([third.uploaded, third.reused, w.count(mark2, '/v1/dj/uploads/part')], [0, 3, 0]);
  assert.ok(a.has(/«Desfile» está en tu nube: 3 canciones \(ya estaban todas\)/));
  assert.equal(third.id, second.id);
  assert.notEqual(third.revision, second.revision);
});

// ------------------------------------------------------------------ actualizar

test('el programa se actualiza en la nube y el otro equipo lo recibe en el mismo programa, sin copias', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  const programId = await armarBoda(a);
  const first = await a.djCloud.upload(programId);
  const b = await equipo(w, MASTER);
  await b.djCloud.refresh();
  await b.djCloud.download((await b.djCloud.inspect(b.djCloud.state.programs[0])).opened);
  const bProgram = b.dj.program();
  const bOldItems = bProgram.items.map((item) => item.id);
  assert.equal(b.dj.state.programs.length, 2, 'Programa 1 vacío + el traído');

  // El equipo A cambia el orden y una etiqueta: ahora tiene cambios que la nube no tiene.
  const [x, y] = a.dj.items();
  a.dj.moveItemBy(x.id, 1);
  a.dj.updateItem(y.id, { label: 'Madrina Rosa (nueva)' });
  assert.equal(a.djCloud.statusOf(a.dj.program()).localChanges, true);
  const mark = w.requests.length;
  const second = await a.djCloud.upload(programId);
  assert.deepEqual([second.id, second.uploaded, second.reused], [first.id, 0, 4]);
  assert.notEqual(second.revision, first.revision);
  assert.equal(w.count(mark, '/v1/dj/uploads/part'), 0);
  assert.equal(a.djCloud.statusOf(a.dj.program()).localChanges, false);
  assert.equal(cloudPrograms(w).length, 1, 'sigue siendo un solo programa en la nube');

  // B ve que la nube tiene algo más nuevo, pregunta y actualiza SU programa (no crea otro).
  assert.equal(b.djCloud.statusOf(bProgram).behind, false, 'todavía no lo ha consultado');
  await b.djCloud.refresh();
  assert.equal(b.djCloud.statusOf(bProgram).behind, true);
  const found = await b.djCloud.inspect(b.djCloud.state.programs[0]);
  assert.equal(found.linked.id, bProgram.id, 'sabe cuál de sus programas es');
  assert.deepEqual([found.summary.reused, found.summary.withAudio], [4, 0], 'las canciones ya están: no se bajan otra vez');
  const mark2 = w.requests.length;
  b.dj.state.nowId = null;
  const report = await b.djCloud.download(found.opened, { replaceId: bProgram.id });
  assert.deepEqual([report.replaced, report.saved, report.reused, report.programs], [true, 0, 4, 1]);
  assert.equal(w.requests.slice(mark2).filter((item) => item.path.startsWith('/v1/dj/audio/')).length, 0);
  assert.equal(b.dj.state.programs.length, 2, 'no aparece una copia');
  assert.equal(b.dj.program().id, bProgram.id);
  assert.equal(b.dj.program().name, 'Boda Ana y Luis');
  assert.deepEqual(rows(b), rows(a));
  assert.ok(b.has(/Programa «Boda Ana y Luis» actualizado: 4 participantes/));
  assert.equal(b.dj.program().cloud.revision, second.revision);
  assert.equal(b.djCloud.statusOf(b.dj.program()).behind, false);
  for (const id of bOldItems) assert.ok(b.engine.dropped.includes(id), 'se libera lo que tenía preparado del programa anterior');
  assert.equal(b.dj.state.tracks.length, 4, 'las canciones no se duplicaron');
});

test('si la nube tiene una versión más nueva, no se pisa: se avisa y se puede subir como programa nuevo', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  const programId = await armarBoda(a);
  const first = await a.djCloud.upload(programId);

  // Un editor trae el programa, lo cambia y lo sube: la nube pasa a la versión 2.
  const editorKey = await w.createUser('Ana', 'editor');
  const e = await equipo(w, editorKey);
  await e.djCloud.refresh();
  await e.djCloud.download((await e.djCloud.inspect(e.djCloud.state.programs[0])).opened);
  e.dj.renameProgram(e.dj.program().id, 'Boda (ajustada por Ana)');
  const second = await e.djCloud.upload(e.dj.program().id);
  assert.equal(second.id, first.id);
  assert.equal(e.djCloud.state.programs[0].by, 'Ana');

  // A todavía tiene la versión 1 y cambia algo: su subida se rechaza sin tocar la nube.
  a.dj.updateItem(a.dj.items()[2].id, { label: 'Padrinos (cambio de A)' });
  assert.equal(await a.djCloud.upload(programId), null);
  assert.ok(a.has(/otra versión de este programa/, 'error'));
  assert.equal(JSON.parse(new TextDecoder().decode(w.bucket.rows.get(`dj/programs/${first.id}.json`).bytes)).revision, second.revision);
  assert.equal(a.djCloud.state.busy, null);

  // Subirlo como programa nuevo sí funciona y deja los dos.
  const copy = await a.djCloud.upload(programId, { asNew: true });
  assert.ok(copy.id && copy.id !== first.id);
  assert.deepEqual(a.djCloud.state.programs.map((entry) => entry.id).sort(), [first.id, copy.id].sort());
  assert.equal(a.dj.program().cloud.id, copy.id, 'ahora este programa apunta a la copia nueva');
});

test('si el programa ya no está en la nube, subirlo de nuevo lo vuelve a crear', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  const first = await a.djCloud.upload(a.dj.program().id);
  const entry = a.djCloud.state.programs[0];
  assert.equal(await a.djCloud.remove(entry), true);
  assert.equal(a.dj.program().cloud, undefined, 'al eliminarlo de la nube, el programa de aquí deja de apuntar a él');
  assert.equal(cloudAudio(w).length, 0);
  const again = await a.djCloud.upload(a.dj.program().id);
  assert.equal(again.uploaded, 4);
  assert.notEqual(again.id, first.id);
});

// ------------------------------------------------------------------ permisos

test('permisos: el músico solo trae; el editor sube; solo el propietario elimina', async () => {
  const w = world();
  const owner = await equipo(w, MASTER, { files: songs() });
  await owner.djCloud.upload(owner.dj.program().id);
  const entry = owner.djCloud.state.programs[0];

  const player = await equipo(w, await w.createPlayer('Luis'), { files: songs() });
  const mark = w.requests.length;
  assert.equal(await player.djCloud.upload(player.dj.program().id), null);
  assert.ok(player.errors().some((message) => /permite reproducir|editor/.test(message)));
  assert.equal(w.requests.slice(mark).filter((item) => item.path.includes('/uploads/')).length, 0, 'ni siquiera lo intenta');
  await player.djCloud.refresh();
  assert.equal(await player.djCloud.remove(entry), false);
  assert.ok(player.errors().some((message) => /Solo el propietario|editor/.test(message)));

  const editor = await equipo(w, await w.createUser('Ana', 'editor'), { files: songs() });
  assert.equal(editor.djCloud.canUpload, true);
  assert.equal(editor.djCloud.canDelete, false);
  const uploaded = await editor.djCloud.upload(editor.dj.program().id);
  assert.deepEqual([uploaded.uploaded, uploaded.reused], [0, 4], 'las mismas canciones ya estaban');
  await editor.djCloud.refresh();
  assert.equal(await editor.djCloud.remove(editor.djCloud.state.programs[0]), false);
  assert.ok(editor.errors().some((message) => /Solo el propietario/.test(message)));
  assert.equal(cloudPrograms(w).length, 2);

  // El propietario elimina uno: el otro conserva sus canciones; al eliminar el último se libera todo.
  await owner.djCloud.refresh();
  assert.equal(owner.djCloud.canDelete, true);
  assert.equal(await owner.djCloud.remove(owner.djCloud.state.programs.find((item) => item.id === entry.id)), true);
  assert.equal(cloudPrograms(w).length, 1);
  assert.equal(cloudAudio(w).length, 4);
  assert.equal(await owner.djCloud.remove(owner.djCloud.state.programs[0]), true);
  assert.deepEqual([cloudPrograms(w).length, cloudAudio(w).length, owner.djCloud.state.programs.length], [0, 0, 0]);
  assert.ok(owner.has(/se eliminó de la nube\. Los equipos que ya lo trajeron conservan su copia/));
});

test('al eliminar de la nube, los programas de este equipo que apuntaban a él dejan de apuntar', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  await a.djCloud.upload(a.dj.program().id);
  const b = await equipo(w, MASTER);
  await b.djCloud.refresh();
  await b.djCloud.download((await b.djCloud.inspect(b.djCloud.state.programs[0])).opened);
  assert.ok(b.dj.program().cloud);
  await b.djCloud.remove(b.djCloud.state.programs[0]);
  assert.equal(b.dj.program().cloud, undefined);
  assert.equal(b.dj.program().items.length, 4, 'el programa traído se conserva');
  // A todavía cree que está en la nube: al consultar la lista lo sabe.
  await a.djCloud.refresh();
  assert.equal(a.djCloud.statusOf(a.dj.program()).gone, true);
});

// ------------------------------------------------------------------ cancelar

test('cancelar una subida deja la nube sin programa a medias, y repetirla aprovecha lo ya subido', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  const request = a.cloud.request.bind(a.cloud);
  let completes = 0;
  a.cloud.request = async (path, options) => {
    const result = await request(path, options);
    if (path === '/v1/dj/uploads/complete' && ++completes === 2) a.djCloud.cancel();
    return result;
  };
  assert.equal(await a.djCloud.upload(a.dj.program().id), null);
  assert.ok(a.has(/Subida cancelada\. Lo que ya se subió se aprovecha si la repites/));
  assert.equal(a.djCloud.state.busy, null);
  assert.equal(a.dj.program().cloud, undefined);
  assert.equal(cloudPrograms(w).length, 0, 'no se publicó nada');
  assert.equal(cloudAudio(w).length, 2, 'las dos canciones terminadas quedan para aprovecharlas');
  assert.deepEqual(abiertas(w), [], 'no queda ninguna subida por partes abierta');

  a.cloud.request = request;
  const mark = w.requests.length;
  const done = await a.djCloud.upload(a.dj.program().id);
  assert.deepEqual([done.uploaded, done.reused], [2, 2]);
  assert.equal(w.count(mark, '/v1/dj/uploads/part'), 2);
  assert.equal(cloudPrograms(w).length, 1);
});

test('cancelar a mitad de una canción larga descarta esa subida a medias y no publica nada', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: [song('Corta.mp3', 2), song('Himno largo.mp3', 9, CHUNK + 1234)] });
  const request = a.cloud.request.bind(a.cloud);
  let parts = 0;
  a.cloud.request = async (path, options) => {
    const result = await request(path, options);
    if (path.startsWith('/v1/dj/uploads/part') && ++parts === 2) a.djCloud.cancel(); // la 1.ª parte de la canción larga
    return result;
  };
  const mark = w.requests.length;
  assert.equal(await a.djCloud.upload(a.dj.program().id), null);
  assert.ok(a.has(/Subida cancelada/));
  assert.equal(w.count(mark, '/v1/dj/uploads/discard'), 1, 'avisa a la nube de que esa subida se abandona');
  assert.deepEqual(abiertas(w), []);
  assert.equal(cloudAudio(w).length, 1, 'solo la canción corta, que sí terminó');
  assert.equal(cloudPrograms(w).length, 0);
  assert.equal(a.dj.program().cloud, undefined);

  a.cloud.request = request;
  const done = await a.djCloud.upload(a.dj.program().id);
  assert.deepEqual([done.uploaded, done.reused], [1, 1]);
  assert.equal(cloudAudio(w).length, 2);
});

test('cancelar una descarga conserva lo que ya llegó y no deja programas a medias; repetirla no baja de nuevo lo guardado', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  await a.djCloud.upload(a.dj.program().id);
  const b = await equipo(w, MASTER);
  await b.djCloud.refresh();
  const found = await b.djCloud.inspect(b.djCloud.state.programs[0]);

  const request = b.cloud.request.bind(b.cloud);
  let audio = 0;
  b.cloud.request = async (path, options) => {
    const result = await request(path, options);
    if (path.startsWith('/v1/dj/audio/') && ++audio === 2) b.djCloud.cancel();
    return result;
  };
  const programs = b.dj.state.programs.length;
  const cut = await b.djCloud.download(found.opened);
  assert.equal(cut.aborted, true);
  assert.ok(b.has(/Descarga cancelada\. Las canciones que ya llegaron se quedan en este dispositivo/));
  assert.equal(b.dj.state.programs.length, programs, 'no se creó ningún programa');
  assert.equal(b.dj.state.tracks.length, 2, 'las dos que alcanzaron a llegar están en la biblioteca');
  assert.equal(b.dj.state.importing, null);
  assert.equal(b.djCloud.state.busy, null);

  b.cloud.request = request;
  const again = await b.djCloud.inspect(b.djCloud.state.programs[0]);
  assert.deepEqual([again.summary.reused, again.summary.withAudio], [2, 2]);
  const mark = w.requests.length;
  const report = await b.djCloud.download(again.opened);
  assert.deepEqual([report.saved, report.reused, report.programs], [2, 2, 1]);
  assert.equal(w.requests.slice(mark).filter((item) => item.path.startsWith('/v1/dj/audio/')).length, 2);
  assert.equal(b.dj.state.tracks.length, 4);
  assert.deepEqual(rows(b).map((row) => row[1]), ['01 Novios', '02 Madrina', '03 Padrinos', '04 Cierre']);
});

// ------------------------------------------------------------------ datos dañados o ajenos

test('una canción dañada en la nube no entra a la biblioteca: se avisa y el participante queda esperando su archivo', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  await a.djCloud.upload(a.dj.program().id);
  // Se altera un byte de una canción guardada en la nube.
  const stored = JSON.parse(new TextDecoder().decode(w.bucket.rows.get(cloudPrograms(w)[0]).bytes));
  const victim = stored.files.find((file) => stored.package.tracks.find((track) => track.ref === file.ref).file === '03 Padrinos.mp3');
  w.bucket.rows.get(`dj/audio/${victim.content}`).bytes[10] ^= 255;

  const b = await equipo(w, MASTER);
  await b.djCloud.refresh();
  const mark = w.requests.length;
  const report = await b.djCloud.download((await b.djCloud.inspect(b.djCloud.state.programs[0])).opened);
  assert.deepEqual([report.saved, report.waiting, report.failed.length, report.programs], [3, 1, 1, 1]);
  assert.match(report.failed[0], /03 Padrinos\.mp3: .*no llegó completa de la nube/);
  assert.ok(b.has(/no llegó completa de la nube/, 'error'));
  assert.equal(b.dj.state.tracks.length, 3);
  assert.ok(!b.dj.state.tracks.some((track) => track.file === '03 Padrinos.mp3'), 'la canción dañada no se guardó');
  assert.equal(b.dj.items()[2].missing, true);
  assert.equal(b.dj.items()[2].trackName, 'Falta «03 Padrinos.mp3»');
  assert.equal(w.requests.slice(mark).filter((item) => item.path === `/v1/dj/audio/${victim.content}`).length, 3, 'reintenta antes de rendirse');

  // Cuando alguien la sube bien, basta con volver a traer el programa: lo ya guardado no se repite.
  a.cloud.request = a.cloud.request.bind(a.cloud);
  w.bucket.rows.get(`dj/audio/${victim.content}`).bytes[10] ^= 255; // se "repara" la nube
  const fixed = await b.djCloud.download((await b.djCloud.inspect(b.djCloud.state.programs[0])).opened);
  assert.deepEqual([fixed.saved, fixed.reused, fixed.waiting], [1, 3, 0]);
});

test('una canción que ya no está en la nube se avisa con claridad', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  await a.djCloud.upload(a.dj.program().id);
  const victim = cloudAudio(w)[0];
  w.bucket.rows.delete(victim);
  const b = await equipo(w, MASTER);
  await b.djCloud.refresh();
  const report = await b.djCloud.download((await b.djCloud.inspect(b.djCloud.state.programs[0])).opened);
  assert.deepEqual([report.saved, report.waiting, report.programs], [3, 1, 1]);
  assert.ok(b.has(/ya no está en la nube\. Vuelve a subir el programa desde el equipo que tiene la canción/, 'error'));
});

test('lo que devuelve la nube se valida antes de usarlo', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  await a.djCloud.upload(a.dj.program().id);
  const key = cloudPrograms(w)[0];
  const good = JSON.parse(new TextDecoder().decode(w.bucket.rows.get(key).bytes));
  const id = good.id;
  const ok = await readCloudProgram(structuredClone(good), id);
  assert.equal(ok.files.size, 4);
  assert.equal(ok.parsed.programs[0].items.length, 4);

  const cases = {
    'otra identificación': (m) => { m.id = 'otro-programa-1'; },
    'versión que no conoce': (m) => { m.schema = 2; },
    'otro tipo': (m) => { m.kind = 'setlist'; },
    'partes de otro tamaño': (m) => { m.chunkSize = 1024; },
    'revisión inválida': (m) => { m.revision = '??'; },
    'no es un paquete del DJ': (m) => { m.package.format = 'otra-cosa'; },
    'dos programas': (m) => { m.package.programs.push(structuredClone(m.package.programs[0])); },
    'tamaño imposible': (m) => { m.files[0].size = -5; },
    'tamaño gigante': (m) => { m.files[0].size = 6 * 1024 ** 3; },
    'faltan hashes': (m) => { m.files[0].hashes = []; },
    'hash mal escrito': (m) => { m.files[0].hashes = ['zz']; },
    'identificación falsa': (m) => { m.files[0].content = 'a'.repeat(64); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const bad = structuredClone(good);
    mutate(bad);
    await assert.rejects(readCloudProgram(bad, id), Error, name);
  }
  await assert.rejects(readCloudProgram(null, id), /no entiende/);
  await assert.rejects(readCloudProgram('texto', id), /no entiende/);

  // Referencias desconocidas o repetidas se ignoran; esas canciones quedan sin audio en vez de romper el programa.
  const odd = structuredClone(good);
  odd.files.push({ ...odd.files[0] }, { ...odd.files[1], ref: 'fantasma' });
  assert.equal((await readCloudProgram(odd, id)).files.size, 4);
  odd.files = [];
  assert.equal((await readCloudProgram(odd, id)).files.size, 0);

  // Y la identificación es la que calcula el Worker: tamaño + hash de cada parte.
  const first = good.files[0];
  assert.equal(first.content, await contentId(first.size, first.hashes));
  assert.equal(first.hashes[0], await sha256(songBytes(seedOf(good.package.tracks.find((track) => track.ref === first.ref).file))));
});

// ------------------------------------------------------------------ nube sin Worker nuevo, sin conexión, sin espacio

test('con un Worker anterior se explica qué hacer en vez de fallar', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  w.hideFeatures = true;
  assert.equal(await a.djCloud.refresh(), false);
  assert.equal(a.djCloud.state.error, OLD_WORKER);
  assert.equal(a.djCloud.state.supported, false);
  const mark = w.requests.length;
  assert.equal(await a.djCloud.upload(a.dj.program().id), null);
  assert.ok(a.has(/todavía no guarda programas del DJ\. Publica primero el Worker nuevo \(server\/worker\.mjs\)/, 'error'));
  assert.equal(w.requests.slice(mark).filter((item) => item.path.includes('/uploads/')).length, 0, 'no sube nada antes de comprobarlo');
  assert.equal(a.djCloud.state.busy, null);

  // Un Worker que anuncia la función pero no tiene la ruta de eliminar también se explica.
  w.hideFeatures = false;
  await a.djCloud.upload(a.dj.program().id);
  w.hideDelete = true;
  await a.djCloud.refresh();
  assert.equal(await a.djCloud.remove(a.djCloud.state.programs[0]), false);
  assert.ok(a.errors().filter((message) => message === OLD_WORKER).length >= 2);
});

test('sin nube conectada no hay nada que hacer y no se rompe', async () => {
  const w = world();
  const off = { connected: false, canAccess: false, canPublish: false, canDelete: false, api: '', identity: null, on: () => () => {}, init: async () => {} };
  const a = await equipo(w, null, { files: songs(), cloud: off });
  assert.equal(a.djCloud.connected, false);
  assert.equal(await a.djCloud.refresh(), false);
  assert.deepEqual(a.djCloud.state.programs, []);
  assert.equal(await a.djCloud.upload(a.dj.program().id), null);
  assert.ok(a.has(/Conecta tu nube/, 'error'));
});

test('mientras suena la música no se sube ni se trae nada', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  const programId = a.dj.program().id;
  a.dj.state.transport = 'playing';
  assert.equal(await a.djCloud.upload(programId), null);
  assert.ok(a.has(/Detén la música antes de subir el programa/, 'error'));
  a.dj.state.transport = 'idle';
  await a.djCloud.upload(programId);

  const b = await equipo(w, MASTER);
  await b.djCloud.refresh();
  const found = await b.djCloud.inspect(b.djCloud.state.programs[0]);
  b.dj.state.transport = 'playing';
  assert.equal(await b.djCloud.download(found.opened), null);
  assert.ok(b.has(/Detén la música antes de traer un programa/, 'error'));
  assert.equal(b.dj.state.tracks.length, 0);
});

test('si no hay espacio en el dispositivo, se avisa antes de bajar nada', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  await a.djCloud.upload(a.dj.program().id);
  const b = await equipo(w, MASTER);
  b.store.estimate = async () => ({ usage: 100, quota: 1000 });
  await b.djCloud.refresh();
  const found = await b.djCloud.inspect(b.djCloud.state.programs[0]);
  const mark = w.requests.length;
  assert.equal(await b.djCloud.download(found.opened), null);
  assert.ok(b.has(/No hay espacio suficiente en este dispositivo para las canciones nuevas/, 'error'));
  assert.equal(w.requests.slice(mark).filter((item) => item.path.startsWith('/v1/dj/audio/')).length, 0);
  assert.equal(b.dj.state.tracks.length, 0);
});

test('un programa sin canciones con audio, o con muchas, se rechaza antes de subir nada', async () => {
  const w = world();
  const empty = await equipo(w, MASTER);
  assert.equal(await empty.djCloud.upload(empty.dj.program().id), null);
  assert.ok(empty.has(/no tiene canciones con audio en este dispositivo/, 'error'));

  // Participantes que todavía esperan su archivo (llegaron sin audio) no cuentan como canciones con audio.
  const source = await equipo(w, MASTER, { files: songs() });
  const light = await source.dj.exportPackage({ audio: false });
  const target = await equipo(w, MASTER);
  await target.dj.importPackage((await target.dj.openPackage(new File([light.blob], light.fileName))).opened);
  assert.equal(await target.djCloud.upload(target.dj.program().id), null);
  assert.ok(target.has(/no tiene canciones con audio en este dispositivo/, 'error'));
  assert.equal(cloudAudio(w).length, 0);

  // Un programa con más de 2000 participantes no cabe.
  const many = await equipo(w, MASTER, { files: [song('Una.mp3', 1)] });
  const track = many.dj.state.tracks[0];
  const program = many.dj.program();
  for (let index = 0; index < 2001; index++) program.items.push({ id: `item-${index}`, trackId: track.id, label: '', start: 0, maxDur: 0, gainDb: 0 });
  const mark = w.requests.length;
  assert.equal(await many.djCloud.upload(program.id), null);
  assert.ok(many.has(/más de 2000 participantes/, 'error'));
  assert.equal(w.requests.slice(mark).filter((item) => item.path.includes('/uploads/')).length, 0);
});

test('los participantes que esperan su archivo viajan igual y se vinculan al añadir la canción en el otro equipo', async () => {
  const w = world();
  const a = await equipo(w, MASTER, { files: songs() });
  // Este equipo ya tenía un participante sin archivo (venía de un paquete sin audio).
  const [, , c, d] = a.dj.items();
  a.dj.program().items.find((item) => item.id === d.id).trackId = 'borrada';
  a.dj.program().items.find((item) => item.id === d.id).want = { name: 'Cierre', file: '04 Cierre.mp3', size: 4400, duration: 200 };
  const result = await a.djCloud.upload(a.dj.program().id);
  assert.deepEqual([result.uploaded, a.djCloud.state.programs[0].songs, a.djCloud.state.programs[0].participants], [3, 3, 4], 'cuatro participantes, tres canciones con audio');

  const b = await equipo(w, MASTER);
  await b.djCloud.refresh();
  const found = await b.djCloud.inspect(b.djCloud.state.programs[0]);
  assert.deepEqual([found.summary.withAudio, found.summary.waiting], [3, 1]);
  const report = await b.djCloud.download(found.opened);
  assert.deepEqual([report.saved, report.waiting], [3, 1]);
  assert.equal(b.dj.items()[3].missing, true);
  assert.equal(b.dj.items()[3].trackName, 'Falta «04 Cierre.mp3»');
  assert.ok(c);
});
