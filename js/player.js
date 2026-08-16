/**
 * The video player: custom controls, YouTube-style keyboard shortcuts, and
 * watched-segment tracking.
 */

import * as db from './db.js';
import { WatchTracker, firstUnwatched } from './progress.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const CONTROLS_IDLE_MS = 3000;
const SAVE_INTERVAL_MS = 5000;
const SEEK_STEP = 5;
const SEEK_STEP_LARGE = 30;

const $ = (sel) => document.querySelector(sel);

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export class Player {
  constructor(callbacks = {}) {
    this.cb = callbacks;

    this.root = $('#player-view');
    this.stage = $('#video-stage');
    this.video = $('#video');
    this.previewVideo = $('#preview-video');
    this.previewCanvas = $('#preview-canvas');
    this.previewBox = $('#preview');
    this.previewTime = $('#preview-time');
    this.controls = $('#controls');
    this.scrub = $('#scrub');
    this.barSeen = $('#bar-seen');
    this.barBuffered = $('#bar-buffered');
    this.barPlayed = $('#bar-played');
    this.barHover = $('#bar-hover');
    this.thumb = $('#scrub-thumb');
    this.flash = $('#center-flash');
    this.titleEl = $('#video-title');

    this.record = null;
    this.objectUrl = null;
    this.tracker = null;
    this.idleTimer = null;
    this.saveTimer = null;
    this.scrubbing = false;
    this.wasPlayingBeforeScrub = false;
    this.previewToken = 0;
    this.settings = {
      volume: 1,
      muted: false,
      playbackRate: 1,
    };

    this.#bindVideo();
    this.#bindControls();
    this.#bindScrub();
    this.#bindKeyboard();
    this.#bindIdle();
    this.#bindLifecycle();
  }

  async init() {
    this.settings = await db.getSettings(this.settings);
    this.video.volume = this.settings.volume;
    this.video.muted = this.settings.muted;
    this.#renderVolume();
  }

  get isOpen() {
    return Boolean(this.record);
  }

  /* --------------------------------------------------------------- loading */

  /**
   * @param {object} record library entry from IndexedDB
   * @param {File} file live file resolved from its handle
   */
  async load(record, file) {
    await this.save({ immediate: true });
    this.#releaseUrl();

    this.record = record;
    this.objectUrl = URL.createObjectURL(file);

    this.tracker = new WatchTracker({
      intervals: record.watchedIntervals || [],
      duration: record.duration || Infinity,
    });

    this.titleEl.textContent = record.name;
    document.title = `${record.name} — Local Video Player`;

    this.video.src = this.objectUrl;
    this.previewVideo.src = this.objectUrl;
    this.video.playbackRate = this.settings.playbackRate;
    this.video.preservesPitch = true;

    this.root.hidden = false;
    document.body.classList.add('playing-video');
    this.#renderSeen();
    this.#showControls();

    try {
      await this.video.play();
    } catch {
      // Autoplay can be refused; the user can press play.
    }
  }

  async close() {
    await this.save({ immediate: true });
    this.video.pause();
    this.#releaseUrl();
    this.record = null;
    this.tracker = null;
    this.root.hidden = true;
    document.body.classList.remove('playing-video');
    document.title = 'Local Video Player';
  }

  #releaseUrl() {
    if (!this.objectUrl) return;
    this.video.removeAttribute('src');
    this.video.load();
    this.previewVideo.removeAttribute('src');
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  /* -------------------------------------------------------------- tracking */

  /** Persist watch state. Debounced unless `immediate`. */
  async save({ immediate = false } = {}) {
    if (!this.record || !this.tracker) return;

    if (!immediate) {
      if (this.saveTimer) return;
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.save({ immediate: true });
      }, SAVE_INTERVAL_MS);
      return;
    }

    clearTimeout(this.saveTimer);
    this.saveTimer = null;

    const duration = Number.isFinite(this.video.duration) ? this.video.duration : this.record.duration;
    const intervals = this.tracker.snapshot();
    const patch = {
      watchedIntervals: intervals,
      lastPosition: this.video.currentTime || 0,
      completed: this.tracker.isComplete(),
      duration: duration || 0,
    };

    const updated = await db.updateVideo(this.record.id, patch);
    if (updated) {
      this.record = updated;
      this.cb.onProgress?.(updated);
    }
  }

  /* ---------------------------------------------------------------- events */

  #bindVideo() {
    const v = this.video;

    v.addEventListener('loadedmetadata', () => {
      const duration = v.duration;
      this.tracker?.setDuration(Number.isFinite(duration) ? duration : Infinity);
      this.#renderTime();
      this.#renderSeen();

      // Resume where the viewer left off, unless they finished it -- then the
      // sensible default is the first thing they haven't seen.
      const resume = this.record?.completed
        ? firstUnwatched(this.record.watchedIntervals, duration) ?? 0
        : this.record?.lastPosition || 0;
      if (resume > 1 && resume < duration - 2) v.currentTime = resume;
    });

    v.addEventListener('timeupdate', () => {
      if (this.tracker?.sample(v.currentTime)) this.#renderSeen();
      this.#renderTime();
      this.#renderProgress();
      if (!v.paused) this.save();
    });

    v.addEventListener('progress', () => this.#renderBuffered());
    v.addEventListener('seeking', () => this.tracker?.break());
    v.addEventListener('waiting', () => this.tracker?.break());

    v.addEventListener('play', () => {
      this.root.classList.add('is-playing');
      this.#showControls();
    });

    v.addEventListener('pause', () => {
      this.root.classList.remove('is-playing');
      this.tracker?.break();
      this.#renderSeen();
      this.save({ immediate: true });
      this.#showControls({ sticky: true });
    });

    v.addEventListener('ended', () => {
      this.tracker?.markComplete();
      this.#renderSeen();
      this.save({ immediate: true });
      this.cb.onEnded?.(this.record);
    });

    v.addEventListener('volumechange', () => {
      this.settings.volume = v.volume;
      this.settings.muted = v.muted;
      db.setSetting('volume', v.volume);
      db.setSetting('muted', v.muted);
      this.#renderVolume();
    });

    v.addEventListener('ratechange', () => this.#renderSpeed());

    v.addEventListener('error', () => {
      this.cb.onError?.(this.record, v.error);
    });

    // Click to toggle, double-click to fullscreen.
    let clickTimer = null;
    this.stage.addEventListener('click', (e) => {
      if (e.target !== this.video && e.target !== this.stage) return;
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        this.togglePlay();
      }, 220);
    });
    this.stage.addEventListener('dblclick', (e) => {
      if (e.target !== this.video && e.target !== this.stage) return;
      clearTimeout(clickTimer);
      clickTimer = null;
      this.toggleFullscreen();
    });
  }

  #bindControls() {
    $('#btn-play').addEventListener('click', () => this.togglePlay());
    $('#btn-back').addEventListener('click', () => this.cb.onClose?.());
    $('#btn-mute').addEventListener('click', () => this.toggleMute());
    $('#btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    $('#btn-shortcuts').addEventListener('click', () => this.cb.onShowShortcuts?.());
    $('#btn-next').addEventListener('click', () => this.cb.onNext?.());
    $('#btn-prev').addEventListener('click', () => this.cb.onPrev?.());

    $('#volume').addEventListener('input', (e) => {
      const value = Number(e.target.value);
      this.video.muted = value === 0;
      this.video.volume = value;
    });

    const speedMenu = $('#speed-menu');
    $('#btn-speed').addEventListener('click', (e) => {
      e.stopPropagation();
      speedMenu.hidden = !speedMenu.hidden;
    });
    speedMenu.addEventListener('click', (e) => {
      const rate = e.target.dataset?.rate;
      if (!rate) return;
      this.setSpeed(Number(rate));
      speedMenu.hidden = true;
    });

    document.addEventListener('click', () => {
      speedMenu.hidden = true;
    });

    document.addEventListener('fullscreenchange', () => {
      this.root.classList.toggle('is-fullscreen', Boolean(document.fullscreenElement));
    });
  }

  /* ----------------------------------------------------------- scrubbing */

  #bindScrub() {
    const timeAt = (clientX) => {
      const rect = this.scrub.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * (this.video.duration || 0);
    };

    this.scrub.addEventListener('pointerdown', (e) => {
      if (!this.video.duration) return;
      this.scrubbing = true;
      this.wasPlayingBeforeScrub = !this.video.paused;
      this.video.pause();
      this.scrub.setPointerCapture(e.pointerId);
      this.video.currentTime = timeAt(e.clientX);
      this.#renderProgress();
    });

    this.scrub.addEventListener('pointermove', (e) => {
      if (!this.video.duration) return;
      const time = timeAt(e.clientX);
      if (this.scrubbing) {
        this.video.currentTime = time;
        this.#renderProgress();
      }
      this.#renderHover(time, e.clientX);
    });

    this.scrub.addEventListener('pointerup', (e) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      this.scrub.releasePointerCapture(e.pointerId);
      this.tracker?.break();
      if (this.wasPlayingBeforeScrub) this.video.play().catch(() => {});
      this.save({ immediate: true });
    });

    this.scrub.addEventListener('pointerleave', () => {
      this.previewBox.hidden = true;
      this.barHover.style.width = '0%';
    });
  }

  /** Draw the hovered frame into the preview box, throttled by a token. */
  async #renderHover(time, clientX) {
    const duration = this.video.duration;
    if (!duration) return;

    this.barHover.style.width = `${(time / duration) * 100}%`;
    this.previewTime.textContent = formatTime(time);
    this.previewBox.hidden = false;

    const scrubRect = this.scrub.getBoundingClientRect();
    const half = this.previewBox.offsetWidth / 2;
    const left = Math.min(
      Math.max(clientX - scrubRect.left, half),
      scrubRect.width - half
    );
    this.previewBox.style.left = `${left}px`;

    const token = ++this.previewToken;
    if (!this.previewVideo.src || this.previewVideo.readyState < 1) return;

    await new Promise((resolve) => {
      const onSeeked = () => {
        this.previewVideo.removeEventListener('seeked', onSeeked);
        resolve();
      };
      this.previewVideo.addEventListener('seeked', onSeeked);
      this.previewVideo.currentTime = time;
    });

    if (token !== this.previewToken) return; // a newer hover superseded this one

    const canvas = this.previewCanvas;
    const vw = this.previewVideo.videoWidth;
    const vh = this.previewVideo.videoHeight;
    if (!vw || !vh) return;
    canvas.height = Math.round((canvas.width * vh) / vw);
    canvas.getContext('2d').drawImage(this.previewVideo, 0, 0, canvas.width, canvas.height);
  }

  /* --------------------------------------------------------------- render */

  #renderTime() {
    $('#time-current').textContent = formatTime(this.video.currentTime);
    $('#time-duration').textContent = formatTime(this.video.duration);
  }

  #renderProgress() {
    const duration = this.video.duration;
    const ratio = duration ? (this.video.currentTime / duration) * 100 : 0;
    this.barPlayed.style.width = `${ratio}%`;
    this.thumb.style.left = `${ratio}%`;
  }

  #renderBuffered() {
    const duration = this.video.duration;
    const buffered = this.video.buffered;
    if (!duration || !buffered.length) {
      this.barBuffered.style.width = '0%';
      return;
    }
    const time = this.video.currentTime;
    for (let i = 0; i < buffered.length; i += 1) {
      if (buffered.start(i) <= time && time <= buffered.end(i)) {
        this.barBuffered.style.width = `${(buffered.end(i) / duration) * 100}%`;
        return;
      }
    }
  }

  /** Paint the already-seen segments underneath the played bar. */
  #renderSeen() {
    const duration = this.video.duration || this.record?.duration;
    if (!duration || !this.tracker) {
      this.barSeen.replaceChildren();
      return;
    }
    const segments = this.tracker.snapshot().map(([start, end]) => {
      const el = document.createElement('span');
      el.className = 'seen-segment';
      el.style.left = `${(start / duration) * 100}%`;
      el.style.width = `${((end - start) / duration) * 100}%`;
      return el;
    });
    this.barSeen.replaceChildren(...segments);
  }

  #renderVolume() {
    const value = this.video.muted ? 0 : this.video.volume;
    $('#volume').value = value;
    const btn = $('#btn-mute');
    btn.dataset.state = value === 0 ? 'muted' : value < 0.5 ? 'low' : 'high';
    btn.title = value === 0 ? 'Unmute (m)' : 'Mute (m)';
  }

  #renderSpeed() {
    const rate = this.video.playbackRate;
    $('#btn-speed').textContent = `${rate}×`;
    for (const el of $('#speed-menu').querySelectorAll('[data-rate]')) {
      el.classList.toggle('active', Number(el.dataset.rate) === rate);
    }
  }

  /* --------------------------------------------------------------- actions */

  togglePlay() {
    if (this.video.paused) {
      this.video.play().catch(() => {});
      this.#flashIcon('play');
    } else {
      this.video.pause();
      this.#flashIcon('pause');
    }
  }

  seekBy(delta) {
    const duration = this.video.duration;
    if (!duration) return;
    this.tracker?.break();
    this.video.currentTime = Math.min(duration, Math.max(0, this.video.currentTime + delta));
    this.#flashIcon(delta > 0 ? 'forward' : 'backward', `${Math.abs(delta)}s`);
  }

  adjustVolume(delta) {
    const next = Math.min(1, Math.max(0, this.video.volume + delta));
    this.video.volume = next;
    if (next > 0) this.video.muted = false;
    this.cb.onToast?.(`Volume ${Math.round(next * 100)}%`);
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
  }

  setSpeed(rate) {
    this.video.playbackRate = rate;
    this.settings.playbackRate = rate;
    db.setSetting('playbackRate', rate);
    this.cb.onToast?.(`Speed ${rate}×`);
  }

  stepSpeed(direction) {
    const current = SPEEDS.indexOf(this.video.playbackRate);
    const base = current === -1 ? SPEEDS.indexOf(1) : current;
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, base + direction))];
    this.setSpeed(next);
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.root.requestFullscreen();
    } catch {
      // Denied or unsupported; nothing useful to do.
    }
  }

  #flashIcon(kind, label = '') {
    this.flash.dataset.kind = kind;
    this.flash.querySelector('.flash-label').textContent = label;
    this.flash.classList.remove('animate');
    void this.flash.offsetWidth; // restart the animation
    this.flash.classList.add('animate');
  }

  /* -------------------------------------------------------------- chrome */

  #bindIdle() {
    const show = () => this.#showControls();
    this.root.addEventListener('mousemove', show);
    this.root.addEventListener('pointerdown', show);
    this.controls.addEventListener('mouseenter', () => this.#showControls({ sticky: true }));
    this.controls.addEventListener('mouseleave', () => this.#showControls());
  }

  #showControls({ sticky = false } = {}) {
    this.root.classList.remove('controls-hidden');
    clearTimeout(this.idleTimer);
    if (sticky || this.video.paused) return;
    this.idleTimer = setTimeout(() => {
      if (!this.video.paused && !this.scrubbing) {
        this.root.classList.add('controls-hidden');
        $('#speed-menu').hidden = true;
      }
    }, CONTROLS_IDLE_MS);
  }

  #bindLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.tracker?.break();
        this.save({ immediate: true });
      }
    });
    // pagehide is the reliable last chance to flush on Chrome.
    window.addEventListener('pagehide', () => {
      this.tracker?.break();
      this.save({ immediate: true });
    });
  }

  /* ------------------------------------------------------------ shortcuts */

  #bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const target = e.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (typing) return;

      // `?` opens the shortcut list from anywhere, including the library.
      if (e.key === '?') {
        e.preventDefault();
        this.cb.onShowShortcuts?.();
        return;
      }

      if (this.cb.isModalOpen?.()) return;
      if (!this.isOpen) return;

      const handled = this.#handleKey(e);
      if (handled) {
        e.preventDefault();
        this.#showControls();
      }
    });
  }

  #handleKey(e) {
    const key = e.key;

    if (key === ' ') return this.togglePlay(), true;
    // Shift turns the arrow keys into a coarse jump, for skipping intros and
    // the like without leaving the keyboard.
    const step = e.shiftKey ? SEEK_STEP_LARGE : SEEK_STEP;
    if (key === 'ArrowLeft') return this.seekBy(-step), true;
    if (key === 'ArrowRight') return this.seekBy(step), true;
    if (key === 'ArrowUp') return this.adjustVolume(0.05), true;
    if (key === 'ArrowDown') return this.adjustVolume(-0.05), true;
    if (key === 'm' || key === 'M') return this.toggleMute(), true;
    if (key === 'f' || key === 'F') return this.toggleFullscreen(), true;
    // Speed stepping keys off `e.code` as well as `e.key`: on non-US layouts
    // Shift+, / Shift+. do not produce `<` / `>`.
    if (e.shiftKey) {
      if (key === '<' || e.code === 'Comma') return this.stepSpeed(-1), true;
      if (key === '>' || e.code === 'Period') return this.stepSpeed(1), true;
    }

    if (key === 'Escape') {
      if (document.fullscreenElement) return false; // browser exits fullscreen itself
      this.cb.onClose?.();
      return true;
    }

    return false;
  }
}

export const SHORTCUTS = [
  {
    group: 'Playback',
    items: [
      { keys: ['Space'], label: 'Play / pause' },
      { keys: ['←'], label: 'Back 5 seconds' },
      { keys: ['→'], label: 'Forward 5 seconds' },
      { keys: ['Shift', '←'], label: 'Back 30 seconds' },
      { keys: ['Shift', '→'], label: 'Forward 30 seconds' },
      { keys: ['Shift', ','], label: 'Decrease playback speed' },
      { keys: ['Shift', '.'], label: 'Increase playback speed' },
    ],
  },
  {
    group: 'Audio',
    items: [
      { keys: ['M'], label: 'Mute / unmute' },
      { keys: ['↑'], label: 'Volume up 5%' },
      { keys: ['↓'], label: 'Volume down 5%' },
    ],
  },
  {
    group: 'View',
    items: [
      { keys: ['F'], label: 'Fullscreen' },
      { keys: ['Esc'], label: 'Exit fullscreen, or back to library' },
      { keys: ['?'], label: 'Show this list' },
    ],
  },
];
