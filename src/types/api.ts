/* ---------------------------------------------------------------------------
   api.ts — the window.editorAPI contract. PLAN §4.

   Compiled into BOTH the renderer bundle and dist-electron (PLAN §1.2), so it
   must contain no React, no DOM-only runtime and no node import. `CH` is a
   VALUE export: main and preload import it rather than retyping a channel
   string, which is what stops the two from drifting.
--------------------------------------------------------------------------- */

import type { Clip, Frames, MediaError, MediaId, MediaKind, ProjectFile, Track } from './model';

export const CH = {
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize-toggle',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaxChanged: 'window:maximize-changed', // main -> renderer
  mediaPick: 'media:pick',
  mediaProbe: 'media:probe',
  mediaRename: 'media:rename',
  mediaReveal: 'media:reveal',
  mediaProbeProgress: 'media:probe-progress', // main -> renderer
  projectSave: 'project:save',
  projectOpen: 'project:open',
  projectPickDir: 'project:pick-directory',
  projectOpenPath: 'project:open-path', // main -> renderer
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportProgress: 'export:progress', // main -> renderer
  // SAFETY.md §5 — the close prompt and autosave.
  appProjectState: 'app:project-state', // renderer -> main, send
  appSaveRequest: 'app:save-request', // main -> renderer, send
  appSaveResult: 'app:save-result', // renderer -> main, send
  appConfirmDiscard: 'app:confirm-discard', // renderer -> main, invoke
  autosaveWrite: 'autosave:write', // renderer -> main, invoke
  autosaveRecoverable: 'autosave:recoverable', // renderer -> main, invoke
  autosaveRetire: 'autosave:retire', // renderer -> main, invoke
  autosaveResolve: 'autosave:resolve-offer', // renderer -> main, invoke
} as const;

export type ChannelName = (typeof CH)[keyof typeof CH];

export interface ProbeData {
  kind: MediaKind;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  hasAudio: boolean;
  /**
   * THE playable source. 've-media://file/<encodeURIComponent(abs)>' — see PLAN §1.4.
   * Never a bare file:// URL: the dev renderer is served from http://localhost:5173 and
   * webSecurity blocks file://. Never '' from a successful probe.
   */
  url: string;
  /** Same scheme as `url`, pointing at the extracted temp frame. null when none. */
  thumbnailUrl: string | null;
}

export type ProbeResult = { ok: true; data: ProbeData } | { ok: false; error: MediaError };

/* ---- renaming a file on disk — RENAME.md §IPC contract ------------------ */

/**
 * The six reachable outcomes. Every `message` is one sentence, safe to render
 * verbatim next to an icon: main never puts an errno, a path or a stack in it.
 *
 * 'file-in-use' and 'permission' are distinct on purpose — one is fixed by
 * closing another program, the other is not fixable from inside this app, and a
 * single "could not rename" would leave the user with nothing to try.
 */
export type RenameError =
  | { code: 'invalid-name'; message: string }
  | { code: 'name-taken'; message: string }
  | { code: 'not-found'; message: string }
  | { code: 'permission'; message: string }
  | { code: 'file-in-use'; message: string }
  | { code: 'io-failed'; message: string };

/**
 * `path` and `name` are the NEW absolute path and the new basename INCLUDING the
 * extension — `MediaItem.path` and `MediaItem.name` respectively.
 *
 * `url` is built by main rather than rebuilt by the renderer so the 've-media://'
 * encoding (PLAN §1.4) stays owned by one function. A renderer that concatenated
 * its own would be one `encodeURIComponent` away from a source that silently
 * fails to load for any name containing a '#' or a '%'.
 */
export type RenameResult =
  | { ok: true; path: string; url: string; name: string }
  | { ok: false; error: RenameError };

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; error: { code: 'cancelled' | 'io-failed'; message: string } };

export type OpenResult =
  | { ok: true; path: string; project: ProjectFile }
  | { ok: false; error: { code: 'cancelled' | 'io-failed' | 'bad-format'; message: string } };

/* ---- the codec union — AUDIO-FEATURES §2.2 ------------------------------ */

/** Codecs that put pixels in the file. `CODEC_SHAPE` and `BITRATE_KBPS` are keyed by this. */
export type VideoCodec = 'h264' | 'h265' | 'prores';
/** Codecs that produce an audio-only file: no video stream, no output frame grid. */
export type AudioCodec = 'aac' | 'mp3' | 'wav';

export interface ExportSettings {
  /** WITHOUT extension; the container supplies it — see CONTAINER in PLAN §7.3. */
  filename: string;
  folder: string;
  width: number;
  height: number;
  fps: number;
  /**
   * ONE widened union rather than an orthogonal `kind` field, which would admit
   * three illegal combinations every consumer would have to reject
   * (AUDIO-FEATURES §2.2). `width`/`height`/`fps` stay required and valid even
   * for an audio codec — see §2.4.
   */
  codec: VideoCodec | AudioCodec;
  quality: 'draft' | 'good' | 'best';
  range: 'entire' | 'inout';
}

/**
 * THE discriminator. A VALUE export, like `CH`: `electron/export/graph.ts` and
 * `electron/ipc/export.ts` import it at runtime, and PLAN §1.2 compiles this file
 * into `dist-electron/src/types/api.js`, so it resolves there with no new build
 * plumbing. A type predicate, so the false arm narrows `codec` to `VideoCodec`
 * and `CODEC_SHAPE[req.codec]` is total without a cast.
 */
export const isAudioOnlyCodec = (c: ExportSettings['codec']): c is AudioCodec =>
  c === 'aac' || c === 'mp3' || c === 'wav';

/* ---- export errors — EXPORT §4 ------------------------------------------ */

export type ExportErrorCode =
  | 'ffmpeg-missing'
  | 'invalid-filename'
  | 'invalid-request'
  | 'empty-timeline'
  | 'source-missing'
  | 'unsupported-codec'
  | 'output-not-writable'
  | 'permission-denied'
  | 'disk-full'
  | 'output-in-use'
  | 'busy'
  | 'encoder-not-started'
  | 'encoder-failed';

export interface ExportError {
  code: ExportErrorCode;
  /** One sentence, sentence case, no trailing period, safe to show verbatim. */
  message: string;
  /** True when re-running the identical request could succeed without user action. */
  retryable: boolean;
}

/* ---- the document handed to the graph builder — EXPORT §5 --------------- */

/**
 * One source file. `path` is an ABSOLUTE filesystem path — never a 've-media://' URL,
 * which exists for Chromium (PLAN §1.4) and which ffmpeg cannot open.
 *
 * `hasAudio` is a property of the FILE, not of the edit: every dev-media fixture carries an
 * audio stream, each with its own audible signature (scripts/make-dev-media.mjs). Whether a
 * clip is audible is decided by `volume` and the track's `muted` flag (EXPORT §1.4), never by
 * guessing from content — a file whose content were silence would still have `hasAudio: true`.
 */
export interface ExportSource {
  mediaId: MediaId;
  path: string;
  kind: MediaKind;
  hasAudio: boolean;
  /** MediaItem.durationFrames — PROJECT frames, at ExportDocument.fps. */
  durationFrames: Frames;
  width: number;
  height: number;
}

/**
 * The timeline, flattened for the encoder. Every frame field is in PROJECT frames at
 * `fps`; MediaItem.fps is never carried, because no frame calculation may read it
 * (PLAN §2.4, the source-mapping invariant).
 */
export interface ExportDocument {
  fps: number;
  width: number;
  height: number;
  /**
   * COMPOSITE order: video tracks bottom-first, then audio tracks in `trackOrder`
   * order. This is NOT a plain reverse of the store's `trackOrder` — see EXPORT §6
   * for the literal transform, which reverses only the video tracks.
   */
  tracks: Track[];
  /** Every clip in the project. The builder filters by range and by track flags. */
  clips: Clip[];
  sources: ExportSource[];
}

/* ---- the request -------------------------------------------------------- */

/**
 * The DIALOG resolves `range` into absolute frames before calling (PLAN §8.9), and
 * attaches the document — a main-process bridge has no other way to see the timeline.
 *
 * `document` is OPTIONAL so that this file can land before the renderer call site that
 * fills it (EXPORT §6, "The seam"). Main treats an absent document as `empty-timeline`.
 * It may be tightened to required once the call site exists.
 */
export type ExportRequest = ExportSettings & {
  startFrame: Frames;
  durationFrames: Frames;
  document?: ExportDocument;
};

export interface ExportProgressEvent {
  jobId: string;
  phase: 'preparing' | 'encoding' | 'finalizing' | 'done' | 'cancelled' | 'error';
  /** 0..1, monotonic within a phase. */
  progress: number;
  framesDone: number;
  /** OUTPUT frames: round(durationSeconds * settings.fps). */
  framesTotal: number;
  /** Required when phase === 'error'. Always equals `error.message` when `error` is set. */
  message?: string;
  /** Set when phase === 'error'. Lets a future UI branch on the code without a contract change. */
  error?: ExportError;
  /**
   * Set when phase === 'done'. The absolute path actually written — main's `path.join`
   * result, which is what the dialog renders (EXPORT §6, RENDERER).
   */
  outputPath?: string;
}

export interface ExportBridge {
  /**
   * The DIALOG resolves `range` into absolute frames before calling. A real ffmpeg-backed
   * bridge cannot know where an in/out range begins otherwise, and the stub and the real
   * bridge must be interchangeable.
   */
  start(req: ExportRequest): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<void>;
  /** Returns its own unsubscribe. */
  onProgress(cb: (e: ExportProgressEvent) => void): () => void;
}

/* ---- data safety — SAFETY.md §1, §2 ------------------------------------- */

/**
 * Mirrored into main on every change so `win.on('close')` — which is synchronous
 * and cannot read the renderer's store — can formulate its question with no
 * round trip (SAFETY §1.3).
 */
export interface ProjectStateReport {
  isDirty: boolean;
  projectName: string;
  /** false = never saved anywhere, so Save will need a path. */
  hasPath: boolean;
}

/**
 * Everything the open-guard dialog needs that only the renderer knows.
 * `exporting` is deliberately NOT here: main computes it (SAFETY §1.9), and a
 * field the only caller cannot compute would be hardcoded `false`.
 */
export interface DiscardQuestion {
  projectName: string;
  neverSaved: boolean;
}

/** Declared once, here. projectActions.ts imports these; it never redeclares them. */
export type DiscardChoice = 'save' | 'discard' | 'cancel';
export type CloseSaveOutcome = 'saved' | 'cancelled' | 'failed';
/** 'abandon' is main-internal — produced by the §1.6 watchdog, never accepted off the wire. */
export type CloseSaveResolution = CloseSaveOutcome | 'abandon';

/** What the renderer sends. Main adds version, sessionId and savedAt. */
export interface AutosavePayload {
  /** Monotonic per renderer session, starting at 1. Orders writes against retirement (§2.6). */
  seq: number;
  /** The .veproj this project came from, or null when it has never been saved. */
  projectPath: string | null;
  projectName: string;
  /** ISO 8601 of the last explicit save in this session; null if there has not been one. */
  lastExplicitSaveAt: string | null;
  /** Exactly what serializeProject() produces, with project.savedAt rewritten (§2.2). */
  project: ProjectFile;
}

/** What is on disk. */
export interface AutosaveSnapshot extends AutosavePayload {
  version: 1;
  sessionId: string;
  /** ISO 8601, when this snapshot was written. Distinct from project.savedAt. */
  savedAt: string;
}

/**
 * `skipped` is not a failure: main declined the write because an export is
 * running and the previous snapshot is younger than the export floor, or
 * because the write was retired underneath it (§2.6).
 */
export type AutosaveWriteResult =
  | { ok: true; skipped: false; at: number }
  | { ok: true; skipped: true }
  | { ok: false };

/** The launch-time recovery offer (§2.3). */
export interface RecoveryOffer {
  sessionId: string;
  projectName: string;
  projectPath: string | null;
  /** false when projectPath is set but no longer resolves to a file. */
  projectPathExists: boolean;
  savedAt: string;
  /** Still passed through migrateProject in the renderer (§2.7). */
  project: ProjectFile;
}

export interface EditorAPI {
  platform: 'win32' | 'darwin' | 'linux';
  window: {
    minimize(): void;
    maximizeToggle(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizeChange(cb: (isMaximized: boolean) => void): () => void;
  };
  media: {
    /** [] on cancel. */
    pickFiles(): Promise<string[]>;
    /** Never throws. */
    probe(path: string): Promise<ProbeResult>;
    /**
     * Renames the file on disk, in place, in the same directory. `baseName`
     * EXCLUDES the extension, which is preserved and is not renameable
     * (RENAME.md §Scope). Never throws, never overwrites an existing file, and
     * does not touch the disk when `baseName` already matches.
     *
     * Main validates `baseName` again with the same predicate the renderer uses
     * (`src/lib/filename.ts`); a renderer that skipped its check cannot get an
     * illegal name onto the filesystem.
     */
    rename(path: string, baseName: string): Promise<RenameResult>;
    /**
     * Shows the file in the OS file manager, selected. Fire-and-forget: there is
     * nothing useful to report back, and a missing file just opens its folder.
     *
     * OPTIONAL because it is a shell capability, and the browser preview has no
     * shell. The media row's context menu detects it rather than assuming it, so
     * `Reveal in folder` is live in Electron and disabled with a reason under
     * `dev:web`.
     */
    reveal?(path: string): void;
    onProbeProgress(cb: (e: { path: string; progress: number }) => void): () => void;
    /**
     * Synchronous. Preload-only capability (webUtils.getPathForFile); null in the fixture
     * bridge and for a File that has no filesystem backing. See PLAN §3.2.
     */
    pathForFile(file: File): string | null;
  };
  project: {
    save(
      project: ProjectFile,
      opts?: { path?: string | null; saveAs?: boolean },
    ): Promise<SaveResult>;
    /**
     * With a `path`, opens that file directly and never raises the picker —
     * symmetric with `save`, whose `opts.path` already works that way. That is
     * what 'open recent', a .veproj handed over by the OS (see
     * `onOpenRequest`), and any automated test of the open path all need. Omit
     * it for the native picker.
     */
    open(path?: string): Promise<OpenResult>;
    pickDirectory(): Promise<string | null>;
    /**
     * The OS handed the app a .veproj — a double-click on Windows/Linux (argv,
     * including the argv of a second launch while this one is running) or the
     * darwin `open-file` event. Main holds the path until the renderer has
     * loaded, so a launch-time association is never dropped.
     *
     * The renderer decides what to do with it: only it can migrate and apply a
     * project. Returns its own unsubscribe.
     */
    onOpenRequest(cb: (path: string) => void): () => void;

    /* ---- data safety (SAFETY.md §5). All optional, exactly as media.reveal is:
       src/dev/fixtures.ts needs no change and dev:web keeps working, because
       every call site feature-detects. ---------------------------------------- */

    /** Mirrors dirty state into main so win.on('close') can answer synchronously. */
    reportState?(report: ProjectStateReport): void;
    /** Main is asking the renderer to save before a close completes. Returns its unsubscribe. */
    onSaveRequest?(cb: (token: string) => void): () => void;
    reportSaveResult?(token: string, outcome: CloseSaveOutcome): void;
    /** Raises the native three-way question. Absent under dev:web ⇒ treat as 'discard'. */
    confirmDiscard?(q: DiscardQuestion): Promise<DiscardChoice>;

    autosaveWrite?(payload: AutosavePayload): Promise<AutosaveWriteResult>;
    /** Idempotent: returns the held offer without consuming it (§2.7). */
    autosaveRecoverable?(): Promise<RecoveryOffer | null>;
    /** Retires THIS session's snapshot through `throughSeq` (§2.6). Fire-and-forget. */
    autosaveRetire?(throughSeq: number): Promise<void>;
    /** Answers a recovery offer from a PREVIOUS session. */
    autosaveResolveOffer?(sessionId: string, how: 'restored' | 'discarded'): Promise<void>;
  };
  /**
   * PRESENT in Electron once electron/ipc/export.ts lands. Absent under dev:web,
   * where ExportDialog falls back to exportStub.
   */
  export?: ExportBridge;
}

declare global {
  interface Window {
    editorAPI?: EditorAPI;
  }
}
