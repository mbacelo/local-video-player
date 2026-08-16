/**
 * IndexedDB layer.
 *
 * Stores FileSystemFileHandle / FileSystemDirectoryHandle objects directly --
 * they are structured-cloneable, which is the entire reason this app must run on
 * a secure origin (HTTPS or localhost) rather than as a file:// page.
 * Video bytes are never copied into the database; only handles and small metadata.
 */

const DB_NAME = 'video-viewer';
const DB_VERSION = 1;

const STORE_VIDEOS = 'videos';
const STORE_FOLDERS = 'folders';
const STORE_SETTINGS = 'settings';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
        const videos = db.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
        videos.createIndex('addedAt', 'addedAt');
        videos.createIndex('folderId', 'folderId');
        videos.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
        db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
      void event;
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });

  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const req = fn(transaction.objectStore(store));
        transaction.oncomplete = () => resolve(req ? req.result : undefined);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

/**
 * Ask Chrome not to evict our database. Without this the library (handles,
 * posters, watch history) can be cleared under storage pressure.
 */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ videos */

/**
 * Identity for a file on disk. Deliberately does not include the path: two
 * copies of the same file collapse to one library entry, which is what a viewer
 * wants. Renaming a file produces a new id (and the old entry goes `missing`).
 */
export function videoId(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export function getVideo(id) {
  return tx(STORE_VIDEOS, 'readonly', (s) => s.get(id));
}

export function getAllVideos() {
  return tx(STORE_VIDEOS, 'readonly', (s) => s.getAll());
}

export function putVideo(video) {
  return tx(STORE_VIDEOS, 'readwrite', (s) => s.put(video));
}

export function deleteVideo(id) {
  return tx(STORE_VIDEOS, 'readwrite', (s) => s.delete(id));
}

/**
 * Read-modify-write a single video record. Used for watch progress so that a
 * debounced save never clobbers fields written elsewhere in the meantime.
 */
export async function updateVideo(id, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_VIDEOS, 'readwrite');
    const store = transaction.objectStore(STORE_VIDEOS);
    const getReq = store.get(id);
    let updated = null;

    getReq.onsuccess = () => {
      const current = getReq.result;
      if (!current) return; // entry removed while playing; drop the write
      updated = { ...current, ...patch };
      store.put(updated);
    };

    transaction.oncomplete = () => resolve(updated);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function clearVideos() {
  return tx(STORE_VIDEOS, 'readwrite', (s) => s.clear());
}

/* ----------------------------------------------------------------- folders */

export function getAllFolders() {
  return tx(STORE_FOLDERS, 'readonly', (s) => s.getAll());
}

export function putFolder(folder) {
  return tx(STORE_FOLDERS, 'readwrite', (s) => s.put(folder));
}

export function deleteFolder(id) {
  return tx(STORE_FOLDERS, 'readwrite', (s) => s.delete(id));
}

export function clearFolders() {
  return tx(STORE_FOLDERS, 'readwrite', (s) => s.clear());
}

/* ---------------------------------------------------------------- settings */

export async function getSetting(key, fallback = null) {
  const row = await tx(STORE_SETTINGS, 'readonly', (s) => s.get(key));
  return row === undefined ? fallback : row.value;
}

export function setSetting(key, value) {
  return tx(STORE_SETTINGS, 'readwrite', (s) => s.put({ key, value }));
}

export async function getSettings(defaults) {
  const rows = await tx(STORE_SETTINGS, 'readonly', (s) => s.getAll());
  const out = { ...defaults };
  for (const row of rows) {
    if (row.key in out) out[row.key] = row.value;
  }
  return out;
}
