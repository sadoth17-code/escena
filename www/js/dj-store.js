// Guardado de la pestaña DJ en el propio dispositivo (IndexedDB), sin internet.
//
// Usa su propia base de datos ("escena-dj") para no tocar la de Escena ni migrarla:
//   tracks    la lista de canciones sueltas (nombre, duración, tamaño)
//   blobs     el audio de cada canción (aparte, para listar rápido sin leer los archivos)
//   programs  los programas (boda, desfile…) con sus participantes en orden
//   meta      ajustes (duración de la mezcla, volumen, asignaciones MIDI…)

const DB_NAME = 'escena-dj';
const DB_VERSION = 1;
export const STORES = ['tracks', 'blobs', 'programs', 'meta'];

function friendly(error) {
  const name = error && error.name;
  if (name === 'QuotaExceededError') return new Error('No hay espacio suficiente en este dispositivo para guardar la canción. Borra alguna canción o libera espacio.');
  return error instanceof Error ? error : new Error('No se pudo guardar en este dispositivo');
}

export function createDjStore({ indexedDB: idb = globalThis.indexedDB, name = DB_NAME } = {}) {
  let dbPromise = null;

  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!idb) {
        reject(new Error('Este navegador no permite guardar canciones en el dispositivo'));
        return;
      }
      const request = idb.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: store === 'meta' ? 'key' : 'id' });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          dbPromise = null;
        };
        resolve(request.result);
      };
      request.onblocked = () => reject(new Error('Cierra las otras ventanas de Escena y vuelve a cargar'));
      request.onerror = () => reject(request.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
    return dbPromise;
  };

  const read = (store, build) =>
    open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const request = build(db.transaction(store, 'readonly').objectStore(store));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        })
    );

  const write = (store, build) =>
    open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(store, 'readwrite');
          build(transaction.objectStore(store));
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(friendly(transaction.error));
          transaction.onabort = () => reject(friendly(transaction.error));
        })
    );

  return {
    kind: 'indexeddb',
    open,
    all: (store) => read(store, (object) => object.getAll()),
    get: (store, id) => read(store, (object) => object.get(id)),
    put: (store, value) => write(store, (object) => object.put(value)),
    remove: (store, id) => write(store, (object) => object.delete(id)),
    async getMeta(key, fallback = null) {
      const row = await read('meta', (object) => object.get(key));
      return row && row.value !== undefined ? row.value : fallback;
    },
    setMeta(key, value) {
      return write('meta', (object) => object.put({ key, value }));
    },
    async estimate() {
      try {
        if (!navigator.storage || !navigator.storage.estimate) return null;
        const { usage, quota } = await navigator.storage.estimate();
        return { usage, quota };
      } catch {
        return null;
      }
    },
  };
}

// Misma interfaz, solo en memoria: sirve para las pruebas y como plan B cuando el navegador no deja guardar
// (ventana privada). En ese caso las canciones duran mientras la ventana siga abierta.
export function createMemoryDjStore() {
  const data = Object.fromEntries(STORES.map((store) => [store, new Map()]));
  const keyOf = (store) => (store === 'meta' ? 'key' : 'id');
  return {
    kind: 'memory',
    async open() {},
    async all(store) {
      return Array.from(data[store].values());
    },
    async get(store, id) {
      return data[store].get(id);
    },
    async put(store, value) {
      data[store].set(value[keyOf(store)], value);
    },
    async remove(store, id) {
      data[store].delete(id);
    },
    async getMeta(key, fallback = null) {
      const row = data.meta.get(key);
      return row && row.value !== undefined ? row.value : fallback;
    },
    async setMeta(key, value) {
      data.meta.set(key, { key, value });
    },
    async estimate() {
      return null;
    },
  };
}
