/* ---------------------------------------------------------------------------
   project.ts — PLAN §2.6. The only module that crosses all four slices.

   Cross-cutting and scaffold-owned (PLAN §0.2): serializeProject hard-codes all
   four slices' state shapes, so any field a slice adds to PERSISTED state
   requires a scaffold edit. State a slice keeps at runtime only needs nothing
   here.
--------------------------------------------------------------------------- */

import type {
  Clip,
  Marker,
  MediaItem,
  PersistedMediaItem,
  ProjectFile,
  Track,
} from '../types/model';
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
    version: 1,
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

/* ------------------------------------------------------------- validation */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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

/** null = not a project file. Never throws. */
export function migrateProject(raw: unknown): ProjectFile | null {
  if (!isObject(raw)) return null;
  if (raw.version !== 1) return null;
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

  return {
    version: 1,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : 'Untitled',
    fps,
    width,
    height,
    media: raw.media.filter(validMedia),
    tracks,
    trackOrder,
    clips: raw.clips.filter(validClip).filter((c) => trackIds.has(c.trackId)),
    markers: Array.isArray(raw.markers) ? raw.markers.filter(validMarker) : [],
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
  };
}
