// Publicar y actualizar solo lo que cambió. Ejecuta el cliente real (www/js/cloud.js)
// contra el Worker real (server/worker.mjs) con R2 en memoria: nada sale de este proceso
// y todas las claves son de prueba.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';
import { A_SIZE, B_SIZE, CHUNK, COVER_1, COVER_2, COVER_3, MASTER, fill, newSong, same, world } from './helpers/cloud-world.mjs';

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

test('publishing a change that leaves the audio alone uploads no audio; a changed track uploads only itself', async () => {
  const w = world(), owner = await w.device(MASTER);
  const song = newSong(owner);

  // Primera publicación: se sube todo (dos partes de A y una de B).
  let mark = w.requests.length;
  await owner.cloud.upload(song);
  assert.equal(w.count(mark, '/v1/uploads/start'), 2);
  assert.equal(w.count(mark, '/v1/uploads/part'), 3);
  const first = song.cloud.revision, songId = song.cloud.id;

  // Solo cambian la portada y las secciones: no se sube audio.
  song.cover = COVER_2; song.markers = [{ id: 'marker01', name: 'Coro', time: 10 }];
  mark = w.requests.length;
  await owner.cloud.upload(song);
  assert.equal(w.count(mark, '/v1/uploads/start'), 0);
  assert.equal(w.count(mark, '/v1/uploads/part'), 0);
  assert.equal(w.count(mark, `/v1/songs/${songId}/publish`), 1);
  const second = await w.manifest(songId);
  assert.notEqual(second.revision, first);
  assert.equal(second.song.cover, COVER_2);
  assert.deepEqual(second.files.map(file => file.revision), [first, first]);
  assert.equal([...w.bucket.rows.keys()].some(key => key.startsWith(`audio/${songId}/${second.revision}/`)), false);
  assert.ok(w.toasts.some(message => /sin cambios/.test(message)));
  assert.equal(song.cloud.revision, second.revision);
  // El audio sigue completo y correcto en la nube con la dirección de la versión nueva.
  assert.ok(same(await w.readAll(songId, second.revision, 'trackaaa1', A_SIZE), fill(A_SIZE, 1)));
  assert.ok(same(await w.readAll(songId, second.revision, 'trackbbb1', B_SIZE), fill(B_SIZE, 2)));

  // Cambia un solo byte, al final de la pista A (su segunda parte): solo A se vuelve a subir.
  const edited = fill(A_SIZE, 1); edited[edited.length - 1] ^= 0xff;
  owner.setFile('file-a', edited);
  mark = w.requests.length;
  await owner.cloud.upload(song);
  assert.equal(w.count(mark, '/v1/uploads/start'), 1);
  assert.equal(w.count(mark, '/v1/uploads/part'), 2);
  const third = await w.manifest(songId);
  const byId = Object.fromEntries(third.files.map(file => [file.id, file]));
  assert.equal(byId.trackaaa1.revision, undefined, 'the changed track lives in the new revision');
  assert.equal(byId.trackbbb1.revision, first, 'the untouched track keeps pointing at the file already uploaded');
  assert.ok(same(await w.readAll(songId, third.revision, 'trackaaa1', A_SIZE), edited));
  assert.ok(same(await w.readAll(songId, third.revision, 'trackbbb1', B_SIZE), fill(B_SIZE, 2)));

  // Cambia solo el tamaño de B: se detecta sin leer nada más y B se sube de nuevo.
  const longer = fill(B_SIZE + 5, 2);
  owner.setFile('file-b', longer);
  mark = w.requests.length;
  await owner.cloud.upload(song);
  assert.equal(w.count(mark, '/v1/uploads/start'), 1);
  const fourth = await w.manifest(songId);
  assert.ok(same(await w.readAll(songId, fourth.revision, 'trackbbb1', longer.length), longer));
  assert.equal(fourth.files.find(file => file.id === 'trackaaa1').revision, third.revision, 'A now points at the revision where its new audio lives');
});

test('a musician updating a song keeps the audio already on the device and downloads only what changed', async () => {
  const w = world(), owner = await w.device(MASTER);
  const song = newSong(owner);
  await owner.cloud.upload(song);
  const songId = song.cloud.id;

  const musician = await w.device(await w.createPlayer());
  await musician.cloud.refresh();
  let mark = w.requests.length;
  await musician.cloud.download(songId);
  assert.equal(w.count(mark, '/v1/audio/' + songId + '/' + song.cloud.revision + '/trackaaa1'), 2);
  assert.equal(w.count(mark, '/v1/audio/' + songId + '/' + song.cloud.revision + '/trackbbb1'), 1);
  const first = musician.cloud.local(songId), firstFiles = first.tracks.map(track => track.fileId);
  assert.ok(same(await musician.fileBytes(firstFiles[0]), fill(A_SIZE, 1)));
  assert.ok(same(await musician.fileBytes(firstFiles[1]), fill(B_SIZE, 2)));

  // El maestro cambia la portada y las secciones; el músico actualiza.
  song.cover = COVER_2; song.markers = [{ id: 'marker01', name: 'Coro', time: 10 }];
  await owner.cloud.upload(song);
  await musician.cloud.refresh();
  const remote = musician.cloud.catalog.find(item => item.id === songId);
  assert.notEqual(remote.revision, first.cloud.revision);
  mark = w.requests.length;
  await musician.cloud.download(songId);
  assert.equal(w.requests.slice(mark).filter(item => item.path.startsWith('/v1/audio/')).length, 0, 'no audio is downloaded again');
  const second = musician.cloud.local(songId);
  assert.equal(second.cover, COVER_2);
  assert.equal(second.cloud.revision, remote.revision);
  assert.deepEqual(second.tracks.map(track => track.fileId), firstFiles);
  assert.deepEqual(musician.commits.at(-1).oldFileIds, [], 'kept audio is never deleted');
  assert.ok(musician.table('files').has(firstFiles[0]) && musician.table('files').has(firstFiles[1]));
  assert.ok(same(await musician.fileBytes(firstFiles[1]), fill(B_SIZE, 2)));

  // El maestro cambia el audio de la pista B; el músico solo baja esa pista.
  const newB = fill(B_SIZE, 9);
  owner.setFile('file-b', newB);
  await owner.cloud.upload(song);
  await musician.cloud.refresh();
  mark = w.requests.length;
  await musician.cloud.download(songId);
  const audio = w.requests.slice(mark).filter(item => item.path.startsWith('/v1/audio/'));
  assert.equal(audio.length, 1);
  assert.ok(audio[0].path.endsWith('/trackbbb1'));
  const third = musician.cloud.local(songId);
  assert.equal(third.tracks[0].fileId, firstFiles[0], 'the unchanged track keeps its local file');
  assert.notEqual(third.tracks[1].fileId, firstFiles[1]);
  assert.deepEqual(musician.commits.at(-1).oldFileIds, [firstFiles[1]], 'only the replaced audio is removed');
  assert.equal(musician.table('files').has(firstFiles[1]), false);
  assert.ok(same(await musician.fileBytes(third.tracks[1].fileId), newB));
  assert.ok(same(await musician.fileBytes(firstFiles[0]), fill(A_SIZE, 1)));

  // El audio cambió por completo en la nube pero con el mismo tamaño: se baja entero y se verifica.
  const sameSizeB = fill(B_SIZE, 33);
  owner.setFile('file-b', sameSizeB);
  await owner.cloud.upload(song);
  await musician.cloud.refresh();
  await musician.cloud.download(songId);
  assert.ok(same(await musician.fileBytes(musician.cloud.local(songId).tracks[1].fileId), sameSizeB));
});

test('a Worker that does not advertise audio reuse still receives a complete, valid upload', async () => {
  const w = world(), owner = await w.device(MASTER);
  const song = newSong(owner);
  await owner.cloud.upload(song);
  const songId = song.cloud.id;

  w.hideFeatures = true; // Worker anterior: la app no intenta reutilizar nada
  song.cover = COVER_2;
  let mark = w.requests.length;
  await owner.cloud.upload(song);
  assert.equal(w.count(mark, '/v1/uploads/start'), 2);
  assert.equal(w.count(mark, '/v1/uploads/part'), 3);
  const legacy = await w.manifest(songId);
  assert.deepEqual(legacy.files.map(file => file.revision), [undefined, undefined]);
  assert.ok(same(await w.readAll(songId, legacy.revision, 'trackaaa1', A_SIZE), fill(A_SIZE, 1)));

  // Con el Worker nuevo, una versión sin `revision` en sus pistas también se puede reutilizar.
  w.hideFeatures = false;
  song.cover = COVER_3;
  mark = w.requests.length;
  await owner.cloud.upload(song);
  assert.equal(w.count(mark, '/v1/uploads/start'), 0);
  const current = await w.manifest(songId);
  assert.deepEqual(current.files.map(file => file.revision), [legacy.revision, legacy.revision]);
  assert.ok(same(await w.readAll(songId, current.revision, 'trackbbb1', B_SIZE), fill(B_SIZE, 2)));
});

test('an interrupted publication that already reused a track resumes without checking or uploading it again', async () => {
  const w = world(), owner = await w.device(MASTER);
  const song = newSong(owner);
  await owner.cloud.upload(song);
  const songId = song.cloud.id, first = song.cloud.revision;

  // Cambia la pista B; A se queda igual. La subida de B se interrumpe antes de terminar.
  const edited = fill(B_SIZE, 5);
  owner.setFile('file-b', edited);
  let broken = true;
  const original = w.bucket.resumeMultipartUpload.bind(w.bucket);
  w.bucket.resumeMultipartUpload = (key, uploadId) => {
    const upload = original(key, uploadId);
    return { ...upload, uploadPart: async (...args) => { if (broken && key.endsWith('/trackbbb1')) throw new Error('corte simulado'); return upload.uploadPart(...args); } };
  };
  await assert.rejects(owner.cloud.upload(song));
  const pending = await owner.cloud.pending();
  assert.equal(pending.length, 1);
  const settled = pending[0].files.find(file => file.id === 'trackaaa1');
  assert.equal(settled.done, true, 'the untouched track is already settled');
  assert.equal(settled.reuse, first);
  assert.equal(pending[0].files.find(file => file.id === 'trackbbb1').done, false);
  assert.equal((await w.manifest(songId)).revision, first, 'nothing was published by the failed attempt');

  broken = false;
  const mark = w.requests.length;
  await owner.cloud.resume(pending[0]);
  assert.equal(w.count(mark, '/v1/uploads/start'), 0, 'the interrupted upload continues; nothing starts over');
  assert.equal(w.count(mark, '/v1/uploads/part'), 1, 'only the missing part of the changed track is sent');
  const current = await w.manifest(songId);
  const byId = Object.fromEntries(current.files.map(file => [file.id, file]));
  assert.equal(byId.trackaaa1.revision, first);
  assert.equal(byId.trackbbb1.revision, undefined);
  assert.ok(same(await w.readAll(songId, current.revision, 'trackaaa1', A_SIZE), fill(A_SIZE, 1)));
  assert.ok(same(await w.readAll(songId, current.revision, 'trackbbb1', B_SIZE), edited));
  assert.equal((await owner.cloud.pending()).length, 0);
});
