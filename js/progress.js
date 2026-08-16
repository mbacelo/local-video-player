/**
 * Watched-interval math. Pure functions -- no DOM, no storage.
 *
 * A video's watch history is an array of merged, sorted [start, end] ranges in
 * seconds. The tracker only ever extends a range by real elapsed playback, so
 * seeking across a region never marks it as seen.
 */

/** Ranges closer together than this are treated as one continuous span. */
export const MERGE_GAP = 0.5;

/** Fraction of a video that must be seen before it counts as fully watched. */
export const COMPLETE_THRESHOLD = 0.9;

/** Ranges shorter than this are noise (a stray timeupdate, a scrub landing). */
const MIN_INTERVAL = 0.25;

/**
 * Sort, clamp and coalesce overlapping or near-adjacent ranges.
 * @param {Array<[number, number]>} intervals
 * @param {number} [duration] optional upper clamp
 * @returns {Array<[number, number]>}
 */
export function mergeIntervals(intervals, duration = Infinity) {
  const cleaned = [];

  for (const item of intervals || []) {
    if (!item) continue;
    let [start, end] = item;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end < start) [start, end] = [end, start];
    start = Math.max(0, start);
    end = Math.min(end, duration);
    if (end - start < MIN_INTERVAL) continue;
    cleaned.push([start, end]);
  }

  if (cleaned.length === 0) return [];
  cleaned.sort((a, b) => a[0] - b[0]);

  const merged = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i += 1) {
    const last = merged[merged.length - 1];
    const next = cleaned[i];
    if (next[0] - last[1] <= MERGE_GAP) {
      last[1] = Math.max(last[1], next[1]);
    } else {
      merged.push(next);
    }
  }
  return merged;
}

/** Total seconds covered by a set of merged ranges. */
export function watchedSeconds(intervals) {
  return (intervals || []).reduce((sum, [start, end]) => sum + (end - start), 0);
}

/** Fraction of the video watched, 0..1. */
export function coverage(intervals, duration) {
  if (!duration || !Number.isFinite(duration)) return 0;
  return Math.min(1, watchedSeconds(intervals) / duration);
}

export function isComplete(intervals, duration) {
  return coverage(intervals, duration) >= COMPLETE_THRESHOLD;
}

/**
 * First point the viewer has not seen yet, or null if nothing is left.
 * Used to decide where "resume" should jump to.
 */
export function firstUnwatched(intervals, duration) {
  const merged = mergeIntervals(intervals, duration);
  if (merged.length === 0) return 0;
  if (merged[0][0] > MERGE_GAP) return 0;

  for (let i = 0; i < merged.length; i += 1) {
    const end = merged[i][1];
    const nextStart = i + 1 < merged.length ? merged[i + 1][0] : duration;
    if (nextStart - end > 1) return end;
  }
  return null;
}

/**
 * Accumulates playback into merged ranges.
 *
 * Feed it `sample(currentTime)` on every timeupdate. A jump larger than
 * `maxStep` (a seek, a stall, a backgrounded tab) breaks the current run
 * instead of painting the skipped span as watched.
 */
export class WatchTracker {
  /**
   * @param {object} opts
   * @param {Array<[number, number]>} [opts.intervals] previously stored ranges
   * @param {number} [opts.duration]
   * @param {number} [opts.maxStep] largest believable gap between samples
   */
  constructor({ intervals = [], duration = Infinity, maxStep = 1 } = {}) {
    this.duration = duration;
    this.maxStep = maxStep;
    this.intervals = mergeIntervals(intervals, duration);
    this.runStart = null;
    this.runEnd = null;
    this.dirty = false;
  }

  setDuration(duration) {
    this.duration = duration;
    this.intervals = mergeIntervals(this.intervals, duration);
  }

  /** Abandon the in-progress run without discarding it (seek, pause, stall). */
  break() {
    this.commit();
    this.runStart = null;
    this.runEnd = null;
  }

  /** Fold the in-progress run into the stored ranges. */
  commit() {
    if (this.runStart !== null && this.runEnd - this.runStart >= MIN_INTERVAL) {
      this.intervals = mergeIntervals(
        [...this.intervals, [this.runStart, this.runEnd]],
        this.duration
      );
      this.dirty = true;
    }
  }

  /**
   * Record that playback reached `time`.
   * @returns {boolean} true if the stored ranges changed
   */
  sample(time) {
    if (!Number.isFinite(time)) return false;

    if (this.runStart === null) {
      this.runStart = time;
      this.runEnd = time;
      return false;
    }

    const delta = time - this.runEnd;

    // Backwards or a jump forward too large to be real playback: start a new run.
    if (delta < 0 || delta > this.maxStep) {
      const before = watchedSeconds(this.intervals);
      this.break();
      this.runStart = time;
      this.runEnd = time;
      return watchedSeconds(this.intervals) !== before;
    }

    this.runEnd = time;
    return false;
  }

  /** Merged ranges including whatever run is currently open. */
  snapshot() {
    if (this.runStart === null || this.runEnd - this.runStart < MIN_INTERVAL) {
      return this.intervals.map((r) => [r[0], r[1]]);
    }
    return mergeIntervals(
      [...this.intervals, [this.runStart, this.runEnd]],
      this.duration
    );
  }

  coverage() {
    return coverage(this.snapshot(), this.duration);
  }

  isComplete() {
    return isComplete(this.snapshot(), this.duration);
  }

  /** Mark everything as seen -- used when the video fires `ended`. */
  markComplete() {
    if (!Number.isFinite(this.duration)) return;
    this.break();
    this.intervals = mergeIntervals(
      [...this.intervals, [0, this.duration]],
      this.duration
    );
    this.dirty = true;
  }
}
