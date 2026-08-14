/* ---------------------------------------------------------------------------
   api.ts — the window.editorAPI contract. PLAN §4.

   Compiled into BOTH the renderer bundle and dist-electron (PLAN §1.2), so it
   must contain no React, no DOM-only runtime and no node import. `CH` is a
   VALUE export: main and preload import it rather than retyping a channel
   string, which is what stops the two from drifting.
--------------------------------------------------------------------------- */

import type {
  Clip,
  ClipId,
  Frames,
  MediaError,
  MediaId,
  MediaKind,
  ProjectFile,
  SubtitleCue,
  SubtitleStyle,
  Track,
} from './model';

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
  /** CREATIVE §6.4 — write a sidecar .srt. Its own channel, not part of
   *  `projectSave`: it produces a different file, for a different program, and
   *  it must work with an empty timeline and no project path. */
  subtitlesExport: 'subtitles:export',
  /** CREATIVE §6.5 — read a sidecar .srt through a NATIVE dialog. Symmetric with
   *  `subtitlesExport`, and its own channel for the same reasons: a different
   *  file, for a different program, usable with an empty timeline. */
  subtitlesImport: 'subtitles:import',
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
  // RELEASE.md §1.11 — auto-update. Registered only when a feed is configured.
  updateCurrent: 'update:current', // renderer -> main, invoke
  updatePhase: 'update:phase', // main -> renderer, send
  updateCheck: 'update:check', // renderer -> main, send
  updateDownload: 'update:download', // renderer -> main, send
  updateCancel: 'update:cancel', // renderer -> main, send
  updateInstall: 'update:install', // renderer -> main, send
  updateDismiss: 'update:dismiss', // renderer -> main, send
  // RELEASE.md §3.10 — the start-up splash. Its own window, its own preload.
  splashStatus: 'splash:status', // main -> splash, send
  splashReady: 'splash:ready', // splash -> main, send
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
  /**
   * CREATIVE §6.3. Burn the project's subtitles into the picture.
   *
   * A SETTING and not a project property: the same edit is exported once with
   * open captions for social and once clean with a sidecar `.srt`, and which one
   * you are making is a fact about this export, not about the project.
   *
   * Ignored by an audio-only codec, where there is no picture to burn into.
   */
  burnSubtitles: boolean;
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
 * A title clip's pixels, rasterised BY THE RENDERER with the same
 * `src/lib/titleRaster.ts` that drew the preview — CREATIVE §5.2. Main decodes
 * it beside the filter script and feeds it as an ordinary `-loop 1` input, so
 * the exported title is pixel-for-pixel what the user was looking at.
 *
 * Keyed by CLIP id, not media id: a title has no media, and two title clips with
 * identical text are still two clips that can be graded and faded apart.
 *
 * `png` is base64 WITHOUT a `data:` prefix. The prefix would be 22 bytes of
 * nothing repeated per title across an IPC boundary, and main would only strip it.
 */
export interface ExportTitle {
  clipId: ClipId;
  png: string;
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
  /** One per title clip in the project. Empty when there are none. */
  titles: ExportTitle[];
  /** The project's cues, in timeline frames. The builder offsets and clips them to range. */
  subtitles: SubtitleCue[];
  subtitleStyle: SubtitleStyle;
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
  /**
   * CREATIVE §4.3. Things the build had to change about what the user authored,
   * and could honour only in part — a cross dissolve with no source handle left,
   * exported as a fade. Set on the FIRST event a job emits after the graph is
   * built, which in practice is `phase: 'encoding'`, and not repeated.
   *
   * Distinct from `message`, which belongs to `phase: 'error'` and means the
   * export did not happen. A notice means the export DID happen and is not quite
   * the edit — which is the only kind of discrepancy this project is willing to
   * ship, and only because it is stated. Without this field §4.3's promise that
   * the build "reports it once in the notice channel" was a promise the contract
   * could not keep, and the message reached a `console.warn` nobody reads.
   *
   * Optional, and absent rather than `[]` when there is nothing to say: an empty
   * array would render as an empty region in a dialog that branches on presence.
   */
  notices?: string[];
}

/**
 * CREATIVE §6.5. A discriminated union rather than
 * `{ ok, text?, path?, reason? }`, for the reason `UpdatePhase` is one: the
 * failure arms carry no text and the success arm carries no reason, and a flat
 * shape would make every consumer test a field the type says might be there in
 * a case where it never is.
 *
 * Deliberately NOT `OpenResult`. That type carries a `ProjectFile` this has no
 * use for and a `bad-format` code that CANNOT occur here — `parseSrt` is
 * tolerant by contract (§6.2), so an unintelligible file yields zero cues, not
 * an error. Reusing it would oblige every caller to handle an arm that is
 * unreachable, which is how an unreachable arm eventually gets reached.
 *
 * `text` is the file's bytes decoded as UTF-8 **verbatim, BOM included**. Main
 * does not strip it: §6.2 documents `parseSrt` as tolerant of a BOM and that
 * tolerance is tested, so stripping it in main would put a second, untested
 * normaliser in front of the tested one — and the two would drift.
 */
export type SubtitleImportResult =
  | { ok: true; text: string; path: string }
  | { ok: false; reason: 'cancelled' | 'read-failed' };

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

/* ---- the build, and what a bug report needs — RELEASE.md §2.2 ----------- */

/** Everything a bug report needs, computed once in main, delivered synchronously. */
export interface AppBuild {
  /** package.json "version" via app.getVersion(). Semver, no leading 'v'. */
  version: string;
  /** process.versions.electron */
  electron: string;
  /** process.versions.chrome */
  chromium: string;
  /** os.release() — '10.0.26200' on win32. */
  os: string;
  /** process.arch — 'x64'. */
  arch: string;
  /** app.isPackaged. False under `npm run dev`; the fixture bridge reports false too. */
  packaged: boolean;
}

/* ---- auto-update — RELEASE.md §1.11 ------------------------------------- */

/**
 * One state machine, pushed whole on every transition. A discriminated union
 * rather than a phase plus optional fields, for the same reason ExportRequest's
 * codec is one widened union: the alternative admits illegal combinations that
 * every consumer then has to reject.
 *
 * NO manual/automatic discriminator, DELIBERATELY. `checking`, `current` and
 * `failed` are pushed ONLY for a check the user started; an automatic check that
 * finds nothing or fails pushes nothing at all and leaves the phase where it was
 * (RELEASE.md §1.5). The distinction lives in the transport rather than in the
 * type, so there is no field a consumer can forget to branch on. The only phase
 * an automatic check can push is `available`.
 */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string; notesUrl: string | null }
  | { kind: 'downloading'; version: string; percent: number } // 0..100, integer
  | { kind: 'ready'; version: string; notesUrl: string | null }
  | { kind: 'failed'; at: 'check' | 'download'; message: string; retryable: boolean };

export interface UpdateBridge {
  /** Pushed on every transition. Returns its own unsubscribe. */
  onPhase(cb: (p: UpdatePhase) => void): () => void;
  /** The phase right now, so the strip renders correctly on its first paint
   *  rather than after the next transition. */
  current(): Promise<UpdatePhase>;
  /** Manual check. Never throws; failures arrive as a 'failed' phase. */
  check(): void;
  download(): void;
  /** Cancels the in-flight download through the CancellationToken main is
   *  holding (§1.5) — there is no other way to stop electron-updater. Returns
   *  the phase to 'available', not 'idle': the update is still available, the
   *  Download button must stay pressable, and the row keeps its height. */
  cancelDownload(): void;
  /** Routes through electron/main.ts's requestInstallAndRestart — §1.8. */
  installAndRestart(): void;
  /** 'Not now' / 'Later' / 'Dismiss'. Returns the phase to 'idle' for THIS
   *  SESSION only; a downloaded update is not deleted and is offered again on
   *  the next launch. */
  dismiss(): void;
}

/* ---- the splash — RELEASE.md §3.10 -------------------------------------- */

/** What main pushes to the splash. `label: null` means draw nothing at all. */
export interface SplashStatus {
  label: string | null;
  /** Phases settled so far. */
  done: number;
  /** Phases this launch will run. Fixed before the splash can be shown (§3.4). */
  total: number;
}

/** Exposed on the SPLASH window only, by electron/splash-preload.ts.
 *  It is deliberately NOT part of EditorAPI: the splash gets the smallest
 *  surface that does its job, and the editor's bridge has no business being
 *  reachable from a window with no user in it. */
export interface SplashAPI {
  build: AppBuild;
  onStatus(cb: (s: SplashStatus) => void): () => void;
  /** The splash telling main it has painted and its fonts have settled (§3.7).
   *  This is condition 2 of §3.4's show rule — not the splash window's own
   *  ready-to-show, which is only that condition's timed fallback. */
  ready(): void;
}

export interface EditorAPI {
  platform: 'win32' | 'darwin' | 'linux';
  /** Constant for the life of the process. Never a promise — see RELEASE.md §2.2. */
  build: AppBuild;
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
     * CREATIVE §6.5 — pick and read a .srt through the NATIVE dialog. Returns
     * the file's text; PARSING stays in the renderer, because `parseSrt` needs
     * the project `fps` to round cue times to whole frames (§6.2) and `fps`
     * lives in the store.
     *
     * Optional for the reason every other capability on this bridge is: the
     * stub bridge the browser dev target runs against does not implement it,
     * and a required member would make that a type error rather than a missing
     * menu item.
     */
    importSubtitles?(): Promise<SubtitleImportResult>;
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

    /**
     * CREATIVE §6.4. Raises a save picker and writes `text` verbatim, UTF-8 with
     * no BOM. The renderer has already produced the SubRip with `formatSrt`, so
     * main writes bytes and does not know what SubRip is — the same division
     * `project.save` uses.
     *
     * OPTIONAL, like every other bridge added after the fixture was written, so
     * `src/dev/fixtures.ts` needs no change and `dev:web` keeps working. The menu
     * item feature-detects it.
     */
    exportSubtitles?(text: string, suggestedName: string): Promise<SaveResult>;
  };
  /**
   * PRESENT in Electron once electron/ipc/export.ts lands. Absent under dev:web,
   * where ExportDialog falls back to exportStub.
   */
  export?: ExportBridge;
  /**
   * PRESENT only when a feed is configured (RELEASE.md §1.3). Absent under
   * dev:web and in every build that ships without a publish target — which is
   * how it ships today. Every call site feature-detects. How preload decides is
   * RELEASE.md §1.11: main carries the answer in `additionalArguments`.
   */
  update?: UpdateBridge;
}

declare global {
  interface Window {
    editorAPI?: EditorAPI;
    /** The splash window only. Absent in the editor window and under dev:web. */
    splashAPI?: SplashAPI;
  }
}
