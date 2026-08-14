/* ---------------------------------------------------------------------------
   VideoSurface — the frame itself. PLAN §8.4, §4.4.

   Renders the topmost visible video clip under the playhead through a pool of
   two <video> elements: one on screen, one holding the next clip's source so a
   cut does not flash black. It composites that single MEDIA clip, plus the title
   stack over and under it — opacity, scale, position, rotation, grade and the
   transition ramp apply per clip against the well.

   The pool's clip is `selectPictureClipIdAtFrame` (pictureClip.ts), NOT the
   topmost clip. Those differ exactly when a title is on top, and conflating them
   is what left the well black over footage the export composites correctly. It
   is a ClipId | null either way, so this still renders at clip boundaries rather
   than at frame rate. Everything that moves with the playhead — the element's
   currentTime, the fixture still's timecode — is written imperatively from a
   store subscription and causes no React render.

   Over a gap, over an offline source, or over an empty timeline it shows the
   bare well and nothing else: no icon, no text, no placeholder graphic
   (PLAN §8.14 — the media rail owns the one empty state in the app).

   CREATIVE ADDS SEVERAL LAYERS TO THE STAGE, and their order in the JSX is
   their compositing order, because paint order inside the stage is document
   order:

     dissolve underlay → titles below the clock clip → pool slots → fixture
     still → the clock clip's vignette → titles above it → cues

   TITLES ARE A STACK, NOT A PROPERTY OF THE CLOCK CLIP. This surface draws one
   MEDIA clip — the topmost, the one that carries the playback clock and the
   sound — but it draws EVERY title that is in range on a visible video track,
   in track order, because that is what the export overlays. Drawing a title
   only when it happened to be the clock clip meant a title on V2 over footage
   on V1 produced no canvas at all while the file composited it correctly. See
   TitleClipLayer for where the order comes from.

   Every drawn layer's grade, effects, opacity and transition ramp come from
   `useClipLayer`, keyed on the clip that layer belongs to — so a layer cannot be
   given the transform and miss the filter, and a title cannot be drawn with the
   footage's geometry. The ramp is `transitionGain` from src/lib/color.ts, the
   SAME function that multiplies the audio voice gain at the same frame, which is
   what stops a fade drifting between picture and sound. It is asked once per
   stream, because CREATIVE §4.3a makes a cross dissolve a picture event with no
   audio ramp; the rule is that function's and is not repeated here.
--------------------------------------------------------------------------- */

import './preview.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject, ReactElement } from 'react';
import { readStore, useEditorStore } from '../../state/store';
import { clipHasAudio, clipUsesMedia, trackVolume } from '../../types/model';
import { framesToSeconds, framesToTimecode } from '../../lib/time';
import { transitionGain } from '../../lib/color';
import { SHUTTLE_REVERSE_MAX_SEEKS_PER_SEC } from '../../lib/constants';
import { selectVideoClipIdAtFrame } from '../../state/timelineSlice';
import { selectNextPictureClipIdAfter, selectPictureClipIdAtFrame } from './pictureClip';
import {
  EMPTY_POOL,
  EMPTY_SLOT,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  derivePool,
  effectiveGain,
  mixVolume,
  otherSlot,
  sourceContiguous,
  transportSilent,
} from './audioMonitor';
import type { Pool, Slot, SlotIndex } from './audioMonitor';
import { ClipFilter } from './ClipFilter';
import { vignetteOpacity } from './clipRender';
import { DissolveUnderlay } from './DissolveUnderlay';
import { selectDissolveRamping, selectDissolveUnderlayClipId } from './dissolve';
import { SubtitleLayer } from './SubtitleLayer';
import { TitleClipLayer, selectTitleClipIds, splitTitleClipIds } from './TitleClipLayer';
import { useClipLayer } from './useClipLayer';

/** Half a frame at 30fps: below this, a currentTime write would be a no-op judder. */
const SEEK_EPSILON_SECONDS = 1 / 60;

/** While playing forward the element owns the clock; only gross drift is corrected. */
const DRIFT_TOLERANCE_SECONDS = 0.25;

/**
 * `MediaError.code`, spelled out. `el.error` is a bare number and the difference between
 * these four is the difference between "this file is broken" and "try that again".
 */
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * How many times one source may fail transiently before we stop reloading it and say so.
 * Counted per source URL and cleared on the next successful load, so a file that hiccups
 * once an hour never accumulates its way into a verdict.
 */
const TRANSIENT_RELOAD_ATTEMPTS = 2;


export interface VideoSurfaceProps {
  /**
   * Published to the playback clock, which derives the playhead from this element's
   * currentTime during forward playback. Null whenever nothing playable is on screen.
   */
  activeVideoRef: MutableRefObject<HTMLVideoElement | null>;
}

export function VideoSurface({ activeVideoRef }: VideoSurfaceProps): ReactElement {
  /* ---------------------------------------------------------- what to show */

  /*
    THE POOL'S CLIP IS THE PICTURE CLIP, not the topmost clip. A title is a clip
    on a video track with no media, so pointing the pool at the topmost clip left
    both <video> elements with no src whenever a title was on top — a black frame
    where the export composites the footage. See pictureClip.ts; on a project
    with no titles these return exactly what the slice's selectors return, so
    cuts and preloading are unchanged rather than newly-tested.
  */
  const clipId = useEditorStore((s) => selectPictureClipIdAtFrame(s, s.playhead));
  const nextClipId = useEditorStore((s) => selectNextPictureClipIdAfter(s, s.playhead));

  const clip = useEditorStore(
    useCallback((s) => (clipId ? (s.clips[clipId] ?? null) : null), [clipId]),
  );
  const nextClip = useEditorStore(
    useCallback((s) => (nextClipId ? (s.clips[nextClipId] ?? null) : null), [nextClipId]),
  );
  /*
    `clipUsesMedia`, not a truthiness test on the clip (CREATIVE §9.4 item 2). A
    title clip carries `mediaId: ''`, and `s.items['']` is undefined rather than
    an error — so without this guard the title reads as an offline source, the
    label says so, and the well shows nothing with a plausible-looking reason.
  */
  const media = useEditorStore(
    useCallback((s) => (clip && clipUsesMedia(clip) ? (s.items[clip.mediaId] ?? null) : null), [clip]),
  );
  const nextMedia = useEditorStore(
    useCallback(
      (s) => (nextClip && clipUsesMedia(nextClip) ? (s.items[nextClip.mediaId] ?? null) : null),
      [nextClip],
    ),
  );

  // Both scalar, both flipping at most twice per dissolve — see DissolveUnderlay.
  const underlayClipId = useEditorStore((s) => selectDissolveUnderlayClipId(s, s.playhead));
  const underlayVisible = useEditorStore((s) => selectDissolveRamping(s, s.playhead));

  /*
    THE TITLE STACK, and note what it is NOT conditioned on: the clock clip. A
    title draws because it is in range on a visible video track, which is the
    export's own rule — the previous build drew one only when it happened to be
    the clock clip, so a title on V2 over footage on V1 produced no canvas at all
    while the file composited it correctly. Two scalar strings, split at the
    clock clip because the preview draws exactly one MEDIA clip and a title below
    that clip is covered by it in the file. See TitleClipLayer.
  */
  // [stable] The topmost drawn clip of any kind — for the accessible name only.
  const topClipId = useEditorStore((s) => selectVideoClipIdAtFrame(s, s.playhead));
  const topClip = useEditorStore(
    useCallback((s) => (topClipId ? (s.clips[topClipId] ?? null) : null), [topClipId]),
  );

  const titleIdsBelow = useEditorStore((s) => selectTitleClipIds(s, s.playhead, 'below'));
  const titleIdsAbove = useEditorStore((s) => selectTitleClipIds(s, s.playhead, 'above'));
  const titlesBelow = useMemo(() => splitTitleClipIds(titleIdsBelow), [titleIdsBelow]);
  const titlesAbove = useMemo(() => splitTitleClipIds(titleIdsAbove), [titleIdsAbove]);

  const projectWidth = useEditorStore((s) => s.width);
  const projectHeight = useEditorStore((s) => s.height);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const rate = useEditorStore((s) => s.rate);
  const volume = useEditorStore((s) => s.volume);
  const muted = useEditorStore((s) => s.muted);

  // No `isTitle` here any more, and its absence is the fix: `clip` is the
  // PICTURE clip, so it can never be a title. Titles are drawn by the stack.
  const online = media !== null && media.status !== 'error';
  const currentUrl = online && media.url !== '' ? media.url : '';
  const nextUrl =
    nextMedia !== null && nextMedia.status !== 'error' && nextMedia.url !== '' ? nextMedia.url : '';
  const stillUrl = clip !== null && online && media.url === '' ? media.thumbnailUrl : null;

  /* ------------------------------------------------------- letterbox maths */

  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setBox((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const aspect = projectHeight > 0 ? projectWidth / projectHeight : 16 / 9;
  let stageWidth = box.width;
  let stageHeight = stageWidth / aspect;
  if (stageHeight > box.height) {
    stageHeight = box.height;
    stageWidth = stageHeight * aspect;
  }
  stageWidth = Math.max(0, Math.floor(stageWidth));
  stageHeight = Math.max(0, Math.floor(stageHeight));

  /* ------------------------------------------------------------- the pool */

  const poolRef = useRef<Pool>(EMPTY_POOL);
  const nextClipRef = useRef(nextClip);

  const elements = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const lastReverseSeekMs = useRef(0);

  /*
    The pool is keyed on the CLIP, not on the URL (AUDIO-MONITOR.md §2.2.1), and
    `derivePool` is shared with the audio voices so there is one implementation of the
    corrected rule rather than two that can drift apart. Two clips cut from the same
    source on the same track have identical URLs, so a url-keyed pool never swaps at that
    cut and leaves one element playing clip A's material while the timeline is inside
    clip B. Picture survives that today only because the `clipId`-dependent effect below
    issues a forced `currentTime` write; clip-keying makes it land on the idle element
    `parkIdle` already seeked to the incoming `mediaIn` instead — a decoded frame rather
    than a seek, strictly better for picture, and identical in every other case. The
    `split` case is covered by the contiguity exception and produces no swap at all.
  */
  const currentSlot: Slot = currentUrl !== '' && clip ? { url: currentUrl, clipId: clip.id } : EMPTY_SLOT;
  const nextSlot: Slot = nextUrl !== '' && nextClip ? { url: nextUrl, clipId: nextClip.id } : EMPTY_SLOT;
  const outgoingId = poolRef.current.slots[poolRef.current.active].clipId;
  const contiguous = sourceContiguous(outgoingId ? readStore().clips[outgoingId] : null, clip);

  // Derived, not stored: the swap lands in the SAME render that changed the clip, so the
  // preloaded element is already the active one on the first paint after a cut.
  const pool = derivePool(poolRef.current, currentSlot, nextSlot, contiguous);
  /*
    The clip-id term is LOAD-BEARING and must not be weakened back to a url comparison:
    it is the only thing that keeps `activeVideoRef` null across a same-source cut, and
    both usePlaybackClock's `frameFromElement` and the audio monitor's reference clock
    (§3.1) depend on that being null while the pool is stale.
  */
  const playable =
    clip !== null &&
    currentUrl !== '' &&
    pool.slots[pool.active].clipId === clip.id &&
    pool.slots[pool.active].url === currentUrl;

  /**
   * The single place refs are published, and it is a layout effect on purpose: writing a
   * ref during render can leave it holding a value from a render React discarded, which
   * `syncTime` and `parkIdle` would then read from a store subscription or a media event.
   * Refs only ever hold committed values. Declared before every effect that reads them.
   */
  useLayoutEffect(() => {
    poolRef.current = pool;
    nextClipRef.current = nextClip;
    activeVideoRef.current = playable ? elements.current[pool.active] : null;
  }, [activeVideoRef, pool, nextClip, playable]);

  /* ------------------------------------------------- imperative time sync */

  const syncTime = useCallback((force: boolean): void => {
    const el = elements.current[poolRef.current.active];
    if (!el) return;

    const s = readStore();
    const id = selectPictureClipIdAtFrame(s, s.playhead);
    const current = id ? s.clips[id] : undefined;
    if (!current) return;

    const item = s.items[current.mediaId];
    if (!item || item.status === 'error' || item.url === '') return;
    // Only sync when the on-screen slot is actually holding THIS CLIP's source. The clip
    // id, not just the url: at a same-source cut both clips share a url, and syncing
    // against a slot that still carries the outgoing clip would seek the element away
    // from the position the pool swap is about to make correct.
    const activeSlot = poolRef.current.slots[poolRef.current.active];
    if (activeSlot.clipId !== current.id || activeSlot.url !== item.url) return;

    // The source-mapping invariant (PLAN §2.4 invariant 3). PROJECT fps, never media.fps.
    const speed = current.properties.speed || 1;
    const sourceFrame = current.mediaIn + (s.playhead - current.start) * speed;
    const target = framesToSeconds(sourceFrame, s.fps);
    if (!Number.isFinite(target) || target < 0) return;

    const delta = Math.abs(el.currentTime - target);

    if (!force && s.isPlaying && s.rate > 0) {
      // Forward playback: the element owns the clock and the playhead follows it.
      // Only a scrub landing elsewhere mid-playback needs correcting.
      if (delta > DRIFT_TOLERANCE_SECONDS) el.currentTime = target;
      return;
    }

    if (!force && s.isPlaying && s.rate < 0) {
      // Reverse is a seek-per-frame scrub; rate-limit it so the decoder survives.
      const now = performance.now();
      if (now - lastReverseSeekMs.current < 1000 / SHUTTLE_REVERSE_MAX_SEEKS_PER_SEC) return;
      lastReverseSeekMs.current = now;
    }

    if (force || delta > SEEK_EPSILON_SECONDS) el.currentTime = target;
  }, []);

  useEffect(() => {
    syncTime(true);
    return useEditorStore.subscribe(
      (s) => s.playhead,
      () => syncTime(false),
    );
  }, [syncTime, clipId, pool, playable]);

  /* ----------------------------------------------------- element transport */

  const speed = clip?.properties.speed ?? 1;
  // The clock clip's audio is carried by the <video> element and by nothing else
  // (AUDIO-MONITOR §2.3). A video-only clip must therefore reach the gain law as
  // volume 0, or the detached half is heard from the element that draws it.
  // Written here rather than inside `effectiveGain`, which is the gain LAW and is
  // asserted against a table of scalars — a clip-shaped argument would make that
  // assertion untestable.
  const clipVolume =
    clip !== null && clipUsesMedia(clip) && clipHasAudio(clip) ? clip.properties.volume : 0;
  const trackMuted = useEditorStore(
    useCallback((s) => (clip ? (s.tracks[clip.trackId]?.muted ?? false) : false), [clip]),
  );
  /*
    CREATIVE §9.4 item 1, THE bug this feature is most likely to ship with. The
    <video> element carries the clock clip's audio and nothing else carries it,
    so a fader applied to the mix voices and not here is a fader that works on
    every track except the one being watched — which is the one the user is
    listening to while they move it.
  */
  const trackGain = useEditorStore(
    useCallback((s) => {
      const track = clip ? s.tracks[clip.trackId] : undefined;
      return track ? trackVolume(track) : 1;
    }, [clip]),
  );
  /*
    CREATIVE §4.2 / §4.3a. The picture ramp lives in `useClipLayer` with the rest
    of the clip's drawing, because every drawn layer needs it. The SOUND ramp is
    here, because only this element carries the clock clip's audio — one
    function, two streams, evaluated at the same frame, and the rule that
    separates them is `transitionGain`'s and is not restated at either call site.

    Exactly 1 for a clip with no transitions, so this subscription costs no
    render outside a ramp — which is what keeps a component that deliberately
    renders at clip boundaries from becoming one that renders at frame rate.
  */
  const soundGain = useEditorStore(
    useCallback((s) => (clip ? transitionGain(clip, s.playhead, 'audio') : 1), [clip]),
  );

  useEffect(() => {
    const [a, b] = elements.current;
    const slots: [HTMLVideoElement | null, HTMLVideoElement | null] = [a, b];

    slots.forEach((el, index) => {
      if (!el) return;
      const isActive = index === pool.active;
      // Reverse shuttle keeps the element paused: Chromium has no negative playbackRate.
      if (!isActive || !playable || !isPlaying || rate <= 0) {
        if (!el.paused) el.pause();
        return;
      }
      el.playbackRate = Math.min(
        PLAYBACK_RATE_MAX,
        Math.max(PLAYBACK_RATE_MIN, speed * Math.abs(rate)),
      );
      void el.play().catch(() => {
        /* A source that refuses to start still fires `error` on the element; that handler
           owns the report, so there is exactly one path to the user for a dead source. */
      });
    });
  }, [isPlaying, rate, speed, playable, pool, clipId]);

  /**
   * The <video> element carries the CLOCK CLIP's audio and nothing else carries it
   * (AUDIO-MONITOR.md §2.3), so it is a gain consumer under exactly the same law as every
   * <audio> voice — clip volume, track mute, master volume, master mute, transport.
   *
   * This used to read `el.volume = volume` and nothing else, which meant a video clip set
   * to `volume: 0`, or sitting on a muted track, monitored at FULL LEVEL while exporting
   * silent. That is a real defect being fixed, not new scope: it is the exact
   * hear-one-thing-ship-another failure the audio work exists to close.
   *
   * `transportSilent` carries §4.2's rule that 8× shuttle is silent. The element MUTES
   * rather than pausing, because the picture keeps shuttling.
   *
   * Two terms were added by CREATIVE: the TRACK fader, which multiplies the clip term
   * (§1.2 — effective gain is the product, which is what a mixer does), and the
   * transition ramp, which multiplies the whole level by the same `transitionGain` the
   * picture's opacity is multiplied by, at the same frame.
   */
  useEffect(() => {
    const level =
      effectiveGain(mixVolume(clipVolume, trackGain), trackMuted, volume, muted, transportSilent(rate)) *
      soundGain;
    elements.current.forEach((el, index) => {
      if (!el) return;
      const isActive = index === pool.active && playable;
      el.volume = isActive ? level : 0;
      el.muted = !isActive || level === 0;
      // At normal speed clip `speed` is applied pitch-preserved, matching export's atempo
      // chain; while shuttling, tape-style pitch rise is the convention.
      el.preservesPitch = Math.abs(rate) === 1;
    });
  }, [volume, muted, pool, playable, clipVolume, trackGain, trackMuted, rate, soundGain]);

  /**
   * Park the idle element on the first frame of the clip it is preloading, so the cut
   * lands on a decoded frame instead of flashing black.
   */
  const parkIdle = useCallback((): void => {
    const idle = elements.current[otherSlot(poolRef.current.active)];
    const upcoming = nextClipRef.current;
    if (!idle || !upcoming || idle.getAttribute('src') === null) return;
    if (!idle.paused) idle.pause();
    const target = framesToSeconds(upcoming.mediaIn, readStore().fps);
    if (Number.isFinite(target) && Math.abs(idle.currentTime - target) > SEEK_EPSILON_SECONDS) {
      idle.currentTime = target;
    }
  }, []);

  useEffect(() => {
    parkIdle();
  }, [parkIdle, nextClip, nextUrl, pool]);

  const handleLoadedMetadata = useCallback(
    (index: SlotIndex) => () => {
      const src = elements.current[index]?.getAttribute('src');
      // This source just loaded, so whatever failed before is spent. Forgetting it here is
      // what keeps a once-an-hour hiccup from adding up to a permanent verdict.
      if (src) reloadAttempts.current.delete(src);
      if (index === poolRef.current.active) syncTime(true);
      else parkIdle();
    },
    [parkIdle, syncTime],
  );

  /**
   * Transient failures per source URL. A ref, not state: it must not render, and it must
   * survive the re-render that a reload provokes.
   */
  const reloadAttempts = useRef(new Map<string, number>());

  /**
   * An `error` event on a pool element. What it means depends entirely on WHICH error and
   * on WHICH element, and conflating the four codes is how a file that plays perfectly gets
   * told it is undecodable.
   *
   * - `MEDIA_ERR_SRC_NOT_SUPPORTED` is the only real verdict: the browser looked at the
   *   container or codec and cannot play it. That one condemns the media.
   * - `MEDIA_ERR_DECODE` and `MEDIA_ERR_NETWORK` are transient. A decoder can drop a frame
   *   under load and a local read can fail once. Reload the element and put it back where
   *   the playhead is — the user should never have to go and find Retry for a file that is
   *   fine. Only when reloading has failed TRANSIENT_RELOAD_ATTEMPTS times is there
   *   something to report, and even then the report says what actually failed.
   * - `MEDIA_ERR_ABORTED` is us. `removeAttribute('src') + load()` is the rename protocol's
   *   own step 2 (RENAME.md §The file-lock problem); a file the user just renamed must not
   *   come back marked offline because we let go of it on purpose.
   *
   * And the slot matters. The idle element is parked off screen holding the NEXT clip, and
   * it is about to be re-pointed anyway. An error there is not what the user is looking at:
   * it never touches media state, it just gets one quiet reload so the cut still lands on a
   * decoded frame instead of black.
   *
   * A real verdict reports through the two channels that already exist — the media item goes
   * to `status: 'error'`, which fires the media rail's Unplug + 'Offline' row treatment (icon
   * and word, never colour alone) and the offline texture on every clip cut from it, plus one
   * notice in the titlebar strip. No error surface is invented in the well (PLAN §8.14): the
   * well stays the frame.
   */
  const handleMediaError = useCallback(
    (index: SlotIndex) => (): void => {
      const el = elements.current[index];
      const src = el?.getAttribute('src');
      if (!el || !src) return; // detached: there is no source, so nothing failed

      const code = el.error?.code ?? MEDIA_ERR_DECODE;
      if (code === MEDIA_ERR_ABORTED) return;

      // Everything that is not the codec verdict is worth trying again — including a code
      // this build has never seen. Retrying a file that turns out to be dead costs two
      // reloads; condemning one that was fine costs the user their trust in the app.
      const attempts = reloadAttempts.current.get(src) ?? 0;
      const canReload =
        code !== MEDIA_ERR_SRC_NOT_SUPPORTED && attempts < TRANSIENT_RELOAD_ATTEMPTS;

      if (index !== poolRef.current.active) {
        if (canReload) {
          reloadAttempts.current.set(src, attempts + 1);
          el.load();
          parkIdle();
        }
        return; // a parked slot never condemns anything
      }

      if (canReload) {
        reloadAttempts.current.set(src, attempts + 1);
        el.load();
        syncTime(true); // before metadata this sets the default playback start position
        const s = readStore();
        if (s.isPlaying && s.rate > 0) {
          void el.play().catch(() => {
            /* If it will not start, `error` fires again and the count above catches it. */
          });
        }
        return;
      }

      const s = readStore();
      const item = Object.values(s.items).find((candidate) => candidate.url === src);
      if (!item || item.status === 'error') return; // already reported; do not re-notice

      // MEDIA_ERR_NETWORK survived the reloads: the bytes are not arriving. That is the file
      // being gone or unreadable, not a codec the app does not speak — and saying "could not
      // be decoded" would send the user looking for a transcode they do not need.
      const [errorCode, message] =
        code === MEDIA_ERR_NETWORK
          ? (['not-found', `${item.name} could not be read from disk`] as const)
          : (['unsupported-codec', `${item.name} could not be decoded`] as const);

      s.updateItem(item.id, { status: 'error', error: { code: errorCode, message } });
      s.setNotice({ tone: 'danger', title: 'Cannot play clip', message });
      if (s.isPlaying) s.pause();
    },
    [parkIdle, syncTime],
  );

  /* -------------------------------------------- the fixture still timecode */

  const stillTimecodeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (stillUrl === null) return;
    const paint = (): void => {
      const node = stillTimecodeRef.current;
      if (!node) return;
      const s = readStore();
      node.textContent = framesToTimecode(s.playhead, s.fps);
    };
    paint();
    const unsubscribePlayhead = useEditorStore.subscribe((s) => s.playhead, paint);
    const unsubscribeFps = useEditorStore.subscribe((s) => s.fps, paint);
    return () => {
      unsubscribePlayhead();
      unsubscribeFps();
    };
  }, [stillUrl]);

  /* ---------------------------------------------------------------- render */

  const scaleToStage = projectWidth > 0 ? stageWidth / projectWidth : 1;

  /*
    One style object for every layer this clip draws — the pool element, the
    fixture still, the title canvas and the vignette all take it. The grade and
    the effects are NOT a second appearance of the clip's properties: they are
    the same three lines, so a layer cannot be given the transform and miss the
    filter. `filter` is `undefined` for an ungraded, unblurred clip, which React
    then omits entirely — CREATIVE §2.2's `neutral` fast path, honoured in the
    only place it can be observed.
  */
  const { style: frameStyle, filterSpec, filterId } = useClipLayer(clip, scaleToStage);

  const vignette = clip ? vignetteOpacity(clip.properties) : 0;

  /*
    The label names the TOPMOST drawn clip, which is the slice's selector and the
    one place it is still the right question: with a title over footage the thing
    a screen reader should announce is the title, even though the element below
    is carrying the footage. The offline qualifier stays keyed to the picture
    clip, because that is the one that can be offline.
  */
  const label = topClip
    ? clip === null || online
      ? `Preview, ${topClip.name}`
      : `Preview, ${topClip.name}, source is offline`
    : 'Preview, no clip under the playhead';

  return (
    <div className="ve-video-surface" ref={boxRef}>
      <div
        className="ve-video-stage"
        role="img"
        aria-label={label}
        style={{ width: `${stageWidth}px`, height: `${stageHeight}px` }}
      >
        {filterSpec !== null ? <ClipFilter id={filterId} spec={filterSpec} /> : null}

        {/* FIRST in the stage, and that is the whole reason it works: paint order
            inside the stage is document order, so the outgoing clip of a
            cross-dissolve sits under both pool slots without a z-index. */}
        <DissolveUnderlay
          clipId={underlayClipId}
          visible={underlayVisible}
          scaleToStage={scaleToStage}
          stageWidth={stageWidth}
          stageHeight={stageHeight}
        />

        {/* Titles the export composites UNDER the clock clip. They are drawn
            first, so the footage covers them here exactly as the overlay does
            in the file. */}
        {titlesBelow.map((id) => (
          <TitleClipLayer
            key={id}
            clipId={id}
            scaleToStage={scaleToStage}
            stageWidth={stageWidth}
            stageHeight={stageHeight}
          />
        ))}

        {([0, 1] as SlotIndex[]).map((index) => (
          <video
            key={index}
            ref={(el) => {
              elements.current[index] = el;
            }}
            className="ve-video-el"
            data-active={index === pool.active && playable ? 'true' : undefined}
            src={pool.slots[index].url === '' ? undefined : pool.slots[index].url}
            style={index === pool.active && playable ? frameStyle : undefined}
            preload="auto"
            playsInline
            disablePictureInPicture
            onLoadedMetadata={handleLoadedMetadata(index)}
            onError={handleMediaError(index)}
          />
        ))}

        {stillUrl !== null ? (
          <>
            <img className="ve-video-still" src={stillUrl} alt="" style={frameStyle} />
            <span
              className="ve-video-still-timecode type-numeric"
              ref={stillTimecodeRef}
              aria-hidden="true"
            />
          </>
        ) : null}

        {/* The CLOCK CLIP's vignette, and it belongs to that clip — same
            transform, same opacity — because the graph vignettes a clip's
            picture and then places it, not the programme. So it is drawn
            immediately over the clip it belongs to and UNDER any title that
            composites above that clip, which is where the overlay puts it. */}
        {vignette > 0 ? (
          <div
            className="ve-video-vignette"
            aria-hidden="true"
            style={{
              opacity: vignette * (frameStyle.opacity as number),
              transform: frameStyle.transform,
            }}
          />
        ) : null}

        {/* Titles the export composites OVER the clock clip, bottom-first. Each
            carries its OWN clip's opacity, geometry, grade and transition — a
            title is an ordinary clip on a video track (§5.1), and nothing here
            reads the clock clip's properties on its behalf. */}
        {titlesAbove.map((id) => (
          <TitleClipLayer
            key={id}
            clipId={id}
            scaleToStage={scaleToStage}
            stageWidth={stageWidth}
            stageHeight={stageHeight}
          />
        ))}

        {/* Last, and above every clip layer: cues are a property of the programme
            (CREATIVE §6.1) and the burn-in is appended to the TERMINAL chain,
            after the last overlay, where no clip's grade can reach it. */}
        <SubtitleLayer stageHeight={stageHeight} />
      </div>
    </div>
  );
}
