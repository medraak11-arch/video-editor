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
import type { AspectId, AspectPreset } from '../lib/constants';
import {
  ASPECT_EPSILON,
  ASPECT_PRESETS,
  PLAYHEAD_TAIL_FRAMES,
  RESOLUTION_TIERS,
} from '../lib/constants';
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
  /** The frame rate has been decided — adopted from a source or set explicitly. */
  fpsLocked: boolean;
  /** The project shape has been decided — adopted from a source or set explicitly. */
  sizeLocked: boolean;
  /**
   * INVARIANT: always `fpsLocked && sizeLocked`. Never written independently — every
   * write to any of the three goes through `locks()` below (FORMAT §7.2).
   *
   * Retained rather than renamed because `mediaSlice` reads it as its adoption guard,
   * where it now means "at least one half is still open", which is exactly when the
   * call is worth making. Not persisted; `ProjectFile` does not carry it.
   */
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
  /**
   * Always succeeds. Never retimes clips. Clamps clips that no longer fit their source.
   * Locks the RATE only — choosing a shape must not forfeit rate adoption (FORMAT §7.1).
   */
  setProjectFps(fps: number): void;
  /** Locks the SHAPE only, and rounds both dimensions up to even (FORMAT §7.3). */
  setProjectSize(width: number, height: number): void;
  /**
   * Adopts rate and shape INDEPENDENTLY, and only the halves still unlocked. A source
   * rate of 0 means "rate unknown" and adopts the shape only. The RATE half additionally
   * requires an EMPTY timeline, so an import can never re-time an edit that already
   * exists. Raises no Notice and shortens no clip — those stay `setProjectFps`'s, which
   * is the action a user takes deliberately (FORMAT §7.3).
   */
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

/**
 * The bounds a project dimension is clamped to. Exported because the resolution
 * ladder must not generate a size the store would refuse, and because no other file
 * may restate the numbers — `ProjectProperties.tsx`'s field `min`/`max` (16 / 8192)
 * are a separate, narrower input affordance and are left exactly as they ship.
 */
export const SIZE_MIN = 2;
export const SIZE_MAX = 16384;

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
  // NEAREST within tolerance, not the first match. KNOWN_FPS is ascending and the
  // tolerance is wider than the gap inside the two NTSC pairs (23.976/24 differ by
  // 0.024, 29.97/30 by 0.03), so first-match silently snapped a true 30.000 source
  // down to 29.97 and a true 24.000 to 23.976 — and every duration and timecode in
  // the project is re-derived from that rate.
  let best = fps;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const known of KNOWN_FPS) {
    const delta = Math.abs(known - fps);
    // Strict < keeps an exact tie on the lower rate: arbitrary, but stable.
    if (delta <= FPS_SNAP_TOLERANCE && delta < bestDelta) {
      best = known;
      bestDelta = delta;
    }
  }
  return best;
}

/* ------------------------------------------------- project shape (FORMAT §2)
   Pure, exported, no store access — the same shape `snapKnownFps` already has.
   The tables live in src/lib/constants.ts; only the arithmetic is here.       */

export interface ProjectSize {
  width: number;
  height: number;
}

/** Even and at least 2. 4:2:0 and 4:2:2 both require it; odd is an encoder hard failure. */
export function evenUp(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r + 1;
}

/** The resolution of `ratio` at short-edge `tier`. Total for every finite input. */
export function sizeForTier(ratio: number, tier: number): ProjectSize {
  if (!(ratio > 0) || !(tier > 0)) return { width: 1920, height: 1080 };
  return ratio >= 1
    ? { width: evenUp(tier * ratio), height: evenUp(tier) }
    : { width: evenUp(tier), height: evenUp(tier / ratio) };
}

/** Which preset this size IS. Never guesses, never throws. */
export function resolveAspectId(width: number, height: number): AspectId {
  if (!(width > 0) || !(height > 0)) return 'custom';
  const ratio = width / height;
  for (const p of ASPECT_PRESETS) {
    if (Math.abs(ratio - p.ratio) <= ASPECT_EPSILON) return p.id;
  }
  return 'custom';
}

/** The short edge — the tier this size sits on. Deliberately NOT snapped; see FORMAT §3.5. */
export const sizeTier = (width: number, height: number): number => Math.min(width, height);

/** The preset this size IS, as the object. `undefined` means 'custom'. Module-private. */
function presetFor(width: number, height: number): AspectPreset | undefined {
  const id = resolveAspectId(width, height);
  return ASPECT_PRESETS.find((p) => p.id === id);
}

/**
 * '4K UHD · 3840 × 2160', or '1920 × 1084' when there is no name to give.
 *
 * A tier name is attached ONLY when the size IS the canonical size for that tier at
 * that preset's EXACT ratio. Being merely inside ASPECT_EPSILON is not enough:
 * 1920 × 1084 is inside the 16:9 epsilon and is not 1080p, and calling it 1080p is
 * precisely the see-one-thing-ship-another failure this whole area exists to prevent.
 * A near-preset size renders as its pixel pair alone, which is the whole truth about it.
 */
export function resolutionLabel(width: number, height: number): string {
  const pixels = `${width} × ${height}`;
  const preset = presetFor(width, height);
  if (!preset) return pixels;
  const tier = sizeTier(width, height);
  const canon = sizeForTier(preset.ratio, tier);
  if (canon.width !== width || canon.height !== height) return pixels;
  const name = preset.tierNames[tier];
  return name ? `${name} · ${pixels}` : pixels;
}

export interface ResolutionOption {
  /** `${width}x${height}` — the Select value, unchanged from the shipping dialog's encoding. */
  value: string;
  label: string;
  width: number;
  height: number;
}

/**
 * The Select `value` for a project size. ALWAYS even, therefore always present in
 * `resolutionLadder(width, height)`, whose passthrough row is evened for the same reason.
 *
 * This is the ONE normaliser. The inspector's Resolution row, the export dialog's
 * Resolution row and the ladder's own passthrough row all derive their string here, so no
 * <select> in the app can ever hold a value absent from its options — a native select with
 * an unmatched value silently displays its FIRST option, which would make the control
 * report a size the settings do not hold.
 */
export const projectResolutionValue = (width: number, height: number): string =>
  `${evenUp(width)}x${evenUp(height)}`;

/**
 * `tier` expressed at the EXACT shape of `width × height`, or null when that shape
 * cannot reach that tier without changing shape. Custom shapes only.
 *
 * The test is integer, not float: `long * tier` is at most 16384 × 2160 ≈ 3.5e7, exact
 * in a double, and `%` on exact integers is exact. A quotient that is not a whole number
 * misses by at least `1 / short` ≥ 1/16384, four orders of magnitude above double error
 * at this magnitude, so `Number.isInteger` would agree — the modulo is used because it
 * says what is meant rather than because it is safer.
 */
function exactTierSize(width: number, height: number, tier: number): ProjectSize | null {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (!(short > 0) || tier % 2 !== 0) return null;
  const scaled = long * tier;
  if (scaled % short !== 0) return null;
  const other = scaled / short;
  if (other % 2 !== 0) return null; // an odd axis is an libx264 hard failure (FORMAT §2.2)
  return width >= height ? { width: other, height: tier } : { width: tier, height: other };
}

/**
 * The resolution ladder for a shape. EVERY entry carries the aspect of the size passed
 * in, so nothing in this list can change the shape of the output (FORMAT §6.3).
 * Descending by short edge, including the passthrough row.
 *
 * A PRESET shape is generated from the MATCHED PRESET'S EXACT RATIO, never from the live
 * `width / height`. That is the difference between a stable ladder and one that ratchets:
 * `sizeForTier` rounds up to even, so 854 × 480 is a ratio of 1.779167 rather than
 * 1.777778, and generating from the live ratio would make tier 2160 emit 3844 × 2160 —
 * still inside ASPECT_EPSILON, therefore still labelled `4K UHD`, with real 3840 × 2160
 * no longer reachable from that project at all. One ordinary selection would destroy the
 * named ladder, and the export dialog is fed this same list.
 *
 * A CUSTOM shape has no canonical ratio to resolve to, so it emits only the tiers it
 * reaches EXACTLY — `exactTierSize` above — and skips the rest. Rounding a custom tier to
 * even is what made the same ratchet unreachable-by-construction for presets and wide open
 * for custom shapes: a 4096 × 2160 project asked for tier 1440 gets 2730.67 rounded to
 * 2732, whose ratio is 1.897222 rather than 1.896296, so selecting that row moves the
 * ladder to 4098 × 2160 and 2050 × 1080 and 4096 × 2160 is gone from that project for
 * good. FORMAT §2.3 sends every user who needs a non-preset size down exactly that path,
 * so the ratchet had to close there too and not only for presets.
 *
 * Emitting only exact tiers closes it completely, and the proof is one line: every emitted
 * row is `(t · long/short, t)`, whose own ratio is `long/short` — the ratio it was
 * generated from, exactly — and whose own short edge is `t`. Regenerating from any row
 * therefore runs the identical exactness test against the identical ratio and yields the
 * identical set. The ladder is a fixed point.
 *
 * The price is stated rather than hidden: a shape whose ratio reaches no tier exactly —
 * 1920 × 1000, say — gets a one-row ladder, its own size. That is honest. Every row it
 * would otherwise have offered was a DIFFERENT shape by up to two pixels, and a menu row
 * that changes the shape of the output is the failure, not the feature. Such a project
 * changes size through Width and Height, which is where a custom shape's information lives
 * anyway.
 *
 * Tiers exceeding SIZE_MAX on either axis are skipped for a separate reason: the store
 * would clamp them, and offering `2160 × 1105920` in a menu whose premise is that every
 * row is shippable would hand ffmpeg a 2.4-gigapixel frame. The passthrough row is never
 * skipped, so the project's own size is always reachable.
 */
export function resolutionLadder(width: number, height: number): ResolutionOption[] {
  const option = (w: number, h: number): ResolutionOption => ({
    value: `${w}x${h}`,
    label: resolutionLabel(w, h),
    width: w,
    height: h,
  });
  if (!(width > 0) || !(height > 0)) return [option(1920, 1080)];

  const preset = presetFor(width, height);
  const rows: ResolutionOption[] = [];
  const seen = new Set<string>();
  for (const tier of RESOLUTION_TIERS) {
    const size = preset ? sizeForTier(preset.ratio, tier) : exactTierSize(width, height, tier);
    if (size === null) continue;
    if (size.width > SIZE_MAX || size.height > SIZE_MAX) continue;
    const value = `${size.width}x${size.height}`;
    if (seen.has(value)) continue;
    seen.add(value);
    rows.push(option(size.width, size.height));
  }

  // The passthrough row, EVENED — and the membership test uses the evened string too. A
  // saved 1920 × 1081 project must not lead its own export ladder with an odd height that
  // dies in libx264 minutes into a render. The store keeps 1081; the ladder offers 1082;
  // `projectResolutionValue` selects it; the Height field still reads 1081 until the user
  // touches a control.
  const own = projectResolutionValue(width, height);
  if (seen.has(own)) return rows;

  // Inserted in DESCENDING short-edge order, not prepended. The rest of the list is
  // strictly descending and the passthrough row is usually the SMALLEST size in it — a
  // 1000 × 1000 project led its own ladder with 1000 × 1000 sitting above 2160 × 2160, so
  // the row the select opens on read as the largest option while being the smallest. A
  // list that is descending except at the one row the user is looking at teaches the wrong
  // thing about every other row.
  const row = option(evenUp(width), evenUp(height));
  const shortEdge = sizeTier(row.width, row.height);
  const at = rows.findIndex((o) => sizeTier(o.width, o.height) < shortEdge);
  if (at < 0) rows.push(row);
  else rows.splice(at, 0, row);
  return rows;
}

/**
 * Where the aspect control moves the project. The TIER is preserved: the short edge is
 * the pixel budget the user already chose, and swapping shape must never silently
 * change it. 'custom' is not a target and returns the size unchanged (FORMAT §3.5).
 */
export function sizeForAspect(width: number, height: number, next: AspectId): ProjectSize {
  const preset = ASPECT_PRESETS.find((p) => p.id === next);
  if (!preset) return { width, height };
  return sizeForTier(preset.ratio, sizeTier(width, height));
}

/**
 * The ONLY way any of the three lock fields is written, so the invariant
 * `formatLocked === fpsLocked && sizeLocked` cannot rot (FORMAT §7.2).
 */
const locks = (
  fpsLocked: boolean,
  sizeLocked: boolean,
): Pick<PlaybackState, 'fpsLocked' | 'sizeLocked' | 'formatLocked'> => ({
  fpsLocked,
  sizeLocked,
  formatLocked: fpsLocked && sizeLocked,
});

export const createPlaybackSlice: SliceCreator<PlaybackSlice> = (set, get) => ({
  playhead: 0,
  isPlaying: false,
  rate: 1,
  inPoint: null,
  outPoint: null,
  fps: 30,
  width: 1920,
  height: 1080,
  fpsLocked: false,
  sizeLocked: false,
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
      if (!s.fpsLocked) set(locks(true, s.sizeLocked));
      return;
    }

    // Frame numbers are literal: clips keep start / duration / mediaIn. Only the media's
    // durationFrames moves, and clampClipsToSource resolves the resulting over-run.
    // The RATE is locked; the shape is left open, so choosing one does not forfeit the
    // other's adoption (FORMAT §7.1).
    set({ fps: next, ...locks(true, s.sizeLocked) });
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
    // EVEN, not just rounded. 4:2:0 and 4:2:2 require it, the export ladder is even by
    // construction, and an odd project height reaching libx264 is a hard encoder failure
    // the user would meet minutes into a render with no idea why. Typing 1081 into the
    // Height field gives 1082, visibly, at commit.
    const w = evenUp(clamp(width, SIZE_MIN, SIZE_MAX));
    const h = evenUp(clamp(height, SIZE_MIN, SIZE_MAX));
    const s = get();
    // The two effects are SEPARATE. Choosing the Aspect a fresh project already has is a
    // no-op on the document but still a decision about the shape, so it locks and stops.
    // Falling through would light the unsaved-changes dot and arm the close guard for an
    // operation that changed nothing — PLAN §3.1's rule that nothing may make the project
    // look more unsaved than it was applies to a no-op too. Mirrors setProjectFps above.
    if (w === s.width && h === s.height) {
      if (!s.sizeLocked) set(locks(s.fpsLocked, true));
      return;
    }
    // No clip is touched, no history transaction is opened, no notice is raised: a clip at
    // default properties is already correct in every shape, because both engines fit by
    // containment at render time, and the preview well changes shape in the same frame
    // (FORMAT §3.6).
    set({ width: w, height: h, ...locks(s.fpsLocked, true) });
    get().markDirty();
  },

  adoptSourceFormat: (m) => {
    const s = get();
    // Each half independently, and only the halves still open. `m.fps <= 0` means "rate
    // unknown", not "rate zero": a caller that cannot measure a frame rate passes 0 and
    // adopts only the size. An audio-only item adopts neither half and locks neither.
    //
    // `Object.keys(s.clips).length === 0` is not a nicety — it is the whole of FORMAT
    // §7.3's edit-safety guarantee. Splitting the locks removed the structural reason an
    // import could never re-time an existing edit: set 9:16, import audio (nothing locks —
    // mediaSlice's guard requires kind 'video'), lay several minutes of it out at the
    // default 30 fps, then import 24 fps video. Without this gate the rate adopts, every
    // durationFrames shrinks by 20%, and clampClipsToSource truncates those audio clips —
    // an import silently rewriting an edit, with project format outside TimelineDoc so
    // Ctrl+Z reverts neither. No notice is good enough for that, so it is made unreachable
    // rather than reported. An import may decide the rate of a project that has no edit in
    // it, and may never change the rate of one that does; the Frame rate field still does,
    // deliberately and with a notice. Size adoption stays ungated because it mutates
    // nothing (§3.6).
    const takeFps = !s.fpsLocked && m.fps > 0 && Object.keys(s.clips).length === 0;
    const takeSize = !s.sizeLocked && m.width > 0 && m.height > 0;
    if (!takeFps && !takeSize) return;

    const fps = takeFps ? snapKnownFps(clamp(m.fps, FPS_MIN, FPS_MAX)) : s.fps;
    set({
      ...(takeFps ? { fps } : null),
      ...(takeSize
        ? {
            width: evenUp(clamp(m.width, SIZE_MIN, SIZE_MAX)),
            height: evenUp(clamp(m.height, SIZE_MIN, SIZE_MAX)),
          }
        : null),
      ...locks(s.fpsLocked || takeFps, s.sizeLocked || takeSize),
    });

    // Duration recompute is a consequence of the RATE only; skip it when only size moved.
    // No clampClipsToSource, no notice, no re-seek: `takeFps` requires an empty timeline,
    // so there is no clip to shorten and no clip tail that could move under the playhead.
    // `setProjectFps` still owns all three, because an explicit rate change is exactly the
    // case where clips DO exist.
    if (takeFps) get().recomputeMediaDurations(fps);
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
      // Opening a project decides both halves. A saved project's format is explicit by
      // definition and must never be re-adopted by a re-probe on open.
      ...locks(true, true),
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
