/* ---------------------------------------------------------------------------
   pictureClip.ts — WHICH CLIP THE <video> ELEMENT CARRIES.

   THE CONFLATION THIS EXISTS TO END. `selectVideoClipIdAtFrame` answers
   "the topmost clip on a visible video track", and until titles existed that was
   simultaneously the answer to three different questions:

     1. what picture is on screen                 → the pool's src
     2. whose clock the element runs on           → usePlaybackClock, the audio
                                                    monitor's reference (§3.1)
     3. whose sound the <video> carries, and is
        therefore excluded from the voices (§2.3) → AudioTrackVoice

   A title clip broke that identity. It is a clip on a video track with no media
   at all, so when one sits on top the selector returns it, the pool points at
   nothing, and the footage underneath — which the export composites perfectly
   well — is simply not drawn. Measured as a black frame where the file has
   picture. It is the same defect the title layer had, one level down: the pool
   was asking the clock's selector what to draw.

   So: questions 1, 2 and 3 all have the SAME answer, and it is not the clock
   clip — it is the topmost clip that actually resolves media picture. They must
   share one answer, because they are all really one question, "which clip is
   this element playing": a pool pointed at the footage while the voices excluded
   the title would play the footage twice, once from the <video> and once from
   its own track voice.

   WHAT DOES NOT CHANGE. These selectors differ from the state slice's only when
   a clip that resolves no media would have won — that is, only in the presence
   of a title. On a project without titles they return, for every frame, exactly
   what `selectVideoClipIdAtFrame` and `selectNextVideoClipIdAfter` return, so
   cut behaviour and preloading are unchanged rather than newly-tested. That
   equivalence is the point of writing them in terms of the same per-track
   primitives the slice uses rather than as a new traversal.
--------------------------------------------------------------------------- */

import type { Clip, ClipId, Frames } from '../../types/model';
import { clipHasVideo, clipUsesMedia } from '../../types/model';
import type { StoreState } from '../../state/types';
import {
  selectClipIdInTrackAtFrame,
  selectNextClipIdInTrackAfter,
} from '../../state/timelineSlice';

/**
 * How many consecutive media-less clips on one track this will step over
 * looking for the next real source to preload.
 *
 * Bounded rather than unbounded because the cost is a binary search per step and
 * the benefit falls off immediately: a run of nine titles before the next shot
 * on the same track means the pool preloads nothing and that cut loads on
 * demand, which is exactly what every cut did before the pool existed. A soft,
 * bounded degradation beats an unbounded scan on the playhead path.
 */
const MAX_MEDIALESS_SKIP = 8;

/** True when this clip puts MEDIA pixels on screen — the thing a pool slot can hold. */
const drawsMedia = (c: Clip): boolean => clipHasVideo(c) && clipUsesMedia(c);

/**
 * [stable] The topmost clip covering `frame` that the <video> pool can actually
 * play, as an id. Null over a gap, over an empty timeline, and over a frame
 * where the only thing on screen is a title.
 *
 * Iterates `trackOrder` — top-first — and defers the per-track lookup to the
 * slice's own binary search, so this is O(tracks · log n) and allocates nothing,
 * the same budget the selector it replaces was written to.
 */
export function selectPictureClipIdAtFrame(s: StoreState, frame: Frames): ClipId | null {
  for (const trackId of s.trackOrder) {
    const track = s.tracks[trackId];
    if (!track || track.kind !== 'video' || !track.visible) continue;
    const id = selectClipIdInTrackAtFrame(s, trackId, frame);
    if (id === null) continue;
    const clip = s.clips[id];
    // A media-less clip does not END the search the way the slice's selector
    // does: the whole point is that the picture is UNDER it.
    if (clip && drawsMedia(clip)) return clip.id;
  }
  return null;
}

/**
 * [stable] The next clip after `frame`, on any visible video track, that the
 * pool can preload. Titles are stepped over rather than treated as the answer —
 * a title winning here would park the idle slot on nothing and cost the cut
 * after it the decoded frame the pool exists to provide.
 */
export function selectNextPictureClipIdAfter(s: StoreState, frame: Frames): ClipId | null {
  let best: Clip | null = null;

  for (const trackId of s.trackOrder) {
    const track = s.tracks[trackId];
    if (!track || track.kind !== 'video' || !track.visible) continue;

    let probe = frame;
    for (let step = 0; step < MAX_MEDIALESS_SKIP; step += 1) {
      const id = selectNextClipIdInTrackAfter(s, trackId, probe);
      if (id === null) break;
      const clip = s.clips[id];
      if (!clip) break;
      if (drawsMedia(clip)) {
        if (best === null || clip.start < best.start) best = clip;
        break;
      }
      // `start` strictly increases along a track, so this terminates.
      probe = clip.start;
    }
  }

  return best ? best.id : null;
}
