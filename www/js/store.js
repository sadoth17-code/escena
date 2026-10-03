const DB_NAME = 'escena';
const DB_VERSION = 2;
const STORES = ['songs', 'setlists', 'files', 'meta', 'cloudTransfers', 'cloudChunks'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Este navegador no permite guardar canciones localmente'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
        }
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); dbPromise = null; };
      resolve(request.result);
    };
    request.onblocked = () => reject(new Error('Cierra las otras pestañas de Escena y vuelve a cargar para actualizar la biblioteca'));
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function readRequest(name, build) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = build(db.transaction(name, 'readonly').objectStore(name));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

function writeRequest(name, build) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(name, 'readwrite');
        build(transaction.objectStore(name));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('No se pudo guardar'));
      })
  );
}

export const store = {
  async clearPrefix(name, prefix) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      const cursor = tx.objectStore(name).openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      cursor.onsuccess = () => { const row = cursor.result; if (row) { row.delete(); row.continue(); } };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('No se pudo limpiar la descarga'));
    });
  },
  async commitCloudSong(song, oldFileIds, transferId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['songs', 'files', 'cloudTransfers'], 'readwrite');
      tx.objectStore('songs').put(song);
      const keep = new Set(song.tracks.map(t => t.fileId));
      for (const id of oldFileIds) if (!keep.has(id)) tx.objectStore('files').delete(id);
      tx.objectStore('cloudTransfers').delete(transferId);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('No se pudo guardar la canción'));
    });
  },
  all(name) {
    return readRequest(name, (s) => s.getAll());
  },
  get(name, key) {
    return readRequest(name, (s) => s.get(key));
  },
  async getMany(name, keys) {
    const rows = await Promise.all(keys.map((key) => this.get(name, key)));
    return rows;
  },
  put(name, value) {
    return writeRequest(name, (s) => s.put(value));
  },
  remove(name, key) {
    return writeRequest(name, (s) => s.delete(key));
  },
  async getMeta(key, fallback) {
    const row = await this.get('meta', key);
    return row ? row.value : fallback;
  },
  setMeta(key, value) {
    return this.put('meta', { key, value });
  },
  async usage() {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      return { used: estimate.usage || 0, quota: estimate.quota || 0 };
    }
    return { used: 0, quota: 0 };
  },
  async requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        return await navigator.storage.persist();
      } catch (error) {
        return false;
      }
    }
    return false;
  },
  async isPersistent() {
    if (navigator.storage && navigator.storage.persisted) {
      try {
        return await navigator.storage.persisted();
      } catch (error) {
        return false;
      }
    }
    return false;
  },
};
