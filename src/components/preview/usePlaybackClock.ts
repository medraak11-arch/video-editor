/* ---------------------------------------------------------------------------
   usePlaybackClock — PLAN §8.4. THE only requestAnimationFrame loop in the app
   that advances the playhead. PreviewWell mounts it exactly once.

   Three paths, one loop:

   - forward, playable source: the playhead is DERIVED from <video>.currentTime
     every frame. Nothing integrates wall-clock time here, which is what keeps an
     hour of playback accurate instead of accumulating a frame of drift a minute.
   - forward, not playable (MediaItem.url === '' — the browser fixture, or a gap
     between clips): integrate performance.now() deltas against an anchor that is
     reset on every external seek.
   - reverse shuttle: HTMLMediaElement.playbackRate refuses negative values in
     Chromium, so there is no element-driven reverse. The element is paused, this
     loop integrates backwards, and VideoSurface repaints by seeking the element —
     rate-limited so the decoder is not thrashed. Reverse is an honest stuttering
     scrub, not smooth playback.

   The loop only runs while `isPlaying`, writes only when the integer frame
   actually changed, and cancels itself on unmount.
--------------------------------------------------------------------------- */

import { useEffect } from 'react';
import type { RefObject } from 'react';
import { readStore, useEditorStore } from '../../state/store';
import type { StoreState } from '../../state/types';
import { secondsToFrames } from '../../lib/time';
import { selectPlaybackStopFrame } from '../../state/playbackSlice';
import { selectVideoClipIdAtFrame } from '../../state/timelineSlice';

/**
 * @param activeVideoRef the pooled <video> currently on screen, or null when the
 *        playhead sits over a gap, over an unplayable source, or over nothing.
 */
export function usePlaybackClock(activeVideoRef: RefObject<HTMLVideoElement | null>): void {
  useEffect(() => {
    let raf = 0;
    let anchorMs = 0;
    let anchorFrame = 0;
    /**
     * True for exactly the duration of this loop's own `seek()` call.
     *
     * zustand runs `subscribeWithSelector` listeners SYNCHRONOUSLY inside `set`, so the
     * playhead subscriber below fires while we are still inside `s.seek(next)`. Comparing
     * against a "last written" value recorded AFTER the call is therefore always one frame
     * stale: the subscriber sees its own write as external, re-anchors the integrator on the
     * rounded value every frame, and the discarded sub-frame remainder plus half-up rounding
     * makes integrated playback run at roughly double speed. The flag has to be raised
     * BEFORE the write. Recording `next` before the call is not enough either — `seek`
     * rounds and clamps, so the committed value can differ from what we asked for.
     */
    let selfWriting = false;

    const anchor = (frame: number): void => {
      anchorFrame = frame;
      anchorMs = performance.now();
    };

    /** The playhead implied by the element's clock, or null when it cannot be trusted. */
    const frameFromElement = (s: StoreState): number | null => {
      const el = activeVideoRef.current;
      if (!el || el.paused || el.seeking || el.readyState < 2) return null;

      const clipId = selectVideoClipIdAtFrame(s, s.playhead);
      const clip = clipId ? s.clips[clipId] : undefined;
      if (!clip) return null;

      const media = s.items[clip.mediaId];
      if (!media || media.status === 'error' || media.url === '') return null;
      // At a cut the element still holds the OUTGOING source for a frame or two.
      // Mapping its clock onto the incoming clip would throw the playhead; fall back
      // to integration until the pool has swapped.
      if (el.getAttribute('src') !== media.url) return null;

      // The source-mapping invariant, inverted (PLAN §2.4 / §8.4). PROJECT fps, always.
      const speed = clip.properties.speed || 1;
      const sourceFrames = secondsToFrames(el.currentTime, s.fps);
      return clip.start + Math.round((sourceFrames - clip.mediaIn) / speed);
    };

    const tick = (): void => {
      raf = requestAnimationFrame(tick);

      const s = readStore();
      if (!s.isPlaying) return;

      const forward = s.rate > 0;
      const stopFrame = selectPlaybackStopFrame(s);

      if (forward && stopFrame <= 0) {
        s.pause();
        return;
      }

      let next: number;
      const fromElement = forward ? frameFromElement(s) : null;
      if (fromElement !== null) {
        // A decode hiccup can report a stale currentTime; never let the playhead retreat
        // during forward playback.
        next = Math.max(fromElement, s.playhead);
        anchor(next); // keep the wall clock in step, so a gap picks up seamlessly
      } else {
        const elapsedSeconds = (performance.now() - anchorMs) / 1000;
        next = Math.round(anchorFrame + elapsedSeconds * s.fps * s.rate);
      }

      if (forward && next >= stopFrame) {
        s.pause();
        s.seek(Math.max(0, stopFrame - 1));
        return;
      }
      if (!forward && next <= 0) {
        s.seek(0);
        s.pause();
        return;
      }

      if (next !== s.playhead) {
        selfWriting = true;
        s.seek(next);
        selfWriting = false;
      }
    };

    const startLoop = (): void => {
      if (raf !== 0) return;
      anchor(readStore().playhead);
      raf = requestAnimationFrame(tick);
    };

    const stopLoop = (): void => {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
    };

    const unsubscribePlaying = useEditorStore.subscribe(
      (s) => s.isPlaying,
      (playing) => (playing ? startLoop() : stopLoop()),
      { fireImmediately: true },
    );

    // A shuttle rate change restarts the integration from where we are now.
    const unsubscribeRate = useEditorStore.subscribe(
      (s) => s.rate,
      () => anchor(readStore().playhead),
    );

    // Somebody else moved the playhead (ruler scrub, timecode entry, a shortcut):
    // re-anchor so the next integrated frame continues from there.
    const unsubscribeSeek = useEditorStore.subscribe(
      (s) => s.playhead,
      (playhead) => {
        if (!selfWriting) anchor(playhead);
      },
    );

    return () => {
      unsubscribePlaying();
      unsubscribeRate();
      unsubscribeSeek();
      stopLoop();
      readStore().pause();
    };
  }, [activeVideoRef]);
}
