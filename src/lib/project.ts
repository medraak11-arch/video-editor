/* ---------------------------------------------------------------------------
   project.ts — PLAN §2.6. The only module that crosses all four slices.

   Cross-cutting and scaffold-owned (PLAN §0.2): serializeProject hard-codes all
   four slices' state shapes, so any field a slice adds to PERSISTED state
   requires a scaffold edit. State a slice keeps at runtime only needs nothing
   here.
--------------------------------------------------------------------------- */

import type {
  Clip,
  ClipStreams,
  LinkId,
  Marker,
  MediaItem,
  PersistedMediaItem,
  ProjectFile,
  Track,
} from '../types/model';
import type { AutosavePayload } from '../types/api';
import type { StoreState } from '../state/types';
import { readStore } from '../state/store';

const PERSISTED_MEDIA_KEYS = [
  'id',
  'path',
  'name',
  'kind',
  'durationFrames',
  'durationSeconds',
  'width',
  'height',
  'fps',
  'codec',
  'hasAudio',
  'addedAt',
] as const;

/**
 * Media is persisted by path, not by runtime state: `url`, `status`, `progress`, `error`,
 * `warnings` and `thumbnailUrl` are all dropped on save (PLAN §2.6).
 */
export function toPersistedMedia(item: MediaItem): PersistedMediaItem {
  const out = {} as Record<string, unknown>;
  for (const key of PERSISTED_MEDIA_KEYS) out[key] = item[key];
  return out as unknown as PersistedMediaItem;
}

export function serializeProject(s: StoreState): ProjectFile {
  return {
    version: PROJECT_VERSION,
    name: s.projectName,
    fps: s.fps,
    width: s.width,
    height: s.height,
    media: s.order.map((id) => s.items[id]).filter(Boolean).map(toPersistedMedia),
    tracks: s.trackOrder.map((id) => s.tracks[id]).filter(Boolean),
    trackOrder: [...s.trackOrder],
    clips: Object.values(s.clips),
    markers: Object.values(s.markers),
    savedAt: new Date().toISOString(),
  };
}

/**
 * Ordering matters: hydratePlayback must set fps before hydrateMedia computes
 * durationFrames, and hydrateMedia must land before hydrateTimeline computes
 * offlineClipIds.
 */
export function applyProject(p: ProjectFile): void {
  const s = readStore();
  s.hydrateUi({ name: p.name });
  s.hydratePlayback({ fps: p.fps, width: p.width, height: p.height });
  s.hydrateMedia(p.media);
  s.hydrateTimeline({
    tracks: p.tracks,
    trackOrder: p.trackOrder,
    clips: p.clips,
    markers: p.markers,
  });
}

/* --------------------------------------------------------------- autosave
   SAFETY.md §2.4. Three numbers with exactly one consumer, the scheduler in
   src/keyboard/projectActions.ts. The 60 s export floor is NOT here: it is
   enforced by main, because main is the only side that knows a job is live. */

/** Quiet-period debounce: nothing is written until editing has stopped this long. */
export const AUTOSAVE_IDLE_MS = 2_000;
/** Hard ceiling on exposure while there are unsaved changes. */
export const AUTOSAVE_MAX_INTERVAL_MS = 20_000;
/** Scheduler granularity. */
export const AUTOSAVE_TICK_MS = 500;

/**
 * Pure. The caller owns `seq` and `lastExplicitSaveAt`; this only assembles them
 * with `serializeProject(s)`.
 *
 * `project.savedAt` is overwritten because `serializeProject` stamps it with
 * `Date.now()` at serialize time — a snapshot taken verbatim would claim the
 * project was SAVED at a moment when nothing was saved, and a hand-lifted
 * `.veproj` would carry that claim into the user's own file (SAFETY §2.2). The
 * value it takes instead means "the last time these bytes were on disk in a
 * file the user chose", falling back to the snapshot time for a project that
 * has never been saved — which is true of the hand-lifted file itself.
 */
export function toAutosavePayload(
  s: StoreState,
  meta: { seq: number; lastExplicitSaveAt: string | null },
): AutosavePayload {
  const takenAt = new Date().toISOString();
  return {
    seq: meta.seq,
    projectPath: s.projectPath,
    projectName: s.projectName,
    lastExplicitSaveAt: meta.lastExplicitSaveAt,
    project: { ...serializeProject(s), savedAt: meta.lastExplicitSaveAt ?? takenAt },
  };
}

/* ------------------------------------------------------------- validation */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A SANITISER, not a validator — AUDIO-FEATURES §1.2. `'av'`, an absent key and
 * anything unknown all collapse to `undefined`, which `clipStreams` reads as
 * `'av'`. Dropping a whole clip because a hand-edited file says `"streams":"audi"`
 * would lose the user's edit over a typo, and `describeProjectProblem` has no
 * sentence for it. `validClip` deliberately does not inspect `streams`: a
 * pre-feature `.veproj` must validate unchanged.
 */
const streamsOf = (v: unknown): ClipStreams | undefined =>
  v === 'video' || v === 'audio' ? v : undefined;

/**
 * A SANITISER, not a validator — the same contract `streamsOf` has (LINKING §11.5).
 * Anything that is not a non-empty string collapses to undefined, which
 * `clipLinkId` reads as "ungrouped". Dropping a whole clip because a hand-edited
 * file has a numeric linkId would lose the user's edit over a typo, and
 * `describeProjectProblem` has no sentence for it.
 */
const linkIdOf = (v: unknown): LinkId | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

function validClip(v: unknown): v is Clip {
  if (!isObject(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.mediaId === 'string' &&
    typeof v.trackId === 'string' &&
    isFiniteNumber(v.start) &&
    isFiniteNumber(v.duration) &&
    isFiniteNumber(v.mediaIn) &&
    typeof v.name === 'string' &&
    isObject(v.properties)
  );
}

function validTrack(v: unknown): v is Track {
  if (!isObject(v)) return false;
  return (
    typeof v.id === 'string' &&
    (v.kind === 'video' || v.kind === 'audio') &&
    isFiniteNumber(v.index) &&
    typeof v.label === 'string' &&
    isFiniteNumber(v.height)
  );
}

function validMarker(v: unknown): v is Marker {
  return isObject(v) && typeof v.id === 'string' && isFiniteNumber(v.frame);
}

function validMedia(v: unknown): v is PersistedMediaItem {
  if (!isObject(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.path === 'string' &&
    typeof v.name === 'string' &&
    (v.kind === 'video' || v.kind === 'audio')
  );
}

/** The only `version` this build writes and the only one it can read. */
export const PROJECT_VERSION = 1;

/**
 * Why `migrateProject` refused a file, as one sentence the user can act on —
 * sentence case, no trailing period, the Notice contract (PLAN §7.6).
 *
 * This exists because `null` is not an error message. A project saved by a
 * newer build and a JPEG renamed to .veproj are the same `null`, and telling
 * the user "that is not a project" about their own project is a lie that costs
 * them the file. Only ever called on the failure branch.
 */
export function describeProjectProblem(raw: unknown): string {
  if (!isObject(raw)) return 'That file is not a video editor project';

  const version = raw.version;
  if (isFiniteNumber(version) && version > PROJECT_VERSION) {
    return `That project was saved by a newer version of the editor (file version ${version}, this one reads ${PROJECT_VERSION})`;
  }
  if (isFiniteNumber(version) && version < PROJECT_VERSION) {
    return `That project uses an older format (version ${version}) that this version can no longer open`;
  }
  if (version === undefined) return 'That file is not a video editor project';
  if (!isFiniteNumber(version)) return 'That file is not a video editor project';

  // Right version, wrong body: the arrays migrateProject needs are missing or
  // are not arrays. A half-written or hand-edited file lands here.
  return 'That project file is incomplete or damaged';
}

/** null = not a project file. Never throws. */
export function migrateProject(raw: unknown): ProjectFile | null {
  if (!isObject(raw)) return null;
  if (raw.version !== PROJECT_VERSION) return null;
  if (!Array.isArray(raw.media) || !Array.isArray(raw.tracks)) return null;
  if (!Array.isArray(raw.trackOrder) || !Array.isArray(raw.clips)) return null;

  const fps = isFiniteNumber(raw.fps) && raw.fps > 0 ? raw.fps : 30;
  const width = isFiniteNumber(raw.width) && raw.width > 0 ? Math.round(raw.width) : 1920;
  const height = isFiniteNumber(raw.height) && raw.height > 0 ? Math.round(raw.height) : 1080;

  const tracks = raw.tracks.filter(validTrack);
  const trackIds = new Set(tracks.map((t) => t.id));
  const trackOrder = raw.trackOrder.filter(
    (id): id is string => typeof id === 'string' && trackIds.has(id),
  );

  // The map returns the ORIGINAL object unless the key is actually wrong, so an
  // untouched project allocates no new clip records on open (AUDIO-FEATURES §1.2).
  const kept = raw.clips
    .filter(validClip)
    .filter((c) => trackIds.has(c.trackId))
    .map((c) => {
      const value = (c as { streams?: unknown }).streams;
      // Absent (every legacy clip), or already 'video'/'audio': `c` is correct as-is.
      if (value === undefined || streamsOf(value) !== undefined) return c;
      // Explicit 'av', or garbage from a hand-edited file: DROP the key. Leaving
      // it would hand the bad value straight to `clipStreams`, whose `??` only
      // catches null/undefined — `detachAudio`'s `!== 'av'` guard would then skip
      // the clip forever, and the next save would persist the garbage.
      const { streams: _drop, ...rest } = c;
      return rest;
    });

  // A LinkId that survives on fewer than two clips is a group of one, and the
  // §1.1 invariant says those do not exist. This is reachable through no fault of
  // the user: the filters above drop a clip whose trackId no longer resolves, and
  // its partner would otherwise load carrying a rail and a group with nobody in
  // it. Counted over the FILTERED array, which is why it is a second pass rather
  // than part of the map (LINKING §11.5).
  const census = new Map<string, number>();
  for (const c of kept) {
    const g = linkIdOf((c as { linkId?: unknown }).linkId);
    if (g !== undefined) census.set(g, (census.get(g) ?? 0) + 1);
  }
  const clips = kept.map((c) => {
    const rawLink = (c as { linkId?: unknown }).linkId;
    const g = linkIdOf(rawLink);
    const keep = g !== undefined && (census.get(g) ?? 0) >= 2;
    if (keep && rawLink === g) return c;
    if (!keep && rawLink === undefined) return c;
    const { linkId: _drop, ...rest } = c;
    return keep ? { ...rest, linkId: g } : rest;
  });

  return {
    version: PROJECT_VERSION,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : 'Untitled',
    fps,
    width,
    height,
    media: raw.media.filter(validMedia),
    tracks,
    trackOrder,
    clips,
    markers: Array.isArray(raw.markers) ? raw.markers.filter(validMarker) : [],
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
  };
}
