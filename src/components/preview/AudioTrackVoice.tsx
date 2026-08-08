/* ---------------------------------------------------------------------------
   AudioTrackVoice — one track's pooled pair of <audio> elements.
   docs/AUDIO-MONITOR.md §2.2, §2.4, §7.1.

   Two elements per track, mirroring VideoSurface's two-<video> pool, because the
   audio problem is the same problem: arbitrary source in-points, cuts that must
   not gap, seeks that must not click. One track can have at most one clip under
   the playhead — clips on a track cannot overlap — so one active slot plus one
   preload slot is exactly sufficient, and that is why the pool is per track.

   This file owns the DOM: `derivePool` during render, `parkIdle`, the `seeked`
   handler and its backstop, and the `error` / `loadedmetadata` handlers. It owns
   NO timing policy: the reference clock, the gain law, the drift controller and
   the transport all live in useAudioMonitor, which reaches these elements
   through the registry.

   It schedules no animation frames of its own and writes nothing to the playhead.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { MutableRefObject, ReactElement } from 'react';
import type { TrackId } from '../../types/model';
import { readStore, useEditorStore } from '../../state/store';
import { framesToSeconds } from '../../lib/time';
import {
  selectClipIdInTrackAtFrame,
  selectNextClipIdInTrackAfter,
  selectVideoClipIdAtFrame,
} from '../../state/timelineSlice';
import {
  EMPTY_POOL,
  EMPTY_SLOT,
  PRELOAD_LEAD_IN_MS,
  TRANSIENT_RELOAD_ATTEMPTS,
  deadBandMs,
  derivePool,
  makeSlotState,
  monitorAudible,
  otherSlot,
  releaseFade,
  sourceContiguous,
} from './audioMonitor';
import type { Pool, Slot, SlotIndex, SlotState, VoiceEntry, VoiceRegistry } from './audioMonitor';

/** `MediaError.code`, spelled out. Mirrors VideoSurface exactly (§7.1). */
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const SLOTS: readonly SlotIndex[] = [0, 1];

export interface AudioTrackVoiceProps {
  trackId: TrackId;
  registryRef: MutableRefObject<VoiceRegistry>;
}

export function AudioTrackVoice({ trackId, registryRef }: AudioTrackVoiceProps): ReactElement | null {
  /* --------------------------------------------------------- what to carry */

  // Both of these are [stable] ClipId | null, so this component renders at clip
  // boundaries, not at frame rate — the same subscription shape VideoSurface uses.
  const clipId = useEditorStore(
    useCallback((s) => selectClipIdInTrackAtFrame(s, trackId, s.playhead), [trackId]),
  );
  const nextClipId = useEditorStore(
    useCallback((s) => selectNextClipIdInTrackAfter(s, trackId, s.playhead), [trackId]),
  );
  // §2.3: the clip on screen has its sound carried by the <video> and by nothing else.
  const clockClipId = useEditorStore((s) => selectVideoClipIdAtFrame(s, s.playhead));

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
  const track = useEditorStore(useCallback((s) => s.tracks[trackId] ?? null, [trackId]));
  const hasClips = useEditorStore(
    useCallback((s) => (s.clipsByTrack[trackId]?.length ?? 0) > 0, [trackId]),
  );

  /**
   * A slot only ever acquires a source for a clip that passes `monitorAudible`. That is
   * §2.2's "a track whose clips are all inaudible still gets its pair, but both slots
   * carry no src and cost nothing", and §7.4's "offline media: no element is allocated,
   * no src is set, no error is raised, and nothing is reported — because it is ALREADY
   * reported, by machinery that exists".
   *
   * Note what is NOT in this test: master mute, master volume and the transport. Those
   * zero the GAIN (§5.1) and must never drop a source — a muted preview that had to
   * reload every voice on unmute would stall the first second of playback.
   */
  const currentAudible =
    clip !== null && media !== null && track !== null && monitorAudible(clip, track, media);
  const nextAudible =
    nextClip !== null &&
    nextMedia !== null &&
    track !== null &&
    monitorAudible(nextClip, track, nextMedia);

  const currentSlot: Slot =
    currentAudible && clip && media ? { url: media.url, clipId: clip.id } : EMPTY_SLOT;
  const nextSlot: Slot =
    nextAudible && nextClip && nextMedia
      ? { url: nextMedia.url, clipId: nextClip.id }
      : EMPTY_SLOT;

  /* ------------------------------------------------------------- the pool */

  const poolRef = useRef<Pool>(EMPTY_POOL);
  const elements = useRef<[HTMLAudioElement | null, HTMLAudioElement | null]>([null, null]);
  const slotState = useRef<[SlotState, SlotState]>([makeSlotState(), makeSlotState()]);
  const reloadAttempts = useRef(new Map<string, number>());

  /**
   * The outgoing clip, read back out of the committed pool. Reading the store during
   * render is safe here for one reason and one reason only: if the clip has been deleted
   * the lookup yields undefined, `sourceContiguous` returns false, and the pool swaps —
   * the safe direction.
   */
  const outgoingId = poolRef.current.slots[poolRef.current.active].clipId;
  const contiguous = sourceContiguous(outgoingId ? readStore().clips[outgoingId] : null, clip);

  // Derived, not stored: the swap lands in the SAME render that changed the clip.
  const pool = derivePool(poolRef.current, currentSlot, nextSlot, contiguous);

  /* --------------------------------------------------------- §2.2.2 preload */

  const nextStart = nextClip?.start ?? null;
  // A boolean, so this re-renders when the lead-in is crossed and not on every frame.
  const nextWithinLeadIn = useEditorStore(
    useCallback(
      (s) => {
        if (nextStart === null || s.fps <= 0) return false;
        return ((nextStart - s.playhead) / s.fps) * 1000 <= PRELOAD_LEAD_IN_MS;
      },
      [nextStart],
    ),
  );

  /**
   * An <audio> pointed at an .mp4 is not an audio-only decoder: Chromium builds the same
   * WebMediaPlayer it builds for <video> and demuxes the container it is given. So an
   * unconditional preload costs, for one video file at a cut, up to THREE live pipelines
   * on the same bytes — the video pool's two slots plus a voice slot.
   *
   * The cost is bounded by the `preload` attribute rather than by withholding `src`,
   * deliberately: withholding would push the clock-clip predicate into the pool, where
   * §2.2.1's rules would need a fourth case. A demoted slot keeps its src, which is what
   * makes promotion a one-attribute change rather than a reload when ownership flips.
   */
  const preloadFor = (index: SlotIndex): 'auto' | 'metadata' => {
    // An audio-only source is the cheap case, and it is the case the feature exists for.
    if (track?.kind === 'audio') return 'auto';
    const id = pool.slots[index].clipId;
    if (id === null || id === clockClipId) return 'metadata';
    if (id === clipId) return 'auto';
    if (id === nextClipId) return nextWithinLeadIn ? 'auto' : 'metadata';
    return 'metadata';
  };

  /* ------------------------------------------------------- registry + refs */

  /**
   * §2.3: the clip on screen has its sound carried by the `<video>` and by nothing else.
   * Both sides compute the predicate from the same selector, so they cannot disagree and
   * no registry field is needed to arbitrate — but the ANSWER is published, from the same
   * render as the pool, so the engine is never reading a fresh predicate against a stale
   * pool. The slot may still hold the src (test 10.1(b)); it may not sound.
   */
  const liveClipId =
    currentAudible && clip && clip.id !== clockClipId ? clip.id : null;

  const entryRef = useRef<VoiceEntry>({
    trackId,
    elements: elements.current,
    slotState: slotState.current,
    pool: EMPTY_POOL,
    liveClipId: null,
  });

  useLayoutEffect(() => {
    const registry = registryRef.current;
    registry.voices.set(trackId, entryRef.current);
    return () => {
      for (const el of elements.current) el?.pause();
      registry.voices.delete(trackId);
    };
  }, [registryRef, trackId]);

  /**
   * Refs only ever hold committed values (writing them during render can leave them
   * holding a value from a render React discarded), and the engine is poked from here
   * rather than from the store subscription — so every store write the monitor could
   * provoke lands after the notification pass, never inside it (§7.5).
   */
  useLayoutEffect(() => {
    poolRef.current = pool;
    entryRef.current.pool = pool;
    entryRef.current.liveClipId = liveClipId;
    registryRef.current.pass();
  }, [registryRef, pool, liveClipId, clip, media, track]);

  /* ------------------------------------------------------------- parkIdle */

  /**
   * Park the idle element on the first frame of the clip it is preloading. Without it
   * the first play() after a cut starts at source zero and blurts the wrong material.
   */
  const parkIdle = useCallback((): void => {
    const index = otherSlot(poolRef.current.active);
    const idle = elements.current[index];
    const upcomingId = poolRef.current.slots[index].clipId;
    if (!idle || upcomingId === null || idle.getAttribute('src') === null) return;
    const s = readStore();
    const upcoming = s.clips[upcomingId];
    if (!upcoming) return;
    if (!idle.paused) idle.pause();
    const target = framesToSeconds(upcoming.mediaIn, s.fps);
    if (!Number.isFinite(target) || target < 0) return;
    if (Math.abs(idle.currentTime - target) > deadBandMs(s.fps) / 1000) idle.currentTime = target;
  }, []);

  useEffect(() => {
    parkIdle();
  }, [parkIdle, pool]);

  /**
   * A slot that lost its source must be told to let go of it. Removing the `src`
   * attribute does not by itself stop playback or release the decoder's file handle —
   * `load()` does, and that is also RENAME.md's step 2.
   */
  useEffect(() => {
    for (const index of SLOTS) {
      const el = elements.current[index];
      if (!el) continue;
      if (pool.slots[index].url === '' && el.currentSrc !== '') {
        el.pause();
        el.load();
      }
    }
  }, [pool]);

  /* ------------------------------------------------------ element handlers */

  const handleSeeked = useCallback(
    (index: SlotIndex) => (): void => {
      // The normal path out of a faded hard seek. It is what keeps the volume restore
      // from landing one or two ticks BEFORE the new samples do.
      releaseFade(elements.current[index], slotState.current[index]);
    },
    [],
  );

  const handleLoadedMetadata = useCallback(
    (index: SlotIndex) => (): void => {
      const src = elements.current[index]?.getAttribute('src');
      // This source just loaded, so whatever failed before is spent.
      if (src) reloadAttempts.current.delete(src);
      if (index === poolRef.current.active) {
        // A fresh load sits at source zero. Tell the engine to reposition it, bypassing
        // the settle window and the rate limit but not the dead band.
        slotState.current[index].forcePosition = true;
        registryRef.current.pass();
      } else {
        parkIdle();
      }
    },
    [parkIdle, registryRef],
  );

  /**
   * §7.1. Mirrors VideoSurface.handleMediaError — same four codes, same two transient
   * reloads per source URL, same "an idle slot never condemns anything".
   *
   * Two deliberate differences, both from §7.1:
   *  - an audio failure never calls pause(). Sound failing on one of six tracks is not a
   *    reason to stop the edit; a picture failure is, because there is nothing to look at.
   *  - the title is 'Cannot play audio', so two simultaneous failures on one file are
   *    distinguishable in the notice strip.
   *
   * These two writes run from the element's own `error` event, which is genuinely
   * asynchronous and outside the playhead notification pass, so they are written
   * directly. They are the ONLY store writes in this feature that are not deferred.
   */
  const handleError = useCallback(
    (index: SlotIndex) => (): void => {
      const el = elements.current[index];
      const src = el?.getAttribute('src');
      if (!el || !src) return; // detached: there is no source, so nothing failed

      const code = el.error?.code ?? MEDIA_ERR_DECODE;
      if (code === MEDIA_ERR_ABORTED) return; // us: the rename protocol's own step

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
        slotState.current[index].forcePosition = true;
        registryRef.current.pass();
        return;
      }

      const s = readStore();
      const item = Object.values(s.items).find((candidate) => candidate.url === src);
      // Already reported — this is what stops the video pool and a voice from
      // double-reporting the same file.
      if (!item || item.status === 'error') return;

      const [errorCode, message] =
        code === MEDIA_ERR_NETWORK
          ? (['not-found', `${item.name} could not be read from disk`] as const)
          : (['unsupported-codec', `${item.name} could not be decoded`] as const);

      s.updateItem(item.id, { status: 'error', error: { code: errorCode, message } });
      s.setNotice({ tone: 'danger', title: 'Cannot play audio', message });
    },
    [parkIdle, registryRef],
  );

  /* ---------------------------------------------------------------- render */

  // A track with no clips gets no voice at all (§2.2). Every hook above has already run.
  if (!hasClips) return null;

  return (
    <div aria-hidden="true" data-audio-voice="" data-track-id={trackId}>
      {SLOTS.map((index) => (
        <audio
          key={index}
          ref={(el) => {
            elements.current[index] = el;
          }}
          data-slot={index}
          src={pool.slots[index].url === '' ? undefined : pool.slots[index].url}
          preload={preloadFor(index)}
          onLoadedMetadata={handleLoadedMetadata(index)}
          onSeeked={handleSeeked(index)}
          onError={handleError(index)}
        />
      ))}
    </div>
  );
}
