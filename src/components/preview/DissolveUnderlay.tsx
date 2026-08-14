/* ---------------------------------------------------------------------------
   DissolveUnderlay — the outgoing clip, still on screen under the ramp.
   CREATIVE §4.3.

   WHY THIS IS A THIRD ELEMENT AND NOT THE POOL'S IDLE SLOT. The two-<video>
   pool cannot serve this, for two independent reasons and either one alone is
   fatal:

   1. The idle slot is committed. `derivePool` re-points it at the NEXT clip in
      the same render that swaps the cut in (audioMonitor.ts §2.2.1), which is
      what keeps the following cut from flashing black. Holding it on the
      OUTGOING clip instead would trade a visible black frame at every cut for a
      correct dissolve at some of them.
   2. Paint order is fixed by DOM order. Which of the two pool elements is active
      alternates, so the outgoing clip is above the incoming one half the time
      and below it the other half — and the fix is a z-index, which this
      stylesheet does not get to invent (there is no plane on the scale for
      "inside the frame").

   So the underlay is its own element, rendered FIRST in the stage and therefore
   painted underneath both pool slots, with a src of its own. The pool is not
   touched at all: nothing about cuts, preloading, the reference clock or the
   audio voices changes because this exists.

   THE COMPOSITE. A cross-dissolve is `A·(1−g) + B·g`. Drawing A at full opacity
   underneath and B at opacity `g` over it gives exactly that, which is why the
   ramp lives entirely on the incoming clip here as it does in the graph — one
   alpha ramp, one source of truth, `transitionGain`.

   THE HANDLE. Step 1 of §4.3 extends the outgoing clip's tail past its out
   point, and how far it can is a fact about the media rather than about the
   edit. `dissolveFrames` in src/lib/color.ts answers that, and it is the SAME
   function the graph clamps its `-t` extension with — so the underlay leaves the
   screen on the frame the graph stops extending, and the ramp above it runs for
   the same clamped length. When it returns 0 there is no handle at all: the
   export degrades the dissolve to a plain `fade` and says so once, and this
   renders nothing, so the preview degrades with it. What is NOT done here is a
   third thing — running the authored length and freezing on the last available
   source frame — which would be a behaviour no consumer of the model asked for.

   THE SOUND. The element is muted, always. §4.3a rules a cross dissolve a
   picture event: it consumes the outgoing clip's picture handle and leaves the
   audio edit the hard cut it already was, which is `transitionGain`'s `'audio'`
   answer for the incoming clip and this element's silence for the outgoing one.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { ClipId } from '../../types/model';
import { clipHasVideo, clipIsTitle, clipSourceLength, clipUsesMedia } from '../../types/model';
import { readStore, useEditorStore } from '../../state/store';
import { framesToSeconds } from '../../lib/time';
import { PLAYBACK_RATE_MAX, PLAYBACK_RATE_MIN, sourceSecondsForTimeline } from './audioMonitor';
import { ClipFilter } from './ClipFilter';
import { TitleLayer } from './TitleLayer';
import { useClipLayer } from './useClipLayer';

/** Mirrors VideoSurface: half a frame at 30fps, below which a write is judder. */
const SEEK_EPSILON_SECONDS = 1 / 60;
/** Mirrors VideoSurface: while running forward the element owns its own clock. */
const DRIFT_TOLERANCE_SECONDS = 0.25;

export interface DissolveUnderlayProps {
  /**
   * The clip whose frames go underneath, or null. Non-null BEFORE the cut as
   * well as during the ramp — the element needs its source decoded and parked on
   * the out-point by the time the ramp starts, and arming it early is the only
   * way it is not black for the first frames of every dissolve.
   */
  clipId: ClipId | null;
  /** True only inside the ramp. False while armed. */
  visible: boolean;
  scaleToStage: number;
  /** Stage size in CSS px. Needed only when the outgoing clip is a title. */
  stageWidth: number;
  stageHeight: number;
}

export function DissolveUnderlay({
  clipId,
  visible,
  scaleToStage,
  stageWidth,
  stageHeight,
}: DissolveUnderlayProps): ReactElement | null {
  const clip = useEditorStore(
    useCallback((s) => (clipId ? (s.clips[clipId] ?? null) : null), [clipId]),
  );
  const media = useEditorStore(
    useCallback(
      (s) => (clip && clipUsesMedia(clip) ? (s.items[clip.mediaId] ?? null) : null),
      [clip],
    ),
  );
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const rate = useEditorStore((s) => s.rate);
  const elementRef = useRef<HTMLVideoElement | null>(null);

  /*
    The outgoing clip keeps its OWN opacity, geometry, grade and transitions
    under the ramp: it is a clip that is still on screen, not a backdrop. It
    therefore goes through the same `useClipLayer` every other drawn layer does.
    A `transitionOut` on it has already completed by this frame and correctly
    reads as 0 — the same answer the graph's `fade=t=out` gives there.
  */
  const { style: layerStyle, filterSpec, filterId } = useClipLayer(clip, scaleToStage);

  /*
    NO HANDLE ARITHMETIC HERE, deliberately. How long the dissolve runs is
    `dissolveFrames`' answer and nobody else's, and the selectors above have
    already applied it — `visible` is false outside the clamped length and the
    id is null when the length is 0. A second, local test of the same fact is how
    the preview and the graph would come to disagree about the length of a
    transition while both looking correct in isolation.
  */
  const titleSpec = clip !== null && clipIsTitle(clip) ? (clip.title ?? null) : null;
  /*
    A title is a legal OUTGOING clip — `dissolveFrames` passes Infinity for one
    precisely because it is generated at every frame asked of it and has no out
    point to run past. It is rasterised here by the same `drawTitle` the layer
    above uses, so a dissolve out of a title cross-fades against real pixels
    instead of against black.
  */
  const usable =
    clip !== null &&
    media !== null &&
    media.status !== 'error' &&
    media.url !== '' &&
    clipHasVideo(clip);

  const url = usable && media ? media.url : '';

  /**
   * Where the element belongs. While the ramp is running the playhead is PAST
   * this clip's out-point, and the source-mapping invariant carries straight
   * through that boundary — the extension is not a special case, it is the same
   * expression evaluated at a later frame. The cap is a guard only: the ramp
   * ends on the clamped length, so it cannot reach past the source in the first
   * place.
   */
  const sync = useCallback(
    (force: boolean): void => {
      const el = elementRef.current;
      if (!el || !clip || !media) return;
      const s = readStore();
      const target = sourceSecondsForTimeline(clip, s.playhead / s.fps, s.fps);
      if (!Number.isFinite(target)) return;
      const last = media.durationSeconds > 0 ? media.durationSeconds - 1 / s.fps : target;
      const want = Math.min(Math.max(0, target), Math.max(0, last));
      const delta = Math.abs(el.currentTime - want);
      // Playing forward, the element runs on its own clock exactly as the pool's
      // does; correcting per frame would seek-storm it through the ramp.
      if (!force && s.isPlaying && s.rate > 0) {
        if (delta > DRIFT_TOLERANCE_SECONDS) el.currentTime = want;
        return;
      }
      if (force || delta > SEEK_EPSILON_SECONDS) el.currentTime = want;
    },
    [clip, media],
  );

  /** Armed, not running: sit on the out-point, which is where the ramp begins. */
  const park = useCallback((): void => {
    const el = elementRef.current;
    if (!el || !clip) return;
    if (!el.paused) el.pause();
    const s = readStore();
    const target = framesToSeconds(clip.mediaIn + clipSourceLength(clip), s.fps);
    if (!Number.isFinite(target) || target < 0) return;
    if (Math.abs(el.currentTime - target) > SEEK_EPSILON_SECONDS) el.currentTime = target;
  }, [clip]);

  useEffect(() => {
    if (!usable) return;
    if (!visible) {
      park();
      return;
    }
    sync(true);
    return useEditorStore.subscribe(
      (s) => s.playhead,
      () => sync(false),
    );
  }, [usable, visible, sync, park]);

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    if (!usable || !visible || !isPlaying || rate <= 0) {
      if (!el.paused) el.pause();
      return;
    }
    const speed = clip?.properties.speed ?? 1;
    el.playbackRate = Math.min(
      PLAYBACK_RATE_MAX,
      Math.max(PLAYBACK_RATE_MIN, speed * Math.abs(rate)),
    );
    void el.play().catch(() => {
      /* A source that will not start leaves the underlay black for the ramp. It is
         already reported by the pool or the voice that owns this same file — this
         element never condemns media, because it is not what the user is looking at. */
    });
  }, [usable, visible, isPlaying, rate, clip]);

  if (clip === null || (!usable && titleSpec === null)) return null;

  // Armed but not ramping: decoded, parked and NOT painted.
  const style: CSSProperties = { ...layerStyle, visibility: visible ? 'visible' : 'hidden' };

  return (
    <>
      {filterSpec !== null ? <ClipFilter id={filterId} spec={filterSpec} /> : null}
      {titleSpec !== null ? (
        <TitleLayer spec={titleSpec} width={stageWidth} height={stageHeight} style={style} />
      ) : (
        <video
          className="ve-video-underlay"
          ref={elementRef}
          src={url === '' ? undefined : url}
          style={style}
          preload="auto"
          muted
          playsInline
          disablePictureInPicture
        />
      )}
    </>
  );
}
