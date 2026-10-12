// Eliminar una canción de la nube. Ejecuta el cliente real (www/js/cloud.js) contra el
// Worker real (server/worker.mjs) con R2 en memoria: nada sale de este proceso.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';
import { API, COVER_2, MASTER, newSong, world } from './helpers/cloud-world.mjs';

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const cloudKeys = (w, songId) => [...w.bucket.rows.keys()].filter(key => key === `catalog/${songId}.json` || key.startsWith(`audio/${songId}/`));

test('the owner deletes a song from the cloud; this device keeps an unlinked copy that can be uploaded again as a new song', async () => {
  const w = world(), owner = await w.device(MASTER);
  const song = newSong(owner);
  await owner.cloud.upload(song);
  const songId = song.cloud.id;
  assert.equal(owner.cloud.canDelete, true);
  assert.ok(cloudKeys(w, songId).length > 0);

  const remote = owner.cloud.catalog.find(item => item.id === songId);
  assert.ok(remote && remote.revision && remote.updatedAt, 'the list carries the revision and the publication date');
  const mark = w.requests.length;
  await owner.cloud.deleteSong(remote);
  assert.equal(w.count(mark, `/v1/songs/${songId}/delete`), 1);
  assert.deepEqual(cloudKeys(w, songId), [], 'catalog entry and every audio file are gone');
  assert.equal(owner.cloud.catalog.some(item => item.id === songId), false);
  assert.ok(w.toasts.some(message => /se eliminó de la nube/.test(message)));

  // La copia de este equipo sigue intacta, pero ya no apunta a una canción inexistente.
  const kept = owner.app.songs.get(song.id);
  assert.ok(kept);
  assert.equal(kept.cloud, undefined);
  assert.ok(owner.table('files').has('file-a') && owner.table('files').has('file-b'));
  assert.equal(owner.cloud.local(songId), undefined);

  // Se puede volver a subir como una canción nueva.
  await owner.cloud.upload(kept);
  assert.ok(kept.cloud.id && kept.cloud.id !== songId);
  assert.equal(cloudKeys(w, songId).length, 0);
  assert.ok(cloudKeys(w, kept.cloud.id).length > 0);
});

test('musicians and editors cannot delete songs, and a song that changed after the list was read is not deleted', async () => {
  const w = world(), owner = await w.device(MASTER);
  const song = newSong(owner);
  await owner.cloud.upload(song);
  const songId = song.cloud.id;
  const remote = { ...owner.cloud.catalog.find(item => item.id === songId) };
  const before = cloudKeys(w, songId).sort();

  const musician = await w.device(await w.createPlayer());
  const editor = await w.device(await w.createUser('Editor', 'editor'));
  await musician.cloud.refresh();
  assert.equal(musician.cloud.canDelete, false);
  assert.equal(editor.cloud.canDelete, false);
  await assert.rejects(musician.cloud.deleteSong(remote), /reproducir|propietario/);
  await assert.rejects(editor.cloud.deleteSong(remote), /propietario/);
  // Aunque se llame al servicio directamente, el Worker lo impide.
  assert.equal((await w.request(`/v1/songs/${songId}/delete`, await w.createUser('Otro editor', 'editor'), { method: 'POST', body: { revision: remote.revision } })).status, 403);
  assert.deepEqual(cloudKeys(w, songId).sort(), before);

  // Otra persona publica una versión nueva mientras el propietario tenía abierta la lista anterior.
  song.cover = COVER_2;
  await owner.cloud.upload(song);
  await assert.rejects(owner.cloud.deleteSong(remote), /cambió en la nube/);
  assert.ok(w.bucket.rows.has(`catalog/${songId}.json`), 'the newer version is still there');
  assert.ok(cloudKeys(w, songId).length >= before.length);
  // Con la lista al día sí se puede.
  await owner.cloud.refresh();
  await owner.cloud.deleteSong(owner.cloud.catalog.find(item => item.id === songId));
  assert.deepEqual(cloudKeys(w, songId), []);
});

test('a song with a pending transfer is not deleted; other devices stop listing a deleted song and a stale publish explains what to do', async () => {
  const w = world(), owner = await w.device(MASTER);
  const song = newSong(owner);
  await owner.cloud.upload(song);
  const songId = song.cloud.id;
  const musician = await w.device(await w.createPlayer());
  await musician.cloud.refresh();
  assert.equal(musician.cloud.catalog.length, 1);

  // Una subida pendiente de esa canción bloquea el borrado.
  owner.table('cloudTransfers').set('up:pending', { id: 'up:pending', kind: 'upload', endpoint: API, songId, title: song.title, files: [], total: 0 });
  await assert.rejects(owner.cloud.deleteSong(owner.cloud.catalog[0]), /transferencia pendiente/);
  assert.ok(w.bucket.rows.has(`catalog/${songId}.json`));
  owner.table('cloudTransfers').delete('up:pending');

  // Un editor tiene la canción enlazada en su equipo; el propietario la elimina de la nube.
  const editor = await w.device(await w.createUser('Editor', 'editor'));
  await editor.cloud.refresh();
  await editor.cloud.download(songId);
  const editorCopy = editor.cloud.local(songId);
  assert.ok(editorCopy);
  await owner.cloud.deleteSong(owner.cloud.catalog.find(item => item.id === songId));
  await musician.cloud.refresh();
  assert.equal(musician.cloud.catalog.length, 0, 'the deleted song disappears from the other devices after refreshing');
  // El editor intenta publicar cambios sobre una canción que ya no existe: mensaje claro y sin transferencias a medias.
  await assert.rejects(editor.cloud.upload(editorCopy), /ya no está en la nube.*nueva canción/);
  assert.equal((await editor.cloud.pending()).length, 0);
  assert.deepEqual(cloudKeys(w, songId), []);
  // Y puede subirla como nueva.
  await editor.cloud.upload(editorCopy, { asNew: true });
  assert.ok(editorCopy.cloud.id && editorCopy.cloud.id !== songId);
});

test('with a Worker that cannot delete songs the owner is told to publish it; a song already deleted from another device leaves the list', async () => {
  const w = world(), owner = await w.device(MASTER);
  const song = newSong(owner);
  await owner.cloud.upload(song);
  const songId = song.cloud.id;
  const remote = { ...owner.cloud.catalog.find(item => item.id === songId) };
  const before = cloudKeys(w, songId).sort();

  // Worker anterior: no conoce la ruta. Se explica qué hacer y no se toca nada.
  w.hideDelete = true;
  await assert.rejects(owner.cloud.deleteSong(remote), /Publica primero el Worker nuevo/);
  assert.deepEqual(cloudKeys(w, songId).sort(), before);
  assert.equal(owner.cloud.catalog.some(item => item.id === songId), true);
  assert.ok(owner.cloud.local(songId), 'the copy on this device is still linked');
  w.hideDelete = false;

  // Otro equipo del propietario la eliminó antes: aquí la tarjeta sigue en la lista hasta intentarlo.
  const other = await w.device(MASTER);
  await other.cloud.refresh();
  await other.cloud.deleteSong(other.cloud.catalog.find(item => item.id === songId));
  assert.equal(owner.cloud.catalog.some(item => item.id === songId), true, 'this device still lists the stale card');
  await assert.rejects(owner.cloud.deleteSong(remote), /ya no está disponible/);
  assert.equal(owner.cloud.catalog.some(item => item.id === songId), false, 'the list is brought up to date');
  assert.deepEqual(cloudKeys(w, songId), []);
});
