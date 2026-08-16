/**
 * Library management: adding videos and folders, permission handling,
 * thumbnail generation, and rescanning remembered folders.
 */

import * as db from './db.js';

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts',
]);

/** Containers a browser realistically cannot decode, flagged in the UI up front. */
const LIKELY_UNSUPPORTED = new Set(['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts']);

const MAX_SCAN_DEPTH = 6;
const POSTER_WIDTH = 320;

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(extensionOf(name));
}

/**
 * Best-effort guess at whether this browser can decode the file, used to warn
 * before the user clicks rather than showing a silent black frame afterwards.
 */
export function playabilityOf(name, type) {
  const ext = extensionOf(name);
  if (LIKELY_UNSUPPORTED.has(ext)) return 'unsupported';

  const probe = document.createElement('video');
  const mime = type || guessMime(ext);
  if (!mime) return 'unknown';
  const verdict = probe.canPlayType(mime);
  if (verdict === 'probably') return 'supported';
  if (verdict === 'maybe') return 'unknown';
  return 'unsupported';
}

function guessMime(ext) {
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'ogv':
    case 'ogg':
      return 'video/ogg';
    case 'mov':
      return 'video/quicktime';
    default:
      return '';
  }
}

/* ------------------------------------------------------------- permissions */

/**
 * Ensure we may read through a handle. Must be called from within a user
 * gesture the first time in a session, or requestPermission() rejects.
 */
export async function ensurePermission(handle, { prompt = true } = {}) {
  if (!handle?.queryPermission) return false;
  const opts = { mode: 'read' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!prompt) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}

/** Resolve a stored record to a live File, prompting for access if needed. */
export async function fileFor(video, { prompt = true } = {}) {
  if (!video.handle) return null;
  if (!(await ensurePermission(video.handle, { prompt }))) return null;
  try {
    return await video.handle.getFile();
  } catch {
    // File was moved, renamed or deleted since it was added.
    await db.updateVideo(video.id, { missing: true });
    return null;
  }
}

/* -------------------------------------------------------------- thumbnails */

/**
 * Decode one frame into a small JPEG and read the intrinsic dimensions.
 * Runs off-document so it never disturbs the visible player.
 */
export function extractPoster(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    // Some files decode metadata but never deliver a frame; don't hang the queue.
    const timer = setTimeout(() => finish(null), 15000);

    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = Math.min(3, duration * 0.1) || 0;
    };

    video.onseeked = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) {
        finish(null);
        return;
      }

      const canvas = document.createElement('canvas');
      const scale = Math.min(1, POSTER_WIDTH / width);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

      const meta = {
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width,
        height,
      };
      canvas.toBlob(
        (blob) => finish({ ...meta, poster: blob }),
        'image/jpeg',
        0.8
      );
    };

    video.onerror = () => finish(null);
    video.src = url;
  });
}

/* ------------------------------------------------------------------ adding */

/**
 * Add one file to the library. Existing entries keep their watch history and
 * simply get a refreshed handle.
 * @returns {Promise<object|null>} the stored record
 */
export async function addFile(handle, file, { folderId = null } = {}) {
  const id = db.videoId(file);
  const existing = await db.getVideo(id);

  if (existing) {
    const patch = { handle, missing: false };
    if (folderId && !existing.folderId) patch.folderId = folderId;
    return db.updateVideo(id, patch);
  }

  const record = {
    id,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
    handle,
    folderId,
    addedAt: Date.now(),
    duration: 0,
    width: 0,
    height: 0,
    poster: null,
    playability: playabilityOf(file.name, file.type),
    watchedIntervals: [],
    lastPosition: 0,
    completed: false,
    missing: false,
  };

  await db.putVideo(record);
  return record;
}

/** Generate and store a poster for a record that lacks one. */
export async function ensurePoster(video) {
  if (video.poster || video.missing) return video;
  const file = await fileFor(video, { prompt: false });
  if (!file) return video;

  const meta = await extractPoster(file);
  if (!meta) {
    return db.updateVideo(video.id, { playability: 'unsupported' });
  }
  return db.updateVideo(video.id, {
    poster: meta.poster,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    playability: 'supported',
  });
}

/**
 * Walk a directory handle collecting video files.
 * @returns {Promise<Array<{handle: FileSystemFileHandle, file: File}>>}
 */
export async function scanFolder(dirHandle, { depth = 0, onProgress } = {}) {
  const found = [];
  if (depth > MAX_SCAN_DEPTH) return found;

  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      if (!isVideoFile(entry.name)) continue;
      try {
        const file = await entry.getFile();
        found.push({ handle: entry, file });
        onProgress?.(found.length, entry.name);
      } catch {
        // Unreadable entry (locked, or a broken link) -- skip it.
      }
    } else if (entry.kind === 'directory') {
      const nested = await scanFolder(entry, { depth: depth + 1, onProgress });
      found.push(...nested);
    }
  }
  return found;
}

/** Add a folder and every video beneath it. */
export async function addFolder(dirHandle, { onProgress } = {}) {
  if (!(await ensurePermission(dirHandle))) return { folderId: null, added: [] };

  const folderId = `folder:${dirHandle.name}:${Date.now()}`;
  await db.putFolder({
    id: folderId,
    name: dirHandle.name,
    handle: dirHandle,
    addedAt: Date.now(),
  });

  const entries = await scanFolder(dirHandle, { onProgress });
  const added = [];
  for (const { handle, file } of entries) {
    added.push(await addFile(handle, file, { folderId }));
  }
  return { folderId, added };
}

/**
 * Re-walk remembered folders to pick up newly added files. Only touches folders
 * whose permission is already granted, so this never triggers a prompt.
 */
export async function rescanFolders({ onProgress } = {}) {
  const folders = await db.getAllFolders();
  const added = [];

  for (const folder of folders) {
    if (!(await ensurePermission(folder.handle, { prompt: false }))) continue;
    let entries;
    try {
      entries = await scanFolder(folder.handle, { onProgress });
    } catch {
      continue;
    }
    for (const { handle, file } of entries) {
      const id = db.videoId(file);
      if (await db.getVideo(id)) continue;
      added.push(await addFile(handle, file, { folderId: folder.id }));
    }
  }
  return added;
}

/* -------------------------------------------------------- drops and pickers */

/**
 * Turn a drop event into file handles. Uses getAsFileSystemHandle() rather than
 * dataTransfer.files, because only a handle can be persisted for later reloads.
 */
export async function handlesFromDrop(dataTransfer) {
  const files = [];
  const directories = [];

  const items = Array.from(dataTransfer.items || []).filter((i) => i.kind === 'file');
  const handles = await Promise.all(
    items.map((item) =>
      item.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : null
    )
  );

  for (const handle of handles) {
    if (!handle) continue;
    if (handle.kind === 'directory') directories.push(handle);
    else if (isVideoFile(handle.name)) files.push(handle);
  }

  return { files, directories };
}

export async function pickFiles() {
  if (!window.showOpenFilePicker) return [];
  try {
    return await window.showOpenFilePicker({
      multiple: true,
      types: [
        {
          description: 'Video files',
          accept: { 'video/*': Array.from(VIDEO_EXTENSIONS, (e) => `.${e}`) },
        },
      ],
    });
  } catch {
    return []; // user cancelled
  }
}

export async function pickFolder() {
  if (!window.showDirectoryPicker) return null;
  try {
    return await window.showDirectoryPicker({ mode: 'read' });
  } catch {
    return null; // user cancelled
  }
}

/* ---------------------------------------------------------------- removal */

export async function removeVideo(id) {
  const video = await db.getVideo(id);
  await db.deleteVideo(id);
  return video;
}

/** Wipe the library. Only touches this database -- never any file on disk. */
export async function clearLibrary() {
  await db.clearVideos();
  await db.clearFolders();
}
