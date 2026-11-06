// Escena Nube: Worker de módulos. Binding R2: ESCENA_BUCKET.

// Secret: ESCENA_KEY (propietario). Las claves individuales solo se guardan como SHA-256.

// Migración opcional: ESCENA_PLAYER_KEY solo funciona si ALLOW_LEGACY_PLAYER=true.

// Variable: ALLOWED_ORIGINS (orígenes separados por comas; sin rutas).

export const CHUNK = 8 * 1024 * 1024;

const MAX_FILE = 5 * 1024 ** 3;

const ID = /^[a-zA-Z0-9_-]{8,80}$/;

const HASH = /^[a-f0-9]{64}$/;

const textEncoder = new TextEncoder();

const json = (data, status = 200) => Response.json(data, { status });

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }

function validId(value) { if (!ID.test(value || '')) fail('Identificador inválido'); return value; }

function paths(data) {

  const song = validId(data.songId), rev = validId(data.revision), file = validId(data.trackId);

  return { key: `audio/${song}/${rev}/${file}`, song, rev, file };

}

async function readLimited(request, limit) {

  if (Number(request.headers.get('content-length')) > limit) fail('Solicitud demasiado grande', 413);

  const reader = request.body?.getReader();

  if (!reader) return new Uint8Array();

  const chunks = []; let length = 0;

  try {

    while (true) {

      const part = await reader.read(); if (part.done) break;

      length += part.value.byteLength;

      if (length > limit) { await reader.cancel(); fail('Solicitud demasiado grande', 413); }

      chunks.push(part.value);

    }

  } finally { reader.releaseLock(); }

  const all = new Uint8Array(length); let offset = 0;

  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }

  return all;

}

async function bodyJson(request) {

  try { return JSON.parse(new TextDecoder().decode(await readLimited(request, 1024 * 1024))); }

  catch (error) { if (error.status) throw error; fail('JSON inválido'); }

}

export async function digest(data) {

  const hash = await crypto.subtle.digest('SHA-256', data);

  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');

}

async function authenticated(request, secret) {

  const supplied = request.headers.get('authorization') || '';

  if (!/^Bearer [a-f0-9]{64}$/.test(supplied)) return false;

  // WebCrypto verifica el MAC en vez de comparar secretos carácter por carácter.

  const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

  const mac = await crypto.subtle.sign('HMAC', key, textEncoder.encode(secret));

  return crypto.subtle.verify('HMAC', key, mac, textEncoder.encode(supplied.slice(7)));

}

const USER_PREFIX = 'auth/users/';
const KEY_PREFIX = 'auth/keys/';
const userKey = id => `${USER_PREFIX}${id}.json`;
const credentialKey = hash => `${KEY_PREFIX}${hash}.json`;
const userRoles = new Set(['editor', 'player']);
const publicUser = ({ id, name, role, active, offlineHours, version, createdAt, updatedAt }) => ({ id, name, role, active, offlineHours, version, createdAt, updatedAt });
const jsonMetadata = { contentType: 'application/json' };

function userFields(data, creating = false) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Datos de usuario inválidos');
  const fields = {};
  if (creating || Object.hasOwn(data, 'name')) {
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 100) fail('El nombre debe tener entre 1 y 100 caracteres');
    fields.name = data.name.trim();
  }
  if (creating || Object.hasOwn(data, 'role')) {
    if (!userRoles.has(data.role)) fail('El rol debe ser editor o player');
    fields.role = data.role;
  }
  if (Object.hasOwn(data, 'active')) {
    if (typeof data.active !== 'boolean') fail('El estado activo debe ser verdadero o falso');
    fields.active = data.active;
  } else if (creating) fields.active = true;
  if (Object.hasOwn(data, 'offlineHours')) {
    if (!Number.isInteger(data.offlineHours) || data.offlineHours < 0 || data.offlineHours > 168) fail('Las horas sin conexión deben estar entre 0 y 168');
    fields.offlineHours = data.offlineHours;
  } else if (creating) fields.offlineHours = 24;
  return fields;
}

async function readUser(bucket, id) {
  const object = await bucket.get(userKey(validId(id)));
  if (!object) fail('Usuario no encontrado', 404);
  return { object, user: await object.json() };
}

function checkUserVersion(user, data) {
  if (!Number.isSafeInteger(data?.version) || data.version < 1) fail('Indica la versión actual del usuario');
  if (user.version !== data.version) fail('El usuario cambió. Actualiza la lista antes de guardar.', 409);
}

async function reserveCredential(env, userId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (key === env.ESCENA_KEY || key === env.ESCENA_PLAYER_KEY) continue;
    const hash = await digest(textEncoder.encode(key));
    const reserved = await env.ESCENA_BUCKET.put(credentialKey(hash), JSON.stringify({ schema: 1, userId }), {
      httpMetadata: jsonMetadata, onlyIf: new Headers({ 'If-None-Match': '*' }),
    });
    if (reserved) return { key, hash };
  }
  fail('No se pudo generar una clave individual. Vuelve a intentar.', 503);
}

async function identify(request, env) {
  if (await authenticated(request, env.ESCENA_KEY)) return { id: 'owner', name: 'Propietario', role: 'owner', offlineHours: 24 };
  if (String(env.ALLOW_LEGACY_PLAYER) === 'true' && env.ESCENA_PLAYER_KEY && await authenticated(request, env.ESCENA_PLAYER_KEY)) {
    return { id: 'legacy-player', name: 'Reproducción compartida', role: 'player', offlineHours: 24 };
  }
  const supplied = request.headers.get('authorization') || '';
  if (!/^Bearer [a-f0-9]{64}$/.test(supplied)) fail('La clave de acceso no es correcta o está bloqueada', 401);
  const hash = await digest(textEncoder.encode(supplied.slice(7)));
  const index = await env.ESCENA_BUCKET.get(credentialKey(hash));
  if (!index) fail('La clave de acceso no es correcta o está bloqueada', 401);
  let pointer, user;
  try {
    pointer = await index.json();
    if (!ID.test(pointer?.userId || '')) throw new Error('Índice inválido');
    const record = await env.ESCENA_BUCKET.get(userKey(pointer.userId));
    if (!record) throw new Error('Registro ausente');
    user = await record.json();
  } catch { fail('La clave de acceso no es correcta o está bloqueada', 401); }
  // Un índice antiguo o una rotación incompleta nunca conceden acceso. Este
  // registro se vuelve a leer en cada petición, sin caché de autorizaciones.
  if (user.id !== pointer.userId || !userRoles.has(user.role) || user.active !== true || user.credentialHash !== hash || !Number.isInteger(user.offlineHours) || user.offlineHours < 0 || user.offlineHours > 168) {
    fail('La clave de acceso no es correcta o está bloqueada', 401);
  }
  return user;
}

async function manageUsers(request, env, principal, path, method) {
  if (principal.role !== 'owner') fail('Solo el propietario puede administrar usuarios', 403);
  const bucket = env.ESCENA_BUCKET;
  if (path === '/v1/users' && method === 'GET') {
    const users = []; let cursor;
    do {
      const page = await bucket.list({ prefix: USER_PREFIX, limit: 100, cursor });
      for (const entry of page.objects) {
        const object = await bucket.get(entry.key);
        if (object) users.push(publicUser(await object.json()));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    users.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return json({ users });
  }
  if (path === '/v1/users' && method === 'POST') {
    const fields = userFields(await bodyJson(request), true);
    const id = crypto.randomUUID(), now = Date.now();
    const credential = await reserveCredential(env, id);
    const user = { schema: 1, id, ...fields, credentialHash: credential.hash, version: 1, createdAt: now, updatedAt: now };
    try {
      const created = await bucket.put(userKey(id), JSON.stringify(user), {
        httpMetadata: jsonMetadata, onlyIf: new Headers({ 'If-None-Match': '*' }),
      });
      if (!created) fail('No se pudo crear el usuario. Vuelve a intentar.', 409);
    } catch (error) {
      await bucket.delete(credentialKey(credential.hash)).catch(() => {});
      throw error;
    }
    return json({ user: publicUser(user), key: credential.key }, 201);
  }
  const matched = path.match(/^\/v1\/users\/([a-zA-Z0-9_-]+)(\/rotate)?$/);
  if (!matched || (matched[2] ? method !== 'POST' : method !== 'PUT')) fail('Ruta no encontrada', 404);
  const { object, user } = await readUser(bucket, matched[1]);
  const data = await bodyJson(request);
  checkUserVersion(user, data);
  const fields = matched[2] ? {} : userFields(data);
  if (!matched[2] && !Object.keys(fields).length) fail('Indica el cambio que deseas guardar');
  const credential = matched[2] ? await reserveCredential(env, user.id) : null;
  const next = { ...user, ...fields, ...(credential ? { credentialHash: credential.hash } : {}), version: user.version + 1, updatedAt: Date.now() };
  try {
    const updated = await bucket.put(userKey(user.id), JSON.stringify(next), {
      httpMetadata: jsonMetadata, onlyIf: new Headers({ 'If-Match': object.httpEtag }),
    });
    if (!updated) fail('El usuario cambió. Actualiza la lista antes de guardar.', 409);
  } catch (error) {
    if (credential) await bucket.delete(credentialKey(credential.hash)).catch(() => {});
    throw error;
  }
  // Aunque la limpieza falle, la comparación con credentialHash ya revocó
  // la clave anterior. No ocultar la nueva clave después de una rotación válida.
  if (credential) await bucket.delete(credentialKey(user.credentialHash)).catch(() => {});
  return json({ user: publicUser(next), ...(credential ? { key: credential.key } : {}) });
}

// Carpeta (revisión) donde está guardado el audio de una pista publicada.
// Una pista que no cambió entre versiones conserva el archivo ya subido: su
// entrada del manifiesto indica la revisión original en files[].revision.
const audioRevision = (manifest, file) => file?.revision || manifest.revision;

// Elimina todo el audio de una canción, de todas sus revisiones. El prefijo termina
// en «/», así que nunca alcanza a otra canción cuyo identificador empiece igual.
async function sweepAudio(bucket, songId) {
  const prefix = `audio/${songId}/`;
  let removed = 0;
  for (let round = 0; round < 200; round++) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (!page.objects.length) return removed;
    await bucket.delete(page.objects.map(object => object.key));
    removed += page.objects.length;
  }
  fail('No se pudieron eliminar todos los archivos de la canción. Vuelve a intentarlo.', 503);
}

function validateManifest(m, songId) {

  if (m?.schema !== 1 || m.id !== songId || !ID.test(m.revision || '') || m.chunkSize !== CHUNK) fail('Versión de canción inválida');

  const s = m.song;

  if (!s || typeof s.title !== 'string' || s.title.length > 300 || !Array.isArray(s.tracks) || s.tracks.length < 1 || s.tracks.length > 128) fail('Canción inválida (máximo 128 pistas)');

  if (s.cover && (typeof s.cover !== 'string' || s.cover.length > 350000 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(s.cover))) fail('Portada inválida. Usa una imagen JPG, PNG o WebP optimizada en Escena.');

  if (!Array.isArray(s.tempoMap) || !s.tempoMap.length || s.tempoMap.length > 1000 || !Array.isArray(s.markers) || s.markers.length > 2000) fail('Mapa de canción inválido');

  if (!Array.isArray(m.files) || m.files.length !== s.tracks.length) fail('Faltan pistas');

  const ids = new Set(); let total = 0;

  for (const file of m.files) {

    validId(file.id);

    if (ids.has(file.id) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE) fail('Tamaño de pista inválido (máximo 5 GiB)');

    ids.add(file.id); total += file.size;

    if (!Array.isArray(file.hashes) || file.hashes.length !== Math.ceil(file.size / CHUNK) || file.hashes.some(hash => !HASH.test(hash))) fail('Comprobación de pistas incompleta');

    if (typeof file.name !== 'string' || file.name.length > 300 || typeof file.type !== 'string' || file.type.length > 100) fail('Datos de pista inválidos');

    if (file.revision !== undefined && (typeof file.revision !== 'string' || !ID.test(file.revision))) fail('Versión de pista inválida');

  }

  if (s.tracks.some(track => !ids.has(track.id)) || new Set(s.tracks.map(t => t.id)).size !== ids.size) fail('Referencias de pistas inválidas');

  return total;

}

// ───────────────────────── Programas del DJ en la nube ─────────────────────────
// Se guardan aparte de las canciones multitrack, con las mismas cuentas y permisos:
//   dj/programs/<id>.json   el programa (orden, tiempos, pads y a qué canciones apunta)
//   dj/audio/<contenido>    cada canción, una sola vez aunque la usen varios programas
// <contenido> es el SHA-256 de «tamaño:hash de cada parte», así una canción ya subida no se repite.
// Nada de esto toca catalog/, audio/ ni auth/. Músico: ver y descargar. Editor: además subir.
// Propietario: además eliminar. Las rutas nuevas son /v1/dj/…; las de siempre no cambian.
const DJ_FEATURE = 1;
const DJ_PROGRAMS = 'dj/programs/';
const DJ_AUDIO = 'dj/audio/';
const DJ_MAX_TRACKS = 1000;
const DJ_MAX_ITEMS = 2000;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const djProgramKey = id => `${DJ_PROGRAMS}${id}.json`;
function djAudioKey(content) { if (!HASH.test(content || '')) fail('Identificador de canción inválido'); return `${DJ_AUDIO}${content}`; }
async function djBody(request) { const data = await bodyJson(request); if (!plainObject(data)) fail('Datos inválidos'); return data; }
const djContent = (size, hashes) => digest(textEncoder.encode(`${size}:${hashes.join(',')}`));
const djContents = manifest => new Set((Array.isArray(manifest?.files) ? manifest.files : []).map(file => file?.content).filter(content => HASH.test(content || '')));

async function validateDjManifest(m, programId) {
  if (!plainObject(m) || m.schema !== 1 || m.kind !== 'dj-program' || m.id !== programId || typeof m.revision !== 'string' || !ID.test(m.revision) || m.chunkSize !== CHUNK) fail('Programa DJ inválido');
  const pack = m.package;
  if (!plainObject(pack) || pack.format !== 'escena-dj' || !Array.isArray(pack.programs) || pack.programs.length !== 1 || !plainObject(pack.programs[0]) || !Array.isArray(pack.tracks) || pack.tracks.length > DJ_MAX_TRACKS) fail('Programa DJ inválido');
  const spec = pack.programs[0];
  if (typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 200) fail('El programa debe tener un nombre de hasta 200 caracteres');
  if (!Array.isArray(spec.items) || spec.items.length < 1 || spec.items.length > DJ_MAX_ITEMS || spec.items.some(item => !plainObject(item))) fail('El programa debe tener entre 1 y 2000 participantes');
  const refs = new Set();
  for (const track of pack.tracks) {
    if (!plainObject(track) || typeof track.ref !== 'string' || !track.ref || track.ref.length > 64 || refs.has(track.ref) || typeof track.file !== 'string' || track.file.length > 300) fail('Canciones del programa inválidas');
    refs.add(track.ref);
  }
  if (!Array.isArray(m.files) || m.files.length > pack.tracks.length) fail('Archivos del programa inválidos');
  const seen = new Set(); let total = 0;
  for (const file of m.files) {
    if (!plainObject(file) || !refs.has(file.ref) || seen.has(file.ref)) fail('Archivos del programa inválidos');
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE) fail('Tamaño de canción inválido (máximo 5 GiB)');
    seen.add(file.ref); total += file.size;
    if (!Array.isArray(file.hashes) || file.hashes.length !== Math.ceil(file.size / CHUNK) || file.hashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))) fail('Comprobación de canciones incompleta');
    if (file.content !== await djContent(file.size, file.hashes)) fail('La identificación de una canción no coincide con su contenido');
  }
  return { total, name: spec.name.trim().slice(0, 200), participants: spec.items.length, songs: m.files.length };
}

// ¿Están completas en la nube todas las canciones del programa? Se revisa el listado, que entrega hasta 1000 a la vez,
// y no una consulta por canción: Cloudflare cuenta cada consulta a R2 como una petición más, y el plan gratuito de
// Workers permite 50 por solicitud, así que con una consulta por canción un programa largo no se podría publicar.
async function djHasAudio(bucket, files) {
  const pending = new Map(files.map(file => [djAudioKey(file.content), file.size]));
  let cursor;
  while (pending.size) {
    const page = await bucket.list({ prefix: DJ_AUDIO, limit: 1000, cursor });
    for (const object of page.objects) if (pending.get(object.key) === object.size) pending.delete(object.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return !pending.size;
}

// Libera las canciones que ningún programa usa ya. Es mejor dejar una canción de más que quitarle el audio a un
// programa que la necesita, así que NO se borra nada si:
//  - algún archivo de la carpeta de programas no se puede leer o no es un programa del DJ, o
//  - mientras se revisaba, alguien publicó, cambió o eliminó un programa (se vuelve a mirar la lista al terminar).
// Lo que queda sin borrar es solo espacio ocupado; las canciones nunca se pierden por esta limpieza.
async function djSweep(bucket, candidates) {
  if (!candidates.size) return 0;
  const used = new Set(), seen = new Map(); let cursor;
  do {
    const page = await bucket.list({ prefix: DJ_PROGRAMS, limit: 100, cursor });
    for (const entry of page.objects) {
      seen.set(entry.key, entry.etag);
      const object = await bucket.get(entry.key);
      if (!object) continue;
      let manifest;
      try { manifest = await object.json(); } catch { manifest = null; }
      if (!plainObject(manifest) || manifest.schema !== 1 || manifest.kind !== 'dj-program' || object.etag !== entry.etag) return djSweepSkipped('un programa no se pudo leer o cambió');
      for (const content of djContents(manifest)) used.add(content);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const now = new Map(); cursor = undefined;
  do {
    const page = await bucket.list({ prefix: DJ_PROGRAMS, limit: 1000, cursor });
    for (const entry of page.objects) now.set(entry.key, entry.etag);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (now.size !== seen.size || [...now].some(([key, etag]) => seen.get(key) !== etag)) return djSweepSkipped('otra persona cambió programas durante la revisión');
  const doomed = [...candidates].filter(content => !used.has(content));
  for (let index = 0; index < doomed.length; index += 500) await bucket.delete(doomed.slice(index, index + 500).map(djAudioKey));
  return doomed.length;
}
function djSweepSkipped(reason) { console.warn(`dj: limpieza omitida (${reason}); las canciones quedan guardadas`); return 0; }

async function djRoute(request, env, principal, url) {
  const bucket = env.ESCENA_BUCKET, path = url.pathname, method = request.method;

  if (path === '/v1/dj/programs' && method === 'GET') {
    const page = await bucket.list({ prefix: DJ_PROGRAMS, limit: 100, cursor: url.searchParams.get('cursor') || undefined, include: ['customMetadata'] });
    const programs = page.objects.map(object => {
      try { return JSON.parse(object.customMetadata.summary); } catch { return null; }
    }).filter(Boolean);
    return json({ programs, cursor: page.truncated ? page.cursor : null });
  }

  const programMatch = path.match(/^\/v1\/dj\/programs\/([a-zA-Z0-9_-]+)(?:\/(publish|delete))?$/);
  if (programMatch) {
    const id = validId(programMatch[1]), action = programMatch[2], key = djProgramKey(id);

    if (!action && method === 'GET') {
      const object = await bucket.get(key);
      if (!object) fail('El programa ya no está en la nube', 404);
      return new Response(object.body, { headers: { 'content-type': 'application/json', etag: object.httpEtag } });
    }

    if (action === 'publish' && method === 'POST') {
      if (principal.role === 'player') fail('Solo el propietario o un editor pueden subir programas', 403);
      const data = await djBody(request), m = data.manifest;
      const info = await validateDjManifest(m, id);
      // Si el programa guardado no se pudiera leer, se trata como si no tuviera versión: no bloquea para siempre.
      const old = await bucket.get(key), previous = old ? await old.json().catch(() => null) : null;
      if (previous?.revision === m.revision) return json({ published: true });
      if ((previous?.revision || null) !== (data.expectedRevision || null)) fail('La nube tiene una versión más reciente de este programa. Tráela o súbelo como programa nuevo.', 409);
      if (!await djHasAudio(bucket, m.files)) fail('Una canción del programa no terminó de subirse. Vuelve a subir el programa.', 409);
      m.publishedAt = Date.now();
      const summary = { id, revision: m.revision, name: info.name, participants: info.participants, songs: info.songs, size: info.total, updatedAt: m.publishedAt, by: String(principal.name || '').slice(0, 100) };
      const result = await bucket.put(key, JSON.stringify(m), {
        httpMetadata: jsonMetadata, customMetadata: { summary: JSON.stringify(summary) },
        onlyIf: new Headers(old ? { 'If-Match': old.httpEtag } : { 'If-None-Match': '*' }),
      });
      if (!result) fail('Otra actualización llegó primero. Vuelve a consultar la nube.', 409);
      // Canciones que la versión anterior usaba y esta ya no: se liberan si ningún otro programa las usa.
      const dropped = djContents(previous);
      for (const content of djContents(m)) dropped.delete(content);
      if (dropped.size) await djSweep(bucket, dropped).catch(error => djSweepSkipped(`error: ${error?.message || error}`));
      return json({ published: true, summary });
    }

    if (action === 'delete' && method === 'POST') {
      // Borrar es definitivo y afecta a todos los equipos: solo el propietario.
      if (principal.role !== 'owner') fail('Solo el propietario puede eliminar programas de la nube', 403);
      const data = await djBody(request), current = await bucket.get(key);
      if (!current) fail('El programa ya no está en la nube', 404);
      const previous = await current.json().catch(() => null);
      // La revisión que el propietario vio en su lista: si otra persona subió cambios mientras tanto, no se borra.
      // Un programa dañado (que no se puede leer) sí se puede quitar, para no dejarlo atascado en la lista.
      if (previous && previous.revision !== validId(typeof data.revision === 'string' ? data.revision : '')) fail('El programa cambió en la nube. Actualiza la lista antes de eliminarlo.', 409);
      await bucket.delete(key);
      await djSweep(bucket, djContents(previous)).catch(error => djSweepSkipped(`error: ${error?.message || error}`));
      return json({ deleted: true });
    }
  }

  if (path === '/v1/dj/uploads/start' && method === 'POST') {
    const data = await djBody(request), key = djAudioKey(data.content);
    if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_FILE) fail('Tamaño de canción inválido');
    const existing = await bucket.head(key);
    if (existing) {
      if (existing.size !== data.size) fail('La canción existente tiene otro tamaño', 409);
      return json({ complete: true });
    }
    const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { size: String(data.size) } });
    return json({ uploadId: upload.uploadId });
  }

  if (path === '/v1/dj/uploads/part' && method === 'PUT') {
    const data = Object.fromEntries(url.searchParams), key = djAudioKey(data.content);
    const partNumber = Number(data.part), expectedHash = request.headers.get('x-chunk-sha256');
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 640 || !data.uploadId || data.uploadId.length > 2000 || !HASH.test(expectedHash || '')) fail('Parte inválida');
    const bytes = await readLimited(request, CHUNK);
    if (!bytes.length || await digest(bytes) !== expectedHash) fail('La comprobación del archivo no coincide', 422);
    try {
      return json(await bucket.resumeMultipartUpload(key, data.uploadId).uploadPart(partNumber, bytes));
    } catch { fail('La subida parcial caducó. Cancela esta subida y vuelve a iniciarla.', 409); }
  }

  if (path === '/v1/dj/uploads/complete' && method === 'POST') {
    const data = await djBody(request), key = djAudioKey(data.content);
    const existing = await bucket.head(key);
    if (existing) {
      if (existing.size !== data.size) fail('La canción existente tiene otro tamaño', 409);
      return json({ complete: true });
    }
    if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_FILE || !Array.isArray(data.parts) || data.parts.length !== Math.ceil(data.size / CHUNK)) fail('Subida incompleta');
    if (data.parts.some((part, index) => part?.partNumber !== index + 1 || typeof part.etag !== 'string')) fail('Partes inválidas');
    try {
      const object = await bucket.resumeMultipartUpload(key, data.uploadId).complete(data.parts);
      if (object.size !== data.size) { await bucket.delete(key); fail('El tamaño recibido no coincide', 422); }
      return json({ complete: true });
    } catch (error) { if (error.status) throw error; fail('Subida caducada o incompleta. Cancélala y vuelve a iniciarla.', 409); }
  }

  if (path === '/v1/dj/uploads/discard' && method === 'POST') {
    const data = await djBody(request), key = djAudioKey(data.content);
    // Solo se aborta la subida por partes pendiente: nunca se borra una canción completa que otro programa pueda usar.
    if (typeof data.uploadId === 'string' && data.uploadId && data.uploadId.length <= 2000) {
      try { await bucket.resumeMultipartUpload(key, data.uploadId).abort(); } catch { /* ya no existe */ }
    }
    return json({ discarded: true });
  }

  const audioMatch = path.match(/^\/v1\/dj\/audio\/([a-f0-9]{64})$/);
  if (audioMatch && method === 'GET') {
    const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d+)$/);
    if (!range) fail('Solicita el archivo por partes', 416);
    const start = Number(range[1]), end = Number(range[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > CHUNK) fail('Rango inválido', 416);
    const audioKey = djAudioKey(audioMatch[1]);
    let object;
    try { object = await bucket.get(audioKey, { range: { offset: start, length: end - start + 1 } }); }
    catch (error) {
      // R2 rechaza con un error un rango que empieza después del final del archivo: eso es un 416, no una falla del servicio.
      const whole = await bucket.head(audioKey).catch(() => null);
      if (whole && start >= whole.size) fail('Rango fuera del archivo', 416);
      throw error;
    }
    if (!object) fail('No se encontró la canción', 404);
    if (end >= object.size) fail('Rango fuera del archivo', 416);
    return new Response(object.body, { status: 206, headers: {
      'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${object.size}`,
      'content-length': String(end - start + 1), 'accept-ranges': 'bytes', etag: object.httpEtag,
    } });
  }

  fail('Ruta no encontrada', 404);
}

async function route(request, env, principal) {

  const bucket = env.ESCENA_BUCKET;

  const url = new URL(request.url), path = url.pathname, method = request.method;

  if (path === '/v1/ping' && method === 'GET') {
    const serverTime = Date.now();
    const { id, name, role, offlineHours } = principal;
    return json({ ok: true, schema: 1, chunkSize: CHUNK, role: role === 'player' ? 'player' : 'master', accessVersion: 2,
      user: { id, name, role, offlineHours }, permissions: { publish: role !== 'player', manageUsers: role === 'owner' }, features: { reuseAudio: true, dj: DJ_FEATURE },
      serverTime, offlineUntil: serverTime + offlineHours * 3600000 });
  }

  if (path === '/v1/users' || path.startsWith('/v1/users/')) return manageUsers(request, env, principal, path, method);

  if (path.startsWith('/v1/dj/')) return djRoute(request, env, principal, url);

  if (path === '/v1/songs' && method === 'GET') {

    const page = await bucket.list({ prefix: 'catalog/', limit: 100, cursor: url.searchParams.get('cursor') || undefined, include: ['customMetadata'] });

    const songs = page.objects.map(object => {

      try { return JSON.parse(object.customMetadata.summary); } catch { return null; }

    }).filter(Boolean);

    return json({ songs, cursor: page.truncated ? page.cursor : null });

  }

  const songMatch = path.match(/^\/v1\/songs\/([a-zA-Z0-9_-]+)$/);

  if (songMatch && method === 'GET') {

    const id = validId(songMatch[1]), object = await bucket.get(`catalog/${id}.json`);

    if (!object) fail('La canción ya no está disponible', 404);

    return new Response(object.body, { headers: { 'content-type': 'application/json', etag: object.httpEtag } });

  }

  if (path === '/v1/uploads/start' && method === 'POST') {

    const data = await bodyJson(request), { key } = paths(data);

    if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_FILE) fail('Tamaño de pista inválido');

    const existing = await bucket.head(key);

    if (existing) {

      if (existing.size !== data.size) fail('La pista existente tiene otro tamaño', 409);

      return json({ complete: true });

    }

    const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { size: String(data.size) } });

    return json({ uploadId: upload.uploadId });

  }

  if (path === '/v1/uploads/part' && method === 'PUT') {

    const data = Object.fromEntries(url.searchParams), { key } = paths(data);

    const partNumber = Number(data.part), expectedHash = request.headers.get('x-chunk-sha256');

    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 640 || !data.uploadId || data.uploadId.length > 2000 || !HASH.test(expectedHash || '')) fail('Parte inválida');

    const bytes = await readLimited(request, CHUNK);

    if (!bytes.length || await digest(bytes) !== expectedHash) fail('La comprobación del archivo no coincide', 422);

    try {

      const upload = bucket.resumeMultipartUpload(key, data.uploadId);

      return json(await upload.uploadPart(partNumber, bytes));

    } catch { fail('La subida parcial caducó. Descarta esta subida y vuelve a iniciarla.', 409); }

  }

  if (path === '/v1/uploads/complete' && method === 'POST') {

    const data = await bodyJson(request), { key } = paths(data);

    const existing = await bucket.head(key);

    if (existing) {
      if (existing.size !== data.size) fail('La pista existente tiene otro tamaño. Usa una revisión nueva.', 409);
      return json({ complete: true });
    }

    if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_FILE || !Array.isArray(data.parts) || data.parts.length !== Math.ceil(data.size / CHUNK)) fail('Subida incompleta');

    if (data.parts.some((part, index) => part.partNumber !== index + 1 || typeof part.etag !== 'string')) fail('Partes inválidas');

    try {

      const upload = bucket.resumeMultipartUpload(key, data.uploadId);

      const object = await upload.complete(data.parts);

      if (object.size !== data.size) { await bucket.delete(key); fail('El tamaño recibido no coincide', 422); }

      return json({ complete: true });

    } catch (error) { if (error.status) throw error; fail('Subida caducada o incompleta. Descártala y vuelve a iniciarla.', 409); }

  }

  const deleteMatch = path.match(/^\/v1\/songs\/([a-zA-Z0-9_-]+)\/delete$/);

  if (deleteMatch && method === 'POST') {
    // Borrar una canción es irreversible y afecta a todos los equipos: solo el propietario.
    if (principal.role !== 'owner') fail('Solo el propietario puede eliminar canciones de la nube', 403);
    const id = validId(deleteMatch[1]), data = await bodyJson(request), catalogKey = `catalog/${id}.json`;
    const current = await bucket.get(catalogKey);
    if (!current) fail('La canción ya no está disponible', 404);
    // La revisión que el propietario vio en su lista: si otra persona publicó mientras tanto, no se borra.
    if ((await current.json()).revision !== validId(data?.revision)) fail('La canción cambió en la nube. Actualiza la lista antes de eliminarla.', 409);
    // Primero el audio y al final el catálogo: si algo falla a medias, la canción sigue en la
    // lista y se puede volver a intentar. La segunda barrida recoge lo que una subida en curso
    // haya terminado mientras tanto.
    await sweepAudio(bucket, id);
    await bucket.delete(catalogKey);
    await sweepAudio(bucket, id);
    return json({ deleted: true });
  }

  const publishMatch = path.match(/^\/v1\/songs\/([a-zA-Z0-9_-]+)\/publish$/);

  if (publishMatch && method === 'POST') {

    const id = validId(publishMatch[1]), data = await bodyJson(request), m = data.manifest;

    const total = validateManifest(m, id), catalogKey = `catalog/${id}.json`;

    const old = await bucket.get(catalogKey), previous = old ? await old.json() : null;

    if (previous?.revision === m.revision) return json({ published: true });

    if ((previous?.revision || null) !== (data.expectedRevision || null)) fail('La nube tiene una versión más reciente. Descarga esa versión o publica como otra canción.', 409);

    for (const file of m.files) {

      const location = audioRevision(m, file);

      if (location !== m.revision) {
        // Solo se puede reutilizar el audio que la versión publicada ya usa, con
        // el mismo tamaño y las mismas comprobaciones. Así no se enlaza audio
        // ajeno, a medio subir ni de otra pista.
        const before = Array.isArray(previous?.files) ? previous.files.find(item => item.id === file.id) : null;
        const same = before && audioRevision(previous, before) === location && before.size === file.size
          && Array.isArray(before.hashes) && before.hashes.length === file.hashes.length && before.hashes.every((hash, index) => hash === file.hashes[index]);
        if (!same) fail(`La pista «${file.name}» ya no coincide con la versión publicada. Vuelve a publicar la canción.`, 409);
      }

      const head = await bucket.head(`audio/${id}/${location}/${file.id}`);

      if (!head || head.size !== file.size) fail(`La pista «${file.name}» está incompleta`, 409);

    }

    m.publishedAt = Date.now();

    const summary = { id, revision: m.revision, title: m.song.title, artist: String(m.song.artist || '').slice(0, 300), size: total, tracks: m.files.length, bpm: m.song.tempoMap[0].bpm, updatedAt: m.publishedAt };

    const result = await bucket.put(catalogKey, JSON.stringify(m), {

      httpMetadata: { contentType: 'application/json' }, customMetadata: { summary: JSON.stringify(summary) },

      onlyIf: new Headers(old ? { 'If-Match': old.httpEtag } : { 'If-None-Match': '*' }),

    });

    if (!result) fail('Otra actualización llegó primero. Vuelve a consultar la nube.', 409);

    return json({ published: true, summary });

  }

  const audioMatch = path.match(/^\/v1\/audio\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);

  if (audioMatch && method === 'GET') {

    const [songId, revision, trackId] = audioMatch.slice(1).map(validId);

    let published = null;
    try {
      const catalog = await bucket.get(`catalog/${songId}.json`);
      published = catalog ? await catalog.json() : null;
    } catch { published = null; }
    const entry = published?.revision === revision && Array.isArray(published.files) ? published.files.find(file => file.id === trackId) : null;

    if (principal.role !== 'owner') {
      if (!published || published.revision !== revision || !entry || !Array.isArray(published.song?.tracks) || !published.song.tracks.some(track => track.id === trackId)) {
        fail('El audio no pertenece a la versión publicada de la canción', 403);
      }
    }

    // La dirección que usan las apps es la de la versión publicada. Si la pista
    // no cambió, el archivo sigue guardado en la revisión donde se subió.
    const { key } = paths({ songId, revision: entry ? audioRevision(published, entry) : revision, trackId });

    const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d+)$/);

    if (!range) fail('Solicita el archivo por partes', 416);

    const start = Number(range[1]), end = Number(range[2]);

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > CHUNK) fail('Rango inválido', 416);

    const object = await bucket.get(key, { range: { offset: start, length: end - start + 1 } });

    if (!object) fail('No se encontró el audio', 404);

    if (end >= object.size) fail('Rango fuera del archivo', 416);

    return new Response(object.body, { status: 206, headers: {

      'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${object.size}`,

      'content-length': String(end - start + 1), 'accept-ranges': 'bytes', etag: object.httpEtag,

    } });

  }

  if (path === '/v1/uploads/discard' && method === 'POST') {

    const data = await bodyJson(request), id = validId(data.songId), revision = validId(data.revision);

    const catalog = await bucket.get(`catalog/${id}.json`);

    if (catalog && (await catalog.json()).revision === revision) fail('Esta versión ya está publicada; se conserva en la nube.', 409);

    for (const file of (data.files || []).slice(0, 128)) {

      if (!file.uploadId) continue;

      const { key } = paths({ songId: id, revision, trackId: file.id });

      await bucket.resumeMultipartUpload(key, file.uploadId).abort().catch(() => {});

    }

    // Otra petición puede publicar esta revisión después de la comprobación
    // anterior. Sin coordinación entre publicación y limpieza, borrar aquí
    // archivos completos podría destruir una canción recién publicada.
    // Solo se abortan multipart pendientes; los objetos completos abandonados
    // quedan privados para una limpieza posterior con coordinación del catálogo.
    return json({ discarded: true, cleanupDeferred: true });

  }

  fail('Ruta no encontrada', 404);

}

export default {

  async fetch(request, env) {

    const origin = request.headers.get('origin');

    const allowed = String(env.ALLOWED_ORIGINS || 'https://sadoth17-code.github.io').split(',').map(s => s.trim()).filter(Boolean);

    const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin' });

    if (origin && !allowed.includes(origin)) return new Response(JSON.stringify({ error: 'Origen no permitido' }), { status: 403, headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' } });

    if (origin) headers.set('access-control-allow-origin', origin);

    headers.set('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');

    headers.set('access-control-allow-headers', 'Authorization, Content-Type, Range, X-Chunk-Sha256');

    headers.set('access-control-expose-headers', 'Content-Range, Content-Length, ETag');

    headers.set('access-control-max-age', '600');

    let response;

    try {

      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

      if (!HASH.test(env.ESCENA_KEY || '') || !env.ESCENA_BUCKET) fail('Configura ESCENA_BUCKET y el secreto ESCENA_KEY en Cloudflare.', 503);

      if (String(env.ALLOW_LEGACY_PLAYER) === 'true' && env.ESCENA_PLAYER_KEY && (!HASH.test(env.ESCENA_PLAYER_KEY) || env.ESCENA_PLAYER_KEY === env.ESCENA_KEY)) fail('ESCENA_PLAYER_KEY debe tener 64 caracteres hexadecimales y ser diferente de ESCENA_KEY.', 503);

      // La autorización se valida en el servidor para cada operación, incluso si

      // alguien altera los controles de la aplicación o llama al Worker directamente.

      const principal = await identify(request, env);
      const path = new URL(request.url).pathname;
      if ((path === '/v1/users' || path.startsWith('/v1/users/')) && principal.role !== 'owner') fail('Solo el propietario puede administrar usuarios', 403);
      if (principal.role === 'player' && !['GET', 'HEAD'].includes(request.method)) fail('Esta clave permite descargar y reproducir. Solo el propietario o un editor pueden publicar o modificar la nube.', 403);

      response = await route(request, env, principal);

    } catch (error) {

      response = json({ error: error.status ? error.message : 'No se pudo completar la operación. Puedes reintentar.' }, error.status || 500);

    }

    const merged = new Headers(response.headers);

    for (const [name, value] of headers) merged.set(name, value);

    return new Response(response.body, { status: response.status, headers: merged });

  },

};
