/* ---------------------------------------------------------------------------
   timelineSlice.ts — OWNER: timeline.

   The document (tracks, clips, markers), the view state (zoom, scroll, snap),
   the selection, and the undo/redo stack over TimelineDoc.

   Three rules this file exists to enforce (PLAN §3.4):

   1. A mutation either applies whole or changes nothing and returns a reason.
      No silent clamping, no overwriting a neighbour, no partial group move.
   2. History snapshots TimelineDoc only. `selection`, `offlineClipIds`, zoom and
      scroll are outside it, so an undo never restores a stale offline set and
      never scrolls the view out from under the user.
   3. `offlineClipIds` is a projection of MEDIA state: it never pushes history
      and never marks the project dirty.

   `planMove` / `planTrim` are exported because the interaction layer needs to
   ask "would this be legal?" on every pointermove without mutating anything —
   one implementation of the rules, used by both the dry run and the commit.
--------------------------------------------------------------------------- */

import type {
  Clip,
  ClipId,
  ClipProperties,
  Frames,
  Marker,
  MarkerId,
  MediaId,
  MediaKind,
  ProjectFile,
  PxPerFrame,
  Selection,
  Track,
  TrackId,
} from '../types/model';
import {
  DEFAULT_CLIP_PROPERTIES,
  EMPTY_SELECTION,
  clipEnd,
  clipSourceLength,
} from '../types/model';
import type { SliceCreator, StoreState } from './types';
import { newId } from '../lib/id';
import { framesToPx, pxToFramesExact } from '../lib/time';
import {
  HISTORY_LIMIT,
  TRACK_HEIGHT_AUDIO,
  TRACK_HEIGHT_MAX,
  TRACK_HEIGHT_MIN,
  TRACK_HEIGHT_VIDEO,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../lib/constants';

/* ------------------------------------------------------------------- types */

export interface TimelineViewState {
  /** ZOOM_MIN..ZOOM_MAX */
  zoom: PxPerFrame;
  /** px from timeline frame 0, >= 0 */
  scrollX: number;
  /** px, lane area vertical scroll */
  scrollY: number;
  snapEnabled: boolean;
}

/** EXACTLY what history snapshots. Everything in here is restorable and self-consistent. */
export interface TimelineDoc {
  tracks: Record<TrackId, Track>;
  trackOrder: TrackId[];
  clips: Record<ClipId, Clip>;
  /**
   * Invariant: every array is sorted ascending by clip.start and contains no overlaps.
   * Derived FROM this doc, so a snapshot always carries a matching index.
   */
  clipsByTrack: Record<TrackId, ClipId[]>;
  markers: Record<MarkerId, Marker>;
}

export interface TimelineState extends TimelineDoc, TimelineViewState {
  selection: Selection;
  /** NOT part of TimelineDoc: derived from MEDIA state, which history does not cover. */
  offlineClipIds: ReadonlySet<ClipId>;
  history: { past: TimelineDoc[]; future: TimelineDoc[] };
  /**
   * Open transaction, or null. It carries the redo stack as it stood BEFORE the
   * transaction opened, because opening one clears `future` optimistically: a
   * transaction that is aborted rather than committed never happened, so its
   * redo entries must come back with the document.
   */
  historyTxn: { label: string; future: TimelineDoc[] } | null;
}

export type MoveFailure =
  | 'overlap' // a clip already occupies the target range
  | 'locked' // source or target track is locked
  | 'out-of-range' // start < 0, or duration < 1
  | 'no-track' // no track of the right kind exists at that position
  | 'kind-mismatch' // video clip onto an audio track, or vice versa
  | 'no-source'; // would need more source frames than the media has

export type MutationResult = { ok: true } | { ok: false; reason: MoveFailure };
export type CreateResult = { ok: true; id: ClipId } | { ok: false; reason: MoveFailure };

/**
 * The dry-run result. `blockingClipId` is what lets the drag ghost name the clip
 * in its refusal label and draw the 2px bar on the right edge (PLAN §3.4).
 */
export type PlanResult =
  | { ok: true; clips: Clip[] }
  | { ok: false; reason: MoveFailure; blockingClipId: ClipId | null };

export interface AddClipInput {
  mediaId: MediaId;
  trackId: TrackId;
  start: Frames;
  /** Defaults to the media's full durationFrames. */
  duration?: Frames;
  /** Defaults to 0. */
  mediaIn?: Frames;
}

export interface TimelineActions {
  addClip(input: AddClipInput): CreateResult;
  /**
   * Convenience used by media double-click and by drop: finds the first track of the right
   * kind with room at `start`, adding a track if none has room.
   */
  insertMediaAt(mediaId: MediaId, start: Frames, preferredTrackId?: TrackId): CreateResult;
  moveClip(id: ClipId, next: { trackId: TrackId; start: Frames }): MutationResult;
  /**
   * Group move. `deltaTrackIndex` is an offset within the SAME-KIND subsequence of
   * trackOrder, so a move can never cross video/audio. All-or-nothing.
   */
  moveClips(ids: ClipId[], deltaFrames: Frames, deltaTrackIndex: number): MutationResult;
  trimClip(id: ClipId, edge: 'in' | 'out', nextFrame: Frames): MutationResult;
  /** Splits every selected clip, or every clip under the playhead when selection is empty. */
  splitAtPlayhead(): void;
  /** Lift: leaves a gap. */
  deleteSelection(): void;
  /** Closes the gap on the affected tracks. */
  rippleDelete(): void;
  select(id: ClipId, mode: 'replace' | 'extend' | 'toggle'): void;
  selectMany(ids: ClipId[], mode: 'replace' | 'extend' | 'toggle'): void;
  clearSelection(): void;
  addTrack(kind: MediaKind): TrackId;
  removeTrack(id: TrackId): void;
  /** TRACK_HEIGHT_MIN..TRACK_HEIGHT_MAX */
  setTrackHeight(id: TrackId, px: number): void;
  toggleMute(id: TrackId): void;
  toggleLock(id: TrackId): void;
  toggleVisible(id: TrackId): void;
  setZoom(zoom: PxPerFrame): void;
  /**
   * anchorPx = pointer x relative to the lane viewport's left edge. Keeps the frame under
   * the pointer stationary. Uses pxToFramesExact internally. The only zoom entry point
   * wheel handlers may call.
   */
  zoomAround(nextZoom: PxPerFrame, anchorPx: number): void;
  zoomToFit(viewportPx: number): void;
  setScroll(x: number, y: number): void;
  setSnapEnabled(on: boolean): void;
  /** null when `frame` is not a finite number — the refusal `MarkerId` cannot express. */
  addMarker(frame?: Frames, label?: string): MarkerId | null;
  removeMarker(id: MarkerId): void;
  /**
   * Called by mediaSlice.removeItem, by probe failure, and after every undo/redo/hydrate.
   * NEVER touches history and never marks dirty — it is a projection of media state.
   */
  markClipsOffline(mediaId: MediaId): void;
  /** Full recompute of offlineClipIds from current media. Idempotent. */
  recomputeOfflineClips(): void;
  /** Shortens any clip whose source no longer covers it. Returns how many it changed. */
  clampClipsToSource(): number;
  /** THE inspector's only write path. All-or-nothing across `ids`. */
  updateClipProperties(ids: ClipId[], patch: Partial<ClipProperties>): MutationResult;
  renameClip(id: ClipId, name: string): void;

  // --- history ---
  /** Open a transaction. A no-op when one is already open (transactions do not nest). */
  beginHistory(label: string): void;
  /** Close the open transaction. A no-op when none is open. */
  commitHistory(): void;
  /** Restore the open transaction's snapshot and close it. A no-op when none is open. */
  abortHistory(): void;
  undo(): void;
  redo(): void;

  hydrateTimeline(p: Pick<ProjectFile, 'tracks' | 'trackOrder' | 'clips' | 'markers'>): void;
}

export type TimelineSlice = TimelineState & TimelineActions;

/* ----------------------------------------------------------------- helpers */

/** Sorts each track's clip ids ascending by start. The clipsByTrack invariant. */
export function buildClipsByTrack(
  clips: Record<ClipId, Clip>,
  trackOrder: readonly TrackId[],
): Record<TrackId, ClipId[]> {
  const byTrack: Record<TrackId, ClipId[]> = {};
  for (const t of trackOrder) byTrack[t] = [];
  for (const clip of Object.values(clips)) {
    if (!byTrack[clip.trackId]) byTrack[clip.trackId] = [];
    byTrack[clip.trackId].push(clip.id);
  }
  for (const t of Object.keys(byTrack)) {
    byTrack[t].sort((a, b) => (clips[a]?.start ?? 0) - (clips[b]?.start ?? 0));
  }
  return byTrack;
}

/**
 * The default track set (PLAN §8.13): a brand-new project must still have lanes, or a
 * first drop has nowhere to land. trackOrder is top-to-bottom, so V2 sits above V1.
 */
export function createDefaultTracks(): { tracks: Track[]; trackOrder: TrackId[] } {
  const mk = (kind: MediaKind, index: number): Track => ({
    id: newId('t'),
    kind,
    index,
    label: `${kind === 'video' ? 'V' : 'A'}${index}`,
    height: kind === 'video' ? TRACK_HEIGHT_VIDEO : TRACK_HEIGHT_AUDIO,
    muted: false,
    locked: false,
    visible: true,
  });
  const tracks = [mk('video', 2), mk('video', 1), mk('audio', 1), mk('audio', 2)];
  return { tracks, trackOrder: tracks.map((t) => t.id) };
}

const docOf = (s: TimelineDoc): TimelineDoc => ({
  tracks: s.tracks,
  trackOrder: s.trackOrder,
  clips: s.clips,
  clipsByTrack: s.clipsByTrack,
  markers: s.markers,
});

/** Shallow per-collection copy. Records are never mutated in place, so this is a true snapshot. */
function cloneDoc(d: TimelineDoc): TimelineDoc {
  const clipsByTrack: Record<TrackId, ClipId[]> = {};
  for (const [t, ids] of Object.entries(d.clipsByTrack)) clipsByTrack[t] = [...ids];
  return {
    tracks: { ...d.tracks },
    trackOrder: [...d.trackOrder],
    clips: { ...d.clips },
    clipsByTrack,
    markers: { ...d.markers },
  };
}

/** Applies clip additions/replacements and removals, keeping clipsByTrack sorted. */
function withClips(
  doc: TimelineDoc,
  next: readonly Clip[],
  removed: readonly ClipId[] = [],
): TimelineDoc {
  const clips: Record<ClipId, Clip> = { ...doc.clips };
  const touched = new Set<TrackId>();

  for (const id of removed) {
    const prev = clips[id];
    if (prev) touched.add(prev.trackId);
    delete clips[id];
  }
  for (const clip of next) {
    const prev = doc.clips[clip.id];
    if (prev) touched.add(prev.trackId);
    touched.add(clip.trackId);
    clips[clip.id] = clip;
  }

  const clipsByTrack: Record<TrackId, ClipId[]> = { ...doc.clipsByTrack };
  for (const trackId of touched) {
    const kept = (doc.clipsByTrack[trackId] ?? []).filter(
      (id) => clips[id] !== undefined && clips[id].trackId === trackId,
    );
    for (const clip of next) {
      if (clip.trackId === trackId && !kept.includes(clip.id)) kept.push(clip.id);
    }
    kept.sort((a, b) => {
      const byStart = (clips[a]?.start ?? 0) - (clips[b]?.start ?? 0);
      return byStart !== 0 ? byStart : a < b ? -1 : a > b ? 1 : 0;
    });
    clipsByTrack[trackId] = kept;
  }
  return { ...doc, clips, clipsByTrack };
}

function pruneSelection(selection: Selection, clips: Record<ClipId, Clip>): Selection {
  let dropped = false;
  const kept = new Set<ClipId>();
  for (const id of selection) {
    if (clips[id]) kept.add(id);
    else dropped = true;
  }
  return dropped ? kept : selection;
}

/**
 * A frame or duration argument that is safe to sanitize. PLAN §2.1: time is whole
 * frames, always — and NaN is not one.
 *
 * Every clamp in this file is blind to it: `Math.max(0, NaN)` is NaN, `Math.round(NaN)`
 * is NaN, and every comparison against NaN is false, so the overlap and source-bound
 * checks below "succeed" and the clip lands in the store with geometry that poisons all
 * duration arithmetic downstream. Sanitizing cannot fix a non-number, so the boundary
 * refuses it — `out-of-range`, the same all-or-nothing refusal as start < 0 (§3.4 rule 1).
 * The invariant is declared here, so it is enforced here rather than at each caller.
 */
const isFiniteFrames = (v: number | undefined): boolean => v === undefined || Number.isFinite(v);

/** The media kind a clip carries. Falls back to its track when the media is gone. */
export function clipKind(s: StoreState, clip: Clip): MediaKind {
  return s.items[clip.mediaId]?.kind ?? s.tracks[clip.trackId]?.kind ?? 'video';
}

/** Source frames available, or null when the media has not reported a duration yet. */
function sourceFrames(s: StoreState, clip: Clip): Frames | null {
  const media = s.items[clip.mediaId];
  if (!media || media.durationFrames <= 0) return null;
  return media.durationFrames;
}

function violatesSource(s: StoreState, clip: Clip): boolean {
  const total = sourceFrames(s, clip);
  if (total === null) return false;
  return clip.mediaIn < 0 || clip.mediaIn + clipSourceLength(clip) > total;
}

/**
 * The last timeline frame this clip's source can reach — where the `no-source` bar is
 * drawn. Returns null when the source length is unknown.
 */
export function maxOutFrame(s: StoreState, clip: Clip): Frames | null {
  const total = sourceFrames(s, clip);
  if (total === null) return null;
  const speed = clip.properties.speed || 1;
  return clip.start + Math.max(1, Math.floor((total - clip.mediaIn) / speed));
}

/** The first clip on `trackId` that intersects [start, end), ignoring `exclude`. */
function overlapOnTrack(
  s: StoreState,
  trackId: TrackId,
  start: Frames,
  end: Frames,
  exclude: ReadonlySet<ClipId>,
): ClipId | null {
  const ids = s.clipsByTrack[trackId];
  if (!ids) return null;
  for (const id of ids) {
    if (exclude.has(id)) continue;
    const clip = s.clips[id];
    if (!clip) continue;
    if (clip.start >= end) break; // sorted by start: nothing later can intersect
    if (start < clipEnd(clip)) return id;
  }
  return null;
}

/** The track ids of one kind, in trackOrder (top to bottom). */
export function tracksOfKind(s: StoreState, kind: MediaKind): TrackId[] {
  return s.trackOrder.filter((id) => s.tracks[id]?.kind === kind);
}

/**
 * Dry run of a group move. Pure — call it from a pointermove to decide whether the ghost
 * is legal, then call `moveClips` with the same arguments on pointerup.
 */
export function planMove(
  s: StoreState,
  ids: readonly ClipId[],
  deltaFrames: number,
  deltaTrackIndex: number,
): PlanResult {
  if (!isFiniteFrames(deltaFrames)) {
    return { ok: false, reason: 'out-of-range', blockingClipId: null };
  }
  const moving: Clip[] = [];
  for (const id of ids) {
    const clip = s.clips[id];
    if (clip) moving.push(clip);
  }
  if (moving.length === 0) return { ok: false, reason: 'no-track', blockingClipId: null };

  const movingSet = new Set(moving.map((c) => c.id));
  const delta = Math.round(deltaFrames);
  const next: Clip[] = [];

  for (const clip of moving) {
    const origin = s.tracks[clip.trackId];
    if (!origin) return { ok: false, reason: 'no-track', blockingClipId: null };
    if (origin.locked) return { ok: false, reason: 'locked', blockingClipId: clip.id };

    const lane = tracksOfKind(s, origin.kind);
    const at = lane.indexOf(clip.trackId);
    const targetId = at < 0 ? undefined : lane[at + deltaTrackIndex];
    const target = targetId ? s.tracks[targetId] : undefined;
    if (!targetId || !target) return { ok: false, reason: 'no-track', blockingClipId: null };
    if (target.locked) return { ok: false, reason: 'locked', blockingClipId: null };
    if (target.kind !== clipKind(s, clip)) {
      return { ok: false, reason: 'kind-mismatch', blockingClipId: null };
    }

    const start = clip.start + delta;
    if (start < 0) return { ok: false, reason: 'out-of-range', blockingClipId: null };
    next.push({ ...clip, trackId: targetId, start });
  }

  for (const clip of next) {
    const blocking = overlapOnTrack(s, clip.trackId, clip.start, clipEnd(clip), movingSet);
    if (blocking) return { ok: false, reason: 'overlap', blockingClipId: blocking };
  }
  for (let i = 0; i < next.length; i += 1) {
    for (let j = i + 1; j < next.length; j += 1) {
      const a = next[i];
      const b = next[j];
      if (a.trackId === b.trackId && a.start < clipEnd(b) && b.start < clipEnd(a)) {
        return { ok: false, reason: 'overlap', blockingClipId: b.id };
      }
    }
  }
  return { ok: true, clips: next };
}

/** Dry run of a trim. Same contract as `planMove`. */
export function planTrim(
  s: StoreState,
  id: ClipId,
  edge: 'in' | 'out',
  nextFrame: Frames,
): PlanResult {
  if (!isFiniteFrames(nextFrame)) {
    return { ok: false, reason: 'out-of-range', blockingClipId: null };
  }
  const clip = s.clips[id];
  if (!clip) return { ok: false, reason: 'no-track', blockingClipId: null };
  const track = s.tracks[clip.trackId];
  if (!track) return { ok: false, reason: 'no-track', blockingClipId: null };
  if (track.locked) return { ok: false, reason: 'locked', blockingClipId: null };

  const speed = clip.properties.speed || 1;
  let updated: Clip;

  if (edge === 'in') {
    const end = clipEnd(clip);
    const start = Math.round(nextFrame);
    if (start < 0) return { ok: false, reason: 'out-of-range', blockingClipId: null };
    const duration = end - start;
    if (duration < 1) return { ok: false, reason: 'out-of-range', blockingClipId: null };
    const mediaIn = clip.mediaIn + Math.round((start - clip.start) * speed);
    if (mediaIn < 0) return { ok: false, reason: 'no-source', blockingClipId: null };
    updated = { ...clip, start, duration, mediaIn };
  } else {
    const duration = Math.round(nextFrame) - clip.start;
    if (duration < 1) return { ok: false, reason: 'out-of-range', blockingClipId: null };
    updated = { ...clip, duration };
  }

  if (violatesSource(s, updated)) return { ok: false, reason: 'no-source', blockingClipId: null };

  const blocking = overlapOnTrack(
    s,
    updated.trackId,
    updated.start,
    clipEnd(updated),
    new Set([id]),
  );
  if (blocking) return { ok: false, reason: 'overlap', blockingClipId: blocking };
  return { ok: true, clips: [updated] };
}

/**
 * Breathing room left to the right of the last frame when fitting, so the final
 * clip's out edge is not flush against the viewport edge and still grabbable.
 * One --space-xxl. Reported to scaffold as a candidate for `src/lib/constants.ts`
 * (PLAN §0.2); named here rather than left as a bare literal in the view maths.
 */
const ZOOM_FIT_MARGIN_PX = 24;

const clampZoom = (zoom: number): PxPerFrame =>
  Number.isFinite(zoom) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) : ZOOM_DEFAULT;

/* ----------------------------------------------------------------- creator */

export const createTimelineSlice: SliceCreator<TimelineSlice> = (set, get) => {
  /**
   * Snapshot before mutating — unless a transaction is open, in which case the
   * transaction's own snapshot already covers this write (PLAN §3.4).
   */
  const pushHistory = (): void => {
    const s = get();
    if (s.historyTxn !== null) return;
    const past = [...s.history.past, cloneDoc(docOf(s))];
    if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
    set({ history: { past, future: [] } });
  };

  /** Restore a document snapshot and re-derive everything history does not cover. */
  const restore = (doc: TimelineDoc, history: TimelineState['history']): void => {
    set({
      tracks: doc.tracks,
      trackOrder: doc.trackOrder,
      clips: doc.clips,
      clipsByTrack: doc.clipsByTrack,
      markers: doc.markers,
      history,
      historyTxn: null,
      selection: pruneSelection(get().selection, doc.clips),
    });
    get().recomputeOfflineClips();
  };

  return {
    tracks: {},
    trackOrder: [],
    clips: {},
    clipsByTrack: {},
    markers: {},

    zoom: ZOOM_DEFAULT,
    scrollX: 0,
    scrollY: 0,
    snapEnabled: true,

    selection: EMPTY_SELECTION,
    offlineClipIds: new Set<ClipId>(),
    history: { past: [], future: [] },
    historyTxn: null,

    /* ------------------------------------------------------------- creation */

    addClip: (input) => {
      if (
        !isFiniteFrames(input.start) ||
        !isFiniteFrames(input.duration) ||
        !isFiniteFrames(input.mediaIn)
      ) {
        return { ok: false, reason: 'out-of-range' };
      }
      const s = get();
      const media = s.items[input.mediaId];
      const track = s.tracks[input.trackId];
      if (!track) return { ok: false, reason: 'no-track' };
      if (track.locked) return { ok: false, reason: 'locked' };
      if (media && media.kind !== track.kind) return { ok: false, reason: 'kind-mismatch' };

      const start = Math.max(0, Math.round(input.start));
      const fallback = media?.durationFrames && media.durationFrames > 0 ? media.durationFrames : 1;
      const duration = Math.max(1, Math.round(input.duration ?? fallback));
      const mediaIn = Math.max(0, Math.round(input.mediaIn ?? 0));

      const clip: Clip = {
        id: newId('c'),
        mediaId: input.mediaId,
        trackId: input.trackId,
        start,
        duration,
        mediaIn,
        name: media?.name ?? 'Clip',
        properties: { ...DEFAULT_CLIP_PROPERTIES },
      };

      if (violatesSource(s, clip)) return { ok: false, reason: 'no-source' };
      if (overlapOnTrack(s, clip.trackId, clip.start, clipEnd(clip), EMPTY_SELECTION)) {
        return { ok: false, reason: 'overlap' };
      }

      pushHistory();
      set(withClips(docOf(get()), [clip]));
      get().markDirty();
      return { ok: true, id: clip.id };
    },

    insertMediaAt: (mediaId, start, preferredTrackId) => {
      if (!isFiniteFrames(start)) return { ok: false, reason: 'out-of-range' };
      const s = get();
      const media = s.items[mediaId];
      if (!media) return { ok: false, reason: 'no-track' };
      const kind = media.kind;

      // V1 / A1 first: lowest index of the right kind, then upward.
      const candidates = tracksOfKind(s, kind).sort(
        (a, b) => (s.tracks[a]?.index ?? 0) - (s.tracks[b]?.index ?? 0),
      );
      if (preferredTrackId && s.tracks[preferredTrackId]?.kind === kind) {
        candidates.unshift(preferredTrackId);
      }

      const at = Math.max(0, Math.round(start));
      const duration = Math.max(1, media.durationFrames || 1);

      for (const trackId of candidates) {
        const track = s.tracks[trackId];
        if (!track || track.locked) continue;
        if (overlapOnTrack(s, trackId, at, at + duration, EMPTY_SELECTION)) continue;
        return get().addClip({ mediaId, trackId, start: at });
      }

      // Nothing had room: the new track and the clip are one edit, so one history entry.
      const opened = get().historyTxn === null;
      if (opened) get().beginHistory('Insert media');
      const trackId = get().addTrack(kind);
      const result = get().addClip({ mediaId, trackId, start: at });
      if (opened) {
        // A refused clip must not leave a stray empty track behind.
        if (result.ok) get().commitHistory();
        else get().abortHistory();
      }
      return result;
    },

    /* --------------------------------------------------------------- moving */

    moveClip: (id, next) => {
      const s = get();
      const clip = s.clips[id];
      if (!clip) return { ok: false, reason: 'no-track' };
      const target = s.tracks[next.trackId];
      const origin = s.tracks[clip.trackId];
      if (!target || !origin) return { ok: false, reason: 'no-track' };
      const lane = tracksOfKind(s, origin.kind);
      const deltaTrackIndex = lane.indexOf(next.trackId) - lane.indexOf(clip.trackId);
      if (lane.indexOf(next.trackId) < 0) return { ok: false, reason: 'kind-mismatch' };
      return get().moveClips([id], next.start - clip.start, deltaTrackIndex);
    },

    moveClips: (ids, deltaFrames, deltaTrackIndex) => {
      const plan = planMove(get(), ids, deltaFrames, deltaTrackIndex);
      if (!plan.ok) return { ok: false, reason: plan.reason };
      if (Math.round(deltaFrames) === 0 && deltaTrackIndex === 0) return { ok: true };
      pushHistory();
      set(withClips(docOf(get()), plan.clips));
      get().markDirty();
      return { ok: true };
    },

    trimClip: (id, edge, nextFrame) => {
      const plan = planTrim(get(), id, edge, nextFrame);
      if (!plan.ok) return { ok: false, reason: plan.reason };
      pushHistory();
      set(withClips(docOf(get()), plan.clips));
      get().markDirty();
      return { ok: true };
    },

    /* -------------------------------------------------------------- editing */

    splitAtPlayhead: () => {
      const s = get();
      const at = s.playhead;
      const targets: Clip[] = [];
      let blockedByLock = false;

      const consider = (clip: Clip | undefined): void => {
        if (!clip) return;
        if (at <= clip.start || at >= clipEnd(clip)) return;
        if (s.tracks[clip.trackId]?.locked) {
          blockedByLock = true;
          return;
        }
        targets.push(clip);
      };

      if (s.selection.size > 0) for (const id of s.selection) consider(s.clips[id]);
      else for (const clip of Object.values(s.clips)) consider(clip);

      // The refusal is raised HERE, not at a call site: the toolbar button and the
      // `S` shortcut are the same registry row, and a check that lives in only one
      // of them makes the control explain itself on click and stay silent on the
      // key (PLAN §5, and §3.4's "never silent").
      if (targets.length === 0) {
        get().setNotice(
          blockedByLock
            ? { tone: 'warning', title: 'Could not split', message: 'Track is locked' }
            : {
                tone: 'warning',
                title: 'Nothing to split',
                message: 'Park the playhead over a clip first',
              },
        );
        return;
      }

      pushHistory();
      const next: Clip[] = [];
      const selection = new Set<ClipId>(s.selection);

      for (const clip of targets) {
        const leftDuration = at - clip.start;
        const speed = clip.properties.speed || 1;
        const left: Clip = { ...clip, duration: leftDuration };
        const right: Clip = {
          ...clip,
          id: newId('c'),
          start: at,
          duration: clipEnd(clip) - at,
          mediaIn: clip.mediaIn + Math.round(leftDuration * speed),
          properties: { ...clip.properties },
        };
        next.push(left, right);
        if (selection.has(clip.id)) selection.add(right.id);
      }

      set({ ...withClips(docOf(get()), next), selection });
      get().markDirty();
      // A split mints a new clip id, so the offline projection no longer covers
      // the clip set — same reason deleteSelection and rippleDelete recompute.
      get().recomputeOfflineClips();
    },

    deleteSelection: () => {
      const s = get();
      const ids = selectDeletableClipIds(s);
      if (ids.length === 0) {
        // Every id in `selection` exists in `clips` (§3.4), so a non-empty
        // selection that yields nothing to remove was refused by a track lock,
        // and a refusal is never silent.
        if (s.selection.size > 0) {
          get().setNotice({
            tone: 'warning',
            title: 'Could not delete',
            message: 'Track is locked',
          });
        }
        return;
      }

      pushHistory();
      const doc = withClips(docOf(get()), [], ids);
      set({ ...doc, selection: EMPTY_SELECTION });
      get().markDirty();
      get().recomputeOfflineClips();
    },

    rippleDelete: () => {
      const s = get();
      const removing = selectDeletableClipIds(s).map((id) => s.clips[id]);
      if (removing.length === 0) {
        if (s.selection.size > 0) {
          get().setNotice({
            tone: 'warning',
            title: 'Could not delete',
            message: 'Track is locked',
          });
        }
        return;
      }

      pushHistory();

      const removedByTrack = new Map<TrackId, Clip[]>();
      for (const clip of removing) {
        const list = removedByTrack.get(clip.trackId);
        if (list) list.push(clip);
        else removedByTrack.set(clip.trackId, [clip]);
      }

      const shifted: Clip[] = [];
      for (const [trackId, gone] of removedByTrack) {
        const goneIds = new Set(gone.map((c) => c.id));
        for (const id of s.clipsByTrack[trackId] ?? []) {
          if (goneIds.has(id)) continue;
          const clip = s.clips[id];
          if (!clip) continue;
          // Everything strictly after a removed clip closes up by that clip's length.
          let delta = 0;
          for (const removed of gone) if (clipEnd(removed) <= clip.start) delta += removed.duration;
          if (delta > 0) shifted.push({ ...clip, start: Math.max(0, clip.start - delta) });
        }
      }

      const doc = withClips(
        docOf(get()),
        shifted,
        removing.map((c) => c.id),
      );
      set({ ...doc, selection: EMPTY_SELECTION });
      get().markDirty();
      get().recomputeOfflineClips();
    },

    /* ------------------------------------------------------------ selection */

    select: (id, mode) => {
      get().selectMany([id], mode);
    },

    selectMany: (ids, mode) => {
      const s = get();
      const valid = ids.filter((id) => s.clips[id] !== undefined);
      if (mode === 'replace') {
        if (valid.length === s.selection.size && valid.every((id) => s.selection.has(id))) return;
        set({ selection: new Set(valid) });
        return;
      }
      const next = new Set<ClipId>(s.selection);
      if (mode === 'extend') for (const id of valid) next.add(id);
      else for (const id of valid) (next.has(id) ? next.delete(id) : next.add(id));
      set({ selection: next });
    },

    clearSelection: () => {
      if (get().selection.size === 0) return;
      set({ selection: EMPTY_SELECTION });
    },

    /* --------------------------------------------------------------- tracks */

    addTrack: (kind) => {
      const s = get();
      let maxIndex = 0;
      for (const id of s.trackOrder) {
        const track = s.tracks[id];
        if (track?.kind === kind && track.index > maxIndex) maxIndex = track.index;
      }
      const index = maxIndex + 1;
      const track: Track = {
        id: newId('t'),
        kind,
        index,
        label: `${kind === 'video' ? 'V' : 'A'}${index}`,
        height: kind === 'video' ? TRACK_HEIGHT_VIDEO : TRACK_HEIGHT_AUDIO,
        muted: false,
        locked: false,
        visible: true,
      };

      pushHistory();
      // Video stacks upward from the top of the order; audio appends to the bottom.
      const trackOrder =
        kind === 'video' ? [track.id, ...s.trackOrder] : [...s.trackOrder, track.id];
      set({
        tracks: { ...s.tracks, [track.id]: track },
        trackOrder,
        clipsByTrack: { ...s.clipsByTrack, [track.id]: [] },
      });
      get().markDirty();
      return track.id;
    },

    removeTrack: (id) => {
      const s = get();
      if (!s.tracks[id]) return;
      pushHistory();
      const doomed = s.clipsByTrack[id] ?? [];
      const doc = withClips(docOf(s), [], doomed);
      const tracks = { ...doc.tracks };
      delete tracks[id];
      const clipsByTrack = { ...doc.clipsByTrack };
      delete clipsByTrack[id];
      set({
        ...doc,
        tracks,
        clipsByTrack,
        trackOrder: doc.trackOrder.filter((t) => t !== id),
        selection: pruneSelection(s.selection, doc.clips),
      });
      get().markDirty();
      get().recomputeOfflineClips();
    },

    setTrackHeight: (id, px) => {
      const s = get();
      const track = s.tracks[id];
      if (!track) return;
      const height = Math.round(Math.min(TRACK_HEIGHT_MAX, Math.max(TRACK_HEIGHT_MIN, px)));
      if (height === track.height) return;
      pushHistory();
      set({ tracks: { ...s.tracks, [id]: { ...track, height } } });
      get().markDirty();
    },

    toggleMute: (id) => {
      const s = get();
      const track = s.tracks[id];
      if (!track) return;
      pushHistory();
      set({ tracks: { ...s.tracks, [id]: { ...track, muted: !track.muted } } });
      get().markDirty();
    },

    toggleLock: (id) => {
      const s = get();
      const track = s.tracks[id];
      if (!track) return;
      pushHistory();
      set({ tracks: { ...s.tracks, [id]: { ...track, locked: !track.locked } } });
      get().markDirty();
    },

    toggleVisible: (id) => {
      const s = get();
      const track = s.tracks[id];
      if (!track) return;
      pushHistory();
      set({ tracks: { ...s.tracks, [id]: { ...track, visible: !track.visible } } });
      get().markDirty();
    },

    /* ----------------------------------------------------------------- view */

    setZoom: (zoom) => {
      const next = clampZoom(zoom);
      if (next === get().zoom) return;
      set({ zoom: next });
    },

    zoomAround: (nextZoom, anchorPx) => {
      const s = get();
      const zoom = clampZoom(nextZoom);
      if (zoom === s.zoom) return;
      // Exact maths, rounded once: pxToFrames inside an anchor calculation drifts (PLAN §2.1).
      const frameAtAnchor = pxToFramesExact(s.scrollX + anchorPx, s.zoom);
      const scrollX = Math.max(0, framesToPx(frameAtAnchor, zoom) - anchorPx);
      set({ zoom, scrollX });
    },

    zoomToFit: (viewportPx) => {
      const s = get();
      const width = Math.max(1, viewportPx);
      const duration = selectTimelineDurationFrames(s);
      const frames = duration > 0 ? duration : Math.max(1, Math.round(s.fps * 10));
      set({ zoom: clampZoom((width - ZOOM_FIT_MARGIN_PX) / frames), scrollX: 0 });
    },

    setScroll: (x, y) => {
      const s = get();
      const scrollX = Math.max(0, x);
      const scrollY = Math.max(0, y);
      if (scrollX === s.scrollX && scrollY === s.scrollY) return;
      set({ scrollX, scrollY });
    },

    setSnapEnabled: (on) => {
      if (on === get().snapEnabled) return;
      set({ snapEnabled: on });
    },

    /* -------------------------------------------------------------- markers */

    addMarker: (frame, label) => {
      if (!isFiniteFrames(frame)) return null;
      const s = get();
      const at = Math.max(0, Math.round(frame ?? s.playhead));
      const existing = Object.values(s.markers).find((m) => m.frame === at);
      if (existing) return existing.id;
      const marker: Marker = { id: newId('k'), frame: at, label: label ?? '' };
      pushHistory();
      set({ markers: { ...s.markers, [marker.id]: marker } });
      get().markDirty();
      return marker.id;
    },

    removeMarker: (id) => {
      const s = get();
      if (!s.markers[id]) return;
      pushHistory();
      const markers = { ...s.markers };
      delete markers[id];
      set({ markers });
      get().markDirty();
    },

    /* --------------------------------------------------- media projections */

    markClipsOffline: (mediaId) => {
      const s = get();
      const next = new Set<ClipId>(s.offlineClipIds);
      let changed = false;
      for (const clip of Object.values(s.clips)) {
        if (clip.mediaId === mediaId && !next.has(clip.id)) {
          next.add(clip.id);
          changed = true;
        }
      }
      if (changed) set({ offlineClipIds: next });
    },

    recomputeOfflineClips: () => {
      const s = get();
      const offline = new Set<ClipId>();
      for (const clip of Object.values(s.clips)) {
        const media = s.items[clip.mediaId];
        if (!media || media.status === 'error') offline.add(clip.id);
      }
      if (offline.size === s.offlineClipIds.size) {
        let same = true;
        for (const id of offline) if (!s.offlineClipIds.has(id)) same = false;
        if (same) return;
      }
      set({ offlineClipIds: offline });
    },

    clampClipsToSource: () => {
      const s = get();
      const shortened: Clip[] = [];
      const stranded = new Set<ClipId>(s.offlineClipIds);
      let strandedChanged = false;

      for (const clip of Object.values(s.clips)) {
        const total = sourceFrames(s, clip);
        if (total === null) continue;
        if (clip.mediaIn >= total) {
          if (!stranded.has(clip.id)) {
            stranded.add(clip.id);
            strandedChanged = true;
          }
          continue;
        }
        const speed = clip.properties.speed || 1;
        const maxDuration = Math.max(1, Math.floor((total - clip.mediaIn) / speed));
        if (clip.duration > maxDuration) shortened.push({ ...clip, duration: maxDuration });
      }

      if (strandedChanged) set({ offlineClipIds: stranded });
      if (shortened.length === 0) return 0;

      pushHistory();
      set(withClips(docOf(get()), shortened));
      get().markDirty();
      return shortened.length;
    },

    /* ----------------------------------------------------------- properties */

    updateClipProperties: (ids, patch) => {
      const s = get();
      const next: Clip[] = [];

      for (const id of ids) {
        const clip = s.clips[id];
        if (!clip) continue;
        if (s.tracks[clip.trackId]?.locked) return { ok: false, reason: 'locked' };

        const properties: ClipProperties = { ...clip.properties, ...patch };
        const oldSpeed = clip.properties.speed || 1;
        const newSpeed = properties.speed || 1;
        // Source consumption is held constant, so a speed change moves the out edge
        // and runs the same overlap and source checks as a trim (PLAN §2.4 rule 4).
        const duration =
          newSpeed === oldSpeed
            ? clip.duration
            : Math.max(1, Math.round((clip.duration * oldSpeed) / newSpeed));

        next.push({ ...clip, properties, duration });
      }

      if (next.length === 0) return { ok: true };

      const movingSet = new Set(next.map((c) => c.id));
      for (const clip of next) {
        if (violatesSource(s, clip)) return { ok: false, reason: 'no-source' };
        const blocking = overlapOnTrack(s, clip.trackId, clip.start, clipEnd(clip), movingSet);
        if (blocking) return { ok: false, reason: 'overlap' };
      }

      pushHistory();
      set(withClips(docOf(get()), next));
      get().markDirty();
      return { ok: true };
    },

    renameClip: (id, name) => {
      const s = get();
      const clip = s.clips[id];
      const trimmed = name.trim();
      if (!clip || trimmed === '' || trimmed === clip.name) return;
      pushHistory();
      set({ clips: { ...s.clips, [id]: { ...clip, name: trimmed } } });
      get().markDirty();
    },

    /* -------------------------------------------------------------- history */

    beginHistory: (label) => {
      const s = get();
      if (s.historyTxn !== null) return; // transactions do not nest
      const past = [...s.history.past, cloneDoc(docOf(s))];
      if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
      set({
        history: { past, future: [] },
        historyTxn: { label, future: s.history.future },
      });
    },

    commitHistory: () => {
      if (get().historyTxn === null) return;
      // The edit really happened, so the redo stash dies with the transaction.
      set({ historyTxn: null });
    },

    abortHistory: () => {
      const s = get();
      const txn = s.historyTxn;
      if (txn === null) return;
      const past = [...s.history.past];
      const snapshot = past.pop();
      if (!snapshot) {
        set({ historyTxn: null, history: { past, future: txn.future } });
        return;
      }
      restore(snapshot, { past, future: txn.future });
    },

    undo: () => {
      const s = get();
      if (s.history.past.length === 0) return;
      const past = [...s.history.past];
      const snapshot = past.pop() as TimelineDoc;
      const future = [cloneDoc(docOf(s)), ...s.history.future];
      restore(snapshot, { past, future });
      get().markDirty();
    },

    redo: () => {
      const s = get();
      if (s.history.future.length === 0) return;
      const future = [...s.history.future];
      const snapshot = future.shift() as TimelineDoc;
      const past = [...s.history.past, cloneDoc(docOf(s))];
      restore(snapshot, { past, future });
      get().markDirty();
    },

    /* -------------------------------------------------------------- hydrate */

    hydrateTimeline: (p) => {
      const seeded =
        p.tracks.length > 0 ? { tracks: p.tracks, trackOrder: p.trackOrder } : createDefaultTracks();

      const tracks: Record<TrackId, Track> = {};
      for (const t of seeded.tracks) tracks[t.id] = t;

      const trackOrder =
        seeded.trackOrder.length > 0 ? [...seeded.trackOrder] : seeded.tracks.map((t) => t.id);

      const clips: Record<ClipId, Clip> = {};
      for (const c of p.clips) if (tracks[c.trackId]) clips[c.id] = c;

      const markers: Record<MarkerId, Marker> = {};
      for (const m of p.markers) markers[m.id] = m;

      set({
        tracks,
        trackOrder,
        clips,
        clipsByTrack: buildClipsByTrack(clips, trackOrder),
        markers,
        selection: EMPTY_SELECTION,
        history: { past: [], future: [] },
        historyTxn: null,
        scrollX: 0,
        scrollY: 0,
      });

      get().recomputeOfflineClips();
      get().markSaved();
    },
  };
};

/* --------------------------------------------------------------- selectors */

const NO_CLIPS: readonly ClipId[] = [];

/**
 * [stable] max clipEnd, min 0.
 *
 * O(tracks) and allocation-free: `clipsByTrack` is sorted ascending by start
 * with no overlaps, so the LAST id on a track carries that track's largest end.
 * This runs on every store write, including the 60-per-second playhead writes
 * during playback (PLAN §1.3 rule 1), so it may not walk `Object.values(clips)`.
 */
export const selectTimelineDurationFrames = (s: StoreState): Frames => {
  let max = 0;
  for (const trackId of s.trackOrder) {
    const ids = s.clipsByTrack[trackId];
    if (!ids || ids.length === 0) continue;
    const clip = s.clips[ids[ids.length - 1]];
    if (!clip) continue;
    const end = clipEnd(clip);
    if (end > max) max = end;
  }
  return max;
};

/** [stable] Returns s.clipsByTrack[t] BY REFERENCE. This is the lane renderer's subscription. */
export const selectClipIdsInTrack = (s: StoreState, t: TrackId): readonly ClipId[] =>
  s.clipsByTrack[t] ?? NO_CLIPS;

/**
 * [UNSTABLE REFERENCE] readStore() only. The clips a delete would actually remove:
 * the selection minus anything a track lock protects. `deleteSelection`,
 * `rippleDelete` and the keyboard layer's focus hand-off all ask this same
 * question, so there is one answer rather than three copies of the lock rule.
 */
export const selectDeletableClipIds = (s: StoreState): ClipId[] => {
  const out: ClipId[] = [];
  for (const id of s.selection) {
    const clip = s.clips[id];
    if (clip && !s.tracks[clip.trackId]?.locked) out.push(id);
  }
  return out;
};

/** [stable] */
export const selectIsSelected = (s: StoreState, id: ClipId): boolean => s.selection.has(id);

/** [stable] */
export const selectIsOffline = (s: StoreState, id: ClipId): boolean => s.offlineClipIds.has(id);

/** Binary search: index of the last clip whose start <= frame, or -1. */
function lastStartingAtOrBefore(ids: readonly ClipId[], clips: Record<ClipId, Clip>, frame: Frames) {
  let lo = 0;
  let hi = ids.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const clip = clips[ids[mid]];
    if (clip && clip.start <= frame) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * [stable] Topmost VISIBLE video clip whose [start, end) contains frame, as an ID.
 * O(tracks · log n). THE preview's subscription — it changes at clip boundaries, not at
 * frame rate.
 */
export const selectVideoClipIdAtFrame = (s: StoreState, frame: Frames): ClipId | null => {
  for (const trackId of s.trackOrder) {
    const track = s.tracks[trackId];
    if (!track || track.kind !== 'video' || !track.visible) continue;
    const ids = s.clipsByTrack[trackId];
    if (!ids || ids.length === 0) continue;
    const i = lastStartingAtOrBefore(ids, s.clips, frame);
    if (i < 0) continue;
    const clip = s.clips[ids[i]];
    if (clip && frame < clipEnd(clip)) return clip.id;
  }
  return null;
};

/**
 * [stable] The clip on `t` covering `frame`, or null. KIND-AGNOSTIC, and that is the
 * point of it: `selectAudioClipsAtFrame` filters `track.kind !== 'audio'`, so it cannot
 * see the audio embedded in a video clip — which EXPORT.md §1.7 mixes and
 * docs/AUDIO-MONITOR.md §1.1 therefore requires the preview to monitor. O(log n) through
 * the same binary search, allocating nothing, so an audio voice can subscribe to it
 * directly under PLAN §1.3 rule 1.
 */
export const selectClipIdInTrackAtFrame = (
  s: StoreState,
  t: TrackId,
  frame: Frames,
): ClipId | null => {
  const ids = s.clipsByTrack[t];
  if (!ids || ids.length === 0) return null;
  const i = lastStartingAtOrBefore(ids, s.clips, frame);
  if (i < 0) return null;
  const clip = s.clips[ids[i]];
  return clip && frame < clipEnd(clip) ? clip.id : null;
};

/**
 * [stable] The first clip on `t` starting STRICTLY after `frame`, or null. The primitive
 * the audio pool preloads from — without a per-track "next clip" there is nothing to
 * park the idle slot on, and every cut starts from source zero.
 */
export const selectNextClipIdInTrackAfter = (
  s: StoreState,
  t: TrackId,
  frame: Frames,
): ClipId | null => {
  const ids = s.clipsByTrack[t];
  if (!ids || ids.length === 0) return null;
  const i = lastStartingAtOrBefore(ids, s.clips, frame);
  const candidate = s.clips[ids[i + 1]];
  return candidate ? candidate.id : null;
};

/** [stable] The clip that starts next after `frame` on any visible video track, as an ID. */
export const selectNextVideoClipIdAfter = (s: StoreState, frame: Frames): ClipId | null => {
  let best: Clip | null = null;
  for (const trackId of s.trackOrder) {
    const track = s.tracks[trackId];
    if (!track || track.kind !== 'video' || !track.visible) continue;
    const ids = s.clipsByTrack[trackId];
    if (!ids) continue;
    const i = lastStartingAtOrBefore(ids, s.clips, frame);
    const candidate = s.clips[ids[i + 1]];
    if (candidate && (best === null || candidate.start < best.start)) best = candidate;
  }
  return best ? best.id : null;
};

/**
 * [stable] `y` is pixels from the top of the lane CONTENT, not the viewport and not the
 * lane rect: `event.clientY - laneRect.top + scrollY`. It does NOT include RULER_HEIGHT.
 * Returns null above the first lane or below the last.
 */
export const selectTrackAtY = (s: StoreState, y: number): Track | null => {
  if (y < 0) return null;
  let top = 0;
  for (const id of s.trackOrder) {
    const track = s.tracks[id];
    if (!track) continue;
    if (y < top + track.height) return track;
    top += track.height;
  }
  return null;
};

/** [stable] px from lane-content top. */
export const selectLaneTop = (s: StoreState, trackId: TrackId): number => {
  let top = 0;
  for (const id of s.trackOrder) {
    if (id === trackId) return top;
    top += s.tracks[id]?.height ?? 0;
  }
  return top;
};

/** [stable] total px, the sum of every Track.height in trackOrder. */
export const selectLaneHeight = (s: StoreState): number => {
  let total = 0;
  for (const id of s.trackOrder) total += s.tracks[id]?.height ?? 0;
  return total;
};

/** [stable] */
export const selectCanUndo = (s: StoreState): boolean => s.history.past.length > 0;

/** [stable] */
export const selectCanRedo = (s: StoreState): boolean => s.history.future.length > 0;

/** [stable] */
export const selectSelectionCount = (s: StoreState): number => s.selection.size;

/**
 * [stable] Total clip count — the timeline's empty-state test. Summed over the
 * per-track index rather than `Object.keys(clips)`, for the same reason as
 * `selectTimelineDurationFrames`: it must not allocate on every store write.
 */
export const selectClipCount = (s: StoreState): number => {
  let total = 0;
  for (const trackId of s.trackOrder) total += (s.clipsByTrack[trackId] ?? NO_CLIPS).length;
  return total;
};

/** [UNSTABLE REFERENCE] readStore() / useShallow only. */
export const selectClipsInTrack = (s: StoreState, t: TrackId): Clip[] =>
  (s.clipsByTrack[t] ?? []).map((id) => s.clips[id]).filter(Boolean);

/**
 * [UNSTABLE REFERENCE] readStore() / useShallow only.
 * Guaranteed to contain no undefined: ids missing from `clips` are filtered out.
 */
export const selectSelectedClips = (s: StoreState): Clip[] => {
  const out: Clip[] = [];
  for (const id of s.selection) {
    const clip = s.clips[id];
    if (clip) out.push(clip);
  }
  return out;
};

/** [UNSTABLE REFERENCE] Called from the rAF audio-gain pass via readStore(), never a hook. */
export const selectAudioClipsAtFrame = (s: StoreState, frame: Frames): Clip[] => {
  const out: Clip[] = [];
  for (const trackId of s.trackOrder) {
    const track = s.tracks[trackId];
    if (!track || track.kind !== 'audio') continue;
    const ids = s.clipsByTrack[trackId];
    if (!ids || ids.length === 0) continue;
    const i = lastStartingAtOrBefore(ids, s.clips, frame);
    if (i < 0) continue;
    const clip = s.clips[ids[i]];
    if (clip && frame < clipEnd(clip)) out.push(clip);
  }
  return out;
};

/** [UNSTABLE REFERENCE] Called once per drag start, cached in a ref for the drag's duration. */
export const selectSnapTargets = (s: StoreState, excludeClipIds?: ReadonlySet<ClipId>): Frames[] => {
  const targets = new Set<Frames>([0, s.playhead]);
  for (const clip of Object.values(s.clips)) {
    if (excludeClipIds?.has(clip.id)) continue;
    targets.add(clip.start);
    targets.add(clipEnd(clip));
  }
  for (const marker of Object.values(s.markers)) targets.add(marker.frame);
  if (s.inPoint !== null) targets.add(s.inPoint);
  if (s.outPoint !== null) targets.add(s.outPoint);
  return [...targets].sort((a, b) => a - b);
};
