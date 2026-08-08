/* ---------------------------------------------------------------------------
   useAudioMonitor — the preview mix engine. docs/AUDIO-MONITOR.md §3, §4, §5, §7.

   THE THREE CONSTRAINTS THIS IS BUILT AROUND, restated here so they cannot be
   lost by anyone editing this file:

   1. The playhead has exactly ONE owner: playbackSlice. This module READS it and
      never writes it. It calls no transport action and exports no setter.
   2. There is exactly ONE animation-frame loop: usePlaybackClock. This module
      adds none. It runs from useEditorStore.subscribe(s => s.playhead), which is
      DRIVEN BY that loop and fires at most once per advanced frame — the same
      mechanism VideoSurface.syncTime already uses. A grep for the frame-scheduling
      API across this directory must still return exactly one file, and this one
      deliberately does not name it.
   3. The source-mapping invariant (PLAN §2.4 invariant 3) is the only expression
      permitted, in both directions, for audio as for picture. Frames are
      integers; MediaItem.fps never appears.

   And a fourth: no path that runs inside the playhead subscription may call a
   store action. zustand runs subscribeWithSelector listeners synchronously
   inside `set`, so a setNotice from the tick is a nested setState during
   listener notification — the exact hazard usePlaybackClock's `selfWriting` flag
   exists to document. Every notice this module raises is deferred through
   `defer` (§7.5).
--------------------------------------------------------------------------- */

import { useEffect } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { Clip, Track, TrackId } from '../../types/model';
import { clipHasAudio } from '../../types/model';
import type { StoreState } from '../../state/types';
import type { Notice } from '../../state/uiSlice';
import { readStore, useEditorStore } from '../../state/store';
import { selectVideoClipIdAtFrame } from '../../state/timelineSlice';
import { ELEMENT_LAG_TOLERANCE_FRAMES } from './usePlaybackClock';
import {
  DRIFT_CHECK_INTERVAL_MS,
  DRIFT_HARD_SEEK_MS,
  DRIFT_TRIM_MAX,
  DRIFT_TRIM_WINDOW_MS,
  EXTERNAL_SEEK_SLACK_FRAMES,
  HARD_SEEK_MIN_INTERVAL_MS,
  IDLE_REPOSITION_INTERVAL_MS,
  MAX_AUDIBLE_SOURCES,
  NON_TRACKING_RECOVER_MS,
  NON_TRACKING_SEEKS,
  NON_TRACKING_WINDOW_MS,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  STALL_MUTE_MS,
  START_SETTLE_MS,
  clamp,
  deadBandMs,
  driftSeconds,
  effectiveGain,
  elementTimelineSeconds,
  hardSeek,
  median,
  monitorAudible,
  pushDrift,
  sourceSecondsForTimeline,
  transportSilent,
  writeElement,
} from './audioMonitor';
import type { SlotIndex, SlotState, VoiceEntry, VoiceRegistry } from './audioMonitor';

const SLOTS: readonly SlotIndex[] = [0, 1];

interface Candidate {
  entry: VoiceEntry;
  index: SlotIndex;
  clip: Clip;
  track: Track;
  /** `speed × |rate|`, before the drift trim. */
  base: number;
}

export function useAudioMonitor(
  activeVideoRef: RefObject<HTMLVideoElement | null>,
  registryRef: MutableRefObject<VoiceRegistry>,
): void {
  useEffect(() => {
    const registry = registryRef.current;

    let lastTickMs = performance.now();
    let lastPlayheadFrame = readStore().playhead;
    /** True while Chromium's autoplay policy is refusing us. See §7.2. */
    let blocked = false;
    /** True while an 'Audio blocked' notice is outstanding. Cleared by a SUCCESSFUL play. */
    let blockNoticed = false;
    /** Increments on every isPlaying false -> true. Notices are once per element per run. */
    let run = 0;
    let capNoticedRun = -1;
    let startPending = false;
    let trailing = 0;
    let disposed = false;

    /* ---------------------------------------------------- §7.5 deferred writes */

    const pending: { notice: Notice | null; flushing: boolean } = { notice: null, flushing: false };

    const defer = (notice: Notice): void => {
      pending.notice = notice;
      if (pending.flushing) return;
      pending.flushing = true;
      queueMicrotask(() => {
        const n = pending.notice;
        pending.notice = null;
        pending.flushing = false;
        if (n && !disposed) readStore().setNotice(n);
      });
    };

    /* ------------------------------------------------------ §3.1 the reference */

    /**
     * Continuous timeline position, in seconds. Read-only, never rounded to a frame.
     *
     * Two branches. With the video element live, audio locks to the picture and the
     * reference has no quantisation. With no trusted element — a gap, an audio-only
     * region, the reverse path, an element that has not arrived after a cut — the
     * reference is `playhead / fps`, which in exactly those cases is what
     * usePlaybackClock's wall-clock integrator is producing.
     *
     * The trust test is usePlaybackClock's own, so both clocks agree on which one is
     * live, and it is ONE-SIDED exactly as it is there. Math.abs here would be a bug: if
     * this rejected an element running two frames AHEAD, usePlaybackClock would accept it
     * and pull the playhead forward while this had already fallen back to the wall clock
     * — picture following the element, audio following the wall clock, the two pulling
     * apart by design.
     */
    const referenceSeconds = (s: StoreState): number => {
      const playheadSeconds = s.playhead / s.fps;
      const el = activeVideoRef.current;
      const clipId = selectVideoClipIdAtFrame(s, s.playhead);
      const clip = clipId ? s.clips[clipId] : undefined;
      const media = clip ? s.items[clip.mediaId] : undefined;

      if (!el || el.paused || el.seeking || el.readyState < 2) return playheadSeconds;
      if (!clip || !media || media.status === 'error' || media.url === '') return playheadSeconds;
      // NOTE: this url test alone does NOT catch a same-source cut — both clips share a
      // url. What catches that is `activeVideoRef` being null until the pool has swapped,
      // which holds because VideoSurface's `playable` is defined in terms of the slot's
      // CLIP ID. If that is ever weakened back to a url comparison, this guard silently
      // stops working.
      if (el.getAttribute('src') !== media.url) return playheadSeconds;

      const elementSeconds = elementTimelineSeconds(clip, el.currentTime, s.fps);
      if (!Number.isFinite(elementSeconds)) return playheadSeconds;
      const lagFrames = (elementSeconds - playheadSeconds) * s.fps;
      return lagFrames >= -ELEMENT_LAG_TOLERANCE_FRAMES ? elementSeconds : playheadSeconds;
    };

    /* ------------------------------------------------------------- §7.4 verdict */

    const markNonTracking = (st: SlotState, clip: Clip): void => {
      if (st.nonTracking) return;
      st.nonTracking = true;
      st.inBandSinceMs = 0;
      if (st.noticedRun === run) return;
      st.noticedRun = run;
      defer({
        tone: 'warning',
        title: 'Audio dropped',
        message: `${clip.name} is not keeping up and has been muted`,
      });
    };

    /* --------------------------------------------------------------- §7.2 start */

    const onPlayRejected = (err: unknown): void => {
      const name = (err as { name?: string } | null)?.name;
      // Anything else (an AbortError from a pause() racing a play()) is swallowed: the
      // element's own `error` event owns reporting, so there is one path to the user.
      if (name !== 'NotAllowedError') return;
      blocked = true;
      if (blockNoticed) return;
      blockNoticed = true;
      defer({
        tone: 'warning',
        title: 'Audio blocked',
        message: 'Click in the window to enable preview audio',
      });
    };

    /* ------------------------------------------------------------- silent slot */

    const silence = (el: HTMLAudioElement, st: SlotState): void => {
      st.desired = { gain: 0, rate: st.desired.rate, pitch: st.desired.pitch };
      writeElement(el, st, st.desired);
      if (!el.paused) el.pause();
      st.playStartedMs = 0;
      st.settled = false;
      st.stallSinceMs = 0;
      st.drift.length = 0;
      st.trim = 0;
    };

    /* ------------------------------------------------------------- THE ONE PASS */

    const pass = (): void => {
      if (disposed) return;
      const s = readStore();
      const now = performance.now();

      /*
        §3.4. The external-seek detector NEVER looks at the reference, and this is the
        first statement in the pass for that reason. The reference switches branches
        between continuous elementSeconds and staircase playheadSeconds whenever the video
        element crosses the trust boundary, pauses, seeks, drops below readyState 2, or
        has not yet swapped src at a cut — a step discontinuity that happens at every cut,
        and that a reference-comparing detector cannot tell from a real timecode entry.
        Measured against elapsed WALL TIME, it scales with the shuttle rate and with a
        long frame automatically; and backwards is always a jump, because usePlaybackClock
        guarantees the playhead is monotonic while rate > 0.
      */
      const elapsedFrames = ((now - lastTickMs) / 1000) * s.fps * Math.abs(s.rate);
      const delta = s.playhead - lastPlayheadFrame;
      const jumped =
        s.isPlaying && s.rate > 0
          ? delta < 0 || delta > elapsedFrames + EXTERNAL_SEEK_SLACK_FRAMES
          : false; // paused: §4.3's throttled silent reposition already covers every case
      lastTickMs = now;
      lastPlayheadFrame = s.playhead;

      const startingRun = startPending;
      startPending = false;

      const silent = transportSilent(s.rate);
      const running = s.isPlaying && !silent;
      const reference = referenceSeconds(s);
      const bandMs = deadBandMs(s.fps);
      const bandSeconds = bandMs / 1000;
      const clockClipId = selectVideoClipIdAtFrame(s, s.playhead);

      /* ---- who wants to sound (§1.1, §2.3, §4.4) */

      const audioVoices: Candidate[] = [];
      const videoVoices: Candidate[] = [];

      for (const trackId of s.trackOrder) {
        const entry = registry.voices.get(trackId);
        const track = s.tracks[trackId];
        if (!entry || !track) continue;
        const index = entry.pool.active;
        const el = entry.elements[index];
        const slot = entry.pool.slots[index];
        // `liveClipId` carries §1.1's audibility, "is under the playhead", and §2.3's
        // clock-clip exclusion, all decided in the same render that produced `pool`. It
        // must be compared against the slot rather than recomputed here: the pool
        // deliberately keeps holding the OUTGOING clip over a gap, so without this the
        // voice plays that clip straight through the gap after it.
        if (!el || slot.clipId === null || slot.clipId !== entry.liveClipId) continue;
        const clip = s.clips[slot.clipId];
        if (!clip) continue;
        const media = s.items[clip.mediaId];
        if (!media || !monitorAudible(clip, track, media)) continue;
        if (slot.url !== media.url) continue; // the pool has not caught up yet
        // §4.4: a rate the element cannot honour is a SILENT voice, not a clamped one.
        // Clamping would advance the audio at half the timeline rate while the picture
        // ran at the timeline rate, and §7.4 would then blame the clip.
        const base = (clip.properties.speed || 1) * Math.abs(s.rate);
        if (!(base >= PLAYBACK_RATE_MIN && base <= PLAYBACK_RATE_MAX)) continue;
        (track.kind === 'audio' ? audioVoices : videoVoices).push({
          entry,
          index,
          clip,
          track,
          base,
        });
      }

      /* ---- §7.3 the cap. Clock clip first, then audio tracks, then video tracks. */

      const total = audioVoices.length + videoVoices.length;
      // The reserved slot is for the <video> element's own sound. A video-only
      // clock clip has just been forced to gain 0 in VideoSurface, so reserving
      // for it would spend a monitored voice on silence and report the cap one
      // clip early. Same fact as VideoSurface's `clipVolume`, read the same way.
      const clockClip = clockClipId !== null ? s.clips[clockClipId] : undefined;
      const clockAudible = clockClip !== undefined && clipHasAudio(clockClip);
      const budget = Math.max(0, MAX_AUDIBLE_SOURCES - (clockAudible ? 1 : 0));
      const chosen = [...audioVoices, ...videoVoices].slice(0, budget);
      if (chosen.length < total && capNoticedRun !== run) {
        capNoticedRun = run;
        defer({
          tone: 'warning',
          title: 'Audio limited',
          message: 'Only 8 clips are monitored at once, but the export mixes all of them',
        });
      }
      const picked = new Map<TrackId, Candidate>();
      for (const c of chosen) picked.set(c.entry.trackId, c);

      /* ---- act */

      let throttled = false;

      for (const trackId of s.trackOrder) {
        const entry = registry.voices.get(trackId);
        if (!entry) continue;
        const candidate = picked.get(trackId);

        for (const index of SLOTS) {
          const el = entry.elements[index];
          const st = entry.slotState[index];
          if (!el) continue;

          // The idle slot is always gain 0 and paused, exactly as VideoSurface's is; so
          // is any slot whose clip is inaudible, offline, the clock clip's, or at a rate
          // the element cannot honour.
          if (!candidate || candidate.index !== index) {
            silence(el, st);
            continue;
          }

          const { clip, track, base } = candidate;

          /*
            §4.3 / §4.1 / §4.2: paused, scrubbing, stepping, reverse, or 8x.

            `blocked` belongs in this branch and not in the live one. While the autoplay
            policy is refusing us, no voice attempts play() — so the element stands still
            while the reference advances, and running the drift controller against it
            would hard-seek it every 500 ms and declare it non-tracking within three
            seconds. The user would get 'Audio dropped' about a clip that is fine, on top
            of the 'Audio blocked' notice that is actually true. Repositioning it silently
            here is also what puts it on the right sample for the moment the gesture lands.
          */
          if (!running || blocked) {
            silence(el, st);
            // Voices still reposition SILENTLY while paused, so the next play() starts on
            // the right sample instead of seeking first. This is the audio counterpart of
            // parkIdle: prefetch, not playback. Throttled, because unthrottled it is 60
            // currentTime writes per second per voice during a scrub.
            if (now - st.lastRepositionMs < IDLE_REPOSITION_INTERVAL_MS) {
              throttled = true;
            } else if (el.readyState >= 1 && !el.seeking) {
              st.lastRepositionMs = now;
              const target = sourceSecondsForTimeline(clip, s.playhead / s.fps, s.fps);
              if (
                Number.isFinite(target) &&
                target >= 0 &&
                Math.abs(el.currentTime - target) > bandSeconds
              ) {
                el.currentTime = target;
              }
            }
            continue;
          }

          /* -- settle (§3.2). No correction of any kind inside this window: play()
                resolves asynchronously and elements do not all start on the same tick. */
          if (st.playStartedMs !== 0 && !st.settled && now - st.playStartedMs >= START_SETTLE_MS) {
            st.settled = true;
            // Cleared when the window EXPIRES, so the first correction afterwards is
            // computed only from samples taken after the element was up.
            st.drift.length = 0;
          }
          const settling = st.playStartedMs !== 0 && !st.settled;

          /* -- §7.4 stall */
          if (el.readyState < 2) {
            if (st.stallSinceMs === 0) st.stallSinceMs = now;
            else if (now - st.stallSinceMs > STALL_MUTE_MS) markNonTracking(st, clip);
          } else {
            st.stallSinceMs = 0;
          }

          /* -- §3.2 drift */
          const measurable = el.readyState >= 2 && !el.seeking && !st.fadeUntilSeeked;
          const drift = measurable ? driftSeconds(reference, clip, el.currentTime, s.fps) : 0;
          if (measurable && !settling) pushDrift(st, drift);

          if (st.nonTracking) {
            // Recovery is automatic: a continuous second inside the dead band clears it.
            if (measurable && Math.abs(drift) <= bandSeconds) {
              if (st.inBandSinceMs === 0) st.inBandSinceMs = now;
              else if (now - st.inBandSinceMs >= NON_TRACKING_RECOVER_MS) {
                st.nonTracking = false;
                st.inBandSinceMs = 0;
              }
            } else {
              st.inBandSinceMs = 0;
            }
          }

          if (measurable) {
            const forced = jumped || startingRun || st.forcePosition;
            st.forcePosition = false;
            if (forced) {
              // An external seek and a fresh load have one remedy regardless of which
              // side moved: put the element where the reference is. Rate limit and settle
              // window bypassed; the dead band is not, so a pool swap that landed on a
              // correctly parked element is left alone.
              if (Math.abs(drift) > bandSeconds) {
                hardSeek(el, st, sourceSecondsForTimeline(clip, reference, s.fps), now);
                st.playStartedMs = now;
                st.settled = false;
              } else {
                st.drift.length = 0;
                st.trim = 0;
              }
            } else if (
              !settling &&
              st.drift.length > 0 &&
              now - st.lastCorrectionMs >= DRIFT_CHECK_INTERVAL_MS
            ) {
              // The controller is fed a MEDIAN, not raw samples: one sample taken across
              // a decode hiccup is an outlier of tens of milliseconds, and a mean carries
              // it into the correction while a median discards it for free.
              const m = median(st.drift);
              st.drift.length = 0;
              st.lastCorrectionMs = now;
              const magnitudeMs = Math.abs(m) * 1000;
              if (magnitudeMs < bandMs) {
                st.trim = 0;
              } else if (magnitudeMs <= DRIFT_HARD_SEEK_MS) {
                st.trim = clamp(
                  m / (DRIFT_TRIM_WINDOW_MS / 1000),
                  -DRIFT_TRIM_MAX,
                  DRIFT_TRIM_MAX,
                );
              } else if (now - st.lastHardSeekMs >= HARD_SEEK_MIN_INTERVAL_MS) {
                hardSeek(el, st, sourceSecondsForTimeline(clip, reference, s.fps), now);
                const cutoff = now - NON_TRACKING_WINDOW_MS;
                st.hardSeekTimes = st.hardSeekTimes.filter((t) => t >= cutoff);
                if (st.hardSeekTimes.length > NON_TRACKING_SEEKS) markNonTracking(st, clip);
              }
            }
          }

          /* -- §5.1 gain, §4.2 pitch, §4.4 rate — through the ONE writer */
          st.desired = {
            // A non-tracking element is muted but left running, so it cannot blurt out of
            // position when it recovers.
            gain: st.nonTracking
              ? 0
              : effectiveGain(clip.properties.volume, track.muted, s.volume, s.muted, silent),
            // The clamp is a guard for the ±2 % the trim can add at the top of the range:
            // 16 × 1.02 is out of range and must not throw.
            rate: clamp(base * (1 + st.trim), PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX),
            // At normal speed clip `speed` is pitch-preserved, matching export's atempo
            // chain. A shuttle is a locating gesture, not a render, and tape-style pitch
            // rise is the convention users expect from it.
            pitch: Math.abs(s.rate) === 1,
          };
          writeElement(el, st, st.desired);

          /* -- transport. play() sets `paused` false synchronously, so this issues at
                most one call per start and never storms. */
          if (el.paused && !blocked) {
            st.playStartedMs = now;
            st.settled = false;
            st.drift.length = 0;
            void el
              .play()
              .then(() => {
                blocked = false;
                blockNoticed = false;
              })
              .catch(onPlayRejected);
          }
        }
      }

      // The trailing call, so the last position of a scrub lands even though the gesture
      // stopped inside the throttle window.
      if (throttled && trailing === 0) {
        trailing = window.setTimeout(() => {
          trailing = 0;
          pass();
        }, IDLE_REPOSITION_INTERVAL_MS);
      }
    };

    registry.pass = pass;

    /* --------------------------------------------------------- subscriptions */

    // Driven BY the one rAF loop, not a second one: usePlaybackClock's tick writes the
    // playhead and zustand notifies this synchronously, at most once per advanced frame.
    const unsubscribePlayhead = useEditorStore.subscribe((s) => s.playhead, pass);

    const unsubscribePlaying = useEditorStore.subscribe(
      (s) => s.isPlaying,
      (playing) => {
        // Re-seed both jump-detector anchors, so a start never reads as an external seek.
        lastTickMs = performance.now();
        lastPlayheadFrame = readStore().playhead;
        if (playing) {
          run += 1;
          startPending = true;
          // §7.2 rule 2: `blocked` is cleared by the events that actually change the
          // browser's answer, never by a successful start — a flag that suppresses the
          // only code that could produce a success can never be cleared by one.
          blocked = false;
        }
        pass();
      },
    );

    const unsubscribeRate = useEditorStore.subscribe(
      (s) => s.rate,
      () => {
        lastTickMs = performance.now();
        lastPlayheadFrame = readStore().playhead;
        pass();
      },
    );

    // The two master terms of §5.1. They move absolute level and never relative balance,
    // and they are the only store fields outside the timeline that the gain law reads.
    const unsubscribeVolume = useEditorStore.subscribe((s) => s.volume, pass);
    const unsubscribeMuted = useEditorStore.subscribe((s) => s.muted, pass);

    /**
     * §7.2. ONE named handler for both events, with capture, and deliberately WITHOUT
     * `once`: `once` removes only the listener that fired, leaving the other registered
     * for the page's lifetime, and this listener has to persist anyway because it is the
     * re-arming mechanism.
     */
    const unblock = (): void => {
      if (!blocked) return;
      blocked = false;
      // The voices have been parked by the throttled silent reposition, so they are
      // within one throttle interval of the reference rather than on it. Force the
      // check on the first live tick so the first thing heard is the right sample.
      for (const entry of registry.voices.values()) {
        for (const st of entry.slotState) st.forcePosition = true;
      }
      pass();
    };
    document.addEventListener('pointerdown', unblock, true);
    document.addEventListener('keydown', unblock, true);

    pass();

    return () => {
      disposed = true;
      unsubscribePlayhead();
      unsubscribePlaying();
      unsubscribeRate();
      unsubscribeVolume();
      unsubscribeMuted();
      document.removeEventListener('pointerdown', unblock, true);
      document.removeEventListener('keydown', unblock, true);
      if (trailing !== 0) clearTimeout(trailing);
      registry.pass = () => {};
      for (const entry of registry.voices.values()) {
        for (const el of entry.elements) el?.pause();
      }
    };
  }, [activeVideoRef, registryRef]);
}
