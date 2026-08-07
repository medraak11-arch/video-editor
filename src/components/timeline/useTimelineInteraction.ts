/* ---------------------------------------------------------------------------
   useTimelineInteraction — every direct-manipulation gesture in the timeline.

   Pointer events only (PLAN §8.5), so a pen and a mouse take the same path and
   an internal clip drag can never be mistaken for an HTML5 file drop. The only
   HTML5 drag handled here is the one arriving FROM the media rail, gated on
   `DND_MEDIA_MIME`.

   THE PERFORMANCE CONTRACT (PLAN §8.7): a pointermove causes zero React
   renders. Every gesture writes `style.transform` / `style.left` / `style.width`
   straight to the DOM, positions its own overlay elements imperatively, and
   commits to the store exactly once — on pointerup, inside `flushSync` so the
   authoritative geometry has landed before the drag transforms are cleared.

   THE REFUSAL CONTRACT (PLAN §3.4): an illegal placement is never silently
   snapped back. The ghost stops at the last legal frame, dims to 60 %, names
   the reason with an icon and a word, and marks the blocking edge. Legality is
   decided by `planMove` / `planTrim` — the same functions the store actions
   use, so the dry run and the commit can never disagree.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type {
  DragEvent as ReactDragEvent,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import type { ClipId, Frames, TrackId } from '../../types/model';
import type { StoreState } from '../../state/types';
import { readStore } from '../../state/store';
import {
  planMove,
  planTrim,
  selectLaneHeight,
  selectLaneTop,
  selectSnapTargets,
  selectTimelineDurationFrames,
  selectTrackAtY,
} from '../../state/timelineSlice';
import type { MoveFailure } from '../../state/timelineSlice';
import { clipEnd } from '../../types/model';
import {
  framesToDuration,
  framesToPx,
  pxToFramesExact,
  secondStepFrames,
} from '../../lib/time';
import {
  CLIP_MIN_RENDER_WIDTH,
  DND_MEDIA_MIME,
  SCRUB_MOMENTUM_CUTOFF_PX,
  SCRUB_MOMENTUM_DECAY,
  ZOOM_STEP,
} from '../../lib/constants';
import { snapFrame, snapTranslation } from './SnapEngine';
import {
  contentFrames,
  contentYAtClientY,
  frameAtClientX,
  frameAtClientXExact,
  trackAtKindOffset,
  trackIndexInKind,
} from './geometry';
import { useReducedMotion } from '../../lib/useReducedMotion';

/** px from a viewport edge at which a drag starts scrolling the timeline. */
const AUTOSCROLL_EDGE = 32;
const AUTOSCROLL_MAX_PX = 18;
/** Pointer travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 3;
/**
 * Scrub velocity is carried in px per animation frame, because the momentum loop
 * that consumes it decays once per rAF. This converts the px/ms the pointer
 * actually reports into that unit.
 */
const MS_PER_FRAME_AT_60 = 1000 / 60;
/**
 * A velocity older than this is stale: the pointer came to rest before it was
 * lifted, so releasing must not fling the playhead off the last fast stroke.
 */
const SCRUB_VELOCITY_STALE_MS = 80;

type BadgeIcon = 'alert' | 'lock' | 'unplug';

const REFUSAL_ICON: Record<MoveFailure, BadgeIcon> = {
  overlap: 'alert',
  locked: 'lock',
  'out-of-range': 'alert',
  'no-track': 'alert',
  'kind-mismatch': 'alert',
  'no-source': 'unplug',
};

/** PLAN §3.4's table, in this slice's own words. One sentence, sentence case. */
function refusalLabel(s: StoreState, reason: MoveFailure, blockingClipId: ClipId | null): string {
  switch (reason) {
    case 'overlap': {
      const name = blockingClipId ? s.clips[blockingClipId]?.name : undefined;
      return name ? `Blocked by ${name}` : 'Blocked by the next clip';
    }
    case 'locked':
      return 'Track is locked';
    case 'out-of-range':
      return 'Start of timeline';
    case 'no-track':
      return 'No track for this media';
    case 'kind-mismatch':
      return 'Video cannot go on an audio track';
    case 'no-source':
      return 'End of source media';
    default:
      return 'That move was refused';
  }
}

export interface TimelineOverlayRefs {
  laneViewport: RefObject<HTMLDivElement>;
  laneContent: RefObject<HTMLDivElement>;
  snapGuide: RefObject<HTMLDivElement>;
  marquee: RefObject<HTMLDivElement>;
  refuseBar: RefObject<HTMLDivElement>;
  refuseLane: RefObject<HTMLDivElement>;
  dragBadge: RefObject<HTMLDivElement>;
  dragBadgeText: RefObject<HTMLSpanElement>;
  trimBadge: RefObject<HTMLDivElement>;
  dropLine: RefObject<HTMLDivElement>;
}

interface Common {
  pointerId: number;
  rect: DOMRect;
  lastClientX: number;
  lastClientY: number;
  startScrollX: number;
  startScrollY: number;
  historyOpen: boolean;
}

interface MoveGesture extends Common {
  kind: 'move';
  startX: number;
  startY: number;
  ids: ClipId[];
  primaryId: ClipId;
  primaryTrackId: TrackId;
  els: HTMLElement[];
  edges: Frames[];
  targets: Frames[];
  moved: boolean;
  /** Applied on pointerup when the press never became a drag. */
  deferredSelect: ClipId | null;
  delta: number;
  deltaTrack: number;
  /** The engaged snap target, or null. Drives the ~90ms magnetic settle. */
  snapTarget: Frames | null;
}

interface TrimGesture extends Common {
  kind: 'trim';
  id: ClipId;
  edge: 'in' | 'out';
  el: HTMLElement;
  startX: number;
  originFrame: Frames;
  targets: Frames[];
  moved: boolean;
  frame: Frames;
}

interface MarqueeGesture extends Common {
  kind: 'marquee';
  anchorContentX: number;
  anchorContentY: number;
  mode: 'replace' | 'extend';
  baseSelection: ClipId[];
  lastKey: string;
}

interface ScrubGesture extends Common {
  kind: 'scrub';
  targets: Frames[];
  velocityPx: number;
  lastTime: number;
}

type Gesture = MoveGesture | TrimGesture | MarqueeGesture | ScrubGesture;

export interface TimelineInteraction {
  focusedClipId: ClipId | null;
  onLanePointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onRulerPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onPlayheadKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
  onLaneKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
  onLaneFocus(event: ReactFocusEvent<HTMLDivElement>): void;
  onDragEnter(event: ReactDragEvent<HTMLDivElement>): void;
  onDragOver(event: ReactDragEvent<HTMLDivElement>): void;
  onDragLeave(event: ReactDragEvent<HTMLDivElement>): void;
  onDrop(event: ReactDragEvent<HTMLDivElement>): void;
  onDragStart(event: ReactDragEvent<HTMLDivElement>): void;
}

export function useTimelineInteraction(refs: TimelineOverlayRefs): TimelineInteraction {
  const [focusedClipId, setFocusedClipId] = useState<ClipId | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const autoScroll = useRef<number | null>(null);
  const momentum = useRef<number | null>(null);
  /** Pending `data-settling` cleanups, so none survives unmount. */
  const settleTimers = useRef<Set<number>>(new Set());
  /** Snap targets for the in-flight HTML5 media drag, built once on dragenter. */
  const dropTargets = useRef<Frames[] | null>(null);
  /** Anchor for shift+click range selection, within one track. */
  const anchor = useRef<ClipId | null>(null);
  /** Alt suppresses snapping for as long as it is held, without changing the preference. */
  const altHeld = useRef(false);
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  /* ------------------------------------------------------------- overlays */

  const hide = useCallback(
    (ref: RefObject<HTMLElement>): void => {
      const el = ref.current;
      if (el) el.hidden = true;
    },
    [],
  );

  const showSnapGuide = useCallback(
    (target: Frames | null): void => {
      const el = refs.snapGuide.current;
      if (!el) return;
      if (target === null) {
        el.hidden = true;
        return;
      }
      const s = readStore();
      el.hidden = false;
      el.style.transform = `translate3d(${framesToPx(target, s.zoom) - s.scrollX}px, 0, 0)`;
    },
    [refs.snapGuide],
  );

  const showRefusal = useCallback(
    (reason: MoveFailure | null, blockingClipId: ClipId | null, atFrame: Frames | null, laneTop: number | null): void => {
      const badge = refs.dragBadge.current;
      const text = refs.dragBadgeText.current;
      const bar = refs.refuseBar.current;
      const lane = refs.refuseLane.current;

      if (reason === null) {
        if (badge) badge.hidden = true;
        if (bar) bar.hidden = true;
        if (lane) lane.hidden = true;
        return;
      }

      const s = readStore();
      if (badge && text) {
        badge.hidden = false;
        badge.dataset.icon = REFUSAL_ICON[reason];
        text.textContent = refusalLabel(s, reason, blockingClipId);
      }
      if (bar) {
        if (atFrame === null) bar.hidden = true;
        else {
          bar.hidden = false;
          bar.style.transform = `translate3d(${framesToPx(atFrame, s.zoom) - s.scrollX}px, 0, 0)`;
        }
      }
      if (lane) {
        if (laneTop === null) lane.hidden = true;
        else {
          lane.hidden = false;
          lane.style.transform = `translate3d(0, ${laneTop - s.scrollY}px, 0)`;
        }
      }
    },
    [refs.dragBadge, refs.dragBadgeText, refs.refuseBar, refs.refuseLane],
  );

  const moveBadge = useCallback(
    (clientX: number, clientY: number, rect: DOMRect): void => {
      const badge = refs.dragBadge.current;
      if (!badge || badge.hidden) return;
      const x = Math.min(Math.max(8, clientX - rect.left + 14), Math.max(8, rect.width - 8));
      const y = Math.min(Math.max(8, clientY - rect.top - 30), Math.max(8, rect.height - 30));
      badge.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    },
    [refs.dragBadge],
  );

  /* --------------------------------------------------------------- scroll */

  const clampScroll = useCallback(
    (x: number, y: number, rect: DOMRect): { x: number; y: number } => {
      const s = readStore();
      const maxX = Math.max(0, framesToPx(contentFrames(s), s.zoom) - rect.width);
      const maxY = Math.max(0, selectLaneHeight(s) - rect.height);
      return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
    },
    [],
  );

  /* -------------------------------------------------------- gesture apply */

  const applyMove = useCallback(
    (g: MoveGesture): void => {
      const s = readStore();
      const startContentX = g.startX - g.rect.left + g.startScrollX;
      const nowContentX = g.lastClientX - g.rect.left + s.scrollX;
      const rawDelta = pxToFramesExact(nowContentX - startContentX, s.zoom);

      const suppressed = !s.snapEnabled || altHeld.current;
      const snapped = snapTranslation(g.edges, g.targets, rawDelta, s.zoom, !suppressed);

      // Which lane is the pointer over? Within the clip's own kind, always.
      const contentY = contentYAtClientY(g.lastClientY, g.rect, s.scrollY);
      const overTrack = selectTrackAtY(s, contentY);
      const primaryTrack = s.tracks[g.primaryTrackId];
      let deltaTrack = 0;
      let kindRefusal: MoveFailure | null = null;
      if (overTrack && primaryTrack) {
        if (overTrack.kind !== primaryTrack.kind) kindRefusal = 'kind-mismatch';
        else deltaTrack = trackIndexInKind(s, overTrack.id) - trackIndexInKind(s, g.primaryTrackId);
      }

      let reason: MoveFailure | null = kindRefusal;
      let blocking: ClipId | null = null;
      let delta = snapped.delta;
      let track = deltaTrack;
      let guide = snapped.target;

      const first = planMove(s, g.ids, delta, track);
      if (!first.ok) {
        reason = reason ?? first.reason;
        blocking = first.blockingClipId;
        // Fall back to the origin lane, then to the last legal frame on it.
        const onOrigin = track !== 0 ? planMove(s, g.ids, delta, 0) : first;
        if (onOrigin.ok) {
          track = 0;
        } else {
          track = planMove(s, g.ids, 0, track).ok ? track : 0;
          delta = largestLegalDelta(s, g.ids, delta, track);
          guide = null;
        }
      }

      g.delta = delta;
      g.deltaTrack = track;
      g.snapTarget = guide;

      // The magnet settles over --dur-snap while a target is engaged, and lets
      // go instantly when it disengages. Reduced motion lands it immediately.
      const magnetic = guide !== null && !reducedRef.current;

      const dx = framesToPx(delta, s.zoom);
      for (const el of g.els) {
        const id = el.dataset.clipId as ClipId | undefined;
        const clip = id ? s.clips[id] : undefined;
        let dy = 0;
        if (clip) {
          const targetId = trackAtKindOffset(s, clip.trackId, track);
          if (targetId) dy = selectLaneTop(s, targetId) - selectLaneTop(s, clip.trackId);
        }
        if (magnetic) el.dataset.snapping = 'true';
        else delete el.dataset.snapping;
        el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        if (reason) el.dataset.refused = 'true';
        else delete el.dataset.refused;
      }

      showSnapGuide(guide);

      let barFrame: Frames | null = null;
      let laneTop: number | null = null;
      if (reason === 'overlap' && blocking) {
        const blocker = s.clips[blocking];
        if (blocker) barFrame = delta >= 0 ? blocker.start : clipEnd(blocker);
      } else if (reason === 'out-of-range') {
        barFrame = 0;
      } else if ((reason === 'locked' || reason === 'kind-mismatch') && overTrack) {
        laneTop = selectLaneTop(s, overTrack.id);
      }
      showRefusal(reason, blocking, barFrame, laneTop);
      moveBadge(g.lastClientX, g.lastClientY, g.rect);
    },
    [moveBadge, showRefusal, showSnapGuide],
  );

  const applyTrim = useCallback(
    (g: TrimGesture): void => {
      const s = readStore();
      const clip = s.clips[g.id];
      if (!clip) return;

      const startContentX = g.startX - g.rect.left + g.startScrollX;
      const nowContentX = g.lastClientX - g.rect.left + s.scrollX;
      const rawFrame = g.originFrame + pxToFramesExact(nowContentX - startContentX, s.zoom);

      const suppressed = !s.snapEnabled || altHeld.current;
      const snapped = snapFrame(rawFrame, g.targets, s.zoom, !suppressed);

      let frame = snapped.frame;
      let guide = snapped.target;
      let reason: MoveFailure | null = null;
      let blocking: ClipId | null = null;

      const plan = planTrim(s, g.id, g.edge, frame);
      if (!plan.ok) {
        reason = plan.reason;
        blocking = plan.blockingClipId;
        frame = largestLegalTrim(s, g.id, g.edge, g.originFrame, frame);
        guide = null;
      }
      g.frame = frame;

      const start = g.edge === 'in' ? frame : clip.start;
      const end = g.edge === 'in' ? clipEnd(clip) : frame;
      const duration = Math.max(1, end - start);

      if (guide !== null && !reducedRef.current) g.el.dataset.snapping = 'true';
      else delete g.el.dataset.snapping;
      g.el.style.left = `${framesToPx(start, s.zoom)}px`;
      g.el.style.width = `${Math.max(CLIP_MIN_RENDER_WIDTH, framesToPx(duration, s.zoom))}px`;
      if (reason) g.el.dataset.refused = 'true';
      else delete g.el.dataset.refused;

      const badge = refs.trimBadge.current;
      if (badge) {
        badge.hidden = false;
        badge.textContent = `${framesToDuration(duration, s.fps)} · ${duration}f`;
        const x = framesToPx(g.edge === 'in' ? start : end, s.zoom) - s.scrollX;
        const laneTop = selectLaneTop(s, clip.trackId) - s.scrollY;
        badge.style.transform = `translate3d(${Math.max(2, x + 6)}px, ${Math.max(2, laneTop + 2)}px, 0)`;
      }

      showSnapGuide(guide);
      let barFrame: Frames | null = null;
      if (reason === 'overlap' && blocking) {
        const blocker = s.clips[blocking];
        if (blocker) barFrame = g.edge === 'in' ? clipEnd(blocker) : blocker.start;
      } else if (reason === 'no-source') {
        barFrame = frame;
      } else if (reason === 'out-of-range') {
        barFrame = g.edge === 'in' ? start : end;
      }
      showRefusal(reason, blocking, barFrame, null);
      moveBadge(g.lastClientX, g.lastClientY, g.rect);
    },
    [moveBadge, refs.trimBadge, showRefusal, showSnapGuide],
  );

  const applyMarquee = useCallback(
    (g: MarqueeGesture): void => {
      const s = readStore();
      const el = refs.marquee.current;
      const nowContentX = g.lastClientX - g.rect.left + s.scrollX;
      const nowContentY = contentYAtClientY(g.lastClientY, g.rect, s.scrollY);

      const x1 = Math.min(g.anchorContentX, nowContentX);
      const x2 = Math.max(g.anchorContentX, nowContentX);
      const y1 = Math.min(g.anchorContentY, nowContentY);
      const y2 = Math.max(g.anchorContentY, nowContentY);

      if (el) {
        el.hidden = false;
        el.style.transform = `translate3d(${x1 - s.scrollX}px, ${y1 - s.scrollY}px, 0)`;
        el.style.width = `${x2 - x1}px`;
        el.style.height = `${y2 - y1}px`;
      }

      const fromFrame = pxToFramesExact(x1, s.zoom);
      const toFrame = pxToFramesExact(x2, s.zoom);
      const hits: ClipId[] = [];
      let top = 0;
      for (const trackId of s.trackOrder) {
        const track = s.tracks[trackId];
        if (!track) continue;
        const bottom = top + track.height;
        if (bottom > y1 && top < y2) {
          for (const id of s.clipsByTrack[trackId] ?? []) {
            const clip = s.clips[id];
            if (!clip) continue;
            if (clip.start < toFrame && fromFrame < clipEnd(clip)) hits.push(id);
          }
        }
        top = bottom;
      }

      const key = hits.join('|');
      if (key === g.lastKey) return;
      g.lastKey = key;
      readStore().selectMany(
        g.mode === 'extend' ? [...g.baseSelection, ...hits] : hits,
        'replace',
      );
    },
    [refs.marquee],
  );

  const applyScrub = useCallback(
    (g: ScrubGesture): void => {
      const s = readStore();
      const raw = frameAtClientXExact(g.lastClientX, g.rect, s.scrollX, s.zoom);
      const suppressed = !s.snapEnabled || altHeld.current;
      const snapped = snapFrame(Math.max(0, raw), g.targets, s.zoom, !suppressed);
      showSnapGuide(snapped.target);
      s.seek(snapped.frame);
    },
    [showSnapGuide],
  );

  const applyGesture = useCallback(
    (g: Gesture): void => {
      if (g.kind === 'move') applyMove(g);
      else if (g.kind === 'trim') applyTrim(g);
      else if (g.kind === 'marquee') applyMarquee(g);
      else applyScrub(g);
    },
    [applyMarquee, applyMove, applyScrub, applyTrim],
  );

  /* ----------------------------------------------------------- autoscroll */

  const stopAutoScroll = useCallback((): void => {
    if (autoScroll.current !== null) {
      cancelAnimationFrame(autoScroll.current);
      autoScroll.current = null;
    }
  }, []);

  const startAutoScroll = useCallback((): void => {
    if (autoScroll.current !== null) return;
    const tick = (): void => {
      const g = gesture.current;
      if (!g) {
        autoScroll.current = null;
        return;
      }
      const { rect } = g;
      const left = g.lastClientX - rect.left;
      const right = rect.width - left;
      const topDist = g.lastClientY - rect.top;
      const bottomDist = rect.height - topDist;

      let dx = 0;
      let dy = 0;
      if (left < AUTOSCROLL_EDGE) dx = -speedFor(AUTOSCROLL_EDGE - left);
      else if (right < AUTOSCROLL_EDGE) dx = speedFor(AUTOSCROLL_EDGE - right);
      if (g.kind === 'move' || g.kind === 'marquee') {
        if (topDist < AUTOSCROLL_EDGE) dy = -speedFor(AUTOSCROLL_EDGE - topDist);
        else if (bottomDist < AUTOSCROLL_EDGE) dy = speedFor(AUTOSCROLL_EDGE - bottomDist);
      }

      if (dx !== 0 || dy !== 0) {
        const s = readStore();
        const next = clampScroll(s.scrollX + dx, s.scrollY + dy, rect);
        if (next.x !== s.scrollX || next.y !== s.scrollY) {
          s.setScroll(next.x, next.y);
          applyGesture(g);
        }
      }
      autoScroll.current = requestAnimationFrame(tick);
    };
    autoScroll.current = requestAnimationFrame(tick);
  }, [applyGesture, clampScroll]);

  /* ---------------------------------------------------------- gesture end */

  /**
   * `settle` is true only when a drag was cancelled, where the clip really does
   * travel back to where it started. On a commit the store already holds the
   * final position, so the transform is dropped without motion — animating it
   * would slide the clip away from the frame it was just committed to.
   *
   * The trim path REWRITES `left` / `width` from the store rather than clearing
   * them: React owns those two properties through the style prop, and blanking
   * them would leave the element geometry-less until its props next changed.
   */
  const clearDragDecorations = useCallback(
    (g: Gesture, settle: boolean): void => {
      if (g.kind === 'move') {
        for (const el of g.els) {
          delete el.dataset.snapping;
          if (settle && !reducedRef.current) {
            el.dataset.settling = 'true';
            // The attribute must outlive the transition it enables, so the
            // duration comes from the same token the rule uses. Timers are
            // tracked so an unmount mid-settle cannot leave one running.
            const timer = window.setTimeout(() => {
              settleTimers.current.delete(timer);
              delete el.dataset.settling;
            }, tokenMs('--dur-feedback'));
            settleTimers.current.add(timer);
          }
          el.style.transform = '';
          delete el.dataset.refused;
          delete el.dataset.dragging;
        }
      } else if (g.kind === 'trim') {
        const s = readStore();
        const clip = s.clips[g.id];
        if (clip) {
          g.el.style.left = `${framesToPx(clip.start, s.zoom)}px`;
          g.el.style.width = `${Math.max(
            CLIP_MIN_RENDER_WIDTH,
            framesToPx(clip.duration, s.zoom),
          )}px`;
        }
        delete g.el.dataset.snapping;
        delete g.el.dataset.refused;
        delete g.el.dataset.dragging;
      }
      showSnapGuide(null);
      showRefusal(null, null, null, null);
      hide(refs.marquee);
      hide(refs.trimBadge);
      hide(refs.dropLine);
    },
    [hide, refs.dropLine, refs.marquee, refs.trimBadge, showRefusal, showSnapGuide],
  );

  /* ------------------------------------------------------ scrub momentum
     DESIGN.md §5's one motion exception: a scrub carries momentum. It is real
     logic rather than a transition, so it consults useReducedMotion() and takes
     the instant path — the playhead simply stops where it was released. */

  const stopMomentum = useCallback((): void => {
    if (momentum.current !== null) {
      cancelAnimationFrame(momentum.current);
      momentum.current = null;
    }
  }, []);

  const startMomentum = useCallback((g: ScrubGesture): void => {
    stopMomentum();
    let velocity = g.velocityPx;
    if (Math.abs(velocity) < SCRUB_MOMENTUM_CUTOFF_PX) return;
    if (performance.now() - g.lastTime > SCRUB_VELOCITY_STALE_MS) return;
    if (readStore().isPlaying) return;

    const step = (): void => {
      velocity *= SCRUB_MOMENTUM_DECAY;
      if (Math.abs(velocity) < SCRUB_MOMENTUM_CUTOFF_PX || readStore().isPlaying) {
        momentum.current = null;
        return;
      }
      const s = readStore();
      s.seek(s.playhead + Math.round(pxToFramesExact(velocity, s.zoom)));
      momentum.current = requestAnimationFrame(step);
    };
    momentum.current = requestAnimationFrame(step);
  }, [stopMomentum]);

  const endGesture = useCallback(
    (commit: boolean): void => {
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;
      stopAutoScroll();

      const store = readStore();
      if (g.kind === 'move' && g.moved) {
        const { ids, delta, deltaTrack } = g;
        const worthwhile = commit && (delta !== 0 || deltaTrack !== 0);
        flushSync(() => {
          if (!worthwhile) {
            readStore().abortHistory();
            return;
          }
          const result = readStore().moveClips(ids, delta, deltaTrack);
          if (result.ok) readStore().commitHistory();
          else readStore().abortHistory();
        });
      } else if (g.kind === 'move') {
        if (commit && g.deferredSelect) store.select(g.deferredSelect, 'replace');
        if (g.historyOpen) store.commitHistory();
      } else if (g.kind === 'trim') {
        if (g.moved) {
          const { id, edge, frame } = g;
          flushSync(() => {
            if (!commit) {
              readStore().abortHistory();
              return;
            }
            const result = readStore().trimClip(id, edge, frame);
            if (result.ok) readStore().commitHistory();
            else readStore().abortHistory();
          });
        } else if (g.historyOpen) {
          store.commitHistory();
        }
      }

      clearDragDecorations(g, !commit);

      const viewport = refs.laneViewport.current;
      if (viewport?.hasPointerCapture(g.pointerId)) viewport.releasePointerCapture(g.pointerId);

      if (g.kind === 'scrub' && commit && !reducedRef.current) startMomentum(g);
    },
    [clearDragDecorations, refs.laneViewport, startMomentum, stopAutoScroll],
  );

  /* ------------------------------------------------- window-level pointer */

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const g = gesture.current;
      if (!g || event.pointerId !== g.pointerId) return;
      altHeld.current = event.altKey;
      // Read the previous sample BEFORE overwriting it — the scrub branch below
      // needs the delta between the last two moves to have a velocity at all.
      const prevX = g.lastClientX;
      g.lastClientX = event.clientX;
      g.lastClientY = event.clientY;

      if (g.kind === 'move' && !g.moved) {
        const far =
          Math.abs(event.clientX - g.startX) > DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - g.startY) > DRAG_THRESHOLD_PX;
        if (!far) return;
        g.moved = true;
        g.deferredSelect = null;
        readStore().beginHistory(g.ids.length > 1 ? 'Move clips' : 'Move clip');
        g.historyOpen = true;
        for (const el of g.els) el.dataset.dragging = 'true';
      }
      if (g.kind === 'trim' && !g.moved) {
        if (Math.abs(event.clientX - g.startX) <= 1) return;
        g.moved = true;
        readStore().beginHistory('Trim clip');
        g.historyOpen = true;
        g.el.dataset.dragging = 'true';
      }
      if (g.kind === 'scrub') {
        const now = performance.now();
        const dt = Math.max(1, now - g.lastTime);
        // px per ~16ms frame, from the travel since the previous sample.
        g.velocityPx = ((event.clientX - prevX) / dt) * MS_PER_FRAME_AT_60;
        g.lastTime = now;
      }

      applyGesture(g);
      startAutoScroll();
    };

    const onPointerUp = (event: PointerEvent): void => {
      const g = gesture.current;
      if (!g || event.pointerId !== g.pointerId) return;
      g.lastClientX = event.clientX;
      g.lastClientY = event.clientY;
      endGesture(true);
    };

    const onPointerCancel = (): void => endGesture(false);

    // Rung (c) of the Escape ladder (PLAN §8.10): an in-flight drag consumes
    // Escape and aborts, so it never also clears the selection underneath.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') altHeld.current = true;
      if (gesture.current && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        endGesture(false);
        return;
      }
      const g = gesture.current;
      if (g && (event.key === 'Alt' || event.altKey)) applyGesture(g);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') {
        altHeld.current = false;
        const g = gesture.current;
        if (g) applyGesture(g);
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [applyGesture, endGesture, startAutoScroll]);

  useEffect(() => {
    const timers = settleTimers.current;
    return () => {
      stopAutoScroll();
      stopMomentum();
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, [stopAutoScroll, stopMomentum]);

  /* ----------------------------------------------------------- pointerdown */

  /**
   * `preventScroll` is not a nicety here. `.tl-lanes` is a real scroll container
   * (its content is far wider and taller than the box) but its scroll is driven
   * entirely by the store, through a transform on `.tl-lane-content`. If the
   * browser scrolled it natively to reveal a focused clip, nothing would ever
   * read or reset `scrollLeft`/`scrollTop` and the lanes would sit permanently
   * offset from the ruler, the playhead and the track heads. `scrollClipIntoView`
   * is the only scroll authority (PLAN §8.6).
   */
  const focusClip = useCallback(
    (id: ClipId): void => {
      setFocusedClipId(id);
      const el = refs.laneContent.current?.querySelector<HTMLElement>(`[data-clip-id="${id}"]`);
      el?.focus({ preventScroll: true });
    },
    [refs.laneContent],
  );

  const onLanePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return;
      const viewport = refs.laneViewport.current;
      if (!viewport) return;
      stopMomentum();

      const target = event.target as HTMLElement;
      const edgeEl = target.closest<HTMLElement>('[data-clip-edge]');
      const clipEl = target.closest<HTMLElement>('[data-clip-id]');
      const rect = viewport.getBoundingClientRect();
      const s = readStore();
      altHeld.current = event.altKey;

      const common: Common = {
        pointerId: event.pointerId,
        rect,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        startScrollX: s.scrollX,
        startScrollY: s.scrollY,
        historyOpen: false,
      };
      viewport.setPointerCapture(event.pointerId);

      /* --- trim ---------------------------------------------------------- */
      if (edgeEl && clipEl) {
        const id = clipEl.dataset.clipId as ClipId;
        const clip = s.clips[id];
        if (!clip) return;
        const edge = (edgeEl.dataset.edge as 'in' | 'out') ?? 'out';
        focusClip(id);
        if (!s.selection.has(id)) s.select(id, 'replace');
        anchor.current = id;
        gesture.current = {
          ...common,
          kind: 'trim',
          id,
          edge,
          el: clipEl,
          startX: event.clientX,
          originFrame: edge === 'in' ? clip.start : clipEnd(clip),
          targets: selectSnapTargets(s, new Set([id])),
          moved: false,
          frame: edge === 'in' ? clip.start : clipEnd(clip),
        };
        return;
      }

      /* --- move ---------------------------------------------------------- */
      if (clipEl) {
        const id = clipEl.dataset.clipId as ClipId;
        const clip = s.clips[id];
        if (!clip) return;

        let deferredSelect: ClipId | null = null;
        if (event.shiftKey) {
          s.selectMany(rangeInTrack(s, anchor.current, id), 'extend');
        } else if (event.ctrlKey || event.metaKey) {
          s.select(id, 'toggle');
        } else if (!s.selection.has(id)) {
          s.select(id, 'replace');
        } else {
          // Already selected: keep the group so it can be dragged as one, and
          // collapse to this clip only if the press turns out to be a click.
          deferredSelect = id;
        }
        anchor.current = id;
        focusClip(id);

        const after = readStore();
        const ids = after.selection.has(id) ? [...after.selection] : [id];
        const movingSet = new Set(ids);
        const els: HTMLElement[] = [];
        const edges: Frames[] = [];
        for (const clipId of ids) {
          const el = refs.laneContent.current?.querySelector<HTMLElement>(
            `[data-clip-id="${clipId}"]`,
          );
          if (el) els.push(el);
          const c = after.clips[clipId];
          if (c) edges.push(c.start, clipEnd(c));
        }

        gesture.current = {
          ...common,
          kind: 'move',
          startX: event.clientX,
          startY: event.clientY,
          ids,
          primaryId: id,
          primaryTrackId: clip.trackId,
          els,
          edges,
          targets: selectSnapTargets(after, movingSet),
          moved: false,
          deferredSelect,
          delta: 0,
          deltaTrack: 0,
          snapTarget: null,
        };
        return;
      }

      /* --- marquee ------------------------------------------------------- */
      const mode: 'replace' | 'extend' =
        event.shiftKey || event.ctrlKey || event.metaKey ? 'extend' : 'replace';
      if (mode === 'replace') s.clearSelection();
      viewport.focus({ preventScroll: true });
      gesture.current = {
        ...common,
        kind: 'marquee',
        anchorContentX: event.clientX - rect.left + s.scrollX,
        anchorContentY: contentYAtClientY(event.clientY, rect, s.scrollY),
        mode,
        baseSelection: mode === 'extend' ? [...s.selection] : [],
        lastKey: '',
      };
    },
    [focusClip, refs.laneContent, refs.laneViewport, stopMomentum],
  );

  const beginScrub = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, focusTarget: HTMLElement | null): void => {
      if (event.button !== 0) return;
      const viewport = refs.laneViewport.current;
      if (!viewport) return;
      stopMomentum();
      const s = readStore();
      const rect = viewport.getBoundingClientRect();
      altHeld.current = event.altKey;

      const g: ScrubGesture = {
        kind: 'scrub',
        pointerId: event.pointerId,
        rect,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        startScrollX: s.scrollX,
        startScrollY: s.scrollY,
        historyOpen: false,
        targets: selectSnapTargets(s),
        velocityPx: 0,
        lastTime: performance.now(),
      };
      gesture.current = g;
      viewport.setPointerCapture(event.pointerId);
      // Scrubbing puts the keyboard in the timeline's scope, so S and M work
      // straight afterwards. Scope is focus containment, never hover (PLAN §8.10).
      // Pressing the playhead marker focuses the marker itself — it is a
      // role="slider", and a press that cannot focus it makes it Tab-only.
      (focusTarget ?? viewport).focus({ preventScroll: true });
      applyScrub(g);
    },
    [applyScrub, refs.laneViewport, stopMomentum],
  );

  /**
   * ONE pointerdown handler for the whole ruler, including the playhead marker
   * inside it. The marker deliberately carries no handler of its own: two
   * handlers on a bubbling synthetic event built two gestures per press.
   */
  const onRulerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const handle = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-playhead-handle]',
      );
      // preventDefault suppresses the native focus that a press would otherwise
      // give the marker, so it is applied only away from the marker.
      if (!handle) event.preventDefault();
      beginScrub(event, handle);
    },
    [beginScrub],
  );

  /* -------------------------------------------------------------- keyboard */

  const onPlayheadKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const s = readStore();
    const second = secondStepFrames(s.fps);
    let delta: number | null = null;
    if (event.key === 'ArrowLeft') delta = event.shiftKey ? -second : -1;
    else if (event.key === 'ArrowRight') delta = event.shiftKey ? second : 1;
    else if (event.key === 'Home') {
      event.preventDefault();
      s.seek(0);
      return;
    } else if (event.key === 'End') {
      event.preventDefault();
      // clipEnd is exclusive, so the duration frame itself has no content.
      s.seek(Math.max(0, selectTimelineDurationFrames(s) - 1));
      return;
    }
    if (delta === null) return;
    event.preventDefault(); // consumed here, so the global step binding does not double-fire
    s.step(delta);
  }, []);

  const onLaneKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const s = readStore();
      const current = focusedClipId;

      const focusAndSelect = (id: ClipId | undefined, extend: boolean): void => {
        if (!id) return;
        event.preventDefault();
        focusClip(id);
        s.select(id, extend ? 'extend' : 'replace');
        anchor.current = id;
        scrollClipIntoView(s, id, refs.laneViewport.current);
      };

      // PROVISIONAL BINDING — see the final report's §0.2 request for
      // `nav.clipBack` / `nav.clipForward`. Handled locally only until the
      // registry carries the ids; nothing here should be copied as a pattern.
      // Alt+Left / Alt+Right: previous or next clip in this lane. Plain arrows
      // stay with the playhead — frame stepping outranks focus travel here.
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        if (!current) return;
        const clip = s.clips[current];
        if (!clip) return;
        const ids = s.clipsByTrack[clip.trackId] ?? [];
        const at = ids.indexOf(current);
        focusAndSelect(ids[at + (event.key === 'ArrowRight' ? 1 : -1)], event.shiftKey);
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (!current) {
          const firstTrack = s.trackOrder[0];
          focusAndSelect((s.clipsByTrack[firstTrack ?? ''] ?? [])[0], false);
          return;
        }
        const clip = s.clips[current];
        if (!clip) return;
        const at = s.trackOrder.indexOf(clip.trackId);
        for (let i = at + step; i >= 0 && i < s.trackOrder.length; i += step) {
          const ids = s.clipsByTrack[s.trackOrder[i]] ?? [];
          if (ids.length === 0) continue;
          const nearest = ids.reduce((best, id) => {
            const a = s.clips[id];
            const b = s.clips[best];
            if (!a || !b) return best;
            return Math.abs(a.start - clip.start) < Math.abs(b.start - clip.start) ? id : best;
          }, ids[0]);
          focusAndSelect(nearest, event.shiftKey);
          return;
        }
        return;
      }

      if (event.key === 'Enter' && current) {
        event.preventDefault();
        s.select(current, 'toggle');
        return;
      }

      // PROVISIONAL BINDING — see the final report's §0.2 request for
      // `edit.nudgeBack` / `edit.nudgeForward`. Kept because the selection would
      // otherwise have no keyboard move at all, which PRODUCT.md treats as a
      // correctness failure, but it is untaught until the registry carries it.
      // Nudge: comma and full stop, one frame, or one second with Shift.
      // Shift is what PRODUCES the character on a printable key, so the shifted
      // pair arrives as '<' and '>' — matching on ',' alone would have made the
      // one-second variant unreachable.
      const back = event.key === ',' || event.key === '<';
      const forward = event.key === '.' || event.key === '>';
      if (back || forward) {
        if (s.selection.size === 0) return;
        event.preventDefault();
        const magnitude = event.shiftKey ? secondStepFrames(s.fps) : 1;
        const delta = back ? -magnitude : magnitude;
        const ids = [...s.selection];
        const result = s.moveClips(ids, delta, 0);
        if (!result.ok) {
          s.setNotice({
            tone: 'danger',
            title: 'Could not move',
            message: refusalLabel(s, result.reason, null),
          });
        }
      }
    },
    [focusClip, focusedClipId, refs.laneViewport],
  );

  /** Keeps the roving tab stop honest when focus lands on a clip by Tab. */
  const onLaneFocus = useCallback((event: ReactFocusEvent<HTMLDivElement>): void => {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-clip-id]');
    const id = el?.dataset.clipId as ClipId | undefined;
    if (id) setFocusedClipId(id);
  }, []);

  /* ------------------------------------------------------------- HTML5 DnD */

  const carriesMedia = (event: ReactDragEvent<HTMLDivElement>): boolean =>
    Array.from(event.dataTransfer.types).includes(DND_MEDIA_MIME);

  /**
   * `selectSnapTargets` is [UNSTABLE REFERENCE] and walks every clip, marker and
   * in/out point, so it is built ONCE when the drag enters and reused for the
   * whole drag — dragover fires at pointer rate.
   */
  const dragSnapTargets = useCallback((): Frames[] => {
    if (dropTargets.current === null) dropTargets.current = selectSnapTargets(readStore());
    return dropTargets.current;
  }, []);

  const showDropLine = useCallback(
    (clientX: number | null): void => {
      const el = refs.dropLine.current;
      const viewport = refs.laneViewport.current;
      if (!el || !viewport) return;
      if (clientX === null) {
        el.hidden = true;
        return;
      }
      const s = readStore();
      const rect = viewport.getBoundingClientRect();
      const frame = frameAtClientX(clientX, rect, s.scrollX, s.zoom);
      const snapped = snapFrame(frame, dragSnapTargets(), s.zoom, s.snapEnabled);
      el.hidden = false;
      el.style.transform = `translate3d(${framesToPx(snapped.frame, s.zoom) - s.scrollX}px, 0, 0)`;
    },
    [dragSnapTargets, refs.dropLine, refs.laneViewport],
  );

  const onDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesMedia(event)) return;
      event.preventDefault();
      showDropLine(event.clientX);
    },
    [showDropLine],
  );

  const onDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesMedia(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      showDropLine(event.clientX);
    },
    [showDropLine],
  );

  const onDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): void => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      dropTargets.current = null;
      showDropLine(null);
    },
    [showDropLine],
  );

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesMedia(event)) return;
      event.preventDefault();
      const targets = dragSnapTargets();
      showDropLine(null);
      dropTargets.current = null;
      const mediaId = event.dataTransfer.getData(DND_MEDIA_MIME);
      if (!mediaId) return;

      const viewport = refs.laneViewport.current;
      if (!viewport) return;
      const s = readStore();
      const rect = viewport.getBoundingClientRect();
      const frame = frameAtClientX(event.clientX, rect, s.scrollX, s.zoom);
      const snapped = snapFrame(frame, targets, s.zoom, s.snapEnabled);
      const track = selectTrackAtY(s, contentYAtClientY(event.clientY, rect, s.scrollY));

      const result = s.insertMediaAt(mediaId, snapped.frame, track?.id);
      if (result.ok) {
        s.select(result.id, 'replace');
        setFocusedClipId(result.id);
      } else {
        s.setNotice({
          tone: 'danger',
          title: 'Could not insert',
          message: refusalLabel(s, result.reason, null),
        });
      }
    },
    [dragSnapTargets, refs.laneViewport, showDropLine],
  );

  /** Internal clip drags are pointer-events only — HTML5 drag must not start here. */
  const onDragStart = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault();
  }, []);

  /* ----------------------------------------------------------------- wheel */

  useEffect(() => {
    const viewport = refs.laneViewport.current;
    if (!viewport) return;

    const onWheel = (event: WheelEvent): void => {
      const s = readStore();
      const rect = viewport.getBoundingClientRect();

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        s.zoomAround(s.zoom * factor, event.clientX - rect.left);
        return;
      }

      event.preventDefault();
      const primary = event.deltaY;
      const dx = event.shiftKey ? primary : event.deltaX;
      const dy = event.shiftKey ? 0 : primary;
      const next = clampScroll(s.scrollX + dx, s.scrollY + dy, rect);
      s.setScroll(next.x, next.y);
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [clampScroll, refs.laneViewport]);

  return {
    focusedClipId,
    onLanePointerDown,
    onRulerPointerDown,
    onPlayheadKeyDown,
    onLaneKeyDown,
    onLaneFocus,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragStart,
  };
}

/* --------------------------------------------------------------- helpers */

function speedFor(overshoot: number): number {
  return Math.min(AUTOSCROLL_MAX_PX, Math.max(2, overshoot * 0.4));
}

/**
 * Reads a motion token in milliseconds. Slice code must not restate a duration
 * that a CSS rule already owns (PLAN §9) — this is the one bridge between them.
 * An unreadable token yields 0, which cleans up on the next tick rather than
 * inventing a fallback number.
 */
function tokenMs(name: string): number {
  if (typeof window === 'undefined') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (raw.endsWith('ms')) return Number.parseFloat(raw) || 0;
  if (raw.endsWith('s')) return (Number.parseFloat(raw) || 0) * 1000;
  return Number.parseFloat(raw) || 0;
}

/** The largest delta in [0, target] that `planMove` accepts. Bisection, 20 steps. */
function largestLegalDelta(
  s: StoreState,
  ids: readonly ClipId[],
  target: number,
  deltaTrack: number,
): number {
  if (!planMove(s, ids, 0, deltaTrack).ok) return 0;
  let lo = 0;
  let hi = Math.round(target);
  for (let i = 0; i < 20; i += 1) {
    const mid = Math.round((lo + hi) / 2);
    if (mid === lo || mid === hi) break;
    if (planMove(s, ids, mid, deltaTrack).ok) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The trim frame closest to `target` that `planTrim` accepts, walking back from it. */
function largestLegalTrim(
  s: StoreState,
  id: ClipId,
  edge: 'in' | 'out',
  origin: Frames,
  target: Frames,
): Frames {
  if (!planTrim(s, id, edge, origin).ok) return origin;
  let lo = origin;
  let hi = Math.round(target);
  for (let i = 0; i < 20; i += 1) {
    const mid = Math.round((lo + hi) / 2);
    if (mid === lo || mid === hi) break;
    if (planTrim(s, id, edge, mid).ok) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Shift+click extends across the clips between the anchor and the target, in one track. */
function rangeInTrack(s: StoreState, anchorId: ClipId | null, targetId: ClipId): ClipId[] {
  const target = s.clips[targetId];
  const anchorClip = anchorId ? s.clips[anchorId] : undefined;
  if (!target || !anchorClip || anchorClip.trackId !== target.trackId) return [targetId];
  const ids = s.clipsByTrack[target.trackId] ?? [];
  const a = ids.indexOf(anchorClip.id);
  const b = ids.indexOf(targetId);
  if (a < 0 || b < 0) return [targetId];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Keyboard focus must not leave the clip off screen. */
function scrollClipIntoView(s: StoreState, id: ClipId, viewport: HTMLElement | null): void {
  const clip = s.clips[id];
  if (!clip || !viewport) return;
  const left = framesToPx(clip.start, s.zoom);
  const right = framesToPx(clipEnd(clip), s.zoom);
  const top = selectLaneTop(s, clip.trackId);
  const bottom = top + (s.tracks[clip.trackId]?.height ?? 0);

  let x = s.scrollX;
  if (left < s.scrollX) x = Math.max(0, left - 24);
  else if (right > s.scrollX + viewport.clientWidth) x = right - viewport.clientWidth + 24;

  let y = s.scrollY;
  if (top < s.scrollY) y = Math.max(0, top);
  else if (bottom > s.scrollY + viewport.clientHeight) y = bottom - viewport.clientHeight;

  const maxY = Math.max(0, selectLaneHeight(s) - viewport.clientHeight);
  s.setScroll(x, Math.min(y, maxY));
}
