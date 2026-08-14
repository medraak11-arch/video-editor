/* ---------------------------------------------------------------------------
   audioMonitor.ts — the pure half of preview audio monitoring.
   docs/AUDIO-MONITOR.md §8.1.

   Every tuning constant this feature has, plus the pure functions the three
   monitoring modules and VideoSurface share. No React, no store import, no DOM
   query: everything here is a function of its arguments, which is what lets
   `derivePool` run during render and lets the gain law be asserted against a
   table of numbers rather than against a running app.

   The pool lives here rather than in VideoSurface because ONE pool
   implementation now serves both surfaces (§2.2.1): keying slots on the URL
   alone is not sufficient for a cut, and two copies of the corrected rule is
   how they stop agreeing.
--------------------------------------------------------------------------- */

import type { Clip, ClipId, MediaItem, Track, TrackId } from '../../types/model';
import { clipEnd, clipHasAudio } from '../../types/model';

/* ------------------------------------------------------------- §9 constants */

/**
 * Unity is 0.5, not 1.0 (§5.2). `HTMLMediaElement.volume` is 0..1 and
 * `ClipProperties.volume` is 0..2, and the export honours the whole range as a
 * real linear gain. Clamping at 1.0 would make a clip boosted to 2.0 monitor
 * identically to one at 1.0 and then ship 6 dB louder — the exact class of
 * failure this whole document exists to prevent. Mapping model unity onto 0.5
 * fits the model's full range inside the element's with no clamping anywhere in
 * the reachable domain, and buys headroom for the sum on top (export sums with
 * `normalize=0`, so overlapping clips get LOUDER).
 *
 * The cost, recorded as divergence 1: monitoring is 6.02 dB below the file.
 */
export const MONITOR_REFERENCE_GAIN = 0.5;

/** The model's ceiling for `ClipProperties.volume` (`src/types/model.ts` §2.4). */
export const CLIP_VOLUME_MAX = 2;

/**
 * §5.2's assertion, stated in code so it cannot rot in a comment. If the clip
 * volume ceiling is ever raised, or the master ever gains boost above unity,
 * either the reference drops or clamping begins — and this is the one line that
 * should have to change.
 */
if (MONITOR_REFERENCE_GAIN * CLIP_VOLUME_MAX > 1) {
  console.warn(
    'audioMonitor: MONITOR_REFERENCE_GAIN * CLIP_VOLUME_MAX > 1 — clip volume now clamps in the ' +
      'monitor and no longer matches the export. See docs/AUDIO-MONITOR.md §5.2.',
  );
}

/**
 * The floor under the drift dead band. The band itself is `Math.max(this, 750 / fps)`
 * — 0.75 of a frame — because §3.1's fallback reference is a staircase quantised to
 * ±0.5 frame and a band narrower than its own sampling noise drives the controller
 * from nothing but that noise. This floor keeps it above `currentTime` reporting
 * noise at high frame rates.
 */
export const DRIFT_DEAD_BAND_FLOOR_MS = 12;

/** ±2 %, about ±35 cents. A semitone is 5.9 %; this is inaudible on anything but a pure tone. */
export const DRIFT_TRIM_MAX = 0.02;

/** A time constant, not a completion time: below 20 ms of error the decay is exponential. */
export const DRIFT_TRIM_WINDOW_MS = 1000;

/** Above this the element is not drifting, it is somewhere else. Move it. */
export const DRIFT_HARD_SEEK_MS = 120;

/** Corrections act on the MEDIAN of the samples collected since the last one. */
export const DRIFT_CHECK_INTERVAL_MS = 250;

/** A source needing continuous hard seeks is broken, not drifting. Do not hammer it. */
export const HARD_SEEK_MIN_INTERVAL_MS = 500;

/** `play()` resolves asynchronously; correcting inside this window hard-seeks a healthy element. */
export const START_SETTLE_MS = 300;

/** `seeked` is not guaranteed. Without this backstop a faded voice stays silent all session. */
export const FADE_RESTORE_BACKSTOP_MS = 200;

/**
 * How far the playhead may move in one tick beyond what elapsed wall time explains.
 * DELIBERATELY NOT `ELEMENT_LAG_TOLERANCE_FRAMES` (§3.4): that one is how far an
 * element may lag and still be believed. Giving both the value 2 is what let an
 * ordinary reference branch-flip read as an external seek and fire the full
 * reposition path at every cut.
 */
export const EXTERNAL_SEEK_SLACK_FRAMES = 4;

/** Paused repositioning is prefetch, not playback. Unthrottled it is 60 seeks a second per voice. */
export const IDLE_REPOSITION_INTERVAL_MS = 120;

/** Video-track voices only (§2.2.2). Audio-track voices are `preload="auto"` throughout. */
export const PRELOAD_LEAD_IN_MS = 2000;

/** 4x still carries words. 8x is a chirp with no editorial information. */
export const SHUTTLE_AUDIBLE_MAX_RATE = 4;

/**
 * Chromium refuses a playbackRate outside this range. Declared here and imported by
 * VideoSurface (§4.4): two copies of a range that must agree is how they stop agreeing.
 */
export const PLAYBACK_RATE_MIN = 0.0625;
export const PLAYBACK_RATE_MAX = 16;

/**
 * A decoder-exhaustion guard, not a policy. Today's real ceiling is `trackOrder.length`
 * — clips on a track cannot overlap, so at most one clip per track sits under the
 * playhead — which makes this unreachable at six tracks. It is written down so that if
 * it ever fires it is legible rather than mysterious, and it announces itself (§7.3).
 */
export const MAX_AUDIBLE_SOURCES = 8;

/** Mirrors VideoSurface: how often one source may fail transiently before a verdict. */
export const TRANSIENT_RELOAD_ATTEMPTS = 2;

/** Hard seeks inside this window mean the element is not tracking, not drifting. */
export const NON_TRACKING_SEEKS = 3;
export const NON_TRACKING_WINDOW_MS = 3000;

/** `readyState < 2` for this long while playing is a stall, not a hiccup. */
export const STALL_MUTE_MS = 1000;

/** Continuous time inside the dead band that clears a non-tracking verdict (§7.4). */
export const NON_TRACKING_RECOVER_MS = 1000;

/** Longest drift ring we keep between corrections. 250 ms at 60 fps is ~15 samples. */
const DRIFT_RING_MAX = 32;

/* ------------------------------------------------------------- small helpers */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * The dead band, derived from `fps` rather than fixed (§3.2). A fixed 12 ms is wrong at
 * every frame rate this app supports except 60: the fallback reference is a staircase
 * quantised to ±0.5 frame, so 0.75 of a frame is always strictly wider than the
 * quantisation that produced the measurement.
 */
export const deadBandMs = (fps: number): number =>
  Math.max(DRIFT_DEAD_BAND_FLOOR_MS, fps > 0 ? 750 / fps : DRIFT_DEAD_BAND_FLOOR_MS);

/**
 * §4.2, expressed ONCE so it applies to the `<video>` element as well as to every voice
 * without a second code path. Reverse is silent because Chromium has no negative
 * playbackRate; 8x is silent because a chirp carries nothing.
 */
export const transportSilent = (rate: number): boolean =>
  rate <= 0 || Math.abs(rate) > SHUTTLE_AUDIBLE_MAX_RATE;

/** Median, not mean: one sample taken across a decode hiccup is an outlier of tens of ms. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* --------------------------------------------------------------- §1.1 audible */

/**
 * `contributesAudio` from EXPORT.md §1.4, plus the two conditions that exist only
 * because monitoring happens in a browser engine rather than in ffmpeg (divergence 9).
 *
 * `track.kind`, `track.visible`, `track.locked` and `clip.properties.opacity` are all
 * deliberately absent, exactly as they are absent from the export predicate. Hiding V2
 * to see what is underneath it must not silence the dialogue on V2 — see §1.2, and do
 * not "fix" this.
 */
export const monitorAudible = (clip: Clip, track: Track, media: MediaItem): boolean =>
  // Added first, because it is the cheapest and the most decisive. It goes into the
  // EXPORT predicate in the same change and with the same meaning (AUDIO-FEATURES
  // §1.7.2 / §1.7.3), so the mirror this comment block describes is preserved rather
  // than broken. Without it a detached pair is audible TWICE: once from the <video>
  // element carrying the picture half, once from the twin's own voice.
  clipHasAudio(clip) &&
  media.status === 'ready' &&
  media.url !== '' &&
  media.hasAudio &&
  !track.muted &&
  clip.properties.volume > 0;

/* ------------------------------------------------------------------ §5.1 gain */

/**
 * THE gain law. One expression, applied identically to every `<audio>` voice and to the
 * active `<video>` element — which is a real defect being fixed, not new scope: a video
 * clip set to `volume: 0` currently monitors at full level while exporting silent.
 *
 * Master volume and master mute have no counterpart in the export graph (divergence 8).
 * They are safe there for one specific reason: they multiply EVERY voice by the same
 * scalar, so they move absolute level and cannot move relative balance.
 *
 * The clamp is a guard, not a behaviour — see the assertion at the top of this file.
 * And note what is NOT here: nothing divides by the number of active sources. That is
 * the exact bug `normalize=0` exists to prevent, and reintroducing it on the monitoring
 * side would make the preview quieter as the mix got busier.
 */
/**
 * CREATIVE §1.2's middle term, applied ONCE so all three consumers spell it the
 * same way — the two preview consumers here, and `graph.ts`'s `volume=` in the
 * export. Effective gain is the PRODUCT of the clip term and the track term,
 * because that is what a mixer does and it is what makes a track fader compose
 * with a clip the user already trimmed by ear; the minimum, or a sum in dB,
 * would both make the fader change the clip's setting rather than ride it.
 *
 * Deliberately OUTSIDE `effectiveGain`: that function is the gain LAW and is
 * asserted against a table of scalars, and a `Track`-shaped argument would make
 * that assertion untestable — the same reason VideoSurface computes its clip
 * term before calling it rather than passing a clip in.
 *
 * NOTE the headroom this spends. `MONITOR_REFERENCE_GAIN` maps model unity onto
 * 0.5 so the clip range 0..2 fits the element's 0..1 with no clamping; with a
 * track fader on top the product reaches 4, and the law's clamp then bites above
 * a product of 2. That ceiling is only reachable with BOTH faders past unity,
 * where the export is clipping anyway, and lowering the reference to buy it back
 * would cost every ordinary edit another 6 dB of monitoring level.
 */
export const mixVolume = (clipVolume: number, trackGain: number): number =>
  clipVolume * trackGain;

export function effectiveGain(
  clipVolume: number,
  trackMuted: boolean,
  masterVolume: number,
  masterMuted: boolean,
  silent: boolean,
): number {
  if (trackMuted || masterMuted || silent) return 0;
  if (!Number.isFinite(clipVolume) || !Number.isFinite(masterVolume)) return 0;
  return Math.min(1, Math.max(0, MONITOR_REFERENCE_GAIN * masterVolume * clipVolume));
}

/* ------------------------------------------------------- §3 source mapping */

/**
 * The source-mapping invariant (PLAN §2.4 invariant 3), INVERTED: where on the timeline
 * this element's clock is currently sitting, in seconds. PROJECT fps, always — never
 * `MediaItem.fps`.
 */
export function elementTimelineSeconds(clip: Clip, elementTime: number, fps: number): number {
  const speed = clip.properties.speed || 1;
  return clip.start / fps + (elementTime - clip.mediaIn / fps) / speed;
}

/** The source-mapping invariant, forwards: where this element's clock SHOULD be. */
export function sourceSecondsForTimeline(clip: Clip, timelineSeconds: number, fps: number): number {
  const speed = clip.properties.speed || 1;
  return clip.mediaIn / fps + (timelineSeconds - clip.start / fps) * speed;
}

/** POSITIVE means the element is BEHIND the reference. */
export function driftSeconds(
  referenceSeconds: number,
  clip: Clip,
  elementTime: number,
  fps: number,
): number {
  return referenceSeconds - elementTimelineSeconds(clip, elementTime, fps);
}

/* ------------------------------------------------------------- §2.2.1 the pool */

export type SlotIndex = 0 | 1;

export interface Slot {
  url: string;
  clipId: ClipId | null;
}

export interface Pool {
  slots: [Slot, Slot];
  active: SlotIndex;
}

export const EMPTY_SLOT: Slot = { url: '', clipId: null };
export const EMPTY_POOL: Pool = { slots: [EMPTY_SLOT, EMPTY_SLOT], active: 0 };

export const otherSlot = (i: SlotIndex): SlotIndex => (i === 0 ? 1 : 0);

const sameSlot = (a: Slot, b: Slot): boolean => a.clipId === b.clipId && a.url === b.url;

/**
 * True when B continues A through the same source at the same rate. Exactly what
 * `timelineSlice.split` makes, and nothing else.
 *
 * The general form is required, not the `start - mediaIn` shorthand: at `speed !== 1`
 * the offset between timeline and source is not constant, and `split` computes the new
 * `mediaIn` as `clip.mediaIn + Math.round(leftDuration * speed)`. This is that identity,
 * read back.
 */
export function sourceContiguous(a: Clip | null | undefined, b: Clip | null | undefined): boolean {
  if (!a || !b || a.mediaId !== b.mediaId) return false;
  const speed = a.properties.speed || 1;
  if (speed !== (b.properties.speed || 1)) return false;
  if (b.start !== clipEnd(a)) return false;
  return b.mediaIn === a.mediaIn + Math.round((b.start - a.start) * speed);
}

/**
 * The pool assignment for a given (current, next) pair, derived from the previous
 * assignment. Pure and idempotent, which is what lets it run during render.
 *
 * It MUST run during render. Committing the swap from an effect leaves one committed
 * render in which the clip is the new one but the pool is still the old one — a black
 * frame for picture and a dropout for sound, at every cut.
 *
 * KEYED ON THE CLIP, NOT ON THE URL, and that is a correction rather than a copy
 * (§2.2.1). Two clips cut from the same source file on the same track — a split take, a
 * re-ordered interview, a J-cut assembled from one recording — have identical URLs, so a
 * url-keyed pool never swaps and leaves one element playing clip A's material while the
 * timeline is inside clip B. Picture survives that today only because a `clipId`-keyed
 * effect issues a forced `currentTime` write; for audio that is a click at every
 * same-source cut, which is the thing the pool exists to avoid.
 *
 * `contiguous` is a caller-supplied hint meaning "the incoming clip continues the
 * outgoing one through the same source at the same rate". It can only ever SUPPRESS a
 * swap, so a stale hint costs at most one drift correction and never a wrong source
 * position.
 *
 * Returns `prev` BY IDENTITY when nothing moved, so effect dependencies stay stable.
 */
export function derivePool(prev: Pool, current: Slot, next: Slot, contiguous: boolean): Pool {
  const slots: [Slot, Slot] = [prev.slots[0], prev.slots[1]];
  let active = prev.active;

  // Rule 1: nothing playable under the playhead — `active` does not move.
  // Rule 2: the active slot already holds this clip — nothing moves. The steady state.
  if (current.clipId !== null && !sameSlot(slots[active], current)) {
    // Rule 3, the cut.
    if (contiguous && slots[active].url === current.url) {
      // Relabel only, and issue NO element operation: the source-mapping invariant
      // already puts the running element on exactly the right sample, so touching it
      // would be strictly worse than leaving it alone. This is the `split` case.
      slots[active] = current;
    } else {
      const idle = otherSlot(active);
      // The preloaded slot already holds it: swap instead of reloading, which is the
      // whole point of the pool — the cut lands on a decoded frame.
      if (sameSlot(slots[idle], current)) active = idle;
      else slots[active] = current;
    }
  }

  const idle = otherSlot(active);
  // NOTE this DOES load the idle slot when `next.url === slots[active].url`. Two elements
  // holding one file at two different positions is the whole point of the correction.
  if (next.clipId !== null && !sameSlot(slots[active], next) && !sameSlot(slots[idle], next)) {
    slots[idle] = next;
  }

  if (slots[0] === prev.slots[0] && slots[1] === prev.slots[1] && active === prev.active) {
    return prev;
  }
  return { slots, active };
}

/* ------------------------------------------------- §3.3 the single element writer */

export interface Desired {
  gain: number;
  rate: number;
  pitch: boolean;
}

interface WriteCache {
  volume: number;
  muted: boolean | null;
  rate: number;
  pitch: boolean | null;
}

/**
 * Per-element monitoring state. Lives on the voice component (so its `seeked` handler
 * can reach it) and is read and written by the engine. Deliberately not store state:
 * the monitor adds no fields to the store.
 */
export interface SlotState {
  wrote: WriteCache;
  desired: Desired;
  /** True between a hard `currentTime` write and its `seeked` (or the backstop). */
  fadeUntilSeeked: boolean;
  fadeBackstop: number;
  /** `performance.now()` at the last `play()` issued from a paused state. 0 = not started. */
  playStartedMs: number;
  settled: boolean;
  drift: number[];
  /** The rate trim currently in force, as a fraction. Persists between corrections. */
  trim: number;
  lastCorrectionMs: number;
  lastHardSeekMs: number;
  hardSeekTimes: number[];
  nonTracking: boolean;
  inBandSinceMs: number;
  stallSinceMs: number;
  /** The playback run in which this element already announced a non-tracking verdict. */
  noticedRun: number;
  lastRepositionMs: number;
  /**
   * Set by the voice when this slot's element was loaded from scratch and is therefore at
   * an unknown position. Consumed by the engine, which repositions bypassing the settle
   * window and the hard-seek rate limit — but NOT the dead band, so a slot the pool swap
   * landed on a parked element does not get seeked off a position that was already right.
   */
  forcePosition: boolean;
}

export function makeSlotState(): SlotState {
  return {
    wrote: { volume: NaN, muted: null, rate: NaN, pitch: null },
    desired: { gain: 0, rate: 1, pitch: true },
    fadeUntilSeeked: false,
    fadeBackstop: 0,
    playStartedMs: 0,
    settled: false,
    drift: [],
    trim: 0,
    lastCorrectionMs: 0,
    lastHardSeekMs: 0,
    hardSeekTimes: [],
    nonTracking: false,
    inBandSinceMs: 0,
    stallSinceMs: 0,
    noticedRun: -1,
    lastRepositionMs: 0,
    forcePosition: false,
  };
}

/* ---------------------------------------------------------------- the registry */

/**
 * One track's pooled pair, as the engine sees it. The voice component owns the elements
 * and the per-slot state (its `seeked` handler has to reach the fade flag); the engine
 * reads and writes both. Nothing here is store state — the monitor adds no fields to the
 * store and calls no transport action.
 */
export interface VoiceEntry {
  trackId: TrackId;
  elements: [HTMLAudioElement | null, HTMLAudioElement | null];
  slotState: [SlotState, SlotState];
  pool: Pool;
  /**
   * The clip this voice should be sounding, as of the last COMMITTED render: audible per
   * §1.1, under the playhead, and not the clock clip. Null over a gap, over an inaudible
   * or offline clip, and over the clip the `<video>` is carrying.
   *
   * This is the audio counterpart of VideoSurface's `playable`, and it exists for the
   * same reason. `derivePool` rule 1 deliberately leaves the active slot holding the
   * OUTGOING clip when nothing is under the playhead — that is what keeps a cut from
   * flashing black — so the pool alone cannot tell "still on this clip" from "ran off the
   * end of it into a gap". Without this the voice plays the outgoing clip straight
   * through the gap after it.
   *
   * Deriving it in the same render as `pool` is what makes them consistent. The engine
   * runs inside the store's notification pass, one tick BEFORE React re-renders, so any
   * predicate it recomputed from fresh state would disagree with the pool it is reading
   * for exactly that tick — pausing a healthy element for a frame at every cut.
   */
  liveClipId: ClipId | null;
}

export interface VoiceRegistry {
  voices: Map<TrackId, VoiceEntry>;
  /**
   * Set by `useAudioMonitor`, called by a voice after a render that changed what it
   * wants — a new clip, a new source, a changed clip volume, a track mute. It is the
   * engine's one pass, invoked from a layout effect and therefore AFTER the store's
   * notification pass has finished, never inside it.
   */
  pass: () => void;
}

export const createVoiceRegistry = (): VoiceRegistry => ({
  voices: new Map(),
  pass: () => {},
});

/**
 * THE only place `volume`, `muted`, `playbackRate` and `preservesPitch` are written on a
 * voice element. The fade (§3.3) and the per-tick gain pass (§5.1) write the same
 * property, so one of them has to be in charge, and this is it: a design where the fade
 * sets `volume = 0` directly and the gain pass independently restores it every tick
 * restores full volume one or two ticks BEFORE the new samples arrive, which is exactly
 * the discontinuity the fade exists to hide.
 *
 * The write cache is not an optimisation, it is the reason this is allowed in the tick.
 * Six voices plus the `<video>`, four properties each, is 28 DOM property writes per
 * frame — and `volume` and `playbackRate` are not free setters, they reach the audio
 * renderer. Skipping the unchanged write reduces the steady state to zero.
 */
export function writeElement(el: HTMLMediaElement, st: SlotState, want: Desired): void {
  const volume = st.fadeUntilSeeked ? 0 : want.gain;
  if (st.wrote.volume !== volume) {
    el.volume = volume;
    st.wrote.volume = volume;
  }
  const muted = volume === 0;
  if (st.wrote.muted !== muted) {
    el.muted = muted;
    st.wrote.muted = muted;
  }
  if (st.wrote.rate !== want.rate) {
    el.playbackRate = want.rate;
    st.wrote.rate = want.rate;
  }
  if (st.wrote.pitch !== want.pitch) {
    el.preservesPitch = want.pitch;
    st.wrote.pitch = want.pitch;
  }
}

/**
 * Clear the fade and restore the gain through the single writer. Called from the
 * element's own `seeked` handler (the normal path) and from the backstop timer.
 */
export function releaseFade(el: HTMLMediaElement | null, st: SlotState): void {
  if (st.fadeBackstop !== 0) {
    clearTimeout(st.fadeBackstop);
    st.fadeBackstop = 0;
  }
  if (!st.fadeUntilSeeked) return;
  st.fadeUntilSeeked = false;
  if (el) writeElement(el, st, st.desired);
}

/**
 * A hard seek, in the order that makes it a fade rather than a click: raise the flag,
 * write (which zeroes the volume), and only then move the clock. Chromium de-zippers
 * volume changes with a short internal ramp, so this costs a few milliseconds and the
 * resulting 20-60 ms hole is strictly better than a discontinuity in the sample stream.
 */
export function hardSeek(el: HTMLMediaElement, st: SlotState, target: number, now: number): void {
  if (!Number.isFinite(target) || target < 0) return;
  st.fadeUntilSeeked = true;
  writeElement(el, st, st.desired);
  el.currentTime = target;
  st.lastHardSeekMs = now;
  st.hardSeekTimes.push(now);
  st.drift.length = 0;
  st.trim = 0;
  if (st.fadeBackstop !== 0) clearTimeout(st.fadeBackstop);
  st.fadeBackstop = window.setTimeout(() => {
    st.fadeBackstop = 0;
    // `seeked` is not guaranteed: a `src` change, an `error`, a decoder stall or a
    // `load()` between the write and the event will swallow it. Without this the voice
    // is silent for the rest of the session with no recovery path — the worst failure
    // this feature can have, because it is the "hearing one thing, shipping another"
    // bug arriving through the machinery meant to prevent it.
    st.fadeUntilSeeked = false;
    writeElement(el, st, st.desired);
  }, FADE_RESTORE_BACKSTOP_MS);
}

/** Push a drift sample onto the bounded ring. */
export function pushDrift(st: SlotState, sample: number): void {
  if (!Number.isFinite(sample)) return;
  if (st.drift.length >= DRIFT_RING_MAX) st.drift.shift();
  st.drift.push(sample);
}
