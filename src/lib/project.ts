/* ---------------------------------------------------------------------------
   project.ts — PLAN §2.6. The only module that crosses all four slices.

   Cross-cutting and scaffold-owned (PLAN §0.2): serializeProject hard-codes all
   four slices' state shapes, so any field a slice adds to PERSISTED state
   requires a scaffold edit. State a slice keeps at runtime only needs nothing
   here.
--------------------------------------------------------------------------- */

import type {
  Clip,
  ClipKind,
  ClipStreams,
  LinkId,
  Marker,
  MediaItem,
  PersistedMediaItem,
  ProjectFile,
  SubtitleCue,
  TitleSpec,
  Track,
  Transition,
  TransitionKind,
} from '../types/model';
import { DEFAULT_TITLE } from '../types/model';
// The four primitives every sanitiser in this file is built from, imported
// rather than restated so the move to ./clipProperties left one copy, not two.
import {
  bool,
  hex,
  isObject,
  normalizeClipProperties,
  num,
  subtitleStyleOf,
} from './clipProperties';
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
    subtitles: Object.values(s.subtitles),
    subtitleStyle: s.subtitleStyle,
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
    subtitles: p.subtitles,
    subtitleStyle: p.subtitleStyle,
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

/* ------------------------------------------------- CREATIVE sanitisers
   All of these are SANITISERS, not validators — the contract `streamsOf` set.
   A hand-edited or truncated file loses the bad FIELD, never the clip.

   `normalizeClipProperties`, `subtitleStyleOf` and the four primitives they are
   built from now live in ./clipProperties and are RE-EXPORTED below, so every
   existing consumer of this module is unchanged. They moved because
   `timelineSlice` needs the same clamp tables on the write path and cannot
   import this file: project.ts imports `readStore`, store.ts calls
   `createTimelineSlice` at module-eval time, and the resulting cycle builds the
   store with an undefined slice creator. See the header of ./clipProperties.  */

export { normalizeClipProperties, subtitleStyleOf } from './clipProperties';

/** `frames` below 1 is not a short transition, it is no transition. */
function transitionOf(v: unknown, allow: readonly TransitionKind[]): Transition | undefined {
  if (!isObject(v)) return undefined;
  const kind = v.kind;
  if (typeof kind !== 'string' || !allow.includes(kind as TransitionKind)) return undefined;
  const frames = Math.round(num(v.frames, 0, 0, 100_000));
  if (frames < 1) return undefined;
  return { kind: kind as TransitionKind, frames };
}

function titleOf(v: unknown): TitleSpec {
  const t = isObject(v) ? v : {};
  const d = DEFAULT_TITLE;
  const align = t.align;
  return {
    text: typeof t.text === 'string' ? t.text : d.text,
    sizePct: num(t.sizePct, d.sizePct, 0.02, 0.4),
    fontFamily: typeof t.fontFamily === 'string' && t.fontFamily !== '' ? t.fontFamily : d.fontFamily,
    bold: bool(t.bold, d.bold),
    italic: bool(t.italic, d.italic),
    color: hex(t.color, d.color),
    background: hex(t.background, d.background),
    backgroundOpacity: num(t.backgroundOpacity, d.backgroundOpacity, 0, 1),
    align: align === 'left' || align === 'right' || align === 'center' ? align : d.align,
    anchorX: num(t.anchorX, d.anchorX, 0, 1),
    anchorY: num(t.anchorY, d.anchorY, 0, 1),
  };
}

function validCue(v: unknown): v is SubtitleCue {
  if (!isObject(v)) return false;
  return (
    typeof v.id === 'string' &&
    isFiniteNumber(v.start) &&
    isFiniteNumber(v.end) &&
    v.end > v.start &&
    typeof v.text === 'string'
  );
}

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

/** The only `version` this build WRITES. */
export const PROJECT_VERSION = 2;
/** Every version it can READ. Ascending. */
export const READABLE_VERSIONS: readonly number[] = [1, 2];

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
  if (isFiniteNumber(version) && version >= 1 && !READABLE_VERSIONS.includes(version)) {
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
  if (!isFiniteNumber(raw.version) || !READABLE_VERSIONS.includes(raw.version)) return null;
  if (!Array.isArray(raw.media) || !Array.isArray(raw.tracks)) return null;
  if (!Array.isArray(raw.trackOrder) || !Array.isArray(raw.clips)) return null;

  const fps = isFiniteNumber(raw.fps) && raw.fps > 0 ? raw.fps : 30;
  const width = isFiniteNumber(raw.width) && raw.width > 0 ? Math.round(raw.width) : 1920;
  const height = isFiniteNumber(raw.height) && raw.height > 0 ? Math.round(raw.height) : 1080;

  // `volume` is normalised in place rather than left to a reader, so a
  // hand-edited `"volume": "loud"` cannot reach the multiply in the mix. The map
  // returns the ORIGINAL object when the key is already absent or already valid,
  // so a version-1 project allocates no new track records on open.
  const tracks = raw.tracks.filter(validTrack).map((t) => {
    const v = (t as { volume?: unknown }).volume;
    if (v === undefined) return t;
    const clean = num(v, 1, 0, 2);
    if (clean === 1) {
      const { volume: _drop, ...rest } = t as Track;
      return rest as Track;
    }
    return v === clean ? t : ({ ...t, volume: clean } as Track);
  });
  const trackIds = new Set(tracks.map((t) => t.id));
  const trackOrder = raw.trackOrder.filter(
    (id): id is string => typeof id === 'string' && trackIds.has(id),
  );

  // Unlike the `streams` pass this REBUILDS every clip, because
  // `normalizeClipProperties` is total. That is a deliberate trade: the
  // allocation is one pass at open time, and what it buys is the guarantee that
  // no code downstream of here has to ask whether a property exists. The
  // previous identity-preserving optimisation only ever held for clips that were
  // already perfect, which is not the case this pass is for.
  const kept = raw.clips
    .filter(validClip)
    .filter((c) => trackIds.has(c.trackId))
    .map((c) => {
      const src = c as unknown as Record<string, unknown>;
      const out: Clip = {
        id: c.id,
        mediaId: c.mediaId,
        trackId: c.trackId,
        start: Math.round(c.start),
        duration: Math.max(1, Math.round(c.duration)),
        mediaIn: Math.max(0, Math.round(c.mediaIn)),
        name: c.name,
        properties: normalizeClipProperties(src.properties),
      };

      // Explicit 'av', or garbage from a hand-edited file: the key is simply not
      // written. Leaving it would hand the bad value straight to `clipStreams`,
      // whose `??` only catches null/undefined — `detachAudio`'s `!== 'av'` guard
      // would then skip the clip forever, and the next save would persist it.
      const streams = streamsOf(src.streams);
      if (streams !== undefined) out.streams = streams;

      // A title clip carries no media, so a `mediaId` on one is meaningless and
      // is dropped: leaving it would send the clip into `offlineClipIds` looking
      // for a MediaItem that a title project never had.
      const kind: ClipKind | undefined = src.kind === 'title' ? 'title' : undefined;
      if (kind === 'title') {
        out.kind = 'title';
        out.title = titleOf(src.title);
        out.mediaId = '';
      }

      // 'dissolve' is INCOMING-ONLY (CREATIVE §4.3). A file claiming an outgoing
      // dissolve is not upgraded to one — it loses the key, because honouring it
      // would give one visual event two owners, which is the thing the asymmetry
      // exists to prevent.
      const tIn = transitionOf(src.transitionIn, ['fade', 'dissolve']);
      if (tIn) out.transitionIn = tIn;
      const tOut = transitionOf(src.transitionOut, ['fade']);
      if (tOut) out.transitionOut = tOut;

      const link = linkIdOf(src.linkId);
      if (link !== undefined) out.linkId = link;

      return out;
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
    // Absent on every version-1 file, which is the whole reason the arrays are
    // guarded rather than required: a project saved before subtitles existed
    // opens with none, not as a damaged file.
    subtitles: Array.isArray(raw.subtitles)
      ? raw.subtitles.filter(validCue).map((c) => ({ ...c, text: String(c.text) }))
      : [],
    subtitleStyle: subtitleStyleOf(raw.subtitleStyle),
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
  };
}
