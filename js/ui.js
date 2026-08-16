/**
 * Library UI, modals, toasts, drag-and-drop, and the wiring that connects
 * the library to the player. This module is the application entry point.
 */

import * as db from './db.js';
import * as lib from './library.js';
import { Player, formatTime, SHORTCUTS } from './player.js';
import { coverage } from './progress.js';
import { initPwa } from './pwa.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  videos: [],
  search: '',
  sort: 'recent',
  posterUrls: new Map(),
  modalOpen: false,
  currentId: null,
};

let player;

/* ------------------------------------------------------------------ toasts */

const MAX_TOASTS = 3;

export function toast(message, { actionLabel, onAction, duration = 4000 } = {}) {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = 'toast';

  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);

  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      onAction();
      el.remove();
    });
    el.append(btn);
  }

  container.append(el);

  // Each toast owns its timer, so a burst of them doesn't leave the earlier
  // ones on screen forever.
  setTimeout(() => el.remove(), duration);
  while (container.childElementCount > MAX_TOASTS) container.firstElementChild.remove();
}

/* ------------------------------------------------------------------ modals */

function openModal(el) {
  state.modalOpen = true;
  $('#modal-backdrop').hidden = false;
  el.hidden = false;
}

function closeModals() {
  state.modalOpen = false;
  $('#modal-backdrop').hidden = true;
  $('#confirm-modal').hidden = true;
  $('#shortcuts-modal').hidden = true;
}

/** Promise-based confirmation dialog. Resolves true when confirmed. */
function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body;
    const ok = $('#confirm-ok');
    ok.textContent = confirmLabel;
    ok.classList.toggle('danger', danger);

    const done = (result) => {
      ok.removeEventListener('click', onOk);
      $('#confirm-cancel').removeEventListener('click', onCancel);
      closeModals();
      resolve(result);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);

    ok.addEventListener('click', onOk);
    $('#confirm-cancel').addEventListener('click', onCancel);
    openModal($('#confirm-modal'));
    ok.focus();
  });
}

function showShortcuts() {
  const body = $('#shortcuts-body');
  if (!body.childElementCount) {
    for (const section of SHORTCUTS) {
      const group = document.createElement('section');
      group.className = 'shortcut-group';

      const heading = document.createElement('h3');
      heading.textContent = section.group;
      group.append(heading);

      for (const item of section.items) {
        const row = document.createElement('div');
        row.className = 'shortcut-row';

        const keys = document.createElement('div');
        keys.className = 'shortcut-keys';
        for (const key of item.keys) {
          const kbd = document.createElement('kbd');
          kbd.textContent = key;
          keys.append(kbd);
        }

        const label = document.createElement('div');
        label.className = 'shortcut-label';
        label.textContent = item.label;

        row.append(keys, label);
        group.append(row);
      }
      body.append(group);
    }
  }
  openModal($('#shortcuts-modal'));
}

/* ----------------------------------------------------------------- library */

function visibleVideos() {
  const term = state.search.trim().toLowerCase();
  let list = state.videos.filter((v) => !term || v.name.toLowerCase().includes(term));

  const sorters = {
    recent: (a, b) => b.addedAt - a.addedAt,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    duration: (a, b) => (b.duration || 0) - (a.duration || 0),
  };
  list.sort(sorters[state.sort] || sorters.recent);
  return list;
}

function posterUrl(video) {
  if (!video.poster) return null;
  if (state.posterUrls.has(video.id)) return state.posterUrls.get(video.id);
  const url = URL.createObjectURL(video.poster);
  state.posterUrls.set(video.id, url);
  return url;
}

function releasePosterUrls(keepIds) {
  for (const [id, url] of state.posterUrls) {
    if (!keepIds.has(id)) {
      URL.revokeObjectURL(url);
      state.posterUrls.delete(id);
    }
  }
}

function buildCard(video) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = video.id;
  card.tabIndex = 0;
  if (video.missing) card.classList.add('is-missing');

  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';

  const url = posterUrl(video);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    thumb.append(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'card-placeholder';
    placeholder.textContent = '▶';
    thumb.append(placeholder);
  }

  if (video.duration) {
    const badge = document.createElement('span');
    badge.className = 'card-duration';
    badge.textContent = formatTime(video.duration);
    thumb.append(badge);
  }

  if (video.completed) {
    const watched = document.createElement('span');
    watched.className = 'card-watched';
    watched.textContent = 'Watched';
    thumb.append(watched);
  }

  if (video.playability === 'unsupported') {
    const warn = document.createElement('span');
    warn.className = 'card-warning';
    warn.textContent = 'May not play';
    warn.title = 'This container or codec usually cannot be decoded by the browser';
    thumb.append(warn);
  }

  const seen = coverage(video.watchedIntervals, video.duration);
  if (seen > 0) {
    const bar = document.createElement('div');
    bar.className = 'card-progress';
    const fill = document.createElement('div');
    fill.className = 'card-progress-fill';
    fill.style.width = `${Math.min(100, seen * 100)}%`;
    bar.append(fill);
    thumb.append(bar);
  }

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = video.name;
  title.title = video.name;

  const meta = document.createElement('p');
  meta.className = 'card-meta';
  const parts = [];
  if (video.width) parts.push(`${video.width}×${video.height}`);
  parts.push(formatBytes(video.size));
  if (video.missing) parts.push('file moved or deleted');
  else if (seen > 0 && !video.completed) parts.push(`${Math.round(seen * 100)}% watched`);
  meta.textContent = parts.join(' · ');

  const remove = document.createElement('button');
  remove.className = 'card-remove';
  remove.title = 'Remove from library';
  remove.setAttribute('aria-label', `Remove ${video.name} from library`);
  remove.textContent = '×';
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    onRemove(video);
  });

  card.append(thumb, title, meta, remove);
  card.addEventListener('click', () => onPlay(video.id));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPlay(video.id);
    }
  });
  return card;
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function renderLibrary() {
  const list = visibleVideos();
  const grid = $('#library-grid');

  releasePosterUrls(new Set(list.map((v) => v.id)));
  grid.replaceChildren(...list.map(buildCard));

  $('#empty-state').hidden = state.videos.length > 0;
  $('#no-results').hidden = state.videos.length === 0 || list.length > 0;

  const watched = state.videos.filter((v) => v.completed).length;
  $('#stat-line').textContent = state.videos.length
    ? `${state.videos.length} video${state.videos.length === 1 ? '' : 's'} · ${watched} watched`
    : '';
  $('#btn-clear').disabled = state.videos.length === 0;
}

async function reload() {
  state.videos = await db.getAllVideos();
  renderLibrary();
}

/* ----------------------------------------------------------------- actions */

async function onPlay(id) {
  const video = state.videos.find((v) => v.id === id);
  if (!video) return;

  const file = await lib.fileFor(video);
  if (!file) {
    await reload();
    toast(
      video.missing
        ? `"${video.name}" is no longer at its original location. Add it again to keep watching.`
        : `Access to "${video.name}" was not granted.`
    );
    return;
  }

  state.currentId = id;
  $('#library-view').hidden = true;
  await player.load(video, file);

  // A poster may still be missing if permission was refused when it was added.
  if (!video.poster) {
    lib.ensurePoster(video).then(reload);
  }
}

async function onRemove(video) {
  await lib.removeVideo(video.id);
  await reload();
  toast(`Removed "${video.name}"`, {
    actionLabel: 'Undo',
    onAction: async () => {
      await db.putVideo(video);
      await reload();
    },
  });
}

async function onClearLibrary() {
  const confirmed = await confirmDialog({
    title: 'Clear the whole library?',
    body:
      `This removes all ${state.videos.length} entries and their watch history from this browser. ` +
      'Your video files on disk are not touched or deleted.',
    confirmLabel: 'Clear library',
    danger: true,
  });
  if (!confirmed) return;

  await lib.clearLibrary();
  await reload();
  toast('Library cleared. No files were deleted from disk.');
}

function neighbour(offset) {
  const list = visibleVideos();
  const index = list.findIndex((v) => v.id === state.currentId);
  if (index === -1) return null;
  return list[(index + offset + list.length) % list.length] || null;
}

async function playNeighbour(offset) {
  const next = neighbour(offset);
  if (next) await onPlay(next.id);
}

async function closePlayer() {
  await player.close();
  $('#library-view').hidden = false;
  await reload();
}

/* --------------------------------------------------------- adding videos */

/**
 * Add handles to the library, then generate posters in the background.
 * A single dropped video starts playing immediately, per the app's core UX.
 */
async function addHandles(fileHandles, directoryHandles) {
  let added = [];
  let firstRecord = null;

  for (const handle of fileHandles) {
    try {
      const file = await handle.getFile();
      const record = await lib.addFile(handle, file);
      added.push(record);
      firstRecord ??= record;
    } catch {
      toast(`Could not read "${handle.name}"`);
    }
  }

  for (const dirHandle of directoryHandles) {
    toast(`Scanning "${dirHandle.name}"…`, { duration: 2000 });
    const result = await lib.addFolder(dirHandle, {
      onProgress: (count) => {
        $('#stat-line').textContent = `Scanning… ${count} video${count === 1 ? '' : 's'} found`;
      },
    });
    added.push(...result.added);
  }

  await reload();

  if (added.length === 0) {
    toast('No playable video files were found.');
    return;
  }

  const singleFile = fileHandles.length === 1 && directoryHandles.length === 0 && firstRecord;
  if (singleFile) {
    await onPlay(firstRecord.id);
  } else {
    toast(`Added ${added.length} video${added.length === 1 ? '' : 's'}`);
  }

  generatePosters(added);
}

/** Sequential so a large folder import doesn't spawn dozens of decoders. */
async function generatePosters(records) {
  let changed = false;
  for (const record of records) {
    if (!record || record.poster) continue;
    const updated = await lib.ensurePoster(record);
    if (updated?.poster) changed = true;
  }
  if (changed) await reload();
}

/* ------------------------------------------------------------ drag & drop */

function bindDragAndDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;

  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth += 1;
    overlay.hidden = false;
  });

  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });

  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;

    const { files, directories } = await lib.handlesFromDrop(e.dataTransfer);
    if (files.length === 0 && directories.length === 0) {
      toast('Drop video files or a folder of videos.');
      return;
    }
    await addHandles(files, directories);
  });
}

/* -------------------------------------------------------------- bootstrap */

function bindToolbar() {
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderLibrary();
  });

  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    db.setSetting('sort', state.sort);
    renderLibrary();
  });

  const onPickFiles = async () => {
    const handles = await lib.pickFiles();
    if (handles.length) await addHandles(handles, []);
  };

  const onPickFolder = async () => {
    const handle = await lib.pickFolder();
    if (handle) await addHandles([], [handle]);
  };

  $('#btn-add-files').addEventListener('click', onPickFiles);
  $('#btn-add-folder').addEventListener('click', onPickFolder);
  $('#btn-empty-files').addEventListener('click', onPickFiles);
  $('#btn-empty-folder').addEventListener('click', onPickFolder);

  $('#btn-clear').addEventListener('click', onClearLibrary);
  $('#btn-help').addEventListener('click', showShortcuts);
  $('#shortcuts-close').addEventListener('click', closeModals);
  $('#modal-backdrop').addEventListener('click', closeModals);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modalOpen) {
      e.preventDefault();
      closeModals();
    }
  });
}

function checkSupport() {
  const problems = [];
  if (!window.indexedDB) problems.push('IndexedDB is unavailable');
  if (!window.showOpenFilePicker) {
    problems.push(
      'the File System Access API is unavailable — the library cannot be remembered between reloads'
    );
  }
  if (location.protocol === 'file:') {
    problems.push(
      'this page was opened directly from disk, which browsers treat as an insecure origin. ' +
        'Open it over HTTPS, or from a local server, so the library can persist (see README.md)'
    );
  }
  if (problems.length) {
    const banner = $('#support-banner');
    banner.textContent = `Heads up: ${problems.join('; ')}.`;
    banner.hidden = false;
  }
}

async function main() {
  checkSupport();
  await db.requestPersistentStorage();

  initPwa({
    installButton: $('#btn-install'),
    onToast: (message, options) => toast(message, options),
  });

  player = new Player({
    onClose: closePlayer,
    onNext: () => playNeighbour(1),
    onPrev: () => playNeighbour(-1),
    onEnded: () => {},
    onShowShortcuts: showShortcuts,
    onToast: (message) => toast(message, { duration: 1500 }),
    onProgress: (updated) => {
      const index = state.videos.findIndex((v) => v.id === updated.id);
      if (index !== -1) state.videos[index] = updated;
    },
    onError: (record) => {
      toast(
        `"${record?.name ?? 'This video'}" could not be decoded by the browser. ` +
          'MKV, AVI and HEVC files usually need conversion to MP4 (H.264) or WebM.',
        { duration: 8000 }
      );
    },
    isModalOpen: () => state.modalOpen,
  });
  await player.init();

  state.sort = await db.getSetting('sort', 'recent');
  $('#sort').value = state.sort;

  bindToolbar();
  bindDragAndDrop();
  await reload();

  // Debug handle -- inspect state or drive the player from DevTools.
  window.localVideoViewer = { state, player, db, lib, reload, toast };

  // Pick up files added to remembered folders since the last visit. Silent:
  // it only touches folders whose permission is still granted.
  const found = await lib.rescanFolders();
  if (found.length) {
    await reload();
    toast(`Found ${found.length} new video${found.length === 1 ? '' : 's'} in your folders`);
    generatePosters(found);
  }
}

main();
