// Programas del DJ en la nube: el Worker real con R2 en memoria. Nada sale de este proceso.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { world, MASTER, CHUNK, A_SIZE, B_SIZE, fill, same } from './helpers/cloud-world.mjs';
import worker from '../server/worker.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Lo que la app calcula de cada canción antes de subirla: el tamaño, el hash de cada parte y el identificador de contenido.
function describe(bytes) {
  const hashes = [];
  for (let at = 0; at < bytes.length; at += CHUNK) hashes.push(sha(bytes.subarray(at, Math.min(bytes.length, at + CHUNK))));
  return { size: bytes.length, hashes, content: sha(Buffer.from(`${bytes.length}:${hashes.join(',')}`)) };
}

const SONG_A = fill(A_SIZE, 11); // dos partes
const SONG_B = fill(B_SIZE, 22); // una parte
const SONG_C = fill(777, 33);

async function upload(w, key, bytes) {
  const d = describe(bytes);
  const start = await w.request('/v1/dj/uploads/start', key, { method: 'POST', body: { content: d.content, size: d.size } });
  assert.equal(start.status, 200);
  const begun = await start.json();
  if (begun.complete) return { ...d, reused: true };
  const parts = [];
  for (let index = 0; index < d.hashes.length; index++) {
    const piece = bytes.subarray(index * CHUNK, Math.min(bytes.length, (index + 1) * CHUNK));
    const response = await w.request(`/v1/dj/uploads/part?content=${d.content}&uploadId=${begun.uploadId}&part=${index + 1}`, key, { method: 'PUT', body: piece, headers: { 'x-chunk-sha256': d.hashes[index] } });
    assert.equal(response.status, 200);
    parts.push(await response.json());
  }
  const done = await w.request('/v1/dj/uploads/complete', key, { method: 'POST', body: { content: d.content, size: d.size, uploadId: begun.uploadId, parts } });
  assert.equal(done.status, 200);
  return { ...d, reused: false };
}

// El programa que sube la app: el paquete del DJ (un programa) + a qué audio apunta cada canción.
function manifestFor(id, revision, songs, { name = 'Boda', items } = {}) {
  const tracks = songs.map((song, index) => ({ ref: `t${index + 1}`, name: song.file.replace(/\.\w+$/, ''), file: song.file, type: 'audio/mpeg', size: song.bytes.length, duration: 180, entry: '' }));
  return {
    schema: 1, kind: 'dj-program', id, revision, chunkSize: CHUNK,
    package: {
      format: 'escena-dj', version: 1, app: 'Escena DJ', created: '2026-01-01T00:00:00.000Z', audio: true,
      programs: [{ name, items: items || tracks.map((track) => ({ track: track.ref, label: '', start: 0, maxDur: 0, gainDb: 0 })) }],
      tracks,
    },
    files: songs.map((song, index) => ({ ref: `t${index + 1}`, ...describe(song.bytes) })),
  };
}

const publish = (w, key, id, manifest, expectedRevision = null) => w.request(`/v1/dj/programs/${id}/publish`, key, { method: 'POST', body: { manifest, expectedRevision } });
const errorOf = async (response) => (await response.json()).error;

async function setup() {
  const w = world();
  const editor = await w.createUser('Ana', 'editor');
  const player = await w.createPlayer('Luis');
  return { w, editor, player };
}

test('el Worker avisa que sabe guardar programas del DJ y no cambia lo que ya anunciaba', async () => {
  const { w } = await setup();
  const ping = await (await w.request('/v1/ping')).json();
  assert.equal(ping.features.dj, 1);
  assert.equal(ping.features.reuseAudio, true);
});

test('subir un programa con sus canciones, verlo en la lista y descargarlo completo', async () => {
  const { w } = await setup();
  const a = await upload(w, MASTER, SONG_A), b = await upload(w, MASTER, SONG_B);
  assert.equal(a.reused, false);
  const manifest = manifestFor('boda-2026-001', 'rev00000001', [{ file: 'Entrada.mp3', bytes: SONG_A }, { file: 'Vals.mp3', bytes: SONG_B }], { name: 'Boda Pérez' });
  const published = await publish(w, MASTER, 'boda-2026-001', manifest);
  assert.equal(published.status, 200);
  const result = await published.json();
  assert.equal(result.published, true);
  assert.deepEqual({ name: result.summary.name, songs: result.summary.songs, participants: result.summary.participants, size: result.summary.size }, { name: 'Boda Pérez', songs: 2, participants: 2, size: A_SIZE + B_SIZE });

  const list = await (await w.request('/v1/dj/programs')).json();
  assert.equal(list.programs.length, 1);
  assert.equal(list.programs[0].id, 'boda-2026-001');
  assert.equal(list.programs[0].revision, 'rev00000001');
  assert.equal(list.programs[0].by, 'Propietario');
  assert.equal(list.cursor, null);

  const fetched = await (await w.request('/v1/dj/programs/boda-2026-001')).json();
  assert.equal(fetched.package.programs[0].name, 'Boda Pérez');
  assert.equal(typeof fetched.publishedAt, 'number');

  // El audio vuelve idéntico, por partes de 8 MiB como el resto de la nube.
  const out = new Uint8Array(A_SIZE);
  for (let start = 0; start < A_SIZE; start += CHUNK) {
    const response = await w.request(`/v1/dj/audio/${a.content}`, MASTER, { headers: { range: `bytes=${start}-${Math.min(A_SIZE, start + CHUNK) - 1}` } });
    assert.equal(response.status, 206);
    out.set(new Uint8Array(await response.arrayBuffer()), start);
  }
  assert.ok(same(out, SONG_A));
  assert.equal(b.size, B_SIZE);
});

test('no se mezcla con las canciones multitrack: la lista de canciones sigue vacía', async () => {
  const { w } = await setup();
  await upload(w, MASTER, SONG_B);
  await publish(w, MASTER, 'solo-dj-0001', manifestFor('solo-dj-0001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]));
  const songs = await (await w.request('/v1/songs')).json();
  assert.deepEqual(songs.songs, []);
  const keys = [...w.bucket.rows.keys()];
  assert.ok(keys.every((key) => key.startsWith('dj/') || key.startsWith('auth/')), keys.join(', '));
});

test('una canción que ya está en la nube no se vuelve a subir, ni siquiera desde otro programa', async () => {
  const { w } = await setup();
  await upload(w, MASTER, SONG_A);
  const again = await upload(w, MASTER, SONG_A);
  assert.equal(again.reused, true);
  const objects = [...w.bucket.rows.keys()].filter((key) => key.startsWith('dj/audio/'));
  assert.equal(objects.length, 1);
});

test('permisos: el músico solo ve y descarga; el editor sube; solo el propietario elimina', async () => {
  const { w, editor, player } = await setup();
  const d = describe(SONG_B);
  const manifest = manifestFor('permisos-0001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]);

  // Músico: ninguna escritura.
  for (const [path, body] of [['/v1/dj/uploads/start', { content: d.content, size: d.size }], ['/v1/dj/programs/permisos-0001/publish', { manifest }], ['/v1/dj/programs/permisos-0001/delete', { revision: 'rev00000001' }]]) {
    const response = await w.request(path, player, { method: 'POST', body });
    assert.equal(response.status, 403, path);
  }

  // Editor: sube y publica.
  await upload(w, editor, SONG_B);
  const published = await publish(w, editor, 'permisos-0001', manifest);
  assert.equal(published.status, 200);
  assert.equal((await published.json()).summary.by, 'Ana');

  // Músico: sí ve la lista y descarga el audio.
  const list = await (await w.request('/v1/dj/programs', player)).json();
  assert.equal(list.programs.length, 1);
  assert.equal((await w.request('/v1/dj/programs/permisos-0001', player)).status, 200);
  const audio = await w.request(`/v1/dj/audio/${d.content}`, player, { headers: { range: `bytes=0-${B_SIZE - 1}` } });
  assert.equal(audio.status, 206);
  assert.ok(same(new Uint8Array(await audio.arrayBuffer()), SONG_B));

  // Editor: no elimina.
  const refused = await w.request('/v1/dj/programs/permisos-0001/delete', editor, { method: 'POST', body: { revision: 'rev00000001' } });
  assert.equal(refused.status, 403);
  assert.match(await errorOf(refused), /propietario/);
  assert.equal((await w.request('/v1/dj/programs/permisos-0001')).status, 200);

  // Sin clave: nada.
  const anonymous = await w.request('/v1/dj/programs', 'f'.repeat(64));
  assert.equal(anonymous.status, 401);
});

test('un programa mal armado se rechaza con un mensaje claro', async () => {
  const { w } = await setup();
  await upload(w, MASTER, SONG_B);
  const good = () => manifestFor('validar-0001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]);
  const cases = [
    ['otra identificación', (m) => { m.id = 'otro-programa-1'; }],
    ['revisión inválida', (m) => { m.revision = 'a b'; }],
    ['tamaño de parte distinto', (m) => { m.chunkSize = 1024; }],
    ['sin paquete', (m) => { delete m.package; }],
    ['formato ajeno', (m) => { m.package.format = 'otra-cosa'; }],
    ['dos programas', (m) => { m.package.programs.push(structuredClone(m.package.programs[0])); }],
    ['sin participantes', (m) => { m.package.programs[0].items = []; }],
    ['demasiados participantes', (m) => { m.package.programs[0].items = Array.from({ length: 2001 }, () => ({ track: 't1' })); }],
    ['participante que no es objeto', (m) => { m.package.programs[0].items = ['t1']; }],
    ['nombre vacío', (m) => { m.package.programs[0].name = '   '; }],
    ['nombre larguísimo', (m) => { m.package.programs[0].name = 'x'.repeat(201); }],
    ['canción repetida', (m) => { m.package.tracks.push({ ...m.package.tracks[0] }); }],
    ['archivo de una canción que no existe', (m) => { m.files[0].ref = 'fantasma'; }],
    ['archivo repetido', (m) => { m.files.push({ ...m.files[0] }); }],
    ['tamaño cero', (m) => { m.files[0].size = 0; }],
    ['tamaño gigante', (m) => { m.files[0].size = 6 * 1024 ** 3; }],
    ['tamaño decimal', (m) => { m.files[0].size = 10.5; }],
    ['faltan comprobaciones', (m) => { m.files[0].hashes = []; }],
    ['comprobación mal escrita', (m) => { m.files[0].hashes = ['ZZ']; }],
    ['identificación que no corresponde', (m) => { m.files[0].content = 'a'.repeat(64); }],
    ['archivos que no son lista', (m) => { m.files = 'no'; }],
  ];
  for (const [name, mutate] of cases) {
    const manifest = good();
    mutate(manifest);
    const response = await publish(w, MASTER, 'validar-0001', manifest);
    assert.equal(response.status, 400, name);
    assert.ok((await errorOf(response)).length > 5, name);
  }
  // Y ninguno de los intentos dejó nada guardado.
  assert.equal((await (await w.request('/v1/dj/programs')).json()).programs.length, 0);
  // El bueno sí entra.
  assert.equal((await publish(w, MASTER, 'validar-0001', good())).status, 200);
});

test('cuerpos y tipos raros se rechazan con 400 (no con un error del servicio) y no dejan el programa atascado', async () => {
  const { w } = await setup();
  await upload(w, MASTER, SONG_B);
  const d = describe(SONG_B);
  // Una solicitud que no trae un objeto (null, lista, número, texto) no es un error del servicio.
  for (const path of ['/v1/dj/programs/raro-0000001/publish', '/v1/dj/programs/raro-0000001/delete', '/v1/dj/uploads/start', '/v1/dj/uploads/complete', '/v1/dj/uploads/discard']) {
    for (const body of [null, [], 5, 'texto']) {
      const response = await w.request(path, MASTER, { method: 'POST', body });
      assert.equal(response.status, 400, `${path} con ${JSON.stringify(body)}`);
    }
  }
  const good = () => manifestFor('raro-0000001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]);
  // Una «revisión» que es una lista con un texto válido adentro pasaba el filtro y dejaba el programa imposible de actualizar o eliminar.
  const asList = good(); asList.revision = ['rev00000001'];
  assert.equal((await publish(w, MASTER, 'raro-0000001', asList)).status, 400);
  const hashAsList = good(); hashAsList.files[0].hashes = [[d.hashes[0]]];
  assert.equal((await publish(w, MASTER, 'raro-0000001', hashAsList)).status, 400);
  assert.equal((await (await w.request('/v1/dj/programs')).json()).programs.length, 0);
  // El correcto entra, se puede actualizar y se puede eliminar.
  assert.equal((await publish(w, MASTER, 'raro-0000001', good())).status, 200);
  const next = good(); next.revision = 'rev00000002';
  assert.equal((await publish(w, MASTER, 'raro-0000001', next, 'rev00000001')).status, 200);
  assert.equal((await w.request('/v1/dj/programs/raro-0000001/delete', MASTER, { method: 'POST', body: { revision: ['rev00000002'] } })).status, 400);
  assert.equal((await w.request('/v1/dj/programs/raro-0000001/delete', MASTER, { method: 'POST', body: { revision: 'rev00000002' } })).status, 200);
});

test('un rango que empieza después del final da 416 aunque R2 lo rechace con un error; un fallo pasajero sigue siendo un fallo', async () => {
  const { w } = await setup();
  const d = await upload(w, MASTER, SONG_B);
  const real = w.bucket.get.bind(w.bucket);
  // R2 de verdad lanza un error (10039) cuando el rango empieza después del final del archivo.
  w.bucket.get = async (key, options = {}) => {
    const row = w.bucket.rows.get(key);
    if (row && options.range && options.range.offset >= row.bytes.length) throw new Error('get: The requested range is not satisfiable (10039)');
    if (w.failNext) { w.failNext = false; throw new Error('get: Internal error (10001)'); }
    return real(key, options);
  };
  const get = (range) => w.request(`/v1/dj/audio/${d.content}`, MASTER, { headers: { range } });
  assert.equal((await get(`bytes=${B_SIZE}-${B_SIZE + 9}`)).status, 416);
  assert.equal((await get(`bytes=${B_SIZE + 5000}-${B_SIZE + 5009}`)).status, 416);
  assert.equal((await get(`bytes=0-${B_SIZE + 99}`)).status, 416); // empieza dentro pero termina fuera
  w.failNext = true;
  assert.equal((await get('bytes=0-9')).status, 500); // falla pasajera de R2: se puede reintentar
  assert.equal((await get('bytes=0-9')).status, 206);
});

test('no se publica un programa cuyas canciones no terminaron de subirse', async () => {
  const { w } = await setup();
  const manifest = manifestFor('incompleto-01', 'rev00000001', [{ file: 'A.mp3', bytes: SONG_A }]);
  const early = await publish(w, MASTER, 'incompleto-01', manifest);
  assert.equal(early.status, 409);
  assert.match(await errorOf(early), /no terminó de subirse/);
  assert.equal((await (await w.request('/v1/dj/programs')).json()).programs.length, 0);

  // Una subida a medias (sin completar) tampoco cuenta.
  const d = describe(SONG_A);
  const start = await (await w.request('/v1/dj/uploads/start', MASTER, { method: 'POST', body: { content: d.content, size: d.size } })).json();
  await w.request(`/v1/dj/uploads/part?content=${d.content}&uploadId=${start.uploadId}&part=1`, MASTER, { method: 'PUT', body: SONG_A.subarray(0, CHUNK), headers: { 'x-chunk-sha256': d.hashes[0] } });
  assert.equal((await publish(w, MASTER, 'incompleto-01', manifest)).status, 409);
  const discarded = await w.request('/v1/dj/uploads/discard', MASTER, { method: 'POST', body: { content: d.content, uploadId: start.uploadId } });
  assert.equal(discarded.status, 200);
  assert.equal(w.bucket.uploads.size, 0);
});

test('la subida de una parte comprueba lo que llega', async () => {
  const { w } = await setup();
  const d = describe(SONG_B);
  const begun = await (await w.request('/v1/dj/uploads/start', MASTER, { method: 'POST', body: { content: d.content, size: d.size } })).json();
  const url = `/v1/dj/uploads/part?content=${d.content}&uploadId=${begun.uploadId}&part=1`;
  const corrupted = SONG_B.slice(); corrupted[5] ^= 255;
  assert.equal((await w.request(url, MASTER, { method: 'PUT', body: corrupted, headers: { 'x-chunk-sha256': d.hashes[0] } })).status, 422);
  assert.equal((await w.request(url, MASTER, { method: 'PUT', body: SONG_B })).status, 400); // sin hash
  assert.equal((await w.request(url.replace('part=1', 'part=0'), MASTER, { method: 'PUT', body: SONG_B, headers: { 'x-chunk-sha256': d.hashes[0] } })).status, 400);
  assert.equal((await w.request(url.replace(d.content, 'xyz'), MASTER, { method: 'PUT', body: SONG_B, headers: { 'x-chunk-sha256': d.hashes[0] } })).status, 400);
  const tooBig = new Uint8Array(CHUNK + 1);
  assert.equal((await w.request(url, MASTER, { method: 'PUT', body: tooBig, headers: { 'x-chunk-sha256': sha(tooBig) } })).status, 413);

  // Completar con partes de más o con un tamaño que no es el anunciado, no deja nada guardado.
  const part = await (await w.request(url, MASTER, { method: 'PUT', body: SONG_B, headers: { 'x-chunk-sha256': d.hashes[0] } })).json();
  const complete = (body) => w.request('/v1/dj/uploads/complete', MASTER, { method: 'POST', body: { content: d.content, size: d.size, uploadId: begun.uploadId, ...body } });
  assert.equal((await complete({ parts: [] })).status, 400);
  assert.equal((await complete({ parts: [part, part] })).status, 400);
  assert.equal((await complete({ parts: [{ partNumber: 2, etag: 'x' }] })).status, 400);
  assert.equal((await complete({ size: 0, parts: [part] })).status, 400);
  assert.equal([...w.bucket.rows.keys()].filter((key) => key.startsWith('dj/audio/')).length, 0);
  assert.equal((await complete({ parts: [part] })).status, 200);
  assert.equal([...w.bucket.rows.keys()].filter((key) => key.startsWith('dj/audio/')).length, 1);
});

test('la descarga del audio exige rangos válidos y no sirve lo que no existe', async () => {
  const { w } = await setup();
  const d = await upload(w, MASTER, SONG_B);
  const get = (content, range) => w.request(`/v1/dj/audio/${content}`, MASTER, { headers: range ? { range } : {} });
  assert.equal((await get(d.content)).status, 416);
  assert.equal((await get(d.content, 'bytes=0-')).status, 416);
  assert.equal((await get(d.content, 'bytes=5-2')).status, 416);
  assert.equal((await get(d.content, `bytes=0-${CHUNK}`)).status, 416); // más de 8 MiB
  assert.equal((await get(d.content, `bytes=0-${B_SIZE}`)).status, 416); // pasa del final
  assert.equal((await get('b'.repeat(64), 'bytes=0-9')).status, 404);
  assert.equal((await get('no-es-un-hash', 'bytes=0-9')).status, 404);
  const ok = await get(d.content, 'bytes=10-19');
  assert.equal(ok.status, 206);
  assert.equal(ok.headers.get('content-range'), `bytes 10-19/${B_SIZE}`);
  assert.ok(same(new Uint8Array(await ok.arrayBuffer()), SONG_B.subarray(10, 20)));
});

test('volver a subir lo mismo es inofensivo; una versión vieja no pisa a una más nueva', async () => {
  const { w, editor } = await setup();
  await upload(w, MASTER, SONG_B);
  const v1 = manifestFor('versiones-001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]);
  assert.equal((await publish(w, MASTER, 'versiones-001', v1)).status, 200);
  // Reintento del mismo envío (por ejemplo, se cortó la respuesta): sigue bien y no cambia nada.
  const before = (await w.bucket.get('dj/programs/versiones-001.json')).etag;
  assert.equal((await publish(w, MASTER, 'versiones-001', v1)).status, 200);
  assert.equal((await w.bucket.get('dj/programs/versiones-001.json')).etag, before);

  // La segunda versión parte de la primera.
  const v2 = manifestFor('versiones-001', 'rev00000002', [{ file: 'B.mp3', bytes: SONG_B }], { name: 'Boda v2' });
  assert.equal((await publish(w, editor, 'versiones-001', v2, 'rev00000001')).status, 200);
  const list = await (await w.request('/v1/dj/programs')).json();
  assert.equal(list.programs[0].name, 'Boda v2');
  assert.equal(list.programs[0].by, 'Ana');

  // Otro equipo que todavía tenía la primera versión no la pisa.
  const stale = manifestFor('versiones-001', 'rev00000003', [{ file: 'B.mp3', bytes: SONG_B }], { name: 'Desde un equipo atrasado' });
  const refused = await publish(w, MASTER, 'versiones-001', stale, 'rev00000001');
  assert.equal(refused.status, 409);
  assert.match(await errorOf(refused), /versión más reciente/);
  // Tampoco se puede crear «de cero» encima de uno que ya existe.
  assert.equal((await publish(w, MASTER, 'versiones-001', stale, null)).status, 409);
  assert.equal((await (await w.request('/v1/dj/programs')).json()).programs[0].name, 'Boda v2');
});

test('al actualizar un programa se liberan las canciones que dejó de usar, salvo las que otro programa necesita', async () => {
  const { w } = await setup();
  const a = await upload(w, MASTER, SONG_A), b = await upload(w, MASTER, SONG_B), c = await upload(w, MASTER, SONG_C);
  const audio = () => [...w.bucket.rows.keys()].filter((key) => key.startsWith('dj/audio/')).map((key) => key.slice('dj/audio/'.length)).sort();

  const first = manifestFor('liberar-0001', 'rev00000001', [{ file: 'A.mp3', bytes: SONG_A }, { file: 'B.mp3', bytes: SONG_B }]);
  await publish(w, MASTER, 'liberar-0001', first);
  const other = manifestFor('liberar-0002', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }, { file: 'C.mp3', bytes: SONG_C }]);
  await publish(w, MASTER, 'liberar-0002', other);
  assert.deepEqual(audio(), [a.content, b.content, c.content].sort());

  // El primero cambia A por nada: A ya no la usa nadie y se libera; B la sigue usando el otro programa.
  const second = manifestFor('liberar-0001', 'rev00000002', [{ file: 'B.mp3', bytes: SONG_B }]);
  assert.equal((await publish(w, MASTER, 'liberar-0001', second, 'rev00000001')).status, 200);
  assert.deepEqual(audio(), [b.content, c.content].sort());
});

test('eliminar un programa libera sus canciones solo si nadie más las usa', async () => {
  const { w } = await setup();
  const a = await upload(w, MASTER, SONG_A), b = await upload(w, MASTER, SONG_B);
  await publish(w, MASTER, 'borrar-00001', manifestFor('borrar-00001', 'rev00000001', [{ file: 'A.mp3', bytes: SONG_A }, { file: 'B.mp3', bytes: SONG_B }]));
  await publish(w, MASTER, 'borrar-00002', manifestFor('borrar-00002', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]));
  const audio = () => [...w.bucket.rows.keys()].filter((key) => key.startsWith('dj/audio/')).map((key) => key.slice('dj/audio/'.length)).sort();

  // Con una revisión equivocada (otro la actualizó mientras tanto) no se borra nada.
  const stale = await w.request('/v1/dj/programs/borrar-00001/delete', MASTER, { method: 'POST', body: { revision: 'rev99999999' } });
  assert.equal(stale.status, 409);
  assert.match(await errorOf(stale), /cambió/);
  assert.equal((await w.request('/v1/dj/programs/borrar-00001')).status, 200);
  assert.equal((await w.request('/v1/dj/programs/borrar-00001/delete', MASTER, { method: 'POST', body: {} })).status, 400);
  assert.equal((await w.request('/v1/dj/programs/inexistente-1/delete', MASTER, { method: 'POST', body: { revision: 'rev00000001' } })).status, 404);

  const deleted = await w.request('/v1/dj/programs/borrar-00001/delete', MASTER, { method: 'POST', body: { revision: 'rev00000001' } });
  assert.equal(deleted.status, 200);
  assert.equal((await w.request('/v1/dj/programs/borrar-00001')).status, 404);
  assert.deepEqual(audio(), [b.content]); // A se liberó; B sigue porque el otro programa la usa
  assert.equal((await w.request(`/v1/dj/audio/${a.content}`, MASTER, { headers: { range: 'bytes=0-9' } })).status, 404);

  assert.equal((await w.request('/v1/dj/programs/borrar-00002/delete', MASTER, { method: 'POST', body: { revision: 'rev00000001' } })).status, 200);
  assert.deepEqual(audio(), []);
  assert.deepEqual((await (await w.request('/v1/dj/programs')).json()).programs, []);
});

test('si algún programa no se puede leer, no se borra ningún audio (mejor una canción de más que una de menos)', async () => {
  const { w } = await setup();
  const b = await upload(w, MASTER, SONG_B);
  await publish(w, MASTER, 'seguro-00001', manifestFor('seguro-00001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]));
  // Un archivo dañado en la carpeta de programas (no debería pasar, pero si pasa no se arriesga el audio de nadie).
  await w.bucket.put('dj/programs/danado-00001.json', 'esto no es json');
  const deleted = await w.request('/v1/dj/programs/seguro-00001/delete', MASTER, { method: 'POST', body: { revision: 'rev00000001' } });
  assert.equal(deleted.status, 200);
  assert.equal((await w.bucket.head(`dj/audio/${b.content}`)).size, B_SIZE);

  // Un programa dañado no queda atascado: el propietario lo quita y también se puede volver a subir encima.
  const removed = await w.request('/v1/dj/programs/danado-00001/delete', MASTER, { method: 'POST', body: { revision: 'rev00000009' } });
  assert.equal(removed.status, 200);
  assert.equal(await w.bucket.head('dj/programs/danado-00001.json'), null);
  await w.bucket.put('dj/programs/danado-00002.json', 'tampoco es json');
  const again = await publish(w, MASTER, 'danado-00002', manifestFor('danado-00002', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]), null);
  assert.equal(again.status, 200);
  assert.equal((await w.bucket.head(`dj/audio/${b.content}`)).size, B_SIZE);
});

// Cloudflare cuenta cada consulta a R2 como una petición del Worker y el plan gratuito permite 50 por solicitud:
// ninguna ruta puede gastar consultas en proporción al número de canciones.
function meter(w) {
  const calls = { count: 0 };
  const bucket = w.bucket, count = (fn) => (...args) => { calls.count++; return fn.apply(bucket, args); };
  for (const name of ['get', 'head', 'put', 'delete', 'list', 'createMultipartUpload']) bucket[name] = count(bucket[name]);
  const resume = bucket.resumeMultipartUpload;
  bucket.resumeMultipartUpload = (...args) => {
    const upload = resume.apply(bucket, args);
    return { uploadPart: count(upload.uploadPart), complete: count(upload.complete), abort: count(upload.abort) };
  };
  return { used: async (run) => { calls.count = 0; const result = await run(); return { result, ops: calls.count }; } };
}

test('publicar un programa largo gasta pocas consultas a R2, igual con 5 canciones que con 120', async () => {
  const { w, editor } = await setup();
  const songs = Array.from({ length: 120 }, (_, index) => {
    const bytes = fill(300 + index, index + 1); // 120 canciones distintas y pequeñas (una parte cada una)
    return { file: `${String(index + 1).padStart(3, '0')} Participante.mp3`, bytes };
  });
  for (const song of songs) await w.bucket.put(`dj/audio/${describe(song.bytes).content}`, song.bytes); // ya subidas
  const m = meter(w);
  const small = await m.used(() => publish(w, editor, 'largo-0000005', manifestFor('largo-0000005', 'rev00000001', songs.slice(0, 5))));
  assert.equal(small.result.status, 200);
  const long = await m.used(() => publish(w, editor, 'largo-0000120', manifestFor('largo-0000120', 'rev00000001', songs)));
  assert.equal(long.result.status, 200);
  assert.ok(long.ops <= small.ops + 1, `5 canciones: ${small.ops} consultas; 120 canciones: ${long.ops}`);
  assert.ok(long.ops <= 15, `120 canciones: ${long.ops} consultas`);

  // Actualizarlo y eliminarlo con otros programas guardados tampoco crece con las canciones.
  const changed = await m.used(() => publish(w, editor, 'largo-0000120', manifestFor('largo-0000120', 'rev00000002', songs.slice(0, 60)), 'rev00000001'));
  assert.equal(changed.result.status, 200);
  assert.ok(changed.ops <= 15, `actualizar quitando 60 canciones: ${changed.ops} consultas`);
  const removed = await m.used(() => w.request('/v1/dj/programs/largo-0000120/delete', MASTER, { method: 'POST', body: { revision: 'rev00000002' } }));
  assert.equal(removed.result.status, 200);
  assert.ok(removed.ops <= 15, `eliminar: ${removed.ops} consultas`);

  // Las demás rutas gastan una cantidad fija, también con una clave individual (que se verifica con 2 lecturas más).
  const d = describe(SONG_A);
  const start = await m.used(() => w.request('/v1/dj/uploads/start', editor, { method: 'POST', body: { content: d.content, size: d.size } }));
  const begun = await start.result.json();
  const part = await m.used(() => w.request(`/v1/dj/uploads/part?content=${d.content}&uploadId=${begun.uploadId}&part=1`, editor, { method: 'PUT', body: SONG_A.subarray(0, CHUNK), headers: { 'x-chunk-sha256': d.hashes[0] } }));
  const listed = await m.used(() => w.request('/v1/dj/programs', editor));
  const fetched = await m.used(() => w.request('/v1/dj/programs/largo-0000005', editor));
  for (const [name, item] of Object.entries({ start, part, listed, fetched })) assert.ok(item.ops <= 6, `${name}: ${item.ops} consultas`);
});

test('el listado de canciones se recorre completo aunque pase de una página (hasta 1000 por página)', async () => {
  const { w } = await setup();
  // Más de 1000 canciones guardadas en la nube: las del programa quedan repartidas en dos páginas.
  for (let index = 0; index < 1100; index++) await w.bucket.put(`dj/audio/${String(index).padStart(64, '0')}`, new Uint8Array(3));
  const first = await upload(w, MASTER, SONG_B), last = await upload(w, MASTER, SONG_C);
  const keys = [...w.bucket.rows.keys()].filter((key) => key.startsWith('dj/audio/')).sort();
  assert.ok(keys.indexOf(`dj/audio/${first.content}`) > 999 || keys.indexOf(`dj/audio/${last.content}`) > 999, 'al menos una canción debe quedar en la segunda página');
  const manifest = manifestFor('paginas-0001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }, { file: 'C.mp3', bytes: SONG_C }]);
  assert.equal((await publish(w, MASTER, 'paginas-0001', manifest)).status, 200);
});

// Programa guardado directamente en la carpeta de programas (como lo dejaría una publicación), sin pasar por la subida.
async function stored(w, id, revision, songs, { name = 'Relleno' } = {}) {
  const manifest = manifestFor(id, revision, songs, { name });
  const summary = { id, revision, name, participants: songs.length, songs: songs.length, size: 1, updatedAt: 1, by: 'Propietario' };
  const result = await w.bucket.put(`dj/programs/${id}.json`, JSON.stringify(manifest), { customMetadata: { summary: JSON.stringify(summary) } });
  return { manifest, etag: result.etag };
}
const audioOf = (w) => [...w.bucket.rows.keys()].filter((key) => key.startsWith('dj/audio/')).map((key) => key.slice('dj/audio/'.length)).sort();

test('con más de 100 programas la limpieza los revisa todos: una canción usada por un programa de la segunda página se conserva', async () => {
  const { w } = await setup();
  const b = await upload(w, MASTER, SONG_B), c = await upload(w, MASTER, SONG_C);
  await publish(w, MASTER, 'borrar-aaaa01', manifestFor('borrar-aaaa01', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }, { file: 'C.mp3', bytes: SONG_C }]));
  for (let index = 1; index <= 129; index++) await stored(w, `relleno-${String(index).padStart(3, '0')}`, 'rev00000001', []); // programas sin canciones, solo para llenar la primera página
  await stored(w, 'zzz-ultimo-01', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]); // el programa 131: cae en la segunda página
  const deleted = await w.request('/v1/dj/programs/borrar-aaaa01/delete', MASTER, { method: 'POST', body: { revision: 'rev00000001' } });
  assert.equal(deleted.status, 200);
  assert.deepEqual(audioOf(w), [b.content]); // C se liberó; B sigue porque la usa el programa de la segunda página
});

test('la lista de programas se entrega por páginas de 100 con su cursor', async () => {
  const { w } = await setup();
  for (let index = 1; index <= 130; index++) await stored(w, `lista-${String(index).padStart(4, '0')}`, 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }], { name: `Programa ${index}` });
  const first = await (await w.request('/v1/dj/programs')).json();
  assert.equal(first.programs.length, 100);
  assert.ok(first.cursor);
  const second = await (await w.request(`/v1/dj/programs?cursor=${encodeURIComponent(first.cursor)}`)).json();
  assert.equal(second.programs.length, 30);
  assert.equal(second.cursor, null);
  const ids = new Set([...first.programs, ...second.programs].map((item) => item.id));
  assert.equal(ids.size, 130);
});

test('la limpieza no borra nada si en la carpeta de programas hay algo que no es un programa del DJ', async () => {
  const { w } = await setup();
  const b = await upload(w, MASTER, SONG_B);
  await publish(w, MASTER, 'ajeno-000001', manifestFor('ajeno-000001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]));
  for (const [index, content] of [null, '"texto"', '{"schema":2,"kind":"dj-program","files":[]}', '{"schema":1,"kind":"otra-cosa","files":[]}', '{}'].entries()) {
    await w.bucket.put(`dj/programs/extrano-0000${index}.json`, content === null ? 'null' : content);
    const deleted = await w.request('/v1/dj/programs/ajeno-000001/delete', MASTER, { method: 'POST', body: { revision: 'rev00000001' } });
    assert.equal(deleted.status, 200, content);
    assert.deepEqual(audioOf(w), [b.content], `con ${content} la canción debe seguir guardada`);
    // Se vuelve a dejar el programa para la siguiente vuelta y se quita lo extraño.
    await w.bucket.delete(`dj/programs/extrano-0000${index}.json`);
    await publish(w, MASTER, 'ajeno-000001', manifestFor('ajeno-000001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]));
  }
});

test('si alguien publica mientras la limpieza revisa los programas, la limpieza se cancela y la canción se conserva', async () => {
  // Una publicación que aparece durante la lectura (programa nuevo)…
  {
    const { w } = await setup();
    const b = await upload(w, MASTER, SONG_B);
    await publish(w, MASTER, 'carrera-00001', manifestFor('carrera-00001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]));
    await stored(w, 'carrera-00002', 'rev00000001', [{ file: 'C.mp3', bytes: SONG_C }]);
    const real = w.bucket.get.bind(w.bucket); let injected = false;
    w.bucket.get = async (key, options) => {
      if (!injected && key.startsWith('dj/programs/')) { injected = true; await stored(w, 'carrera-00003', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]); } // otra persona publica una canción que usa B
      return real(key, options);
    };
    const deleted = await w.request('/v1/dj/programs/carrera-00001/delete', MASTER, { method: 'POST', body: { revision: 'rev00000001' } });
    assert.equal(deleted.status, 200);
    assert.ok(injected);
    assert.deepEqual(audioOf(w), [b.content]);
  }
  // …o un programa que ya estaba y se actualiza justo al terminar de leer.
  {
    const { w } = await setup();
    const b = await upload(w, MASTER, SONG_B);
    await publish(w, MASTER, 'carrera-00001', manifestFor('carrera-00001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]));
    await stored(w, 'carrera-00002', 'rev00000001', [{ file: 'C.mp3', bytes: SONG_C }]);
    const realList = w.bucket.list.bind(w.bucket); let changed = false;
    w.bucket.list = async (options = {}) => {
      if (!changed && options.prefix === 'dj/programs/' && options.limit === 1000) { changed = true; await stored(w, 'carrera-00002', 'rev00000002', [{ file: 'B.mp3', bytes: SONG_B }]); }
      return realList(options);
    };
    const deleted = await w.request('/v1/dj/programs/carrera-00001/delete', MASTER, { method: 'POST', body: { revision: 'rev00000001' } });
    assert.equal(deleted.status, 200);
    assert.ok(changed);
    assert.deepEqual(audioOf(w), [b.content]);
  }
  // Y sin nadie más, la misma operación sí libera la canción (la prueba no está bloqueando todo).
  {
    const { w } = await setup();
    await upload(w, MASTER, SONG_B);
    await publish(w, MASTER, 'carrera-00001', manifestFor('carrera-00001', 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }]));
    await stored(w, 'carrera-00002', 'rev00000001', [{ file: 'C.mp3', bytes: SONG_C }]);
    assert.equal((await w.request('/v1/dj/programs/carrera-00001/delete', MASTER, { method: 'POST', body: { revision: 'rev00000001' } })).status, 200);
    assert.deepEqual(audioOf(w), []);
  }
});

test('la lista se entrega por páginas y la ruta desconocida responde 404', async () => {
  const { w } = await setup();
  await upload(w, MASTER, SONG_B);
  for (let index = 1; index <= 3; index++) {
    const id = `pagina-0000${index}`;
    await publish(w, MASTER, id, manifestFor(id, 'rev00000001', [{ file: 'B.mp3', bytes: SONG_B }], { name: `Programa ${index}` }));
  }
  const list = await (await w.request('/v1/dj/programs')).json();
  assert.deepEqual(list.programs.map((item) => item.name), ['Programa 1', 'Programa 2', 'Programa 3']);
  assert.equal((await w.request('/v1/dj/otra-cosa')).status, 404);
  assert.equal((await w.request('/v1/dj/programs/ab')).status, 400); // identificador demasiado corto
  assert.equal((await w.request('/v1/dj/programs/pagina-00001/publish')).status, 404); // la publicación es solo POST
});

test('el navegador puede llamar a las rutas nuevas desde la app (CORS) y no desde otro sitio', async () => {
  const { w } = await setup();
  const app = 'https://app.example.test';
  const ask = (path, method, headers) => worker.fetch(new Request(`https://worker.example.test${path}`, { method: 'OPTIONS', headers: { origin: app, 'access-control-request-method': method, 'access-control-request-headers': headers } }), w.env);
  for (const [path, method, headers] of [
    ['/v1/dj/uploads/part?content=x&uploadId=y&part=1', 'PUT', 'authorization,x-chunk-sha256'],
    ['/v1/dj/uploads/start', 'POST', 'authorization,content-type'],
    ['/v1/dj/programs/abc-12345/publish', 'POST', 'authorization,content-type'],
    [`/v1/dj/audio/${'a'.repeat(64)}`, 'GET', 'authorization,range'],
  ]) {
    const response = await ask(path, method, headers);
    assert.equal(response.status, 204, path);
    assert.equal(response.headers.get('access-control-allow-origin'), app, path);
    assert.ok(response.headers.get('access-control-allow-methods').includes(method), path);
    for (const name of headers.split(',')) assert.ok(response.headers.get('access-control-allow-headers').toLowerCase().includes(name), `${path}: ${name}`);
  }
  const listed = await worker.fetch(new Request('https://worker.example.test/v1/dj/programs', { headers: { origin: app, authorization: `Bearer ${MASTER}` } }), w.env);
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('access-control-allow-origin'), app);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  const stranger = await worker.fetch(new Request('https://worker.example.test/v1/dj/programs', { headers: { origin: 'https://otro.example.test', authorization: `Bearer ${MASTER}` } }), w.env);
  assert.equal(stranger.status, 403);
});

test('las rutas de siempre (canciones multitrack) siguen respondiendo igual', async () => {
  const { w } = await setup();
  assert.equal((await w.request('/v1/songs')).status, 200);
  assert.equal((await w.request('/v1/uploads/start', MASTER, { method: 'POST', body: {} })).status, 400);
  assert.equal((await w.request('/v1/otra')).status, 404);
});
