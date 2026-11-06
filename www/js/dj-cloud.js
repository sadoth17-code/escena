// Programas del DJ en la nube de Escena.
//
// Un programa del DJ (con sus canciones) se sube a la misma nube que los multitracks y se trae en cualquier otro
// dispositivo conectado a esa nube. Va en una sección aparte (/v1/dj/…): no se mezcla con las canciones multitrack, pero
// usa las mismas cuentas y permisos (músico: ver y traer · editor: además subir · propietario: además eliminar).
//
// Cómo se guarda:
//   - Cada canción se sube en partes de 8 MiB, y el Worker comprueba cada parte (SHA-256) igual que con los multitracks.
//   - Cada canción se identifica por su contenido: si ya está en la nube (la subió otro programa o este mismo antes),
//     no se vuelve a subir. Así volver a subir un programa tras cambiarle el orden casi no cuesta nada.
//   - El programa (orden, tiempos, pads) viaja con la misma descripción que un paquete «Llevar a otra PC».
//
// Traer un programa reutiliza la importación de paquetes del DJ (dj.js): lo que ya está en la biblioteca no se baja otra
// vez, y cada parte que llega se comprueba contra el hash que dejó quien lo subió. Lo que viene de la nube es un dato
// externo, así que se valida todo antes de usarlo.
//
// Este módulo no toca el DOM: lo usa la pantalla del DJ (ui/dj-view.js).

import { createEmitter } from './util.js';
import { parseManifest } from './dj-package.js';

const CHUNK = 8 * 1024 * 1024; // igual que la nube de multitracks
const MAX_FILE = 5 * 1024 ** 3;
const ATTEMPTS = 12; // reintentos por solicitud en una transferencia larga (igual que cloud-request.js)
const MAX_REQUEST_BYTES = 1000000; // el Worker acepta hasta 1 MiB por solicitud
export const CLOUD_LIMITS = Object.freeze({ tracks: 1000, items: 2000 });
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{8,80}$/;
const SPACE_MARGIN = 64 * 1024 * 1024;

export const OLD_WORKER = 'Tu nube todavía no guarda programas del DJ. Publica primero el Worker nuevo (server/worker.mjs) y vuelve a intentarlo.';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
export const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', data));
// Lo que identifica una canción en la nube: su tamaño y el hash de cada parte (así no hace falta releerla para saber si ya está).
export const contentId = (size, hashes) => sha256(new TextEncoder().encode(`${size}:${hashes.join(',')}`));
const newId = () => crypto.randomUUID();
const abortError = () => new DOMException('Cancelado', 'AbortError');
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const isAbort = (error) => Boolean(error && error.name === 'AbortError');

// Un Worker anterior no conoce las rutas del DJ y contesta «Ruta no encontrada».
const friendly = (error) => {
  if (error && error.status === 404 && /Ruta no encontrada/i.test(error.message || '')) return OLD_WORKER;
  return (error && error.message) || 'No se pudo completar la operación con tu nube.';
};

function cleanSummary(raw) {
  if (!isObject(raw) || !ID.test(raw.id || '') || !ID.test(raw.revision || '') || typeof raw.name !== 'string') return null;
  const number = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
  return {
    id: raw.id,
    revision: raw.revision,
    name: raw.name.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Programa',
    participants: number(raw.participants),
    songs: number(raw.songs),
    size: number(raw.size),
    updatedAt: number(raw.updatedAt),
    by: typeof raw.by === 'string' ? raw.by.slice(0, 100) : '',
  };
}

// Valida lo que devolvió la nube (dato externo) y lo deja en la forma que entiende la importación del DJ.
// Devuelve { revision, publishedAt, parsed, files: Map(ref -> { size, hashes, content }) }.
export async function readCloudProgram(raw, expectedId) {
  const incompatible = () => new Error('Ese programa de la nube tiene un formato que esta versión de Escena no entiende. Actualiza Escena e inténtalo de nuevo.');
  if (!isObject(raw) || raw.schema !== 1 || raw.kind !== 'dj-program' || raw.id !== expectedId || !ID.test(raw.revision || '') || raw.chunkSize !== CHUNK) throw incompatible();
  const parsed = parseManifest(raw.package);
  if (parsed.programs.length !== 1) throw incompatible();
  const refs = new Set(parsed.tracks.map((track) => track.ref));
  const files = new Map();
  for (const file of Array.isArray(raw.files) ? raw.files : []) {
    if (!isObject(file) || typeof file.ref !== 'string' || !refs.has(file.ref) || files.has(file.ref)) continue;
    const sound =
      Number.isSafeInteger(file.size) && file.size >= 1 && file.size <= MAX_FILE &&
      Array.isArray(file.hashes) && file.hashes.length === Math.ceil(file.size / CHUNK) && file.hashes.every((hash) => HASH.test(hash)) &&
      HASH.test(file.content || '') && file.content === (await contentId(file.size, file.hashes));
    if (!sound) throw new Error('Una canción de ese programa está incompleta en la nube. Pide que lo vuelvan a subir.');
    files.set(file.ref, { size: file.size, hashes: file.hashes.slice(), content: file.content });
  }
  return { revision: raw.revision, publishedAt: Number(raw.publishedAt) || 0, parsed, files };
}

export function createDjCloud({ dj, cloud } = {}) {
  const bus = createEmitter();
  const state = {
    supported: null, // null = sin comprobar · true/false = el Worker de la nube sabe (o no) guardar programas del DJ
    loading: false,
    loaded: false,
    error: '', // por qué no se pudo leer la lista
    programs: [], // lo que hay en la nube: { id, revision, name, participants, songs, size, updatedAt, by }
    busy: null, // operación en curso: { kind, name, phase, file, filesDone, filesTotal, bytesDone, bytesTotal, cancelable }
  };
  let controller = null;
  let destroyed = false;
  const toast = (message, kind) => dj.notify(message, kind);
  const emit = () => {
    if (!destroyed) bus.emit('change');
  };

  const connected = () => Boolean(cloud && cloud.connected);

  // ---------------------------------------------------------- lista de la nube

  async function checkSupport(signal) {
    const ping = await cloud.request('/v1/ping', { maxAttempts: 1, signal });
    state.supported = Number(ping && ping.features && ping.features.dj) >= 1;
    return state.supported;
  }

  async function refresh() {
    if (!connected()) {
      state.programs = [];
      state.loaded = false;
      state.error = '';
      state.supported = null;
      emit();
      return false;
    }
    if (state.loading) return false;
    state.loading = true;
    state.error = '';
    emit();
    try {
      await cloud.init();
      if (!(await checkSupport())) {
        state.programs = [];
        state.error = OLD_WORKER;
        state.loaded = true;
        return false;
      }
      const programs = [];
      let cursor = null;
      for (let page = 0; page < 50; page++) {
        const result = await cloud.request(`/v1/dj/programs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!result || !Array.isArray(result.programs)) throw new Error('La nube devolvió una lista de programas que no se puede leer.');
        for (const raw of result.programs) {
          const entry = cleanSummary(raw);
          if (entry) programs.push(entry);
        }
        cursor = result.cursor || null;
        if (!cursor) break;
      }
      programs.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'es'));
      state.programs = programs;
      state.loaded = true;
      return true;
    } catch (error) {
      state.error = friendly(error);
      if (error && error.status === 404 && state.error === OLD_WORKER) state.supported = false;
      return false;
    } finally {
      state.loading = false;
      emit();
    }
  }

  // Cómo está un programa de este dispositivo respecto a la nube.
  function statusOf(program) {
    const link = program && program.cloud && program.cloud.endpoint === cloud.api ? program.cloud : null;
    if (!link) return { linked: false, remote: null, gone: false, localChanges: false, behind: false };
    const remote = state.programs.find((entry) => entry.id === link.id) || null;
    return {
      linked: true,
      remote,
      gone: state.loaded && !state.error && !remote,
      localChanges: Number(program.updated || 0) > Number(link.syncedAt || 0),
      behind: Boolean(remote && remote.revision !== link.revision),
    };
  }

  // ---------------------------------------------------------- trabajo en curso

  const busyNow = () => Boolean(state.busy);
  const progress = (patch) => {
    if (state.busy) {
      Object.assign(state.busy, patch);
      emit();
    }
  };

  function cancel() {
    if (controller && state.busy && state.busy.cancelable) controller.abort();
  }

  // Todo lo que corre en la nube va por aquí: una a la vez, y sin cruzarse con una transferencia de multitracks.
  async function exclusiveRun(kind, name, work, { cancelable = true } = {}) {
    if (busyNow() || dj.state.importing || dj.state.exporting) {
      toast('Espera a que termine lo anterior.');
      return null;
    }
    try {
      await cloud.init();
      return await cloud.exclusive(async () => {
        const abort = new AbortController();
        controller = abort;
        state.busy = { kind, name, phase: 'prepare', file: '', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, cancelable };
        emit();
        try {
          return await work(abort.signal);
        } finally {
          state.busy = null;
          controller = null;
          emit();
        }
      });
    } catch (error) {
      toast(friendly(error), 'error');
      return null;
    }
  }

  // ---------------------------------------------------------- subir

  // Sube el programa (con sus canciones) a la nube. `asNew` lo sube como un programa nuevo aunque ya esté vinculado a uno.
  // Devuelve { id, revision, uploaded, reused } o null si no se pudo (el motivo se avisa con un aviso en pantalla).
  async function upload(programId, { asNew = false } = {}) {
    if (dj.state.transport === 'playing') {
      toast('Detén la música antes de subir el programa.', 'error');
      return null;
    }
    if (!connected()) {
      toast('Conecta tu nube (pestaña Nube) para subir programas.', 'error');
      return null;
    }
    try {
      await cloud.init();
      cloud.requireMaster();
    } catch (error) {
      toast(error.message, 'error');
      return null;
    }
    return exclusiveRun('upload', '', async (signal) => {
      const pending = []; // subidas por partes que quedaron a medias si algo falla
      try {
        if (!(await checkSupport(signal))) throw new Error(OLD_WORKER);
        const source = await dj.cloudSource(programId);
        if (!source) throw new Error('Ese programa ya no existe en este dispositivo.');
        const snapshotAt = source.program.updated;
        progress({ name: source.program.name });
        if (!source.files.length) throw new Error('Este programa no tiene canciones con audio en este dispositivo, así que no hay nada que subir. Añade primero las canciones.');
        const spec = source.manifest.programs[0];
        if (spec.items.length > CLOUD_LIMITS.items) throw new Error(`Este programa tiene más de ${CLOUD_LIMITS.items} participantes y no cabe en la nube. Divídelo en dos programas.`);
        if (source.manifest.tracks.length > CLOUD_LIMITS.tracks) throw new Error(`Este programa usa más de ${CLOUD_LIMITS.tracks} canciones y no cabe en la nube. Divídelo en dos programas.`);
        for (const file of source.files) {
          if (!file.blob.size) throw new Error(`«${file.name}» está vacío. Bórralo de la biblioteca y vuelve a añadirlo.`);
          if (file.blob.size > MAX_FILE) throw new Error(`«${file.name}» pesa más de 5 GiB y no cabe en la nube.`);
        }

        // ¿Es una actualización? Solo si el programa sigue igual en la nube que la última vez que este equipo lo vio.
        const link = !asNew && source.program.cloud && source.program.cloud.endpoint === cloud.api ? source.program.cloud : null;
        const id = link ? link.id : newId();
        let expectedRevision = link ? link.revision : null;
        if (link) {
          let remote = null;
          try {
            remote = await cloud.request(`/v1/dj/programs/${encodeURIComponent(id)}`, { signal });
          } catch (error) {
            if (error.status !== 404) throw error; // si ya no está, se vuelve a crear
          }
          if (remote && remote.revision !== expectedRevision) {
            throw Object.assign(new Error('La nube tiene otra versión de este programa (se subió desde otro equipo). Tráela primero con «Traer», o súbelo como programa nuevo.'), { code: 'newer' });
          }
          if (!remote) expectedRevision = null;
        }

        // 1) Huella de cada canción: tamaño y hash de cada parte. Con eso se sabe si la nube ya la tiene.
        progress({ phase: 'hash', filesTotal: source.files.length, bytesTotal: source.files.reduce((sum, file) => sum + file.blob.size, 0), bytesDone: 0, filesDone: 0 });
        const described = [];
        for (const file of source.files) {
          progress({ file: file.name });
          const hashes = [];
          for (let at = 0; at < file.blob.size; at += CHUNK) {
            if (signal.aborted) throw abortError();
            const bytes = await file.blob.slice(at, Math.min(file.blob.size, at + CHUNK)).arrayBuffer();
            hashes.push(await sha256(bytes));
            progress({ bytesDone: state.busy.bytesDone + bytes.byteLength });
          }
          described.push({ ref: file.ref, name: file.name, blob: file.blob, size: file.blob.size, hashes, content: await contentId(file.blob.size, hashes) });
          progress({ filesDone: state.busy.filesDone + 1 });
        }
        const revision = newId();
        const manifest = {
          schema: 1,
          kind: 'dj-program',
          id,
          revision,
          chunkSize: CHUNK,
          package: source.manifest,
          files: described.map(({ ref, size, hashes, content }) => ({ ref, content, size, hashes })),
        };
        const payload = { manifest, expectedRevision };
        if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_REQUEST_BYTES) {
          throw new Error('La descripción de este programa es demasiado grande para la nube (demasiadas canciones o participantes). Divídelo en dos programas.');
        }

        // 2) Las canciones que la nube todavía no tiene.
        progress({ phase: 'upload', filesDone: 0, bytesDone: 0 });
        let uploaded = 0;
        let reused = 0;
        for (const file of described) {
          if (signal.aborted) throw abortError();
          progress({ file: file.name });
          const body = { content: file.content, size: file.size };
          const start = await cloud.request('/v1/dj/uploads/start', { method: 'POST', data: body, signal, maxAttempts: ATTEMPTS });
          if (start.complete) {
            reused++;
            progress({ filesDone: state.busy.filesDone + 1, bytesDone: state.busy.bytesDone + file.size });
            continue;
          }
          const inflight = { content: file.content, uploadId: start.uploadId };
          pending.push(inflight);
          const parts = [];
          for (let index = 0; index < file.hashes.length; index++) {
            if (signal.aborted) throw abortError();
            const bytes = await file.blob.slice(index * CHUNK, Math.min(file.size, (index + 1) * CHUNK)).arrayBuffer();
            const query = new URLSearchParams({ content: file.content, uploadId: start.uploadId, part: String(index + 1) });
            parts.push(await cloud.request(`/v1/dj/uploads/part?${query}`, { method: 'PUT', bytes, signal, maxAttempts: ATTEMPTS, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': file.hashes[index] } }));
            progress({ bytesDone: state.busy.bytesDone + bytes.byteLength });
          }
          await cloud.request('/v1/dj/uploads/complete', { method: 'POST', data: { ...body, uploadId: start.uploadId, parts }, signal, maxAttempts: ATTEMPTS });
          pending.splice(pending.indexOf(inflight), 1);
          uploaded++;
          progress({ filesDone: state.busy.filesDone + 1 });
        }

        // 3) Se publica el programa. Desde aquí ya no se cancela: es una sola solicitud corta.
        progress({ phase: 'publish', file: '', cancelable: false });
        try {
          await cloud.request(`/v1/dj/programs/${encodeURIComponent(id)}/publish`, { method: 'POST', data: payload, maxAttempts: ATTEMPTS });
        } catch (error) {
          if (error.status === 409 && /versión más reciente/i.test(error.message || '')) {
            throw Object.assign(new Error('La nube tiene otra versión de este programa (se subió desde otro equipo). Tráela primero con «Traer», o súbelo como programa nuevo.'), { code: 'newer' });
          }
          throw error;
        }
        dj.setCloudLink(programId, { endpoint: cloud.api, id, revision, syncedAt: snapshotAt });
        await refresh().catch(() => {});
        const songs = described.length;
        const detail = [];
        if (uploaded) detail.push(plural(uploaded, 'subida ahora', 'subidas ahora'));
        if (reused) detail.push(uploaded ? plural(reused, 'ya estaba', 'ya estaban') : songs === 1 ? 'ya estaba' : 'ya estaban todas');
        toast(`«${source.program.name}» está en tu nube: ${plural(songs, 'canción', 'canciones')} (${detail.join(', ')}).`);
        return { id, revision, uploaded, reused };
      } catch (error) {
        // Las subidas por partes que quedaron a medias se descartan (lo ya terminado se aprovecha si se repite).
        // Se espera un momento para que el aviso llegue, pero sin dejar la pantalla colgada si la conexión no responde.
        if (pending.length) {
          let timer;
          const settled = Promise.allSettled(pending.map((item) => cloud.request('/v1/dj/uploads/discard', { method: 'POST', data: item, maxAttempts: 1 })));
          await Promise.race([settled, new Promise((resolve) => (timer = setTimeout(resolve, 3000)))]);
          clearTimeout(timer);
        }
        if (isAbort(error) || signal.aborted) toast('Subida cancelada. Lo que ya se subió se aprovecha si la repites.');
        else toast(friendly(error), 'error');
        return null;
      }
    });
  }

  // ---------------------------------------------------------- traer

  // Lee un programa de la nube y dice qué traería, sin cambiar nada todavía. Devuelve { opened, summary, linked, entry } o null.
  async function inspect(entry) {
    try {
      await cloud.init();
      if (!connected() || !cloud.canAccess) throw new Error('Conecta tu nube (pestaña Nube) para traer programas.');
      const raw = await cloud.request(`/v1/dj/programs/${encodeURIComponent(entry.id)}`);
      const program = await readCloudProgram(raw, entry.id);
      const endpoint = cloud.api;
      const opened = {
        kind: 'cloud',
        fileName: program.parsed.programs[0].name,
        manifest: program.parsed,
        cloud: { endpoint, id: entry.id, revision: program.revision },
        info: { by: entry.by || '', publishedAt: program.publishedAt },
        audioSize: (def) => (program.files.has(def.ref) ? program.files.get(def.ref).size : null),
        readAudio: (def) => readAudio(program.files.get(def.ref), def),
      };
      const summary = dj.summarizePackage(opened);
      const linked = dj.programsLinkedTo(endpoint, entry.id)[0] || null;
      return { opened, summary, linked, entry };
    } catch (error) {
      toast(friendly(error), 'error');
      if (error && error.status === 404) refresh().catch(() => {});
      return null;
    }
  }

  // Baja una canción por partes y comprueba cada una contra el hash que dejó quien la subió.
  async function readAudio(file, def) {
    if (!file) throw new Error(`«${def.file}» no trae su audio en la nube.`);
    const signal = controller ? controller.signal : undefined;
    progress({ file: def.file });
    const parts = [];
    for (let index = 0; index < file.hashes.length; index++) {
      if (signal && signal.aborted) throw abortError();
      const start = index * CHUNK;
      const end = Math.min(file.size, start + CHUNK) - 1;
      let bytes = null;
      for (let attempt = 1; !bytes; attempt++) {
        let response;
        try {
          response = await cloud.request(`/v1/dj/audio/${file.content}`, { binary: true, signal, maxAttempts: ATTEMPTS, headers: { Range: `bytes=${start}-${end}` } });
        } catch (error) {
          if (error && error.status === 404) throw Object.assign(new Error(`«${def.file}» ya no está en la nube. Vuelve a subir el programa desde el equipo que tiene la canción.`), { code: 'gone' });
          throw error;
        }
        const sound = response.status === 206 && response.range === `bytes ${start}-${end}/${file.size}` && response.bytes.byteLength === end - start + 1 && (await sha256(response.bytes)) === file.hashes[index];
        if (sound) bytes = response.bytes;
        else if (attempt >= 3) throw Object.assign(new Error(`«${def.file}» no llegó completa de la nube (falló la comprobación). Vuelve a intentarlo.`), { code: 'verify' });
      }
      parts.push(new Blob([bytes]));
      progress({ bytesDone: (state.busy ? state.busy.bytesDone : 0) + bytes.byteLength });
    }
    const blob = new Blob(parts, { type: def.type || '' });
    if (blob.size !== file.size) throw Object.assign(new Error(`«${def.file}» llegó con otro tamaño. Vuelve a intentarlo.`), { code: 'verify' });
    progress({ filesDone: (state.busy ? state.busy.filesDone : 0) + 1 });
    return blob;
  }

  // Trae lo que mostró `inspect`. `replaceId` actualiza ese programa de este dispositivo en vez de crear uno nuevo.
  async function download(opened, { applySettings = false, replaceId = null } = {}) {
    const summary = dj.summarizePackage(opened);
    // Espacio: las canciones nuevas se guardan en este dispositivo.
    if (summary.audioBytes) {
      const room = await dj.estimate().catch(() => null);
      if (room && room.quota && room.quota - room.usage < summary.audioBytes + SPACE_MARGIN) {
        toast(`No hay espacio suficiente en este dispositivo para ${summary.withAudio === 1 ? 'la canción nueva' : 'las canciones nuevas'}. Libera espacio y vuelve a intentarlo.`, 'error');
        return null;
      }
    }
    return exclusiveRun('download', opened.fileName, async (signal) => {
      progress({ phase: 'download', filesTotal: summary.withAudio, bytesTotal: summary.audioBytes });
      const report = await dj.importPackage(opened, { applySettings, replaceId, signal });
      if (report && report.aborted) toast('Descarga cancelada. Las canciones que ya llegaron se quedan en este dispositivo y no se repiten al volver a traerlo.');
      if (report && report.programIds && report.programIds.length) refresh().catch(() => {});
      return report;
    });
  }

  // ---------------------------------------------------------- eliminar

  // Quita un programa de la nube (solo el propietario). Las copias que ya trajeron otros equipos se quedan.
  async function remove(entry) {
    if (busyNow()) {
      toast('Espera a que termine lo anterior.');
      return false;
    }
    try {
      await cloud.init();
      cloud.requireMaster();
      if (!cloud.canDelete) throw new Error('Solo el propietario puede eliminar programas de la nube.');
    } catch (error) {
      toast(error.message, 'error');
      return false;
    }
    state.busy = { kind: 'delete', name: entry.name, phase: 'delete', file: '', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, cancelable: false };
    emit();
    try {
      await cloud.request(`/v1/dj/programs/${encodeURIComponent(entry.id)}/delete`, { method: 'POST', data: { revision: entry.revision } });
      state.programs = state.programs.filter((item) => item.id !== entry.id);
      for (const local of dj.programsLinkedTo(cloud.api, entry.id)) dj.setCloudLink(local.id, null);
      toast(`«${entry.name}» se eliminó de la nube. Los equipos que ya lo trajeron conservan su copia.`);
      return true;
    } catch (error) {
      toast(friendly(error), 'error');
      if (error && error.status === 404) refresh().catch(() => {});
      return false;
    } finally {
      state.busy = null;
      emit();
      refresh().catch(() => {});
    }
  }

  // ---------------------------------------------------------- permisos y limpieza

  const offCloud = cloud && cloud.on ? cloud.on('change', emit) : () => {};
  const offRevoked = cloud && cloud.on ? cloud.on('access:revoked', () => {
    state.programs = [];
    state.loaded = false;
    state.error = '';
    state.supported = null;
    emit();
  }) : () => {};

  return {
    state,
    on: bus.on,
    get connected() {
      return connected();
    },
    get canRead() {
      return connected() && cloud.canAccess;
    },
    get canUpload() {
      return connected() && cloud.canPublish;
    },
    // La cuenta es de editor o propietario (aunque ahora no tenga internet para subir).
    get accountCanUpload() {
      return connected() && cloud.role === 'master' && Boolean(cloud.permissions && cloud.permissions.publish);
    },
    get canDelete() {
      return connected() && cloud.canDelete;
    },
    get endpoint() {
      return cloud ? cloud.api : '';
    },
    get who() {
      return (cloud && cloud.identity && cloud.identity.name) || '';
    },
    refresh,
    statusOf,
    upload,
    inspect,
    download,
    remove,
    cancel,
    destroy() {
      destroyed = true;
      offCloud();
      offRevoked();
    },
  };
}
