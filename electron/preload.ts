/* ---------------------------------------------------------------------------
   electron/preload.ts — the contextBridge. PLAN §4.2.

   The ONLY module permitted to call webUtils. No logic, no fs, no
   child_process: every member is a one-line ipcRenderer.invoke / .send, or an
   .on wrapper that returns its own unsubscribe — with one stated exception,
   the argv-derived constants. `readBuild()` and the `--ve-update=1` switch read
   values main put in this process's own argv at window creation, which is what
   lets the version and the update capability be synchronous facts rather than
   an IPC round trip during preload (RELEASE.md §2.2, §1.11).

   Emits as CommonJS. With contextIsolation:true and sandbox:false, Electron
   loads the preload as CJS; an ESM preload fails silently, leaving
   window.editorAPI undefined and the app running in fixture mode INSIDE
   Electron — a failure that looks like a data bug.
--------------------------------------------------------------------------- */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CH } from '../src/types/api';
import type {
  AppBuild,
  AutosavePayload,
  AutosaveWriteResult,
  CloseSaveOutcome,
  DiscardChoice,
  DiscardQuestion,
  EditorAPI,
  ExportProgressEvent,
  ExportRequest,
  OpenResult,
  ProbeResult,
  ProjectStateReport,
  RecoveryOffer,
  RenameResult,
  SaveResult,
  SubtitleImportResult,
  UpdatePhase,
} from '../src/types/api';
import type { ProjectFile } from '../src/types/model';

/** Subscribes and hands back its own unsubscribe. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const platform = process.platform as EditorAPI['platform'];

const BUILD_ARG = '--ve-build=';
const UPDATE_ARG = '--ve-update=1';

/** Never throws. A malformed argument yields a build whose every field is
 *  'unknown', which is a visible, reportable state rather than a crash during
 *  preload — RELEASE.md §2.2. */
function readBuild(): AppBuild {
  const raw = process.argv.find((a) => a.startsWith(BUILD_ARG));
  try {
    if (raw) return JSON.parse(decodeURIComponent(raw.slice(BUILD_ARG.length))) as AppBuild;
  } catch {
    /* fall through */
  }
  return {
    version: 'unknown',
    electron: 'unknown',
    chromium: 'unknown',
    os: 'unknown',
    arch: 'unknown',
    packaged: false,
  };
}

const api: EditorAPI = {
  platform,
  build: readBuild(),

  window: {
    minimize: () => ipcRenderer.send(CH.windowMinimize),
    maximizeToggle: () => ipcRenderer.send(CH.windowMaximize),
    close: () => ipcRenderer.send(CH.windowClose),
    isMaximized: () => ipcRenderer.invoke(CH.windowIsMaximized) as Promise<boolean>,
    onMaximizeChange: (cb) => subscribe<boolean>(CH.windowMaxChanged, cb),
  },

  media: {
    pickFiles: () => ipcRenderer.invoke(CH.mediaPick) as Promise<string[]>,
    probe: (path: string) => ipcRenderer.invoke(CH.mediaProbe, path) as Promise<ProbeResult>,
    rename: (path: string, baseName: string) =>
      ipcRenderer.invoke(CH.mediaRename, path, baseName) as Promise<RenameResult>,
    reveal: (path: string) => ipcRenderer.send(CH.mediaReveal, path),
    onProbeProgress: (cb) =>
      subscribe<{ path: string; progress: number }>(CH.mediaProbeProgress, cb),
    /** Preload-only capability. There is no `(file as any).path` anywhere in this codebase. */
    pathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
  },

  project: {
    save: (project: ProjectFile, opts) =>
      ipcRenderer.invoke(CH.projectSave, project, opts ?? {}) as Promise<SaveResult>,
    open: (path) => ipcRenderer.invoke(CH.projectOpen, path ?? null) as Promise<OpenResult>,
    pickDirectory: () => ipcRenderer.invoke(CH.projectPickDir) as Promise<string | null>,
    /** CREATIVE §6.4. The renderer has already produced the SubRip; this passes
     *  bytes, exactly as `save` passes a serialised project. */
    exportSubtitles: (text: string, suggestedName: string) =>
      ipcRenderer.invoke(CH.subtitlesExport, text, suggestedName) as Promise<SaveResult>,
    /** CREATIVE §6.5. Returns the file's text; `parseSrt` runs in the renderer,
     *  which is the only side that has the project fps. */
    importSubtitles: () =>
      ipcRenderer.invoke(CH.subtitlesImport) as Promise<SubtitleImportResult>,
    onOpenRequest: (cb) => {
      const stop = subscribe<string>(CH.projectOpenPath, cb);
      // Tells main a listener exists. A .veproj the OS handed over at launch is
      // held until this ping, so it cannot arrive before the renderer subscribes.
      ipcRenderer.send(CH.projectOpenPath);
      return stop;
    },

    /* ---- data safety — SAFETY.md §9.2. No logic, no fs. ------------------ */

    reportState: (report: ProjectStateReport) => ipcRenderer.send(CH.appProjectState, report),
    onSaveRequest: (cb) => subscribe<string>(CH.appSaveRequest, cb),
    reportSaveResult: (token: string, outcome: CloseSaveOutcome) =>
      ipcRenderer.send(CH.appSaveResult, token, outcome),
    confirmDiscard: (q: DiscardQuestion) =>
      ipcRenderer.invoke(CH.appConfirmDiscard, q) as Promise<DiscardChoice>,
    autosaveWrite: (payload: AutosavePayload) =>
      ipcRenderer.invoke(CH.autosaveWrite, payload) as Promise<AutosaveWriteResult>,
    autosaveRecoverable: () =>
      ipcRenderer.invoke(CH.autosaveRecoverable) as Promise<RecoveryOffer | null>,
    autosaveRetire: (throughSeq: number) =>
      ipcRenderer.invoke(CH.autosaveRetire, throughSeq) as Promise<void>,
    autosaveResolveOffer: (id: string, how: 'restored' | 'discarded') =>
      ipcRenderer.invoke(CH.autosaveResolve, id, how) as Promise<void>,
  },

  // Adding this member is what flips `getEditorAPI().export ?? exportStub` to the
  // real ffmpeg bridge inside Electron. Under dev:web there is no preload, so the
  // member is absent and the dialog keeps falling back to its local stub.
  export: {
    start: (req: ExportRequest) =>
      ipcRenderer.invoke(CH.exportStart, req) as Promise<{ jobId: string }>,
    cancel: (jobId: string) => ipcRenderer.invoke(CH.exportCancel, jobId) as Promise<void>,
    onProgress: (cb) => subscribe<ExportProgressEvent>(CH.exportProgress, cb),
  },
};

// The one CONDITIONAL member in this file. `media.reveal` and `export` are
// absent only under dev:web, where there is no preload at all — a whole-bridge
// condition. This one is per-build: main decided it with updateFeedConfigured()
// and carried the answer here in argv, because preload has no fs and must not
// round-trip for a constant. A build with no feed never gets the member, so
// `getEditorAPI().update` is undefined and both §1.6 surfaces vanish.
if (process.argv.includes(UPDATE_ARG)) {
  api.update = {
    onPhase: (cb) => subscribe<UpdatePhase>(CH.updatePhase, cb),
    current: () => ipcRenderer.invoke(CH.updateCurrent) as Promise<UpdatePhase>,
    check: () => ipcRenderer.send(CH.updateCheck),
    download: () => ipcRenderer.send(CH.updateDownload),
    cancelDownload: () => ipcRenderer.send(CH.updateCancel),
    installAndRestart: () => ipcRenderer.send(CH.updateInstall),
    dismiss: () => ipcRenderer.send(CH.updateDismiss),
  };
}

contextBridge.exposeInMainWorld('editorAPI', api);
