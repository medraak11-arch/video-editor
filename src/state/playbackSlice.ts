/* ---------------------------------------------------------------------------
   playbackSlice.ts — OWNER: preview.

   THE PLAYHEAD LIVES IN THE STORE (PLAN §1.3). There is no shadow channel, no
   ref-based playhead, no commit-on-pause. The preview owns advancement (the one
   rAF clock in `components/preview/usePlaybackClock.ts`); every other slice
   writes it through seek().

   Units are whole frames at the PROJECT fps, everywhere. Seconds exist only at
   the <video> edge and are converted in src/lib/time.ts.
--------------------------------------------------------------------------- */

import type { Frames, MediaItem, ProjectFile } from '../types/model';
import type { SliceCreator, StoreState } from './types';
import { framesToTimecode } from '../lib/time';
import { PLAYHEAD_TAIL_FRAMES } from '../lib/constants';
import { selectTimelineDurationFrames } from './timelineSlice';

export interface PlaybackState {
  /** THE playhead. Single source of truth for the whole app. Integer frames. */
  playhead: Frames;
  isPlaying: boolean;
  /** Playback rate. 1 = normal. Negative = reverse shuttle. Never 0 (use pause). */
  rate: number;
  inPoint: Frames | null;
  outPoint: Frames | null;
  /** Project format. Adopted from the first ready media item, then locked. */
  fps: number;
  width: number;
  height: number;
  formatLocked: boolean;
  /** 0..1 */
  volume: number;
  muted: boolean;
}

export interface PlaybackActions {
  play(): void;
  pause(): void;
  togglePlay(): void;
  /** Rounds to an integer frame, then clamps — see the clamp rule in PLAN §3.3. */
  seek(frame: Frames): void;
  /**
   * Relative seek. ALWAYS rounds: `seek(Math.round(playhead + delta))`.
   *
   * CONTRACT, not an implementation note: stepping while playing calls `pause()` first,
   * which also resets `rate` to 1. A step is a request to look at one specific frame, and
   * leaving the clock running would move the playhead off it before it could be read;
   * every NLE stops on step for that reason. Callers may rely on `isPlaying === false`
   * and `rate === 1` after any `step()`. PLAN §3.3 does not yet state this — reported as
   * a required amendment.
   */
  step(delta: Frames): void;
  /** J/K/L. dir -1 reverse, 0 stop, +1 forward; repeats escalate through SHUTTLE_RATES. */
  shuttle(dir: -1 | 0 | 1): void;
  setRate(rate: number): void;
  /** Default: current playhead. */
  setInPoint(frame?: Frames): void;
  setOutPoint(frame?: Frames): void;
  clearInOut(): void;
  /** Always succeeds. Never retimes clips. Clamps clips that no longer fit their source. */
  setProjectFps(fps: number): void;
  setProjectSize(width: number, height: number): void;
  /** One-shot auto-adopt from the first ready item. No-op when formatLocked. */
  adoptSourceFormat(m: Pick<MediaItem, 'fps' | 'width' | 'height'>): void;
  setVolume(v: number): void;
  /**
   * PLAN §3.3 names this action `toggleMute()`. That name is UNUSABLE here: PLAN §3.4
   * declares `toggleMute(id: TrackId)` on TimelineActions, both slices merge into one
   * StoreState, and `(id: TrackId) => void` is not assignable to `() => void` — so
   * `store.ts` fails to compile with both declared, and at runtime the timeline's
   * implementation would win anyway (it is spread last), silently muting a track when
   * the transport asked to mute the preview.
   *
   * Resolution taken here: playback exposes `setMuted(next)` — an explicit setter, which
   * is the better shape for a toggle button anyway — and drops the colliding name so the
   * track-head toggle keeps `toggleMute(id)`.
   *
   * REQUIRED INTEGRATION CHANGE (scaffold owns both ends; this slice cannot land either):
   * pick ONE and make the documents agree —
   *   (a) amend PLAN §3.3 to declare `setMuted(next: boolean): void` on PlaybackActions
   *       and delete `toggleMute()` from it (nothing calls the old name today), or
   *   (b) rename PLAN §3.4's `toggleMute(id: TrackId)` to `toggleTrackMute(id: TrackId)`,
   *       after which this can go back to `toggleMute()`.
   * (a) is the smaller change. Until one lands, PLAN §3.3 and this file disagree.
   */
  setMuted(next: boolean): void;
  hydratePlayback(p: Pick<ProjectFile, 'fps' | 'width' | 'height'>): void;
}

export type PlaybackSlice = PlaybackState & PlaybackActions;

export const SHUTTLE_RATES = [1, 2, 4, 8] as const;

/** The known frame rates adoptSourceFormat snaps an odd source rate onto. */
export const KNOWN_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;

/** Tolerance for that snap, per PLAN §3.3. */
const FPS_SNAP_TOLERANCE = 0.05;

const FPS_MIN = 1;
const FPS_MAX = 240;
const SIZE_MIN = 2;
const SIZE_MAX = 16384;
const RATE_MAX = SHUTTLE_RATES[SHUTTLE_RATES.length - 1];
const RATE_MIN_MAGNITUDE = 0.1;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Next magnitude up the shuttle ladder; saturates at the top. */
const escalate = (magnitude: number): number => {
  for (const r of SHUTTLE_RATES) if (r > magnitude + 1e-9) return r;
  return RATE_MAX;
};

/** Snaps an odd source rate onto a known rate. Exported so media can report honestly. */
export function snapKnownFps(fps: number): number {
  for (const known of KNOWN_FPS) {
    if (Math.abs(known - fps) <= FPS_SNAP_TOLERANCE) return known;
  }
  return fps;
}

export const createPlaybackSlice: SliceCreator<PlaybackSlice> = (set, get) => ({
  playhead: 0,
  isPlaying: false,
  rate: 1,
  inPoint: null,
  outPoint: null,
  fps: 30,
  width: 1920,
  height: 1080,
  formatLocked: false,
  volume: 1,
  muted: false,

  /* ------------------------------------------------------------- transport */

  play: () => {
    const s = get();
    const stop = selectPlaybackStopFrame(s);
    if (stop <= 0) return; // nothing on the timeline: play would stop on its first frame

    // Parked on (or past) the stop frame: restart from the in point, or from the head.
    const restart = s.playhead >= stop - 1;
    const from = s.inPoint !== null && s.inPoint < stop ? s.inPoint : 0;

    set({
      isPlaying: true,
      rate: 1, // the play control is always normal-speed forward; shuttle sets its own rate
      ...(restart ? { playhead: from } : null),
    });
  },

  pause: () => {
    const s = get();
    if (!s.isPlaying && s.rate === 1) return;
    set({ isPlaying: false, rate: 1 }); // K resets the shuttle ladder
  },

  togglePlay: () => {
    if (get().isPlaying) get().pause();
    else get().play();
  },

  seek: (frame) => {
    // The most-called action in the app and the only writer of its most important field.
    // Without this, a NaN in (a half-parsed timecode, a division by a zero speed) commits
    // `playhead: NaN`, which then poisons framesToTimecode, selectVideoClipIdAtFrame and
    // every other consumer with no recovery short of a reload.
    if (!Number.isFinite(frame)) return;
    const s = get();
    const max = selectTimelineDurationFrames(s) + PLAYHEAD_TAIL_FRAMES;
    const next = Math.min(Math.max(0, Math.round(frame)), max);
    if (next !== s.playhead) set({ playhead: next });
  },

  step: (delta) => {
    const d = Math.round(delta);
    if (d === 0) return;
    const s = get();
    if (s.isPlaying) get().pause();
    get().seek(Math.round(s.playhead + d));
  },

  shuttle: (dir) => {
    if (dir === 0) {
      get().pause();
      return;
    }
    const s = get();
    const current = s.isPlaying ? s.rate : 0;
    const sameDirection = current !== 0 && Math.sign(current) === dir;
    const magnitude = sameDirection ? escalate(Math.abs(current)) : 1;

    // Forward from a playhead already parked on the stop frame: the clock's next tick
    // would reach the stop and pause immediately, so L would look dead. Restart from the
    // in point exactly as play() does — PLAN §8.4, 'J must not silently no-op'.
    if (dir === 1) {
      const stop = selectPlaybackStopFrame(s);
      if (stop <= 0) return; // nothing on the timeline to shuttle through
      if (s.playhead >= stop - 1) {
        const from = s.inPoint !== null && s.inPoint < stop ? s.inPoint : 0;
        set({ isPlaying: true, rate: magnitude, playhead: from });
        return;
      }
    }

    set({ isPlaying: true, rate: magnitude * dir });
  },

  setRate: (rate) => {
    if (!Number.isFinite(rate) || rate === 0) return; // 0 is pause, not a rate
    const magnitude = clamp(Math.abs(rate), RATE_MIN_MAGNITUDE, RATE_MAX);
    set({ rate: magnitude * Math.sign(rate) });
  },

  /* ----------------------------------------------------------- in and out */

  setInPoint: (frame) => {
    const s = get();
    const next = Math.max(0, Math.round(frame ?? s.playhead));
    // An in point after the out point would describe an empty range; drop the stale mark
    // rather than silently moving the one the user just placed.
    set({
      inPoint: next,
      ...(s.outPoint !== null && s.outPoint < next ? { outPoint: null } : null),
    });
  },

  setOutPoint: (frame) => {
    const s = get();
    const next = Math.max(0, Math.round(frame ?? s.playhead));
    set({
      outPoint: next,
      ...(s.inPoint !== null && s.inPoint > next ? { inPoint: null } : null),
    });
  },

  clearInOut: () => set({ inPoint: null, outPoint: null }),

  /* -------------------------------------------------------- project format */

  setProjectFps: (fps) => {
    if (!Number.isFinite(fps) || fps <= 0) return;
    const next = clamp(fps, FPS_MIN, FPS_MAX);
    const s = get();
    if (next === s.fps) {
      if (!s.formatLocked) set({ formatLocked: true });
      return;
    }

    // Frame numbers are literal: clips keep start / duration / mediaIn. Only the media's
    // durationFrames moves, and clampClipsToSource resolves the resulting over-run.
    set({ fps: next, formatLocked: true });
    get().recomputeMediaDurations(next);
    const trimmed = get().clampClipsToSource();
    get().seek(get().playhead); // the tail clamp may have moved under the playhead
    get().markDirty();

    if (trimmed > 0) {
      get().setNotice({
        tone: 'warning',
        title: 'Frame rate changed',
        message:
          trimmed === 1
            ? '1 clip was shortened to fit its source'
            : `${trimmed} clips were shortened to fit their source`,
      });
    }
  },

  setProjectSize: (width, height) => {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const w = Math.round(clamp(width, SIZE_MIN, SIZE_MAX));
    const h = Math.round(clamp(height, SIZE_MIN, SIZE_MAX));
    const s = get();
    if (w === s.width && h === s.height && s.formatLocked) return;
    set({ width: w, height: h, formatLocked: true });
    get().markDirty();
  },

  adoptSourceFormat: (m) => {
    if (get().formatLocked) return;
    // An audio-only first import carries fps 0 and no dimensions. Adopting that would
    // set the project to 0 fps, so it is not an adoption and must not lock the format.
    if (!(m.fps > 0 && m.width > 0 && m.height > 0)) return;

    const fps = snapKnownFps(clamp(m.fps, FPS_MIN, FPS_MAX));
    set({
      fps,
      width: Math.round(clamp(m.width, SIZE_MIN, SIZE_MAX)),
      height: Math.round(clamp(m.height, SIZE_MIN, SIZE_MAX)),
      formatLocked: true,
    });
    get().recomputeMediaDurations(fps);
    get().clampClipsToSource();
    get().markDirty();
  },

  /* ---------------------------------------------------------------- output */

  setVolume: (v) => {
    if (!Number.isFinite(v)) return;
    const next = clamp(v, 0, 1);
    if (next !== get().volume) set({ volume: next });
  },

  setMuted: (next) => {
    if (next !== get().muted) set({ muted: next });
  },

  /* --------------------------------------------------------------- hydrate */

  hydratePlayback: (p) =>
    set({
      fps: p.fps,
      width: p.width,
      height: p.height,
      playhead: 0,
      isPlaying: false,
      rate: 1,
      inPoint: null,
      outPoint: null,
      formatLocked: true,
    }),
});

/* --------------------------------------------------------------- selectors */

/** [stable] */
export const selectTimecode = (s: StoreState): string => framesToTimecode(s.playhead, s.fps);

/**
 * [stable] Where playback stops. Because it reads the CURRENT playhead, playback that
 * begins past outPoint naturally ignores in/out and runs to the end. Nothing loops.
 */
export const selectPlaybackStopFrame = (s: StoreState): Frames =>
  s.outPoint !== null && s.playhead <= s.outPoint
    ? s.outPoint + 1
    : selectTimelineDurationFrames(s);
