/* ---------------------------------------------------------------------------
   Timeline geometry — the two expressions of PLAN §8.6, written once.

     LAYOUT     x = framesToPx(frame, zoom)                  no scrollX
     HIT-TEST   frame = pxToFrames(clientX - rect.left + scrollX, zoom)

   scrollX appears in exactly one formula in this codebase, and it is the second
   one. Everything drawn inside the lane content is positioned in content space
   and moved by the single transform on that element.
--------------------------------------------------------------------------- */

import type { Frames, MediaKind, PxPerFrame, TrackId } from '../../types/model';
import type { StoreState } from '../../state/types';
import { pxToFrames, pxToFramesExact } from '../../lib/time';
import { PLAYHEAD_TAIL_FRAMES } from '../../lib/constants';
import { selectLaneTop, selectTimelineDurationFrames, tracksOfKind } from '../../state/timelineSlice';

/** Pointer x -> timeline frame. The only place scrollX enters a formula. */
export function frameAtClientX(
  clientX: number,
  rect: DOMRect,
  scrollX: number,
  zoom: PxPerFrame,
): Frames {
  return Math.max(0, pxToFrames(clientX - rect.left + scrollX, zoom));
}

/** The same, unrounded — for accumulating maths (PLAN §2.1). */
export function frameAtClientXExact(
  clientX: number,
  rect: DOMRect,
  scrollX: number,
  zoom: PxPerFrame,
): number {
  return pxToFramesExact(clientX - rect.left + scrollX, zoom);
}

/** Pointer y -> px from the top of the lane CONTENT, which is what selectTrackAtY wants. */
export function contentYAtClientY(clientY: number, rect: DOMRect, scrollY: number): number {
  return clientY - rect.top + scrollY;
}

/** Position of a track inside the same-kind subsequence of trackOrder, or -1. */
export function trackIndexInKind(s: StoreState, trackId: TrackId): number {
  const kind = s.tracks[trackId]?.kind;
  if (!kind) return -1;
  return tracksOfKind(s, kind).indexOf(trackId);
}

/** The track `deltaTrackIndex` lanes away from `trackId`, within its own kind. */
export function trackAtKindOffset(
  s: StoreState,
  trackId: TrackId,
  delta: number,
): TrackId | undefined {
  const kind = s.tracks[trackId]?.kind;
  if (!kind) return undefined;
  const lane = tracksOfKind(s, kind);
  const at = lane.indexOf(trackId);
  return at < 0 ? undefined : lane[at + delta];
}

/** Vertical offset in px between two lanes. */
export function laneDeltaY(s: StoreState, fromTrack: TrackId, toTrack: TrackId): number {
  return selectLaneTop(s, toTrack) - selectLaneTop(s, fromTrack);
}

/**
 * How many frames the lane content spans. The tail is what keeps the ruler alive on an
 * empty project and lets the playhead park past the last clip (PLAN §3.3).
 */
export function contentFrames(s: StoreState): Frames {
  return selectTimelineDurationFrames(s) + PLAYHEAD_TAIL_FRAMES;
}

export const kindLabel = (kind: MediaKind): string => (kind === 'video' ? 'video' : 'audio');
