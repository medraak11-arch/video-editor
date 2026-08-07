/* ---------------------------------------------------------------------------
   VideoSurface — the frame itself. PLAN §8.4, §4.4.

   Renders the topmost visible video clip under the playhead through a pool of
   two <video> elements: one on screen, one holding the next clip's source so a
   cut does not flash black. This build composites that single clip only —
   opacity, scale, position and rotation apply to it against the well.

   It subscribes to `selectVideoClipIdAtFrame`, a ClipId | null, so it renders at
   clip boundaries rather than at frame rate. Everything that moves with the
   playhead — the element's currentTime, the fixture still's timecode — is
   written imperatively from a store subscription and causes no React render.

   Over a gap, over an offline source, or over an empty timeline it shows the
   bare well and nothing else: no icon, no text, no placeholder graphic
   (PLAN §8.14 — the media rail owns the one empty state in the app).
--------------------------------------------------------------------------- */

import './preview.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MutableRefObject, ReactElement } from 'react';
import { readStore, useEditorStore } from '../../state/store';
import { framesToSeconds, framesToTimecode } from '../../lib/time';
import { SHUTTLE_REVERSE_MAX_SEEKS_PER_SEC } from '../../lib/constants';
import { selectNextVideoClipIdAfter, selectVideoClipIdAtFrame } from '../../state/timelineSlice';

/** Chromium refuses a playbackRate outside this range. */
const PLAYBACK_RATE_MIN = 0.0625;
const PLAYBACK_RATE_MAX = 16;

/** Half a frame at 30fps: below this, a currentTime write would be a no-op judder. */
const SEEK_EPSILON_SECONDS = 1 / 60;

/** While playing forward the element owns the clock; only gross drift is corrected. */
const DRIFT_TOLERANCE_SECONDS = 0.25;

type SlotIndex = 0 | 1;

interface Pool {
  srcs: [string, string];
  active: SlotIndex;
}

const otherSlot = (i: SlotIndex): SlotIndex => (i === 0 ? 1 : 0);

/**
 * The pool assignment for a given (current, next) pair, derived from the previous
 * assignment. Pure and idempotent — `derivePool(derivePool(p, u, n), u, n)` returns the
 * same object — which is what lets it run during render instead of in an effect.
 *
 * It MUST run during render. Committing the swap from an effect leaves one committed
 * render in which the clip is the new one but the pool is still the old one, so `playable`
 * is false, neither element is active, and the stage paints bare well — a black frame at
 * every cut, which is the exact thing the two-element pool and `parkIdle` exist to
 * prevent. Returns `prev` by identity when nothing moved, so effect dependencies on the
 * pool stay stable.
 */
function derivePool(prev: Pool, currentUrl: string, nextUrl: string): Pool {
  const srcs: [string, string] = [prev.srcs[0], prev.srcs[1]];
  let active = prev.active;

  if (currentUrl !== '' && srcs[active] !== currentUrl) {
    const idle = otherSlot(active);
    // The preloaded slot already holds it: swap instead of reloading, which is the
    // whole point of the pool — the cut lands on a decoded frame.
    if (srcs[idle] === currentUrl) active = idle;
    else srcs[active] = currentUrl;
  }

  const idle = otherSlot(active);
  if (nextUrl !== '' && nextUrl !== srcs[active] && srcs[idle] !== nextUrl) {
    srcs[idle] = nextUrl;
  }

  if (srcs[0] === prev.srcs[0] && srcs[1] === prev.srcs[1] && active === prev.active) {
    return prev;
  }
  return { srcs, active };
}

export interface VideoSurfaceProps {
  /**
   * Published to the playback clock, which derives the playhead from this element's
   * currentTime during forward playback. Null whenever nothing playable is on screen.
   */
  activeVideoRef: MutableRefObject<HTMLVideoElement | null>;
}

export function VideoSurface({ activeVideoRef }: VideoSurfaceProps): ReactElement {
  /* ---------------------------------------------------------- what to show */

  const clipId = useEditorStore((s) => selectVideoClipIdAtFrame(s, s.playhead));
  const nextClipId = useEditorStore((s) => selectNextVideoClipIdAfter(s, s.playhead));

  const clip = useEditorStore(
    useCallback((s) => (clipId ? (s.clips[clipId] ?? null) : null), [clipId]),
  );
  const nextClip = useEditorStore(
    useCallback((s) => (nextClipId ? (s.clips[nextClipId] ?? null) : null), [nextClipId]),
  );
  const media = useEditorStore(
    useCallback((s) => (clip ? (s.items[clip.mediaId] ?? null) : null), [clip]),
  );
  const nextMedia = useEditorStore(
    useCallback((s) => (nextClip ? (s.items[nextClip.mediaId] ?? null) : null), [nextClip]),
  );

  const projectWidth = useEditorStore((s) => s.width);
  const projectHeight = useEditorStore((s) => s.height);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const rate = useEditorStore((s) => s.rate);
  const volume = useEditorStore((s) => s.volume);
  const muted = useEditorStore((s) => s.muted);

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

  const poolRef = useRef<Pool>({ srcs: ['', ''], active: 0 });
  const nextClipRef = useRef(nextClip);

  const elements = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const lastReverseSeekMs = useRef(0);

  // Derived, not stored: the swap lands in the SAME render that changed the clip, so the
  // preloaded element is already the active one on the first paint after a cut.
  const pool = derivePool(poolRef.current, currentUrl, nextUrl);
  const playable = currentUrl !== '' && pool.srcs[pool.active] === currentUrl;

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
    const id = selectVideoClipIdAtFrame(s, s.playhead);
    const current = id ? s.clips[id] : undefined;
    if (!current) return;

    const item = s.items[current.mediaId];
    if (!item || item.status === 'error' || item.url === '') return;
    // Only sync when the on-screen slot is actually holding this clip's source.
    if (item.url !== poolRef.current.srcs[poolRef.current.active]) return;

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

  useEffect(() => {
    elements.current.forEach((el, index) => {
      if (!el) return;
      el.volume = volume;
      el.muted = muted || index !== pool.active;
    });
  }, [volume, muted, pool]);

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
      if (index === poolRef.current.active) syncTime(true);
      else parkIdle();
    },
    [parkIdle, syncTime],
  );

  /**
   * A source that probed fine but will not decode. Without this the user gets a black
   * stage that is indistinguishable from a gap while the transport keeps running.
   *
   * It reports through the two channels that already exist — the media item goes to
   * `status: 'error'`, which fires the media rail's Unplug + 'Offline' row treatment and
   * the offline texture on every clip cut from it, plus one notice in the titlebar strip.
   * No error surface is invented in the well (PLAN §8.14): the well stays the frame.
   */
  const handleDecodeError = useCallback(
    (index: SlotIndex) => (): void => {
      const src = elements.current[index]?.getAttribute('src');
      if (!src) return;

      const s = readStore();
      const item = Object.values(s.items).find((candidate) => candidate.url === src);
      if (!item || item.status === 'error') return; // already reported; do not re-notice

      const message = `${item.name} could not be decoded`;
      s.updateItem(item.id, {
        status: 'error',
        error: { code: 'unsupported-codec', message },
      });
      s.setNotice({ tone: 'danger', title: 'Cannot play clip', message });
      if (s.isPlaying) s.pause();
    },
    [],
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
  const frameStyle: CSSProperties = clip
    ? {
        opacity: clip.properties.opacity,
        transform: [
          `translate(${clip.properties.positionX * scaleToStage}px, ${
            clip.properties.positionY * scaleToStage
          }px)`,
          `rotate(${clip.properties.rotation}deg)`,
          `scale(${clip.properties.scale})`,
        ].join(' '),
      }
    : {};

  const label = clip
    ? online
      ? `Preview, ${clip.name}`
      : `Preview, ${clip.name}, source is offline`
    : 'Preview, no clip under the playhead';

  return (
    <div className="ve-video-surface" ref={boxRef}>
      <div
        className="ve-video-stage"
        role="img"
        aria-label={label}
        style={{ width: `${stageWidth}px`, height: `${stageHeight}px` }}
      >
        {([0, 1] as SlotIndex[]).map((index) => (
          <video
            key={index}
            ref={(el) => {
              elements.current[index] = el;
            }}
            className="ve-video-el"
            data-active={index === pool.active && playable ? 'true' : undefined}
            src={pool.srcs[index] === '' ? undefined : pool.srcs[index]}
            style={index === pool.active && playable ? frameStyle : undefined}
            preload="auto"
            playsInline
            disablePictureInPicture
            onLoadedMetadata={handleLoadedMetadata(index)}
            onError={handleDecodeError(index)}
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
      </div>
    </div>
  );
}
