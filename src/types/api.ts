/* ---------------------------------------------------------------------------
   api.ts — the window.editorAPI contract. PLAN §4.

   Compiled into BOTH the renderer bundle and dist-electron (PLAN §1.2), so it
   must contain no React, no DOM-only runtime and no node import. `CH` is a
   VALUE export: main and preload import it rather than retyping a channel
   string, which is what stops the two from drifting.
--------------------------------------------------------------------------- */

import type { Frames, MediaError, MediaKind, ProjectFile } from './model';

export const CH = {
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize-toggle',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaxChanged: 'window:maximize-changed', // main -> renderer
  mediaPick: 'media:pick',
  mediaProbe: 'media:probe',
  mediaProbeProgress: 'media:probe-progress', // main -> renderer
  projectSave: 'project:save',
  projectOpen: 'project:open',
  projectPickDir: 'project:pick-directory',
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

export interface ExportProgressEvent {
  jobId: string;
  phase: 'preparing' | 'encoding' | 'finalizing' | 'done' | 'cancelled' | 'error';
  /** 0..1, monotonic within a phase. */
  progress: number;
  framesDone: number;
  framesTotal: number;
  /** Required when phase === 'error'. */
  message?: string;
}

export interface ExportBridge {
  /**
   * The DIALOG resolves `range` into absolute frames before calling. A real ffmpeg-backed
   * bridge cannot know where an in/out range begins otherwise, and the stub and the real
   * bridge must be interchangeable.
   */
  start(
    req: ExportSettings & { startFrame: Frames; durationFrames: Frames },
  ): Promise<{ jobId: string }>;
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
    open(): Promise<OpenResult>;
    pickDirectory(): Promise<string | null>;
  };
  /** ABSENT in this build. ExportDialog falls back to the local stub. See PLAN §8.9. */
  export?: ExportBridge;
}

declare global {
  interface Window {
    editorAPI?: EditorAPI;
  }
}
