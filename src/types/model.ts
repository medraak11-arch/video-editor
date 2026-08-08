/* ---------------------------------------------------------------------------
   model.ts — the shared data model. PLAN §2, reproduced as code.

   Cross-cutting and scaffold-owned: every slice reads this file, only scaffold
   writes it. A slice that needs a field states the exact declaration it needs
   in its final message (PLAN §0.2) rather than patching around the gap.

   No React, no DOM, no node imports: this module is compiled into BOTH the
   renderer bundle and dist-electron.
--------------------------------------------------------------------------- */

/* ------------------------------------------------------------------ 2.1 Time
   Time is stored in whole frames, as integers, everywhere in the store,
   without exception. Seconds and timecode exist only at the edges.          */

/** Whole frames at the project fps. Always an integer. Never negative for a timeline position. */
export type Frames = number;
/** Real seconds. Only ever at an edge: <video>.currentTime, ffprobe, export duration. */
export type Seconds = number;
/** Timeline pixels per frame. The single zoom unit. */
export type PxPerFrame = number;

/* ------------------------------------------------------------------- 2.2 Ids */

export type MediaId = string; // 'm_' + nanoid
export type ClipId = string; // 'c_' + nanoid
export type TrackId = string; // 't_' + nanoid
export type MarkerId = string; // 'k_' + nanoid

/* ----------------------------------------------------------------- 2.3 Media */

export type MediaKind = 'video' | 'audio';
export type MediaStatus = 'probing' | 'ready' | 'error';

export type MediaErrorCode =
  | 'not-found' // file disappeared or path unreadable
  | 'unsupported-codec' // probed fine, we cannot decode it
  | 'probe-failed' // ffprobe returned non-zero / unparseable
  | 'ffmpeg-missing' // binary not on PATH
  | 'cancelled';

export interface MediaError {
  code: MediaErrorCode;
  /** One sentence, sentence case, no trailing period, safe to show verbatim. */
  message: string;
}

/** Non-fatal. The item is usable; something about it will bite later. */
export type MediaWarningCode = 'fps-mismatch' | 'resolution-mismatch';

export interface MediaWarning {
  code: MediaWarningCode;
  /** Sentence case, no trailing period. */
  message: string;
}

export interface MediaItem {
  id: MediaId;
  /** Absolute filesystem path. In the browser fixture, a plausible pseudo-path. */
  path: string;
  /** Playable source for <video src>. 've-media://…' in Electron. Empty string = not playable. */
  url: string;
  /** Basename including extension. */
  name: string;
  kind: MediaKind;
  status: MediaStatus;
  error: MediaError | null;
  /** Non-fatal notes. Empty array when clean. Drives the warning treatment (PLAN §7.6). */
  warnings: MediaWarning[];
  /** 0..1, meaningful only while status === 'probing'. */
  progress: number;
  /** Source duration converted to project frames. 0 until ready. */
  durationFrames: Frames;
  /** Native duration in seconds, as probed. */
  durationSeconds: Seconds;
  /** Native pixel dimensions. 0 for audio-only. */
  width: number;
  height: number;
  /** Native frame rate. 0 for audio-only. Informational: never used to convert a clip field. */
  fps: number;
  codec: string;
  hasAudio: boolean;
  /** 've-media://…' (Electron) or a served/data URL (fixture). null when none could be extracted. */
  thumbnailUrl: string | null;
  /** Date.now() */
  addedAt: number;
}

/** What actually goes in a .veproj. Runtime-only fields are dropped — see PLAN §2.6. */
export type PersistedMediaItem = Omit<
  MediaItem,
  'url' | 'status' | 'progress' | 'error' | 'warnings' | 'thumbnailUrl'
>;

/* ------------------------------------------------- 2.4 Clips, tracks, markers */

export interface ClipProperties {
  /** 1 = 100% */
  scale: number;
  /** px in project-resolution space, 0 = centred */
  positionX: number;
  positionY: number;
  /** degrees, -180..180 */
  rotation: number;
  /** 0..1 */
  opacity: number;
  /** 1 = 100%, 0.1..8, never 0 */
  speed: number;
  /** 0..2, 1 = unity */
  volume: number;
}

export const DEFAULT_CLIP_PROPERTIES: ClipProperties = {
  scale: 1,
  positionX: 0,
  positionY: 0,
  rotation: 0,
  opacity: 1,
  speed: 1,
  volume: 1,
};

/**
 * Which streams of the referenced media this clip uses.
 *
 * ABSENT means 'av'. The field is optional so that a .veproj written before this
 * feature — which has no such key — is a valid project file rather than a
 * migration, and so that an ordinary clip does not carry a redundant "av" into
 * every save. Read it through `clipStreams`, never directly.
 */
export type ClipStreams = 'av' | 'video' | 'audio';

export interface Clip {
  id: ClipId;
  mediaId: MediaId;
  trackId: TrackId;
  /** Timeline frame of this clip's first frame. Inclusive. >= 0. PROJECT frames. */
  start: Frames;
  /** Length on the timeline. >= 1. PROJECT frames. */
  duration: Frames;
  /** Offset into the source of this clip's first frame. >= 0. PROJECT frames. */
  mediaIn: Frames;
  /** Display name. Defaults to the media name; user-renameable later. */
  name: string;
  properties: ClipProperties;
  /** Undefined ≡ 'av'. Written only by `detachAudio`; see docs/AUDIO-FEATURES.md §1.1. */
  streams?: ClipStreams;
}

/** Exclusive end. There is no `end` field — derive it, always, with this helper. */
export const clipEnd = (c: Clip): Frames => c.start + c.duration;

/** THE reader. Nothing anywhere may write `c.streams ?? 'av'` inline. */
export const clipStreams = (c: Clip): ClipStreams => c.streams ?? 'av';
/** True when this clip puts pixels on the canvas. */
export const clipHasVideo = (c: Clip): boolean => clipStreams(c) !== 'audio';
/** True when this clip puts samples in the mix. */
export const clipHasAudio = (c: Clip): boolean => clipStreams(c) !== 'video';

/** Source frames this clip consumes. THE source-mapping primitive (PLAN §2.4). */
export const clipSourceLength = (c: Clip): Frames => Math.round(c.duration * c.properties.speed);

export interface Track {
  id: TrackId;
  kind: MediaKind;
  /** Monotonic within kind, 1-based. Drives the label. NEVER renumbered. */
  index: number;
  /** 'V1' | 'A2'. The ONLY uppercase strings in the UI. */
  label: string;
  /** Lane height in px. THE runtime source of truth for lane geometry. */
  height: number;
  muted: boolean;
  locked: boolean;
  visible: boolean;
}

export interface Marker {
  id: MarkerId;
  frame: Frames;
  /** May be ''. */
  label: string;
}

/* --------------------------------------------------------------- 2.5 Selection */

/** Immutable. Every mutation allocates a new Set so referential equality means "unchanged". */
export type Selection = ReadonlySet<ClipId>;
export const EMPTY_SELECTION: Selection = new Set<ClipId>();

/* ------------------------------------------------------------ 2.6 Project file */

export interface ProjectFile {
  version: 1;
  name: string;
  fps: number;
  width: number;
  height: number;
  media: PersistedMediaItem[];
  tracks: Track[];
  trackOrder: TrackId[];
  clips: Clip[];
  markers: Marker[];
  /** ISO 8601 */
  savedAt: string;
}
