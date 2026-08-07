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

export interface SnapOutcome {
  /** The delta to apply, in whole frames. Equals `Math.round(rawDelta)` when nothing engaged. */
  delta: Frames;
  /** The frame the guide line is drawn at, or null when nothing engaged. */
  target: Frames | null;
}

/**
 * Snap a *translation*. `edges` are the moving frames that may land on a target — for a
 * clip drag, the start and end of every moving clip.
 *
 * `enabled` is `snapEnabled && !altKey`: holding Alt suppresses snapping without
 * changing the persisted preference.
 */
export function snapTranslation(
  edges: readonly Frames[],
  targets: readonly Frames[],
  rawDelta: number,
  zoom: PxPerFrame,
  enabled: boolean,
): SnapOutcome {
  const plain = Math.round(rawDelta);
  if (!enabled || edges.length === 0 || targets.length === 0) return { delta: plain, target: null };

  const threshold = snapThresholdFrames(zoom);
  let bestDelta = plain;
  let bestTarget: Frames | null = null;
  let bestDistance = threshold;

  for (const edge of edges) {
    const wanted = edge + rawDelta;
    const i = nearestIndex(targets, wanted);
    if (i < 0) continue;
    const target = targets[i];
    const distance = Math.abs(target - wanted);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestDelta = Math.round(target - edge);
      bestTarget = target;
    }
  }
  return { delta: bestDelta, target: bestTarget };
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
