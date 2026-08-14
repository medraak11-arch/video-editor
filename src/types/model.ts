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
export type CueId = string; // 'q_' + nanoid. A subtitle cue. `s_` would read as "source".
/**
 * 'g_' + nanoid. The identity of a link group; it names no other thing.
 *
 * The prefix is `g`, not `l`: ids are read in the mono face, where `l_` and `1_`
 * are near-indistinguishable, and this project's ids are read by humans — in
 * `data-clip-id`, in a hand-inspected `.veproj`, and through CDP.
 */
export type LinkId = string; // 'g_' + nanoid

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

  /* ------------------------------------------------------- grade (CREATIVE §2)
     Read these through `gradeMath` in src/lib/color.ts and nowhere else. Neither
     the preview nor the graph may consume one of these numbers directly: CSS
     brightness is multiplicative and ffmpeg's is additive, so a direct wiring
     gives a preview that disagrees with the file at every non-default setting. */

  /** -1..1, 0 = unity. ADDITIVE — slope/intercept, see `gradeMath`. */
  brightness: number;
  /** 0..3, 1 = unity. */
  contrast: number;
  /**
   * 0..**1.8**, 1 = unity. NARROWED from 0..3 — CREATIVE §2.5.
   *
   * `colorchannelmixer` refuses any coefficient outside [-2, 2], and the
   * saturation matrix's own diagonal is `LUMA_B + (1 − LUMA_B)·s` scaled by the
   * temperature gain, which crosses 2 at s = 1.846 with `TEMPERATURE_GAIN` at
   * its coolest. Above that the export does not degrade — it REFUSES, naming a
   * filter parameter the user has never heard of. The declared range is now the
   * range that can actually be encoded.
   *
   * 1.8 rather than 1.846 for headroom, and it is not a retreat from anything
   * real: Premiere's Lumetri and Resolve both top out at 2×. The 0..3 this
   * replaces was the outlier.
   */
  saturation: number;
  /** -100..100, 0 = unity. Negative is cooler, positive warmer. */
  temperature: number;

  /* ------------------------------------------------------ effects (CREATIVE §3)
     A fixed catalogue, not an orderable stack: five fields persist, undo and
     migrate for free, where a stack would need ids, ordering and an orphan pass
     and would buy nothing until there are two effects worth reordering. */

  /** Gaussian sigma in PROJECT-resolution px. 0 = off. Rescaled onto the output grid. */
  blur: number;
  /** 0..2, 0 = off. */
  sharpen: number;
  /** 0..1, 0 = off. */
  vignette: number;
  flipH: boolean;
  flipV: boolean;
}

export const DEFAULT_CLIP_PROPERTIES: ClipProperties = {
  scale: 1,
  positionX: 0,
  positionY: 0,
  rotation: 0,
  opacity: 1,
  speed: 1,
  volume: 1,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  blur: 0,
  sharpen: 0,
  vignette: 0,
  flipH: false,
  flipV: false,
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

/* ------------------------------------------------- transitions (CREATIVE §4) */

export type TransitionKind = 'fade' | 'dissolve';

export interface Transition {
  kind: TransitionKind;
  /** >= 1, in PROJECT frames. The value the USER authored — never the clamped one. */
  frames: Frames;
}

/** Default length of a transition added by a command rather than dragged. */
export const DEFAULT_TRANSITION_FRAMES: Frames = 12;

/* ------------------------------------------------------ titles (CREATIVE §5) */

/** ABSENT ≡ 'media'. Not a MediaKind: Track.kind is a MediaKind, and widening it
 *  would invent a "title track" this app does not have. */
export type ClipKind = 'media' | 'title';

export interface TitleSpec {
  /** '\n' separates lines. No markup. */
  text: string;
  /** Cap height as a fraction of FRAME height, so a title is resolution-independent. */
  sizePct: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  /** '#rrggbb'. */
  color: string;
  /** '#rrggbb', the plate behind the text. */
  background: string;
  /** 0..1. 0 = no plate at all. */
  backgroundOpacity: number;
  align: 'left' | 'center' | 'right';
  /** Anchor of the text block within the frame, 0..1. 0.5/0.5 is centred. */
  anchorX: number;
  anchorY: number;
}

export const DEFAULT_TITLE: TitleSpec = {
  text: 'Title',
  sizePct: 0.09,
  fontFamily: 'Inter, Segoe UI, sans-serif',
  bold: true,
  italic: false,
  color: '#ffffff',
  background: '#000000',
  backgroundOpacity: 0,
  align: 'center',
  anchorX: 0.5,
  anchorY: 0.5,
};

export interface Clip {
  id: ClipId;
  /** '' for a title clip. Every media lookup must SKIP title clips rather than
   *  resolve an empty id — `offlineClipIds` above all, or every title reads as
   *  offline media. */
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
  /**
   * The link group this clip belongs to, or absent when it belongs to none.
   *
   * ABSENT means ungrouped. Optional for the same two reasons `streams` is: a
   * .veproj written before this feature has no such key and must stay a valid
   * project file rather than become a migration, and an ordinary clip must not
   * carry a redundant field into every save. Read it through `clipLinkId`.
   *
   * INVARIANT: every LinkId present in the store is carried by at least two
   * clips. A group of one is meaningless and is dissolved at the single choke
   * point that can create one — see docs/LINKING.md §5.1.
   */
  linkId?: LinkId;
  /**
   * ABSENT ≡ 'media', for the reason every other optional on this interface is
   * optional: a pre-feature `.veproj` stays a valid project file rather than
   * becoming a migration. Read it through `clipIsTitle`.
   */
  kind?: ClipKind;
  /** Present iff `kind === 'title'`. */
  title?: TitleSpec;
  /**
   * CREATIVE §4. On the clip and not in a keyed collection, because a transition
   * has no identity of its own: it cannot outlive its clip, be selected apart
   * from it, or be shared. Deleting a clip therefore deletes its transitions,
   * with no orphan pass — the pass `linkId` needed and got wrong twice.
   */
  transitionIn?: Transition;
  /** `kind` is ALWAYS 'fade' here. A dissolve is owned by the INCOMING clip
   *  alone (CREATIVE §4.3), so that one visual event has one source of truth. */
  transitionOut?: Transition;
}

/** Exclusive end. There is no `end` field — derive it, always, with this helper. */
export const clipEnd = (c: Clip): Frames => c.start + c.duration;

/** THE reader. Nothing anywhere may write `c.streams ?? 'av'` inline. */
export const clipStreams = (c: Clip): ClipStreams => c.streams ?? 'av';
/** True when this clip puts pixels on the canvas. */
export const clipHasVideo = (c: Clip): boolean => clipStreams(c) !== 'audio';
/** True when this clip puts samples in the mix. */
export const clipHasAudio = (c: Clip): boolean => clipStreams(c) !== 'video';

/** THE reader. Nothing anywhere may write `c.linkId ?? null` inline. */
export const clipLinkId = (c: Clip): LinkId | null => c.linkId ?? null;
/** True when this clip moves with others. */
export const clipIsLinked = (c: Clip): boolean => c.linkId !== undefined;

/** THE reader. Nothing anywhere may test `c.kind === 'title'` inline. */
export const clipIsTitle = (c: Clip): boolean => c.kind === 'title';
/** True when this clip resolves a MediaItem. The predicate every media lookup wants. */
export const clipUsesMedia = (c: Clip): boolean => !clipIsTitle(c) && c.mediaId !== '';

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
  /**
   * 0..2, 1 = unity. ABSENT ≡ 1 — CREATIVE §1.1.
   *
   * The middle term between `properties.volume` and `muted`: the thing you reach
   * for when one camera was louder than the other for the whole edit. Effective
   * gain is the PRODUCT of clip and track, and 0 when muted. Read it through
   * `trackVolume`.
   */
  volume?: number;
}

/** THE reader. Nothing anywhere may write `t.volume ?? 1` inline. */
export const trackVolume = (t: Track): number => t.volume ?? 1;

export interface Marker {
  id: MarkerId;
  frame: Frames;
  /** May be ''. */
  label: string;
}

/* --------------------------------------------------- subtitles (CREATIVE §6) */

export interface SubtitleCue {
  id: CueId;
  /** Inclusive, in PROJECT frames. */
  start: Frames;
  /** Exclusive. Always > start. */
  end: Frames;
  /** '\n' separates lines. No markup. */
  text: string;
}

export interface SubtitleStyle {
  /** Cap height as a fraction of frame height. 0.02..0.2 */
  sizePct: number;
  /** '#rrggbb' */
  color: string;
  /** Outline width in px at 1080p, scaled with the output height. 0..4 */
  outline: number;
  /** Baseline distance from the bottom of the frame, as a fraction of height. 0..0.4 */
  marginPct: number;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  sizePct: 0.055,
  color: '#ffffff',
  outline: 2,
  marginPct: 0.08,
};

/* --------------------------------------------------------------- 2.5 Selection */

/** Immutable. Every mutation allocates a new Set so referential equality means "unchanged". */
export type Selection = ReadonlySet<ClipId>;
export const EMPTY_SELECTION: Selection = new Set<ClipId>();

/* ------------------------------------------------------------ 2.6 Project file */

export interface ProjectFile {
  /**
   * 2 since CREATIVE. Bumped rather than left at 1 even though every new field
   * is additive: a 0.1.6 build reading a version-1 file full of titles and
   * transitions would open it, show none of them, and write them away on the
   * next save. Refusing the file with "saved by a newer version" costs the user
   * an upgrade; opening it costs them their work. `migrateProject` still reads
   * version 1 and fills the defaults, so nothing old is orphaned.
   */
  version: 1 | 2;
  name: string;
  fps: number;
  width: number;
  height: number;
  media: PersistedMediaItem[];
  tracks: Track[];
  trackOrder: TrackId[];
  clips: Clip[];
  markers: Marker[];
  /** CREATIVE §6.1. Project-level: subtitles survive re-cutting the footage. */
  subtitles: SubtitleCue[];
  subtitleStyle: SubtitleStyle;
  /** ISO 8601 */
  savedAt: string;
}
