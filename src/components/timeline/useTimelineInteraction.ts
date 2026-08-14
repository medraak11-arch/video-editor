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

   THE CAPTURE RULE: every gesture is driven by listeners bound to `window`, so
   pointer capture is an optimisation and never a precondition. `capturePointer`
   swallows the NotFoundError the spec mandates for an unknown pointer id, and
   the capture is taken only AFTER the gesture record exists — a press must
   still select, still drag and still commit when capture is unavailable. Two
   real cases depend on this: a pointer lost mid-drag (the id stops existing, so
   the release throws too), and any harness that dispatches PointerEvents
   directly, which is what makes this layer testable without stubbing the DOM.

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
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import type { ClipContextMenuHandle } from './ClipContextMenu';
import type { Clip, ClipId, Frames, TrackId, TransitionKind } from '../../types/model';
import type { TrackContextMenuHandle } from './TrackContextMenu';
import type { StoreState } from '../../state/types';
import { readStore } from '../../state/store';
import {
  planInsert,
  planMove,
  planTrim,
  selectLaneHeight,
  selectLaneTop,
  selectLinkedClosure,
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
import type { SnapEdge } from './SnapEngine';
import {
  contentFrames,
  contentYAtClientY,
  frameAtClientX,
  frameAtClientXExact,
  trackAtKindOffset,
  trackIndexInKind,
} from './geometry';
import { useReducedMotion } from '../../lib/useReducedMotion';
import { refusalLabel } from './refusalLabel';

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

/**
 * The "nothing is pushed" push set. A shared frozen empty array rather than a
 * fresh `[]` per evaluation: `applyMove` runs at pointer rate and the common
 * case by far is that no insert is in play.
 */
const EMPTY_PUSH: readonly Clip[] = Object.freeze([]);

type BadgeIcon = 'alert' | 'lock' | 'unplug';

const REFUSAL_ICON: Record<MoveFailure, BadgeIcon> = {
  overlap: 'alert',
  locked: 'lock',
  'out-of-range': 'alert',
  'no-track': 'alert',
  'kind-mismatch': 'alert',
  'no-source': 'unplug',
};

/**
 * What the drag is authoring, in words, for the read-out badge. Sentence case.
 * A dissolve can only be on the 'in' edge (CREATIVE §4.3), so the outgoing case
 * has no dissolve branch to write.
 */
function transitionWord(kind: TransitionKind, edge: 'in' | 'out'): string {
  if (kind === 'dissolve') return 'Cross dissolve';
  return edge === 'in' ? 'Fade in' : 'Fade out';
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
  /** CREATIVE §12.6. The seam an insert will open, on the landing lane. */
  insertCaret: RefObject<HTMLDivElement>;
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
  edges: SnapEdge[];
  targets: Frames[];
  moved: boolean;
  /** Applied on pointerup when the press never became a drag. */
  deferredSelect: ClipId | null;
  delta: number;
  deltaTrack: number;
  /** The engaged snap target, or null. Drives the ~90ms magnetic settle. */
  snapTarget: Frames | null;
  /**
   * CREATIVE §12. True when this drop will INSERT rather than move — that is,
   * the ordinary move was refused for overlap and `planInsert` accepted the
   * placement. No snap and no threshold are involved. It decides which store
   * action `endGesture` commits, so the drop can never do something the preview
   * did not show.
   */
  insert: boolean;
  /**
   * The clips currently rendered at a PUSHED position, and the element each one
   * is translated on. Held so a pointermove that changes the push set can put
   * back the clips that left it — they are not in `els`, so nothing else would.
   */
  pushedEls: Map<ClipId, HTMLElement>;
}

interface TrimGesture extends Common {
  kind: 'trim';
  id: ClipId;
  edge: 'in' | 'out';
  /** The primary. Kept for the badge's lane and for `id`; it is also in `members`. */
  el: HTMLElement;
  /**
   * Every member with a rendered element, primary included, PAIRED — not two
   * parallel arrays (docs/LINKING.md §5.3). A member scrolled out of the lane has
   * no element, and `MoveGesture.els`'s trick of dropping it silently works there
   * only because a move writes the same transform to every element. A trim writes
   * a DIFFERENT geometry per member, so a dropped element that shifted the
   * indices would paint one member with another member's edge.
   */
  members: { id: ClipId; el: HTMLElement }[];
  startX: number;
  originFrame: Frames;
  targets: Frames[];
  moved: boolean;
  frame: Frames;
}

/**
 * Dragging a clip's transition ramp (CREATIVE §4.4).
 *
 * IT CANNOT COLLIDE WITH TRIM, and that is settled by GEOMETRY rather than by
 * handler order: `.tl-clip-edge` occupies the outer 6 px of each end and
 * `.tl-clip-transition-handle` starts at 6 px, so the two hit areas are
 * disjoint and neither can be "nearly" hit. `onLanePointerDown` still resolves
 * `[data-clip-transition]` FIRST, so if a later stylesheet ever overlapped them
 * the outcome is a stated decision rather than whichever `closest()` ran first.
 *
 * The handle is also inside the clip, so a press on it would otherwise start a
 * MOVE; returning from this branch is what stops that, exactly as the trim
 * branch already does.
 *
 * `frames` is the authored value, never the built one: the store keeps what the
 * user asked for and the export clamps it to the handle that exists (§4.3), so
 * trimming the outgoing clip longer later restores the transition rather than
 * having silently shortened it forever.
 */
interface TransitionGesture extends Common {
  kind: 'transition';
  id: ClipId;
  edge: 'in' | 'out';
  /** The clip element, for `data-dragging`. */
  el: HTMLElement;
  /** The zero-width span the ramp is painted into. Always mounted (Clip.tsx). */
  rampEl: HTMLElement | null;
  /** Preserved from whatever is already on the edge; a bare drag authors a fade. */
  transitionKind: TransitionKind;
  startX: number;
  startFrames: Frames;
  /** ⌊shorter/3⌋ — 0 when the clip is too short to carry one at all. */
  maxFrames: Frames;
  moved: boolean;
  frames: Frames;
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

type Gesture =
  | MoveGesture
  | TrimGesture
  | TransitionGesture
  | MarqueeGesture
  | ScrubGesture;

/** Inset of the keyboard-opened menu from the focused clip's bottom-left corner. */
const GAP_FROM_CLIP = 8;

export interface TimelineInteraction {
  focusedClipId: ClipId | null;
  onLanePointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onLaneContextMenu(event: ReactMouseEvent<HTMLDivElement>): void;
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

export function useTimelineInteraction(
  refs: TimelineOverlayRefs,
  clipMenu: RefObject<ClipContextMenuHandle | null>,
  trackMenu: RefObject<TrackContextMenuHandle | null>,
): TimelineInteraction {
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
  /** True only across a `focusClip` call, so `onLaneFocus` can tell a Tab from us. */
  const selfFocus = useRef(false);
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

  /**
   * The insert caret (CREATIVE §12.6) — the seam the drop will open, drawn on
   * the lane the clip is landing on so it is unambiguous which track cascades.
   * `null` hides it.
   */
  const showInsertCaret = useCallback(
    (target: Frames | null, trackId: TrackId | undefined): void => {
      const el = refs.insertCaret.current;
      if (!el) return;
      if (target === null || trackId === undefined) {
        el.hidden = true;
        return;
      }
      const s = readStore();
      el.hidden = false;
      el.style.height = `${s.tracks[trackId]?.height ?? 0}px`;
      el.style.transform = `translate3d(${framesToPx(target, s.zoom) - s.scrollX}px, ${
        selectLaneTop(s, trackId) - s.scrollY
      }px, 0)`;
    },
    [refs.insertCaret],
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

  /**
   * Renders the push set at its pushed position — CREATIVE §12.6's "the clips
   * actually move". A `translateX` on elements that are already mounted, so a
   * cascade of any length costs no layout and allocates no DOM at pointer rate.
   *
   * The displacement is read from `planInsert`'s own output, never recomputed:
   * `clip.start` in `pushed` is where that clip WILL be, so the transform is the
   * difference against where it is now. Deriving it here would be the second
   * implementation §12.7 forbids.
   *
   * Elements that LEAVE the push set between two pointermoves are put back
   * first. They are not in `g.els`, so nothing else in this file would ever
   * clear them, and a clip left translated after the cascade shortened would be
   * a clip drawn somewhere it is not.
   */
  const applyPushPreview = useCallback(
    (g: MoveGesture, s: StoreState, pushed: readonly Clip[]): void => {
      const next = new Map<ClipId, HTMLElement>();

      for (const clip of pushed) {
        const el =
          g.pushedEls.get(clip.id) ??
          refs.laneContent.current?.querySelector<HTMLElement>(`[data-clip-id="${clip.id}"]`);
        // A pushed clip scrolled out of the lane has no element. That is not a
        // reason to abort anything: the commit still moves it, exactly as a
        // linked trim member with no element is still trimmed.
        if (!el) continue;
        const current = s.clips[clip.id];
        if (!current) continue;
        next.set(clip.id, el);
        el.dataset.pushed = 'true';
        el.style.transform = `translate3d(${framesToPx(clip.start - current.start, s.zoom)}px, 0, 0)`;
      }

      for (const [id, el] of g.pushedEls) {
        if (next.has(id)) continue;
        delete el.dataset.pushed;
        el.style.transform = '';
      }

      g.pushedEls = next;
    },
    [refs.laneContent],
  );

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

      const first = planMove(s, g.ids, delta, track, g.primaryTrackId);

      /* ------------------------------------------------ insert (CREATIVE §12)

         Attempted ONLY when the ordinary move was refused for OVERLAP and the
         ghost would overlap something. That is the WHOLE condition.

         IT USED TO ALSO REQUIRE A SNAP — `snapped.edge === 'start' && guide !==
         null` — and that is the bug the user hit: "blocked by x whenever i try
         to move a clip to the seam". The capture window is SNAP_THRESHOLD_PX,
         8px, about ±2 frames at ordinary zoom, while a mouse reports every
         18-23px. A human does not narrowly miss a window that small; they step
         clean over it, so the feature almost never armed. The deeper error was
         reusing a POSITIONING threshold to gate a BEHAVIOUR: snapping is allowed
         to be forgiving because missing it costs three frames and a nudge, and
         borrowing it here changed what a miss costs into "the edit you asked for
         does not happen".

         So: no magnet, no edge test, no window. `kindRefusal` stays — a video
         clip over an audio lane is refused before geometry is consulted at all,
         and inserting it there would answer a question the user did not ask.

         The plan comes from the STORE, never from arithmetic here. `planInsert`
         is the same function `insertClips` runs, so the ghost below and the drop
         in `endGesture` cannot disagree — which is the failure §12.7 exists to
         prevent. */
      let pushed: readonly Clip[] = EMPTY_PUSH;
      let inserting = false;
      /**
       * Where the moving clips actually LAND, by id, when that is not simply
       * `start + delta`. The half-clip rule resolves a drop over a clip to that
       * clip's start or end, so the landing point can differ from the pointer —
       * and the ghost has to show the landing, not the pointer, or the drop
       * commits somewhere the preview never drew.
       */
      let resolved: Map<ClipId, Frames> | null = null;
      /** The plan's own resolved boundary. The caret marks THIS and nothing else. */
      let insertAt: Frames | null = null;
      if (!first.ok && first.reason === 'overlap' && kindRefusal === null) {
        const attempt = planInsert(s, g.ids, delta, track, g.primaryTrackId);
        if (attempt.ok) {
          inserting = true;
          pushed = attempt.pushed;
          insertAt = attempt.insertAt;
          resolved = new Map(attempt.clips.map((clip) => [clip.id, clip.start]));
          // An insert is a legal outcome, not a refused one: clear the refusal
          // the failed `planMove` was about to raise, and keep the pointer's
          // delta rather than clamping back to the last non-overlapping frame.
          reason = null;
          blocking = null;
        }
      }

      if (!inserting && !first.ok) {
        reason = reason ?? first.reason;
        blocking = first.blockingClipId;
        // Fall back to the origin lane, then to the last legal frame on it.
        const onOrigin = track !== 0 ? planMove(s, g.ids, delta, 0, g.primaryTrackId) : first;
        if (onOrigin.ok) {
          track = 0;
        } else {
          track = planMove(s, g.ids, 0, track, g.primaryTrackId).ok ? track : 0;
          delta = largestLegalDelta(s, g.ids, delta, track, g.primaryTrackId);
          guide = null;
        }
      }

      g.delta = delta;
      g.deltaTrack = track;
      g.snapTarget = guide;
      g.insert = inserting;

      applyPushPreview(g, s, pushed);

      // The magnet settles over --dur-snap while a target is engaged, and lets
      // go instantly when it disengages. Reduced motion lands it immediately.
      const magnetic = guide !== null && !reducedRef.current;

      const dx = framesToPx(delta, s.zoom);
      for (const el of g.els) {
        const id = el.dataset.clipId as ClipId | undefined;
        const clip = id ? s.clips[id] : undefined;
        // While inserting, the horizontal offset comes from the PLAN, not from
        // the pointer. The half-clip rule can resolve a drop over a clip to that
        // clip's start or its end, so `start + delta` is no longer where the
        // clip lands — and a ghost drawn at the pointer would promise a frame
        // the commit does not use. Falls back to the uniform delta for any clip
        // the plan does not name, and for every ordinary move.
        const landed = clip && resolved ? resolved.get(clip.id) : undefined;
        const clipDx = landed !== undefined && clip ? framesToPx(landed - clip.start, s.zoom) : dx;
        let dy = 0;
        // Kind-scoped, exactly as planMove is (docs/LINKING.md §5.2b): the lane
        // offset belongs to the lane the pointer is over, so a linked audio member
        // stays on its own lane while the picture changes video lane. A ghost that
        // slid it anyway would promise a move the commit does not make.
        if (clip && track !== 0 && s.tracks[clip.trackId]?.kind === primaryTrack?.kind) {
          const targetId = trackAtKindOffset(s, clip.trackId, track);
          if (targetId) dy = selectLaneTop(s, targetId) - selectLaneTop(s, clip.trackId);
        }
        if (magnetic) el.dataset.snapping = 'true';
        else delete el.dataset.snapping;
        el.style.transform = `translate3d(${clipDx}px, ${dy}px, 0)`;
        if (reason) el.dataset.refused = 'true';
        else delete el.dataset.refused;
      }

      /* THE CARET, at the RESOLVED boundary — not under the pointer.

         This is now the load-bearing signal of the whole gesture rather than a
         garnish on it. With the half-clip rule the drop no longer lands where
         the pointer is: anywhere over a clip's first half resolves to that
         clip's start and anywhere over its second half to its end, so a
         catchment that used to be ±2 frames is now half a clip wide. That is
         what makes the feature reachable by a human, and it is exactly what
         makes the landing point unguessable without being drawn. The caret says
         WHERE the drop lands; the live displacement says WHAT it costs.

         The frame is `InsertPlan.insertAt`, read straight off the plan. It is
         reported for exactly this reason: a caret that worked the boundary out
         for itself — from the plan's clips, or by re-applying the half-clip rule
         — would be the second implementation §12.7 exists to prevent, and the
         one that drifts is always the one drawn on screen.

         It REPLACES the snap guide rather than joining it — two marks for one
         fact, and the quieter one says less. */
      if (inserting && insertAt !== null) {
        const landingTrackId =
          (track !== 0 ? trackAtKindOffset(s, g.primaryTrackId, track) : g.primaryTrackId) ??
          g.primaryTrackId;
        showInsertCaret(insertAt, landingTrackId);
        showSnapGuide(null);
      } else {
        showInsertCaret(null, undefined);
        showSnapGuide(guide);
      }

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
    [applyPushPreview, moveBadge, showInsertCaret, showRefusal, showSnapGuide],
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

      // The members' ghosts are derived from the same `delta` the planner uses,
      // not from a plan (docs/LINKING.md §5.3): `applyTrim` never reads
      // `plan.clips`, and on the refusal path — the common one, since every trim
      // drag ends by pushing past something — there is no plan at all. `frame` is
      // already resolved here, legal or clamped, and the clamp is group-legal for
      // free because `largestLegalTrim` binary-searches the group-aware planTrim.
      const delta = g.edge === 'in' ? frame - clip.start : frame - clipEnd(clip);
      for (const member of g.members) {
        const m = s.clips[member.id];
        if (!m) continue;
        const memberStart = g.edge === 'in' ? m.start + delta : m.start;
        const memberDuration = Math.max(
          1,
          g.edge === 'in' ? m.duration - delta : m.duration + delta,
        );
        member.el.style.left = `${framesToPx(memberStart, s.zoom)}px`;
        member.el.style.width = `${Math.max(
          CLIP_MIN_RENDER_WIDTH,
          framesToPx(memberDuration, s.zoom),
        )}px`;
        // Both go on EVERY member: the refusal is the group's, not the primary's.
        if (guide !== null && !reducedRef.current) member.el.dataset.snapping = 'true';
        else delete member.el.dataset.snapping;
        if (reason) member.el.dataset.refused = 'true';
        else delete member.el.dataset.refused;
      }

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

  /**
   * NO SNAPPING, deliberately. Every other gesture here resolves to a POSITION
   * on the timeline, and the snap targets are positions — clip edges, markers,
   * the in and out points. A transition length is a DURATION, and snapping one
   * to a distant clip's start would set it to whatever arbitrary number of
   * frames happened to lie under the pointer.
   *
   * There is also no refusal path: the value is clamped to [0, max] as it is
   * dragged, so there is no illegal length to refuse. Dragging to zero is the
   * removal gesture and the badge says so in words.
   */
  const applyTransition = useCallback(
    (g: TransitionGesture): void => {
      const s = readStore();
      const clip = s.clips[g.id];
      if (!clip) return;

      const startContentX = g.startX - g.rect.left + g.startScrollX;
      const nowContentX = g.lastClientX - g.rect.left + s.scrollX;
      // Inward is positive on both ends: rightward lengthens a head ramp,
      // leftward lengthens a tail one. The alternative — signed by screen
      // direction — would make the out handle run backwards under the hand.
      const inward = g.edge === 'in' ? 1 : -1;
      const travel = pxToFramesExact(nowContentX - startContentX, s.zoom) * inward;
      const frames = Math.min(g.maxFrames, Math.max(0, Math.round(g.startFrames + travel)));
      g.frames = frames;

      if (g.rampEl) g.rampEl.style.setProperty('--tl-ramp-w', `${framesToPx(frames, s.zoom)}px`);

      const badge = refs.trimBadge.current;
      if (badge) {
        badge.hidden = false;
        badge.textContent =
          frames === 0
            ? 'No transition'
            : `${transitionWord(g.transitionKind, g.edge)} · ${framesToDuration(frames, s.fps)} · ${frames}f`;
        const x = framesToPx(g.edge === 'in' ? clip.start : clipEnd(clip), s.zoom) - s.scrollX;
        const laneTop = selectLaneTop(s, clip.trackId) - s.scrollY;
        badge.style.transform = `translate3d(${Math.max(2, x + 6)}px, ${Math.max(2, laneTop + 2)}px, 0)`;
      }
      moveBadge(g.lastClientX, g.lastClientY, g.rect);
    },
    [moveBadge, refs.trimBadge],
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
      else if (g.kind === 'transition') applyTransition(g);
      else if (g.kind === 'marquee') applyMarquee(g);
      else applyScrub(g);
    },
    [applyMarquee, applyMove, applyScrub, applyTransition, applyTrim],
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
        // The push set first, and unconditionally. These elements are NOT in
        // `els`, and the store has already been written by the time we get here
        // on a commit — so a pushed clip's real geometry is now its pushed
        // geometry, and any surviving transform would double the displacement.
        // On an abort the store was never touched and clearing simply puts the
        // clip back, which is §12.6's "aborting restores every pushed clip".
        for (const el of g.pushedEls.values()) {
          delete el.dataset.pushed;
          el.style.transform = '';
        }
        g.pushedEls.clear();

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
        // Every member, not just the primary: a trim writes a different geometry
        // to each one, so each one has to be put back from the store.
        for (const member of g.members) {
          const clip = s.clips[member.id];
          if (clip) {
            member.el.style.left = `${framesToPx(clip.start, s.zoom)}px`;
            member.el.style.width = `${Math.max(
              CLIP_MIN_RENDER_WIDTH,
              framesToPx(clip.duration, s.zoom),
            )}px`;
          }
          delete member.el.dataset.snapping;
          delete member.el.dataset.refused;
        }
        delete g.el.dataset.dragging;
      } else if (g.kind === 'transition') {
        // REWRITTEN from the store, not cleared, for the reason the trim path is:
        // React owns `--tl-ramp-w` through the ramp span's style prop, and when
        // the committed value equals the one already rendered React writes
        // nothing — so a blanked or stale custom property would survive with no
        // render to correct it.
        const s = readStore();
        const clip = s.clips[g.id];
        const authored =
          (g.edge === 'in' ? clip?.transitionIn?.frames : clip?.transitionOut?.frames) ?? 0;
        g.rampEl?.style.setProperty('--tl-ramp-w', `${framesToPx(authored, s.zoom)}px`);
        delete g.el.dataset.dragging;
      }
      showSnapGuide(null);
      showRefusal(null, null, null, null);
      hide(refs.marquee);
      hide(refs.trimBadge);
      hide(refs.dropLine);
      hide(refs.insertCaret);
    },
    [hide, refs.dropLine, refs.insertCaret, refs.marquee, refs.trimBadge, showRefusal, showSnapGuide],
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
        const { ids, delta, deltaTrack, primaryTrackId, insert } = g;
        // An INSERT with a zero delta is still worthwhile — it rearranges the
        // track even though the dragged clip has not itself moved. `moveClips`
        // with a zero delta is the no-op this guard was written for.
        //
        // This relies on an invariant, stated here because it is what keeps the
        // relaxation from minting an EMPTY undo entry: `insert` is only ever set
        // when `planMove` refused for OVERLAP, an overlap means at least one
        // clip is in the way, and `planInsert` must therefore push at least one
        // clip. So `insertClips` can never take its own no-op early-return under
        // this branch, and the `commitHistory` below always closes a
        // transaction that really changed something. Widening the condition that
        // sets `insert` means revisiting this.
        const worthwhile = commit && (insert || delta !== 0 || deltaTrack !== 0);
        flushSync(() => {
          if (!worthwhile) {
            readStore().abortHistory();
            return;
          }
          // The SAME predicate the ghost used, carried on the gesture record
          // rather than recomputed here — recomputing it would re-read a store
          // that may have changed under a slow pointerup, and the drop would
          // then do something the preview never showed (CREATIVE §12.7).
          const result = insert
            ? readStore().insertClips(ids, delta, deltaTrack, primaryTrackId)
            : readStore().moveClips(ids, delta, deltaTrack, primaryTrackId);
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
      } else if (g.kind === 'transition') {
        if (g.moved) {
          const { id, edge, frames, transitionKind } = g;
          // `flushSync` for the same reason move and trim need it: the
          // authoritative geometry has to have landed before
          // `clearDragDecorations` reads it back out of the store.
          flushSync(() => {
            if (!commit) {
              readStore().abortHistory();
              return;
            }
            // Zero is REMOVAL, not a zero-length transition: `Transition.frames`
            // is >= 1 by declaration, so there is no such thing to store.
            readStore().setClipTransition(
              id,
              edge,
              frames >= 1 ? { kind: transitionKind, frames } : null,
            );
            readStore().commitHistory();
          });
        } else if (g.historyOpen) {
          store.commitHistory();
        }
      }

      clearDragDecorations(g, !commit);

      releasePointer(refs.laneViewport.current, g.pointerId);

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

      // A release that happens outside the window never reaches us, and without
      // a capture nothing cancels the gesture either — the press would stay open
      // for ever, holding an uncommitted history transaction and a clip stuck
      // under the cursor. A move reporting no buttons IS that lost release, so
      // the gesture ends where the pointer actually is.
      if (event.buttons === 0) {
        const underway =
          g.kind === 'move' || g.kind === 'trim' || g.kind === 'transition' ? g.moved : true;
        if (underway) applyGesture(g);
        endGesture(true);
        return;
      }

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
      // Same 1px threshold the trim uses, and for the same reason: this is a
      // horizontal-only gesture, so a vertical tremor must not open a history
      // transaction, but a single deliberate pixel must.
      if (g.kind === 'transition' && !g.moved) {
        if (Math.abs(event.clientX - g.startX) <= 1) return;
        g.moved = true;
        readStore().beginHistory('Set transition');
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
      // Marks the focus that follows as ours, so `onLaneFocus` does not also
      // reveal it: the keyboard callers scroll deliberately afterwards and the
      // pointer callers must not scroll at all (a press on a clip whose far edge
      // is off screen would jump the lanes out from under the gesture).
      selfFocus.current = true;
      el?.focus({ preventScroll: true });
      selfFocus.current = false;
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
      const transitionEl = target.closest<HTMLElement>('[data-clip-transition]');
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

      /* --- transition ---------------------------------------------------- */
      // FIRST, before trim and before move. The three hit areas are disjoint by
      // geometry (see TransitionGesture), so this ordering never actually fires
      // ahead of a trim — it is here so that the precedence is a decision in the
      // source rather than an accident of which `closest()` happened to match.
      if (transitionEl && clipEl) {
        const id = clipEl.dataset.clipId as ClipId;
        const clip = s.clips[id];
        if (!clip) return;
        const edge = (transitionEl.dataset.edge as 'in' | 'out') ?? 'in';
        focusClip(id);
        if (!s.selection.has(id)) s.select(id, 'replace');
        anchor.current = id;

        // A bare drag authors a FADE; an edge that already carries a dissolve
        // keeps it. Changing the kind is the context menu's job — a 10px corner
        // cannot express "and make it a dissolve", and silently demoting one to
        // a fade because the user adjusted its length would lose the crossing.
        const existing = edge === 'in' ? clip.transitionIn : clip.transitionOut;
        const transitionKind: TransitionKind = existing?.kind ?? 'fade';

        // A third of the SHORTER clip (CREATIVE §4.4). For a fade that is the
        // clip itself; for a dissolve it is the lesser of it and the outgoing
        // clip, because the ramp has to fit inside both.
        let shorter = clip.duration;
        if (transitionKind === 'dissolve') {
          const ids = s.clipsByTrack[clip.trackId] ?? [];
          const at = ids.indexOf(id);
          const previous = at > 0 ? s.clips[ids[at - 1]] : undefined;
          if (previous) shorter = Math.min(shorter, previous.duration);
        }
        // Never below what is already stored: a value authored when the clip was
        // longer is the user's, and a drag must be able to shorten it by hand
        // rather than have the press itself silently clamp it.
        const existingFrames = existing?.frames ?? 0;
        const maxFrames = Math.max(existingFrames, Math.floor(shorter / 3));

        gesture.current = {
          ...common,
          kind: 'transition',
          id,
          edge,
          el: clipEl,
          rampEl: clipEl.querySelector<HTMLElement>(`.tl-clip-ramp[data-edge="${edge}"]`),
          transitionKind,
          startX: event.clientX,
          startFrames: existingFrames,
          maxFrames,
          moved: false,
          frames: existingFrames,
        };
        // AFTER the gesture record exists, never before — THE CAPTURE RULE at the
        // top of this file. `setPointerCapture` throws on an id it cannot capture,
        // and a throw above this line would cost the whole press.
        capturePointer(viewport, event.pointerId);
        return;
      }

      /* --- trim ---------------------------------------------------------- */
      if (edgeEl && clipEl) {
        const id = clipEl.dataset.clipId as ClipId;
        const clip = s.clips[id];
        if (!clip) return;
        const edge = (edgeEl.dataset.edge as 'in' | 'out') ?? 'out';
        focusClip(id);
        if (!s.selection.has(id)) s.select(id, 'replace');
        anchor.current = id;
        // The whole group, in closure order, primary included. A member with no
        // rendered element is SKIPPED, never a reason to abort the gesture — it is
        // off screen, the commit still trims it, and the next render paints it
        // correctly (docs/LINKING.md §5.3).
        const memberIds = selectLinkedClosure(s, [id]);
        const members: { id: ClipId; el: HTMLElement }[] = [];
        for (const memberId of memberIds) {
          const el =
            memberId === id
              ? clipEl
              : refs.laneContent.current?.querySelector<HTMLElement>(
                  `[data-clip-id="${memberId}"]`,
                );
          if (el) members.push({ id: memberId, el });
        }
        gesture.current = {
          ...common,
          kind: 'trim',
          id,
          edge,
          el: clipEl,
          members,
          startX: event.clientX,
          originFrame: edge === 'in' ? clip.start : clipEnd(clip),
          // The exclusion widens to the whole member set, or a member's own edge
          // becomes a snap target for the trim that is moving it.
          targets: selectSnapTargets(s, new Set(memberIds)),
          moved: false,
          frame: edge === 'in' ? clip.start : clipEnd(clip),
        };
        capturePointer(viewport, event.pointerId);
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
        const edges: SnapEdge[] = [];
        for (const clipId of ids) {
          const el = refs.laneContent.current?.querySelector<HTMLElement>(
            `[data-clip-id="${clipId}"]`,
          );
          if (el) els.push(el);
          const c = after.clips[clipId];
          // Start BEFORE end, per clip, unchanged — `snapTranslation`'s tie
          // resolution depends on this order (see its comment), and the kinds
          // are now named here so the two files cannot disagree about which is
          // which.
          if (c) edges.push({ frame: c.start, kind: 'start' }, { frame: clipEnd(c), kind: 'end' });
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
          insert: false,
          pushedEls: new Map(),
        };
        // AFTER the record exists — THE CAPTURE RULE. Unchanged by §12; the
        // insert path adds no earlier exit and takes no capture of its own.
        capturePointer(viewport, event.pointerId);
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
      capturePointer(viewport, event.pointerId);
    },
    [focusClip, refs.laneContent, refs.laneViewport, stopMomentum],
  );

  /**
   * The clip context menu, opened from the lane viewport's delegated handler —
   * so it costs no per-clip listener at forty clips, exactly as
   * `onLanePointerDown` already resolves a clip through `[data-clip-id]`.
   *
   * A right-press must NOT change an existing selection (`handlePointerDown`
   * ignores `button > 0` for the same reason: a context-menu press is not a
   * choice). When the clip is not selected it is selected `replace` first, so
   * the menu never acts on something invisible.
   */
  const onLaneContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const clipEl = (event.target as HTMLElement).closest<HTMLElement>('[data-clip-id]');
      const s = readStore();

      /* --- empty lane space ---------------------------------------------
         The TRACK menu, not a second clip menu: the questions worth asking
         about a stretch of empty lane are all about the track it belongs to —
         put a title here, mute it, lock it, set its level. It carries the frame
         under the pointer, so `Add title` lands where the user pressed rather
         than at the playhead. */
      if (!clipEl) {
        const viewport = refs.laneViewport.current;
        if (!viewport) return;
        const rect = viewport.getBoundingClientRect();
        const track = selectTrackAtY(s, contentYAtClientY(event.clientY, rect, s.scrollY));
        if (!track) return;
        event.preventDefault();
        const frame = frameAtClientX(event.clientX, rect, s.scrollX, s.zoom);
        const snapped = snapFrame(frame, selectSnapTargets(s), s.zoom, s.snapEnabled);
        trackMenu.current?.openAt(track.id, snapped.frame, event.clientY, event.clientX);
        return;
      }

      const id = clipEl.dataset.clipId as ClipId;
      if (!s.clips[id]) return;
      event.preventDefault();
      if (!s.selection.has(id)) s.select(id, 'replace');
      // The menu acts on the clip it opened on, so that is where the keyboard
      // comes back to.
      focusClip(id);
      clipMenu.current?.openAt(id, event.clientY, event.clientX);
    },
    [clipMenu, focusClip, refs.laneViewport, trackMenu],
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
      capturePointer(viewport, event.pointerId);
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

      // Both platform conventions for "open the context menu on the focused
      // thing", so the menu is reachable on a keyboard that has no Menu key —
      // the same pair the media rail's rows already answer to.
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        if (!current || !s.clips[current]) return;
        event.preventDefault();
        const el = refs.laneContent.current?.querySelector<HTMLElement>(
          `[data-clip-id="${current}"]`,
        );
        if (!el) return;
        if (!s.selection.has(current)) s.select(current, 'replace');
        const rect = el.getBoundingClientRect();
        clipMenu.current?.openAt(
          current,
          rect.bottom - GAP_FROM_CLIP,
          rect.left + GAP_FROM_CLIP,
        );
        return;
      }

      // `edit.addTitle` used to be matched HERE, by hand. It has moved to
      // `useRegionShortcuts` on `.tl-root`: matching it in this handler meant it
      // fired only while focus was inside the lane viewport, so `T` on a track
      // head or the toolbar did nothing despite the row being scoped to the
      // whole timeline — and the key comparison here duplicated a binding the
      // registry already owned. Nothing region-scoped belongs in this handler.

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
        // There is no gesture here, so there is no lane the pointer is over.
        // deltaTrackIndex is 0, and kind-scoping only ever decides WHICH lane list
        // an index offset is applied to — at offset 0 every member resolves to its
        // own track whatever the primary is. So any member's track is correct;
        // focus is the honest one when it resolves, and the first moving id is the
        // fallback (docs/LINKING.md §5.2b).
        const primaryTrackId = s.clips[focusedClipId ?? '']?.trackId ?? s.clips[ids[0]]?.trackId;
        const result = s.moveClips(ids, delta, 0, primaryTrackId);
        if (!result.ok) {
          s.setNotice({
            tone: 'danger',
            title: 'Could not move',
            message: refusalLabel(s, result.reason, null),
          });
        }
      }
    },
    [clipMenu, focusClip, focusedClipId, refs.laneContent, refs.laneViewport],
  );

  /**
   * Keeps the roving tab stop honest when focus lands on a clip by Tab — and
   * reveals it. `focusClip` uses `preventScroll` because the lane scroll is
   * store-owned, so a Tab arriving from outside would otherwise leave the roving
   * clip focused somewhere off screen with no focus ring anywhere on screen.
   * Only a focus this hook did not itself cause needs the reveal.
   */
  const onLaneFocus = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>): void => {
      const el = (event.target as HTMLElement).closest<HTMLElement>('[data-clip-id]');
      const id = el?.dataset.clipId as ClipId | undefined;
      if (!id) return;
      setFocusedClipId(id);
      if (selfFocus.current) return;
      scrollClipIntoView(readStore(), id, refs.laneViewport.current);
    },
    [refs.laneViewport],
  );

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
    onLaneContextMenu,
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
 * Take pointer capture if the browser will give it, and carry on if it will not.
 *
 * `setPointerCapture` throws `NotFoundError` whenever the id is not a pointer
 * the element could capture — a pointer already lifted or cancelled, an id
 * synthesised by a test harness, a pointer captured elsewhere. Every gesture
 * here is driven by `window` listeners, so losing the capture costs nothing;
 * letting the throw escape cost the entire press, because the call sat above
 * the branches that build the gesture.
 */
function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* Window listeners already cover the gesture. */
  }
}

/** The mirror of `capturePointer`: releasing a capture we never took must not throw. */
function releasePointer(el: Element | null, pointerId: number): void {
  if (!el) return;
  try {
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
  } catch {
    /* Nothing was captured. */
  }
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
  primaryTrackId: TrackId | undefined,
): number {
  if (!planMove(s, ids, 0, deltaTrack, primaryTrackId).ok) return 0;
  let lo = 0;
  let hi = Math.round(target);
  for (let i = 0; i < 20; i += 1) {
    const mid = Math.round((lo + hi) / 2);
    if (mid === lo || mid === hi) break;
    if (planMove(s, ids, mid, deltaTrack, primaryTrackId).ok) lo = mid;
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
