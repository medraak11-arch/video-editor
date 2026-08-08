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
  ClipStreams,
  Frames,
  LinkId,
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
  clipHasVideo,
  clipSourceLength,
  clipStreams,
} from '../types/model';
import type { SliceCreator, StoreState } from './types';
import type { Notice } from './uiSlice';
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
  /** Defaults to undefined ≡ 'av'. Only `detachAudio` passes it. */
  streams?: ClipStreams;
  /** Defaults to the media's name, as today. Only `detachAudio` passes it. */
  name?: string;
  /** Defaults to `{ ...DEFAULT_CLIP_PROPERTIES }`, as today. Only `detachAudio` passes it. */
  properties?: ClipProperties;
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
   *
   * `primaryTrackId` is the gesture's own lane; the vertical offset applies only
   * to clips of that lane's kind (docs/LINKING.md §5.2b). Required, not optional,
   * so `tsc` enumerates every call site rather than leaving one on the old
   * semantics.
   */
  moveClips(
    ids: ClipId[],
    deltaFrames: Frames,
    deltaTrackIndex: number,
    primaryTrackId: TrackId | undefined,
  ): MutationResult;
  trimClip(id: ClipId, edge: 'in' | 'out', nextFrame: Frames): MutationResult;
  /** Splits every selected clip, or every clip under the playhead when selection is empty. */
  splitAtPlayhead(): void;
  /**
   * Detach audio. Turns each eligible clip into a video-only clip and creates an
   * audio-only twin on an audio track at the same start, duration and mediaIn.
   *
   * Operates on the ELIGIBLE SUBSET of `ids`, defaulting to the current selection —
   * the same shape as `splitAtPlayhead`, and for the same reason: one command, one
   * refusal, raised HERE rather than at the two call sites, so the menu item and
   * the shortcut cannot explain themselves differently.
   *
   * The pair is LINKED afterwards (docs/LINKING.md §4.3). One history entry for
   * the whole operation, including any tracks it had to create.
   */
  detachAudio(ids?: ClipId[]): void;
  /**
   * Form one link group from `ids`, defaulting to the current selection
   * (docs/LINKING.md §4.1).
   *
   * The argument is closed over first, so linking clip A to one member of an
   * existing group links A to ALL of it — there is no way to end up half joined.
   * Every target leaves whatever group it was in and joins the new one; a group
   * left with fewer than two members is dissolved by `withClips`'s pass.
   *
   * ONE history entry. Refuses whole, never partially (PLAN §3.4 rule 1).
   */
  linkClips(ids?: ClipId[]): void;
  /**
   * Dissolve every link group any clip in `ids` belongs to, defaulting to the
   * current selection (docs/LINKING.md §4.2). Ungrouped clips in `ids` are
   * ignored; a call that finds no group at all raises a notice rather than
   * pushing an empty history entry.
   *
   * No closure is needed and none is taken: a group is already the unit, and the
   * ids are only ever read for the LinkIds they carry.
   *
   * ONE history entry.
   */
  unlinkClips(ids?: ClipId[]): void;
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

  // docs/LINKING.md §5.1 — the dissolve pass. A LinkId carried by fewer than two
  // clips is a group of one, which means nothing and would make
  // `selectLinkedClosure` return a set of one — i.e. a clip that renders the link
  // rail and behaves as if ungrouped. Enforced HERE, at the one funnel, rather
  // than at the actions that can produce one — removeTrack (which deletes a
  // lane's clips without consulting a group), splitAtPlayhead (whose right side
  // can be a single half) and unlinkClips: a rule spread over call sites is a
  // rule the next call site will forget. deleteSelection and rippleDelete can no
  // longer reach it at all — their delete set is a whole number of groups — but
  // they run through this funnel too, and the pass is what keeps that a belt
  // rather than a load-bearing assumption.
  //
  // The gate is exhaustive, not a heuristic. A group's census can change only if
  // a member is written INTO it, written OUT of it, or deleted — and those are
  // the three disjuncts. An edit that touches no grouped clip therefore never
  // walks the clip map, which is every ordinary move, trim and property change on
  // an ungrouped timeline.
  const touchesGroup =
    removed.some((id) => doc.clips[id]?.linkId !== undefined) ||
    next.some((c) => c.linkId !== undefined || doc.clips[c.id]?.linkId !== undefined);

  if (touchesGroup) {
    const census = new Map<LinkId, ClipId[]>();
    for (const clip of Object.values(clips)) {
      if (clip.linkId === undefined) continue;
      const list = census.get(clip.linkId);
      if (list) list.push(clip.id);
      else census.set(clip.linkId, [clip.id]);
    }
    for (const members of census.values()) {
      if (members.length >= 2) continue;
      for (const id of members) {
        const { linkId: _drop, ...rest } = clips[id];
        clips[id] = rest;
      }
    }
  }
  // No `touched.add` is needed: dissolving changes neither `trackId` nor `start`,
  // so `clipsByTrack` is untouched.

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

/**
 * [UNSTABLE REFERENCE] readStore() / an action only. THE expansion rule, once:
 * the ids given, plus every clip that shares a linkId with any of them
 * (docs/LINKING.md §3.1).
 *
 * The early return is not a micro-optimisation, it is the common case: on a
 * timeline with no groups, and on any selection that touches none, this never
 * walks the clip map at all. It is called once per selection change, once per
 * gesture start, once per planner call and once per history restore — never in a
 * rAF body and never on a per-frame path, which is what keeps it off PLAN §1.3
 * rule 1's list.
 *
 * It takes `Pick<StoreState, 'clips'>` rather than the whole store because it
 * reads exactly one field, and because `restore` has to call it against a
 * history SNAPSHOT — a `TimelineDoc`, which is not a `StoreState` and never will
 * be. Every call site that has a full store still type-checks.
 */
export function selectLinkedClosure(
  s: Pick<StoreState, 'clips'>,
  ids: Iterable<ClipId>,
): ClipId[] {
  const groups = new Set<LinkId>();
  const out = new Set<ClipId>();
  for (const id of ids) {
    const clip = s.clips[id];
    if (!clip) continue;
    out.add(id);
    if (clip.linkId !== undefined) groups.add(clip.linkId);
  }
  if (groups.size === 0) return [...out];
  for (const clip of Object.values(s.clips)) {
    if (clip.linkId !== undefined && groups.has(clip.linkId)) out.add(clip.id);
  }
  return [...out];
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

/**
 * The media kind a clip carries. `streams` outranks the media; the track is the
 * last resort (AUDIO-FEATURES §1.3). This is what makes a detached audio clip
 * legal on an A-track and refused on a V-track, and it is the only placement
 * rule — `addClip` consults the same fact through `wantKind`.
 */
export function clipKind(s: StoreState, clip: Clip): MediaKind {
  const streams = clipStreams(clip);
  if (streams === 'audio') return 'audio';
  if (streams === 'video') return 'video';
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

/**
 * Where a detached audio twin goes (AUDIO-FEATURES §1.5). The same ladder
 * `insertMediaAt` establishes: A1 first by `Track.index`, upward, skipping a
 * locked lane and a lane already occupied at that range; a new audio track when
 * nothing has room.
 *
 * It takes the store as an argument and `detachAudio` passes it a fresh `get()`
 * on every iteration. There is deliberately NO `placed` array: `addClip` and
 * `addTrack` both commit before they return, so a twin placed in iteration 1 IS
 * an existing clip by iteration 2 and a track created in iteration 1 IS a
 * candidate. Side bookkeeping would only duplicate what the store already knows.
 */
function findAudioHome(s: StoreState, clip: Clip): TrackId {
  const candidates = tracksOfKind(s, 'audio').sort(
    (a, b) => (s.tracks[a]?.index ?? 0) - (s.tracks[b]?.index ?? 0),
  );
  const end = clipEnd(clip);
  for (const trackId of candidates) {
    const track = s.tracks[trackId];
    if (!track || track.locked) continue;
    if (overlapOnTrack(s, trackId, clip.start, end, EMPTY_SELECTION)) continue;
    return trackId;
  }
  return s.addTrack('audio');
}

/** The track ids of one kind, in trackOrder (top to bottom). */
export function tracksOfKind(s: StoreState, kind: MediaKind): TrackId[] {
  return s.trackOrder.filter((id) => s.tracks[id]?.kind === kind);
}

/**
 * Dry run of a group move. Pure — call it from a pointermove to decide whether the ghost
 * is legal, then call `moveClips` with the same arguments on pointerup.
 *
 * `primaryTrackId` is the gesture's own lane: `deltaTrackIndex` is an offset
 * within the lane list of THAT track's kind, and applies only to members of the
 * same kind (docs/LINKING.md §5.2b). Without it, dragging the picture of a V1/A1
 * pair up to V2 would send the sound to A2 and refuse the whole move on a project
 * whose only audio lane is A1.
 */
export function planMove(
  s: StoreState,
  ids: readonly ClipId[],
  deltaFrames: number,
  deltaTrackIndex: number,
  primaryTrackId: TrackId | undefined,
): PlanResult {
  if (!isFiniteFrames(deltaFrames)) {
    return { ok: false, reason: 'out-of-range', blockingClipId: null };
  }
  // Fails closed when the primary track does not resolve, so a missed JavaScript
  // call site is loud instead of silently degraded: without this,
  // `s.tracks[undefined]?.kind` is undefined, no clip's kind ever matches it, and
  // every clip silently keeps its trackId — a vertical drag that quietly becomes
  // a horizontal one. The gate scripts are .mjs bundled by esbuild: they will not
  // fail typecheck and they will not throw.
  const primary = primaryTrackId !== undefined ? s.tracks[primaryTrackId] : undefined;
  if (!primary) return { ok: false, reason: 'no-track', blockingClipId: null };

  // The two dry-run planners have ONE rule between them: the caller names clips,
  // the planner moves groups (§5.2a). Relying on `selectMany`'s expansion to hand
  // this function whole groups would make it correct for the drag path and wrong
  // for every other caller — `moveClip(id, next)` passes a bare `[id]`, and it is
  // public API on TimelineActions. A planner that desyncs a group when called
  // directly is a planner with a trap in it. The closure is idempotent, so the
  // drag path plans exactly what it planned before.
  const moving: Clip[] = [];
  for (const id of selectLinkedClosure(s, ids)) {
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

    // A lane offset is a spatial fact about the lane the pointer is over, so it
    // applies only to clips of the pointer's own kind. Every other member keeps
    // its trackId and takes the horizontal delta alone.
    let targetId: TrackId | undefined = clip.trackId;
    if (deltaTrackIndex !== 0 && origin.kind === primary.kind) {
      const lane = tracksOfKind(s, origin.kind);
      const at = lane.indexOf(clip.trackId);
      targetId = at < 0 ? undefined : lane[at + deltaTrackIndex];
    }
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

/**
 * Dry run of a trim. Same contract as `planMove`, and group-aware in the same
 * way (docs/LINKING.md §5.3): the caller names one clip, the planner trims every
 * member of its group by the delta that clip's named edge travelled.
 *
 * Group-aware IN PLACE rather than in a second function — it is the one
 * implementation both the pointermove dry run and the pointerup commit use, and a
 * second one would let the ghost and the commit disagree.
 */
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

  // The delta the named edge travelled, computed once, from the named clip.
  const at = Math.round(nextFrame);
  const delta = edge === 'in' ? at - clip.start : at - clip.start - clip.duration;

  const memberIds = selectLinkedClosure(s, [id]);
  const updated: Clip[] = [];

  for (const memberId of memberIds) {
    const member = s.clips[memberId];
    if (!member) continue;
    const memberTrack = s.tracks[member.trackId];
    if (!memberTrack) return { ok: false, reason: 'no-track', blockingClipId: null };
    // `blockingClipId` names the MEMBER, so the ghost's badge can say which clip
    // is on the locked track rather than a lock the user is not touching. The
    // named clip's own track is checked above and returns null, so the two cases
    // stay distinguishable at the call site.
    if (memberTrack.locked) {
      return { ok: false, reason: 'locked', blockingClipId: member.id };
    }

    if (edge === 'in') {
      const start = member.start + delta;
      if (start < 0) return { ok: false, reason: 'out-of-range', blockingClipId: null };
      const duration = member.duration - delta;
      if (duration < 1) return { ok: false, reason: 'out-of-range', blockingClipId: null };
      const speed = member.properties.speed || 1;
      const mediaIn = member.mediaIn + Math.round(delta * speed);
      if (mediaIn < 0) return { ok: false, reason: 'no-source', blockingClipId: null };
      updated.push({ ...member, start, duration, mediaIn });
    } else {
      const duration = member.duration + delta;
      if (duration < 1) return { ok: false, reason: 'out-of-range', blockingClipId: null };
      updated.push({ ...member, duration });
    }
  }

  if (updated.length === 0) return { ok: false, reason: 'no-track', blockingClipId: null };

  const excluded = new Set(updated.map((c) => c.id));
  for (const c of updated) {
    if (violatesSource(s, c)) return { ok: false, reason: 'no-source', blockingClipId: null };
    // Overlap is checked against everything EXCEPT the whole member set, not just
    // the named clip: a member's own old edge must not block the trim moving it.
    const blocking = overlapOnTrack(s, c.trackId, c.start, clipEnd(c), excluded);
    if (blocking) return { ok: false, reason: 'overlap', blockingClipId: blocking };
  }
  // …and against each other, exactly as planMove does. A group MAY hold two clips
  // on one track (§2's repeated sting), and an out-trim extends both by the same
  // delta, so the earlier member's new end can reach the later member's start.
  // The exclusion set above cannot see that, and `clipsByTrack`'s no-overlap
  // invariant is not optional.
  for (let i = 0; i < updated.length; i += 1) {
    for (let j = i + 1; j < updated.length; j += 1) {
      const a = updated[i];
      const b = updated[j];
      if (a.trackId === b.trackId && a.start < clipEnd(b) && b.start < clipEnd(a)) {
        return { ok: false, reason: 'overlap', blockingClipId: b.id };
      }
    }
  }
  return { ok: true, clips: updated };
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
    // The closure is taken against the RESTORED doc, not against get(): the
    // snapshot is what carries the linkIds being put back, and get().clips is
    // still the doc being undone (docs/LINKING.md §3.4). Without this, undoing an
    // unlink hands back a group with one member selected, and the next Delete
    // would take half of it.
    //
    // pruneSelection returns its ARGUMENT when it drops nothing, and this
    // preserves that: a restore that changes neither membership nor grouping
    // hands back the same Set reference, so `selection` compares equal and
    // nothing re-renders.
    const pruned = pruneSelection(get().selection, doc.clips);
    const closed = selectLinkedClosure(doc, pruned);
    set({
      tracks: doc.tracks,
      trackOrder: doc.trackOrder,
      clips: doc.clips,
      clipsByTrack: doc.clipsByTrack,
      markers: doc.markers,
      history,
      historyTxn: null,
      selection: closed.length === pruned.size ? pruned : new Set(closed),
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
      // `streams` outranks the media, exactly as it does in `clipKind`: an
      // audio-only clip cut from an .mp4 belongs on an A-track.
      const wantKind: MediaKind =
        input.streams === 'audio'
          ? 'audio'
          : input.streams === 'video'
            ? 'video'
            : (media?.kind ?? track.kind);
      if (wantKind !== track.kind) return { ok: false, reason: 'kind-mismatch' };

      const start = Math.max(0, Math.round(input.start));
      const fallback = media?.durationFrames && media.durationFrames > 0 ? media.durationFrames : 1;
      const duration = Math.max(1, Math.round(input.duration ?? fallback));
      const mediaIn = Math.max(0, Math.round(input.mediaIn ?? 0));

      // `name` and `properties` are applied HERE, above the two checks below, so
      // `violatesSource` and `overlapOnTrack` evaluate the clip that will
      // actually exist. A twin built at speed 1 and patched afterwards would be
      // rescaled by `updateClipProperties` and come out the wrong length
      // (AUDIO-FEATURES §1.3).
      const clip: Clip = {
        id: newId('c'),
        mediaId: input.mediaId,
        trackId: input.trackId,
        start,
        duration,
        mediaIn,
        name: input.name ?? media?.name ?? 'Clip',
        properties: input.properties ? { ...input.properties } : { ...DEFAULT_CLIP_PROPERTIES },
        // Conditional, never `streams: input.streams` — §1.2 forbids writing an
        // explicit 'av', and an `undefined`-valued key would still show up in an
        // `in` check and a key count.
        ...(input.streams !== undefined ? { streams: input.streams } : {}),
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
      return get().moveClips([id], next.start - clip.start, deltaTrackIndex, clip.trackId);
    },

    moveClips: (ids, deltaFrames, deltaTrackIndex, primaryTrackId) => {
      const plan = planMove(get(), ids, deltaFrames, deltaTrackIndex, primaryTrackId);
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
      let targets: Clip[] = [];
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

      // docs/LINKING.md §5.4 — a group is split whole or not at all, and a lock on
      // any member the split would WRITE blocks the whole group. The split writes
      // exactly two kinds of member: the ones the playhead crosses, and the ones
      // at or after it, which the migration pass below re-links. A member that
      // ends at or before the playhead is never written, so a lock there is
      // irrelevant and must not block anything.
      const grouped = new Set<LinkId>();
      for (const clip of targets) if (clip.linkId !== undefined) grouped.add(clip.linkId);

      const lockedGroups = new Set<LinkId>();
      if (grouped.size > 0) {
        for (const clip of Object.values(s.clips)) {
          const g = clip.linkId;
          if (g === undefined || !grouped.has(g)) continue;
          if (clipEnd(clip) <= at) continue; // never written; a lock here is not a lock on us
          if (s.tracks[clip.trackId]?.locked) lockedGroups.add(g);
        }
      }

      let blockedLinked = false;
      if (lockedGroups.size > 0) {
        const kept = targets.filter((c) => c.linkId === undefined || !lockedGroups.has(c.linkId));
        blockedLinked = kept.length !== targets.length;
        targets = kept;
      }

      // A group dropped for a lock withholds clips that are NOT locked and that
      // the user can see are under the playhead, so it is never silent — the
      // notice fires whether or not the rest of the timeline still splits.
      const linkedLockNotice: Notice = {
        tone: 'warning',
        title: 'Could not split',
        message: 'A linked clip is on a locked track',
      };

      // The refusal is raised HERE, not at a call site: the toolbar button and the
      // `S` shortcut are the same registry row, and a check that lives in only one
      // of them makes the control explain itself on click and stay silent on the
      // key (PLAN §5, and §3.4's "never silent"). Checked in this order, so the
      // sentence names the cause the user cannot see rather than the one they can.
      if (targets.length === 0) {
        get().setNotice(
          blockedLinked
            ? linkedLockNotice
            : blockedByLock
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

      /** One fresh LinkId per source group, minted lazily so an ungrouped split allocates nothing. */
      const rightLink = new Map<LinkId, LinkId>();
      const rightLinkFor = (g: LinkId): LinkId => {
        const existing = rightLink.get(g);
        if (existing !== undefined) return existing;
        const minted = newId('g');
        rightLink.set(g, minted);
        return minted;
      };

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
        // The LEFT half keeps the original group; the RIGHT halves of one source
        // group form a new one. Both halves inherit `linkId` from `{ ...clip }`,
        // so the right half is REASSIGNED rather than assigned — otherwise the
        // left half of the picture would stay linked to the right half of the
        // sound, and moving one would drag a clip from the other side of the cut.
        if (clip.linkId !== undefined) right.linkId = rightLinkFor(clip.linkId);
        next.push(left, right);
        if (selection.has(clip.id)) selection.add(right.id);
      }

      /** The clips the loop above actually cut. Everything else in a split group is below. */
      const splitIds = new Set(targets.map((c) => c.id));

      // A member the playhead does not cross is not split, and it has to pick a
      // side — otherwise the left group keeps a member that lies wholly to the
      // RIGHT of the cut, and moving the left half of the picture drags an
      // untouched clip a second away. `start >= at` is the test: a member that
      // straddles `at` was split above, and a member wholly left of `at` stays in
      // the original group with no write.
      //
      // There is deliberately no lock check in this loop. It cannot need one: the
      // whole-group lock rule above drops any group carrying a locked member that
      // is not wholly left of the cut, so every clip this loop writes is on an
      // unlocked track by construction.
      for (const [source, minted] of rightLink) {
        for (const clip of Object.values(s.clips)) {
          if (clip.linkId !== source) continue;
          if (splitIds.has(clip.id)) continue; // already handled by the loop above
          if (clip.start >= at) next.push({ ...clip, linkId: minted });
        }
      }

      set({ ...withClips(docOf(get()), next), selection });
      if (blockedLinked) get().setNotice(linkedLockNotice);
      get().markDirty();
      // A split mints a new clip id, so the offline projection no longer covers
      // the clip set — same reason deleteSelection and rippleDelete recompute.
      get().recomputeOfflineClips();
    },

    detachAudio: (ids) => {
      // Computed ONCE, before the transaction, so the eligible set is a stable
      // snapshot and cannot grow or shrink under the loop. `findAudioHome`, by
      // contrast, re-reads get() every pass — see its header.
      const before = get();
      const targets = selectDetachableClipIds(before, ids).map((id) => before.clips[id]);

      if (targets.length === 0) {
        get().setNotice(detachRefusal(before, ids));
        return;
      }

      // Deterministic order, so an undo is reproducible: track index, then start.
      targets.sort((a, b) => {
        const byTrack =
          (before.tracks[a.trackId]?.index ?? 0) - (before.tracks[b.trackId]?.index ?? 0);
        return byTrack !== 0 ? byTrack : a.start - b.start;
      });

      get().beginHistory('Detach audio');
      const pairs: { source: Clip; twinId: ClipId }[] = [];
      let lastHome: TrackId | null = null;

      for (const clip of targets) {
        const trackId = findAudioHome(get(), clip);
        lastHome = trackId;
        // NO linkId is passed: `addClip` commits before it returns, so the twin
        // would exist in a group of one for the length of one loop iteration, and
        // `withClips`'s dissolve pass would be entitled to strip it. Both ends
        // acquire their group in the single write below instead.
        const result = get().addClip({
          mediaId: clip.mediaId,
          trackId,
          start: clip.start,
          duration: clip.duration,
          mediaIn: clip.mediaIn,
          name: clip.name,
          properties: clip.properties,
          streams: 'audio',
        });
        if (!result.ok) {
          // Documented as unreachable — step 4 of the ladder always yields an
          // empty lane — but not assumed. abortHistory restores the snapshot AND
          // removes any track this operation created, which is why the whole
          // thing is one transaction.
          get().abortHistory();
          get().setNotice({
            tone: 'danger',
            title: 'Could not detach',
            message: 'The detached audio could not be placed',
          });
          return;
        }
        pairs.push({ source: clip, twinId: result.id });
      }

      // ONE atomic write for every linkId this operation assigns (docs/LINKING.md
      // §4.3). Both halves of a pair acquire their group in the same `withClips`,
      // so the ">= 2 members" invariant is never even momentarily false and the
      // dissolve pass — which runs on every call — cannot strip a half-built group
      // out from under this action.
      const detached: Clip[] = [];
      for (const { source, twinId } of pairs) {
        // If the picture was already linked to something else, its new sound joins
        // that group and everything continues to move together. If it was not, the
        // pair becomes a group of two.
        const linkId = source.linkId ?? newId('g');
        const twin = get().clips[twinId];
        detached.push({ ...source, streams: 'video', linkId });
        if (twin) detached.push({ ...twin, linkId });
      }
      const doc = withClips(docOf(get()), detached);
      // …and the selection is re-closed in the SAME write. `selectMany` and
      // `restore` are the two places the closure is normally enforced, and
      // neither covers this one: the selection was made before the group
      // existed, so nothing has re-run since the linkIds landed. Leaving it
      // would put one member of a two-member group in the selection — the exact
      // state §3.4 calls an invariant of the store — and the inspector, which
      // counts within the selection, would read `Linked, 1 clips`.
      //
      // This is §4.3's stated end state, not a change to it: "selection
      // unchanged, on the originals", which after §3.2's expansion means the
      // pair. pruneSelection's return-its-argument property is preserved, so a
      // detach that somehow closed nothing hands back the same Set reference.
      const pruned = pruneSelection(get().selection, doc.clips);
      const closed = selectLinkedClosure(doc, pruned);
      set({ ...doc, selection: closed.length === pruned.size ? pruned : new Set(closed) });
      get().commitHistory();
      // A detach mints new clip ids and `offlineClipIds` is keyed by CLIP id, so
      // without this a twin cut from an offline source would render with no
      // offline treatment beneath a picture half that shows all of it.
      get().recomputeOfflineClips();
      get().markDirty();
      if (lastHome !== null) revealLane(get(), lastHome);
    },

    linkClips: (ids) => {
      const s = get();
      // Closure FIRST: linking A to one member of an existing group links A to all
      // of it, so there is no way to end up half joined.
      const targets = selectLinkedClosure(s, ids ?? s.selection);
      if (targets.length < 2) {
        get().setNotice(linkRefusal(s, ids));
        return;
      }
      // A locked track refuses the WHOLE call rather than excluding that clip: a
      // silently excluded member would produce a group the user did not ask for
      // and cannot see the boundary of, and a group containing a locked member
      // cannot move at all — every subsequent gesture would refuse with a message
      // about a lock the user has forgotten setting.
      if (targets.some((id) => s.tracks[s.clips[id]?.trackId ?? '']?.locked === true)) {
        get().setNotice({ tone: 'warning', title: 'Could not link', message: 'Track is locked' });
        return;
      }

      const linkId = newId('g');
      pushHistory();
      set({
        ...withClips(
          docOf(get()),
          targets.map((id) => ({ ...s.clips[id], linkId })),
        ),
        // Selection becomes the new group, not "unchanged". After the call,
        // clicking any member selects all of them, so the selection must already
        // say so — otherwise the very next click would appear to ADD clips the
        // user thought were already selected.
        selection: new Set(targets),
      });
      get().markDirty();
    },

    unlinkClips: (ids) => {
      const s = get();
      const groups = new Set<LinkId>();
      for (const id of ids ?? s.selection) {
        const g = s.clips[id]?.linkId;
        if (g !== undefined) groups.add(g);
      }
      if (groups.size === 0) {
        get().setNotice({
          tone: 'warning',
          title: 'Nothing to unlink',
          message: 'Select a linked clip first',
        });
        return;
      }

      // A track lock does NOT block an unlink, and the asymmetry with `linkClips`
      // is deliberate: unlinking removes a constraint, can only ever make more
      // operations legal, and changes no clip's geometry. Refusing it on a lock
      // would strand a user who locked a track and then needed to break a group
      // that reaches into it.
      const members: Clip[] = [];
      for (const clip of Object.values(s.clips)) {
        if (clip.linkId === undefined || !groups.has(clip.linkId)) continue;
        // The key is STRIPPED, never set to undefined: an own property with an
        // undefined value survives an `in` check and a key count, and JSON.stringify
        // drops it — so the in-memory clip and the saved clip would disagree about
        // their own shape. `migrateProject` establishes the same rest-destructure.
        const { linkId: _drop, ...rest } = clip;
        members.push(rest);
      }

      pushHistory();
      set(withClips(docOf(get()), members));
      // Selection is unchanged, and after the call it holds every former member —
      // which is what makes the next click meaningful: clicking one of them now
      // selects that clip alone.
      get().markDirty();
    },

    deleteSelection: () => {
      const s = get();
      const lockedLinked = lockedLinkedClipId(s);
      if (lockedLinked !== null) {
        get().setNotice(LOCKED_LINKED_DELETE_NOTICE);
        return;
      }
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
      if (lockedLinkedClipId(s) !== null) {
        get().setNotice(LOCKED_LINKED_DELETE_NOTICE);
        return;
      }
      const removingIds = selectDeletableClipIds(s);
      const removing = removingIds.map((id) => s.clips[id]);
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
      const removedIdSet = new Set(removingIds);

      const removedByTrack = new Map<TrackId, Clip[]>();
      for (const clip of removing) {
        const list = removedByTrack.get(clip.trackId);
        if (list) list.push(clip);
        else removedByTrack.set(clip.trackId, [clip]);
      }

      // Step 1 — today's per-clip shift, per track, for every surviving clip on a
      // track something was removed from. A clip with nothing removed before it
      // gets an entry of 0, not no entry: step 2 has to tell "did not move" apart
      // from "was not considered", and both are 0.
      const perClip = new Map<ClipId, Frames>();
      for (const [trackId, gone] of removedByTrack) {
        for (const id of s.clipsByTrack[trackId] ?? []) {
          if (removedIdSet.has(id)) continue;
          const clip = s.clips[id];
          if (!clip) continue;
          let delta = 0;
          for (const removed of gone) if (clipEnd(removed) <= clip.start) delta += removed.duration;
          perClip.set(id, delta);
        }
      }

      // Step 2 — a group moves as one or not at all (docs/LINKING.md §5.5). Every
      // surviving group is WHOLE, because the delete set is a closure and a lock
      // refuses the call, so this is a statement about a complete membership.
      //
      // A member at shift 0 is a member with nothing removed before it: it has no
      // room to move left and no reason to, because the gap that closed is not in
      // front of it. So the whole group holds still — uniform, safe by
      // construction, and exactly the pre-linking behaviour for a group that spans
      // the cut.
      const membersOfGroup = new Map<LinkId, Clip[]>();
      for (const clip of Object.values(s.clips)) {
        if (removedIdSet.has(clip.id) || clip.linkId === undefined) continue;
        const list = membersOfGroup.get(clip.linkId);
        if (list) list.push(clip);
        else membersOfGroup.set(clip.linkId, [clip]);
      }
      const perGroup = new Map<LinkId, Frames>();
      for (const [group, members] of membersOfGroup) {
        let shift = 0;
        for (const member of members) {
          const own = perClip.get(member.id) ?? 0;
          if (own === 0) {
            shift = 0;
            break;
          }
          if (own > shift) shift = own;
        }
        perGroup.set(group, shift);
      }

      const shiftOf = (clip: Clip): Frames =>
        clip.linkId !== undefined
          ? (perGroup.get(clip.linkId) ?? 0)
          : (perClip.get(clip.id) ?? 0);

      // Walked in clipsByTrack order so the clip the refusal names is deterministic.
      const shifted: Clip[] = [];
      let negative: Clip | null = null;
      for (const trackId of s.trackOrder) {
        for (const id of s.clipsByTrack[trackId] ?? []) {
          if (removedIdSet.has(id)) continue;
          const clip = s.clips[id];
          if (!clip) continue;
          const shift = shiftOf(clip);
          if (shift === 0) continue;
          const start = clip.start - shift;
          if (start < 0 && negative === null) negative = clip;
          shifted.push({ ...clip, start });
        }
      }

      // Step 3 — validate, and change NOTHING on a refusal. Per-track ripple could
      // never collide, which is why there was no check at all; a group shift moves
      // clips on tracks that had no removal, so it can. The old
      // `Math.max(0, start - delta)` clamp is gone rather than kept "just in case":
      // a clamp is what desyncs, by silently giving one member a shorter shift
      // than its partner.
      const candidate = withClips(docOf(s), shifted, removingIds);
      if (negative !== null) {
        get().setNotice({
          tone: 'warning',
          title: 'Could not ripple delete',
          message: `${negative.name} would be pushed before the start of the timeline, so unlink it first`,
        });
        return;
      }
      const collision = firstOverlap(candidate);
      if (collision) {
        const previous = candidate.clips[collision.previousId];
        const later = candidate.clips[collision.id];
        // The linked one is named first; otherwise the pair is named in track order.
        const swap = later?.linkId !== undefined && previous?.linkId === undefined;
        const a = swap ? later : previous;
        const b = swap ? previous : later;
        get().setNotice({
          tone: 'warning',
          title: 'Could not ripple delete',
          message: `${a?.name ?? 'A clip'} and ${b?.name ?? 'another clip'} would overlap after the gap closes, so unlink them first`,
        });
        return;
      }

      pushHistory();
      set({ ...candidate, selection: EMPTY_SELECTION });
      get().markDirty();
      get().recomputeOfflineClips();
    },

    /* ------------------------------------------------------------ selection */

    select: (id, mode) => {
      get().selectMany([id], mode);
    },

    selectMany: (ids, mode) => {
      const s = get();
      // Expansion happens HERE and nowhere else (docs/LINKING.md §3.2). Every
      // selection path in the app — click, shift-range, ctrl-toggle, marquee,
      // keyboard travel, the context menu's pre-selection — funnels through this
      // action, so one call closes the rule for all of them.
      // `selectLinkedClosure` already drops ids that are not in `clips`, which is
      // what the old `valid` filter was for.
      const valid = selectLinkedClosure(s, ids);
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

      // `speed` is the one property that changes GEOMETRY: PLAN §2.4 rule 4
      // rescales duration from it, twenty lines below. Every other field here is
      // inert on the timeline, and per-member volume is exactly what a user wants
      // — quieting a detached sound without touching the picture it is linked to
      // (docs/LINKING.md §5.6).
      const targets = patch.speed !== undefined ? selectLinkedClosure(s, ids) : ids;

      for (const id of targets) {
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
  // The closure is taken HERE rather than being assumed of `s.selection`
  // (docs/LINKING.md §5.5). `restore` keeps the selection closed, but a selector
  // that would silently halve a group if the selection ever were not is a
  // selector with a trap in it — and the keyboard layer's focus hand-off asks
  // this same question, so it gets the same answer.
  for (const id of selectLinkedClosure(s, s.selection)) {
    const clip = s.clips[id];
    if (clip && !s.tracks[clip.trackId]?.locked) out.push(id);
  }
  return out;
};

/**
 * A member of a group the selection touches that a track lock protects, or null.
 * Delete is all-or-nothing across a group (docs/LINKING.md §0.2 rule 2), and a
 * lock is the one thing that can make that impossible.
 *
 * Without this, `selectDeletableClipIds` would drop the locked member, delete the
 * rest, and the dissolve pass would strip the survivor's `linkId` — a silent,
 * partial application of an all-or-nothing operation.
 */
export const lockedLinkedClipId = (s: StoreState): ClipId | null => {
  for (const id of selectLinkedClosure(s, s.selection)) {
    const clip = s.clips[id];
    if (clip?.linkId !== undefined && s.tracks[clip.trackId]?.locked) return id;
  }
  return null;
};

/** Checked FIRST, so the sentence names the cause the user cannot see. */
const LOCKED_LINKED_DELETE_NOTICE: Notice = {
  tone: 'warning',
  title: 'Could not delete',
  message: 'A linked clip is on a locked track',
};

/**
 * Why a link found nothing to do (docs/LINKING.md §4.1), checked in that order.
 * Exported because the context menu shows the same sentence as the item's
 * `disabledReason` — one copy of the copy, the pattern `detachRefusal` set.
 *
 * There is deliberately no "these are already linked to each other" refusal:
 * re-linking mints a new LinkId over the same membership, which is a harmless
 * no-op costing one undo slot.
 */
export function linkRefusal(s: StoreState, ids?: Iterable<ClipId>): Notice {
  const targets = selectLinkedClosure(s, ids ?? s.selection);
  if (targets.length < 2) {
    return { tone: 'warning', title: 'Nothing to link', message: 'Select two or more clips first' };
  }
  return { tone: 'warning', title: 'Could not link', message: 'Track is locked' };
}

/**
 * The first adjacent pair that overlaps, or null. O(clips): `clipsByTrack` is
 * sorted ascending by start with no overlaps in a valid doc, so checking adjacent
 * pairs is sufficient — a clip that overlaps a non-adjacent one necessarily
 * overlaps the one between them.
 *
 * It returns the PAIR, not one id: the refusal copy has to name the linked clip,
 * and either of the two may be the linked one.
 */
function firstOverlap(doc: TimelineDoc): { id: ClipId; previousId: ClipId } | null {
  for (const ids of Object.values(doc.clipsByTrack)) {
    for (let i = 1; i < ids.length; i += 1) {
      const a = doc.clips[ids[i - 1]];
      const b = doc.clips[ids[i]];
      if (a && b && b.start < clipEnd(a)) return { id: b.id, previousId: a.id };
    }
  }
  return null;
}

/**
 * [UNSTABLE REFERENCE] readStore() only. THE eligibility rule for a detach, once
 * (AUDIO-FEATURES §1.4). The context menu asks it to decide `disabled` +
 * `disabledReason`; the action asks it to decide what to operate on, so the menu
 * and the keystroke cannot explain themselves differently.
 *
 * Media STATUS is deliberately not consulted: an offline clip is still
 * detachable, because the operation is purely structural and touches no file.
 */
export const selectDetachableClipIds = (s: StoreState, ids?: Iterable<ClipId>): ClipId[] => {
  const out: ClipId[] = [];
  for (const id of ids ?? s.selection) {
    const clip = s.clips[id];
    if (!clip) continue;
    if (clipStreams(clip) !== 'av') continue; // already detached, or already audio-only
    const track = s.tracks[clip.trackId];
    if (!track || track.kind !== 'video' || track.locked) continue;
    if (s.items[clip.mediaId]?.hasAudio !== true) continue;
    out.push(id);
  }
  return out;
};

/**
 * Why a detach found nothing to do, in the four sentences AUDIO-FEATURES §1.4
 * pins, checked in that order. Exported because the context menu shows the same
 * sentence as the item's `disabledReason` — one copy of the copy.
 */
export function detachRefusal(s: StoreState, ids?: Iterable<ClipId>): Notice {
  const candidates: Clip[] = [];
  for (const id of ids ?? s.selection) {
    const clip = s.clips[id];
    if (clip) candidates.push(clip);
  }
  if (candidates.length === 0) {
    return { tone: 'warning', title: 'Nothing to detach', message: 'Select a video clip first' };
  }
  const onVideo = candidates.filter((c) => s.tracks[c.trackId]?.kind === 'video');
  if (onVideo.length > 0 && onVideo.every((c) => s.tracks[c.trackId]?.locked === true)) {
    return { tone: 'warning', title: 'Could not detach', message: 'Track is locked' };
  }
  const unlocked = onVideo.filter((c) => s.tracks[c.trackId]?.locked !== true);
  if (
    unlocked.length > 0 &&
    unlocked.every((c) => clipStreams(c) === 'av' && s.items[c.mediaId]?.hasAudio !== true)
  ) {
    return {
      tone: 'warning',
      title: 'Could not detach',
      message: 'Those clips have no audio to detach',
    };
  }
  return {
    tone: 'warning',
    title: 'Nothing to detach',
    message: 'Select a video clip that still has its audio',
  };
}

/**
 * Brings a lane fully into the lane viewport's vertical range, by the minimum
 * distance, through the store's own scroll path — the twin appears on a lane
 * below, and a twin the user cannot see is a silent success.
 *
 * Vertical only: the twin sits at the same start as the clip it came from, so
 * the horizontal position is already wherever the user was looking. It lives
 * here rather than in the interaction layer because the menu item and the
 * keyboard binding both enter through this action, and a reveal implemented at
 * one call site would be missing from the other.
 */
function revealLane(s: StoreState, trackId: TrackId): void {
  if (typeof document === 'undefined') return;
  const viewport = document.querySelector<HTMLElement>('[data-lane-viewport]');
  if (!viewport) return;
  const top = selectLaneTop(s, trackId);
  const bottom = top + (s.tracks[trackId]?.height ?? 0);
  const view = viewport.clientHeight;
  if (view <= 0) return;
  let y = s.scrollY;
  if (top < s.scrollY) y = Math.max(0, top);
  else if (bottom > s.scrollY + view) y = bottom - view;
  if (y === s.scrollY) return;
  s.setScroll(s.scrollX, Math.min(y, Math.max(0, selectLaneHeight(s) - view)));
}

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
    // `clipHasVideo` is defensive here: §1.3 makes an audio-only clip illegal on
    // a video track. A hand-edited .veproj, or a future action that forgets,
    // would otherwise have the preview compositing a clip that has no picture.
    if (clip && frame < clipEnd(clip) && clipHasVideo(clip)) return clip.id;
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
    if (candidate && clipHasVideo(candidate) && (best === null || candidate.start < best.start)) {
      best = candidate;
    }
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
