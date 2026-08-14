/* ---------------------------------------------------------------------------
   dissolve.ts — where a cross dissolve is, and how long it actually runs.
   CREATIVE §4.3.

   Selectors only: no JSX, no elements, no timing. They live apart from
   DissolveUnderlay because the CLAMPED LENGTH is needed by two unrelated
   consumers — the underlay, to know how long to keep the outgoing clip on
   screen, and every drawn clip layer, to know how long to ramp its alpha for —
   and a module that owned the element as well would make the second import the
   first.

   Every one of these returns a SCALAR. They run on every store notification, so
   an object or an array would fail zustand's identity check and re-render the
   preview at frame rate for a value that changes twice per dissolve.
--------------------------------------------------------------------------- */

import type { Clip, ClipId, Frames } from '../../types/model';
import { clipEnd, clipUsesMedia } from '../../types/model';
import type { StoreState } from '../../state/types';
import {
  selectClipIdInTrackAtFrame,
  selectNextClipIdInTrackAfter,
} from '../../state/timelineSlice';
import { selectPictureClipIdAtFrame } from './pictureClip';
import { dissolveFrames } from '../../lib/color';
import { PRELOAD_LEAD_IN_MS } from './audioMonitor';

/** The clip immediately before `clip` on its own track, iff it abuts it exactly. */
export function abuttingPredecessor(s: StoreState, clip: Clip): Clip | null {
  if (clip.start <= 0) return null;
  const id = selectClipIdInTrackAtFrame(s, clip.trackId, clip.start - 1);
  const previous = id ? s.clips[id] : undefined;
  // `selectClipIdInTrackAtFrame` already guarantees it covers start−1, and clips
  // on a track cannot overlap, so covering start−1 IS ending at start. Asserted
  // anyway: a dissolve against a clip that merely nearly abuts is not a dissolve.
  return previous && clipEnd(previous) === clip.start ? previous : null;
}

/**
 * Source frames available for `clip`, in the two-valued form `dissolveFrames`
 * asks for.
 *
 * `null` is NOT "no handle" — it is "not measured yet", and the distinction is
 * the reason the argument is nullable at all: refusing the transition on an
 * unprobed source would make a dissolve appear and disappear as the probe lands,
 * on a timeline the user is already scrubbing.
 *
 * A title clip passes Infinity: it is generated at every frame asked of it, so
 * it has no out point to run past and no handle to exhaust.
 */
function sourceDurationFrames(s: StoreState, clip: Clip): number | null {
  if (!clipUsesMedia(clip)) return Number.POSITIVE_INFINITY;
  const media = s.items[clip.mediaId];
  if (!media || media.durationFrames <= 0) return null;
  return media.durationFrames;
}

/**
 * THE length of the dissolve into `clip` — the clamped one, not the authored one
 * — through `dissolveFrames`, which is the same function the export graph clamps
 * its `-t` extension with. Two copies of this arithmetic would be two answers to
 * "how long is this dissolve", and the user would see the disagreement as a
 * preview whose ramp outlasts the file's.
 *
 * 0 means there is no dissolve to draw. It does NOT mean there is no transition:
 * CREATIVE §4.3 degrades a handle-less dissolve to a plain `fade`, so the
 * incoming clip still ramps up — over black, with nothing underneath, which is
 * exactly what the file will contain.
 */
export function selectDissolveLength(s: StoreState, clip: Clip): Frames {
  const t = clip.transitionIn;
  if (!t || t.kind !== 'dissolve') return 0;
  const previous = abuttingPredecessor(s, clip);
  if (!previous) return 0;
  return dissolveFrames(t.frames, previous, sourceDurationFrames(s, previous));
}

/**
 * The clip that must be decoded and ready underneath, or null.
 *
 * Deliberately non-null BEFORE the cut as well as during the ramp, and it is the
 * SAME clip id on both sides of that cut — first as "the clip you are watching,
 * about to become the underlay", then as "the clip before the one you are
 * watching". That continuity is what keeps the element's `src` unchanged across
 * the cut, so it enters the ramp already decoded instead of black.
 */
export function selectDissolveUnderlayClipId(s: StoreState, frame: Frames): ClipId | null {
  const currentId = selectPictureClipIdAtFrame(s, frame);
  const current = currentId ? s.clips[currentId] : undefined;
  if (!current) return null;

  const length = selectDissolveLength(s, current);
  if (length > 0 && frame < current.start + length) {
    const previous = abuttingPredecessor(s, current);
    if (previous) return previous.id;
  }

  // Arming. Bounded by the same lead-in the audio voices preload against, so a
  // timeline full of dissolves does not hold a second decode pipeline open on
  // every clip for its whole duration.
  const nextId = selectNextClipIdInTrackAfter(s, current.trackId, frame);
  const next = nextId ? s.clips[nextId] : undefined;
  if (!next || next.start !== clipEnd(current) || selectDissolveLength(s, next) === 0) return null;
  if (s.fps <= 0) return null;
  return ((next.start - frame) / s.fps) * 1000 <= PRELOAD_LEAD_IN_MS ? current.id : null;
}

/**
 * True only while the ramp is actually on screen. Flips twice per dissolve.
 *
 * It ends on the CLAMPED length, so a short handle takes the underlay off at the
 * same frame the graph stops extending the outgoing input's `-t` — rather than
 * freezing it on its last source frame, which is a third behaviour neither the
 * plan nor the export ever asked for.
 */
export function selectDissolveRamping(s: StoreState, frame: Frames): boolean {
  const currentId = selectPictureClipIdAtFrame(s, frame);
  const current = currentId ? s.clips[currentId] : undefined;
  if (!current) return false;
  const length = selectDissolveLength(s, current);
  return length > 0 && frame < current.start + length;
}
