/* ---------------------------------------------------------------------------
   SnapEngine — magnetic snapping for every timeline gesture.

   The threshold is constant in SCREEN space: 8 px, converted to frames per
   evaluation and capped at SNAP_THRESHOLD_MAX_FRAMES so a very low zoom cannot
   make it minutes wide (PLAN §7.3, §8.6). That is what stops snapping from
   changing meaning as you zoom.

   Targets come from `selectSnapTargets` — the playhead, every clip edge, every
   marker, the in/out points and frame 0 — collected once per gesture and cached
   in a ref, never recomputed on pointermove.

   Nothing here touches the store or the DOM. It is pure arithmetic, so the
   drag layer can call it sixty times a second without allocating.
--------------------------------------------------------------------------- */

import type { Frames, PxPerFrame } from '../../types/model';
import { SNAP_THRESHOLD_MAX_FRAMES, SNAP_THRESHOLD_PX } from '../../lib/constants';

/** 8 screen px expressed in frames at this zoom, hard-capped. */
export function snapThresholdFrames(zoom: PxPerFrame): Frames {
  if (!Number.isFinite(zoom) || zoom <= 0) return SNAP_THRESHOLD_MAX_FRAMES;
  return Math.min(SNAP_THRESHOLD_PX / zoom, SNAP_THRESHOLD_MAX_FRAMES);
}

/** Index of the target nearest to `frame` in an ascending array, or -1 when empty. */
function nearestIndex(targets: readonly Frames[], frame: number): number {
  if (targets.length === 0) return -1;
  let lo = 0;
  let hi = targets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (targets[mid] < frame) lo = mid + 1;
    else hi = mid;
  }
  const above = lo;
  const below = lo > 0 ? lo - 1 : 0;
  return Math.abs(targets[above] - frame) <= Math.abs(targets[below] - frame) ? above : below;
}

/**
 * A moving frame that may land on a target, and WHICH end of its clip it is.
 *
 * The kind is carried per entry rather than inferred from the array's packing.
 * The caller builds this list as `[start, end]` per moving clip, so a parity
 * rule — even is a start, odd is an end — would have worked and would have been
 * an invisible contract between two files: one `push` in the wrong order in
 * `onLanePointerDown` and every abutting drop would start reporting itself as a
 * start-edge landing, which is CREATIVE §12.2's named failure. Naming the kind
 * costs one property on a list built once per gesture, never per pointermove.
 */
export interface SnapEdge {
  frame: Frames;
  kind: 'start' | 'end';
}

export interface SnapOutcome {
  /** The delta to apply, in whole frames. Equals `Math.round(rawDelta)` when nothing engaged. */
  delta: Frames;
  /** The frame the guide line is drawn at, or null when nothing engaged. */
  target: Frames | null;
  /**
   * Which moving edge landed on `target`. null when nothing snapped.
   *
   * CREATIVE §12.2: insertion is a START-edge property. A clip whose END snaps
   * to the next clip's start is an ordinary abutting drop, and treating it as an
   * insert would make the single most common snap in the application — butting
   * one clip against the one before it — rearrange the track.
   */
  edge: 'start' | 'end' | null;
}

/**
 * Snap a *translation*. `edges` are the moving frames that may land on a target — for a
 * clip drag, the start and end of every moving clip.
 *
 * `enabled` is `snapEnabled && !altKey`: holding Alt suppresses snapping without
 * changing the persisted preference. That is also what makes CREATIVE §12.2's
 * "snapping off means no insert" structural rather than a second rule: with
 * snapping suppressed this returns `edge: null`, and no caller can find a seam.
 */
export function snapTranslation(
  edges: readonly SnapEdge[],
  targets: readonly Frames[],
  rawDelta: number,
  zoom: PxPerFrame,
  enabled: boolean,
): SnapOutcome {
  const plain = Math.round(rawDelta);
  if (!enabled || edges.length === 0 || targets.length === 0) {
    return { delta: plain, target: null, edge: null };
  }

  const threshold = snapThresholdFrames(zoom);
  let bestDelta = plain;
  let bestTarget: Frames | null = null;
  let bestEdge: 'start' | 'end' | null = null;
  let bestDistance = threshold;

  // `<=` and the caller's `[start, end]` per clip order are both LOAD-BEARING
  // and unchanged: an exact tie resolves to the last candidate examined, which
  // is the end edge of the same clip. That is the conservative resolution — a
  // tie yields an ordinary abut rather than a rearrangement — and it is the
  // behaviour that shipped before `edge` existed, so adding the field changed
  // no delta anywhere.
  for (const edge of edges) {
    const wanted = edge.frame + rawDelta;
    const i = nearestIndex(targets, wanted);
    if (i < 0) continue;
    const target = targets[i];
    const distance = Math.abs(target - wanted);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestDelta = Math.round(target - edge.frame);
      bestTarget = target;
      bestEdge = edge.kind;
    }
  }
  return { delta: bestDelta, target: bestTarget, edge: bestEdge };
}

export interface SnapFrameOutcome {
  frame: Frames;
  target: Frames | null;
}

/** Snap a *single* frame — the scrub position, or the edge being trimmed. */
export function snapFrame(
  frame: number,
  targets: readonly Frames[],
  zoom: PxPerFrame,
  enabled: boolean,
): SnapFrameOutcome {
  const plain = Math.round(frame);
  if (!enabled || targets.length === 0) return { frame: plain, target: null };

  const threshold = snapThresholdFrames(zoom);
  const i = nearestIndex(targets, frame);
  if (i < 0) return { frame: plain, target: null };

  const target = targets[i];
  if (Math.abs(target - frame) > threshold) return { frame: plain, target: null };
  return { frame: target, target };
}
