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
  mediaProbeProgress: 'media:probe-progress', // main -> renderer
  projectSave: 'project:save',
  projectOpen: 'project:open',
  projectPickDir: 'project:pick-directory',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportProgress: 'export:progress', // main -> renderer
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

export interface ExportSettings {
  /** WITHOUT extension; the container supplies it — see CONTAINER in PLAN §7.3. */
  filename: string;
  folder: string;
  width: number;
  height: number;
  fps: number;
  codec: 'h264' | 'h265' | 'prores';
  quality: 'draft' | 'good' | 'best';
  range: 'entire' | 'inout';
}

/* ---- export errors — EXPORT §4 ------------------------------------------ */

export type ExportErrorCode =
  | 'ffmpeg-missing'
  | 'invalid-filename'
  | 'empty-timeline'
  | 'source-missing'
  | 'unsupported-codec'
  | 'output-not-writable'
  | 'permission-denied'
  | 'disk-full'
  | 'output-in-use'
  | 'busy'
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
 * `hasAudio` is a property of the FILE, not of the edit: every dev-media fixture has an
 * audio stream even though its content is silence. Whether a clip is audible is decided
 * by `volume` and the track's `muted` flag (EXPORT §1.4), never by guessing from content.
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
     * what 'open recent', a .veproj handed over by the OS, and any automated
     * test of the open path all need. Omit it for the native picker.
     */
    open(path?: string): Promise<OpenResult>;
    pickDirectory(): Promise<string | null>;
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
