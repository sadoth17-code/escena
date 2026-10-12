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

  }

  if (s.tracks.some(track => !ids.has(track.id)) || new Set(s.tracks.map(t => t.id)).size !== ids.size) fail('Referencias de pistas inválidas');

  return total;

}

async function route(request, env, principal) {

  const bucket = env.ESCENA_BUCKET;

  const url = new URL(request.url), path = url.pathname, method = request.method;

  if (path === '/v1/ping' && method === 'GET') {
    const serverTime = Date.now();
    const { id, name, role, offlineHours } = principal;
    return json({ ok: true, schema: 1, chunkSize: CHUNK, role: role === 'player' ? 'player' : 'master', accessVersion: 2,
      user: { id, name, role, offlineHours }, permissions: { publish: role !== 'player', manageUsers: role === 'owner' },
      serverTime, offlineUntil: serverTime + offlineHours * 3600000 });
  }

  if (path === '/v1/users' || path.startsWith('/v1/users/')) return manageUsers(request, env, principal, path, method);

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

  const publishMatch = path.match(/^\/v1\/songs\/([a-zA-Z0-9_-]+)\/publish$/);

  if (publishMatch && method === 'POST') {

    const id = validId(publishMatch[1]), data = await bodyJson(request), m = data.manifest;

    const total = validateManifest(m, id), catalogKey = `catalog/${id}.json`;

    const old = await bucket.get(catalogKey), previous = old ? await old.json() : null;

    if (previous?.revision === m.revision) return json({ published: true });

    if ((previous?.revision || null) !== (data.expectedRevision || null)) fail('La nube tiene una versión más reciente. Descarga esa versión o publica como otra canción.', 409);

    for (const file of m.files) {

      const head = await bucket.head(`audio/${id}/${m.revision}/${file.id}`);

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

    const { key } = paths({ songId, revision, trackId });

    if (principal.role !== 'owner') {
      const catalog = await bucket.get(`catalog/${songId}.json`);
      const published = catalog ? await catalog.json() : null;
      if (!published || published.revision !== revision || !Array.isArray(published.files) || !published.files.some(file => file.id === trackId) || !Array.isArray(published.song?.tracks) || !published.song.tracks.some(track => track.id === trackId)) {
        fail('El audio no pertenece a la versión publicada de la canción', 403);
      }
    }

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
