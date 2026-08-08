/* ---------------------------------------------------------------------------
   electron/main.ts — the main process. PLAN §1.1, §1.4, §8.12.

   Owns: the frameless BrowserWindow, the privileged ve-media:// scheme, the
   window-control channels, the .veproj handoff from the OS, and the only
   child_process spawn in the app (which currently lives in
   electron/ipc/media.ts).

   Emits to dist-electron/electron/main.js, so __dirname at runtime is
   dist-electron/electron: preload.js is its sibling and the built renderer is
   two levels up.
--------------------------------------------------------------------------- */

import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CH } from '../src/types/api';
import type { CloseSaveResolution, ProjectStateReport } from '../src/types/api';
import { describeFfmpegResolution } from './ffmpeg';
import { registerExportIpc } from './ipc/export';
import { registerMediaIpc } from './ipc/media';
import {
  beginDecision,
  endDecision,
  hasLiveSnapshot,
  isDecisionInFlight,
  registerProjectIpc,
  retireAutosaveSync,
  unsavedQuestion,
} from './ipc/project';

const MIN_WINDOW = { width: 1024, height: 640 };

/** The one URL builder. Stated once so main and electron/ipc/media.ts cannot drift. */
export const mediaUrlForPath = (abs: string): string =>
  `ve-media://file/${encodeURIComponent(abs)}`;

/* --------------------------------------------------------------- protocol
   Must run BEFORE app.whenReady(). `stream: true` is what makes <video>
   seekable; without it the element downloads the whole file before it plays.

   `stream: true` is necessary and NOT sufficient. Chromium decides a media
   resource is seekable from the RESPONSE: it needs `Accept-Ranges: bytes` and a
   real `206 Partial Content` when it asks for one. `net.fetch()` on a `file://`
   URL ignores the Range header and answers 200 with the whole file, so every
   source reported `video.seekable = [0, 0]`, every `currentTime` write clamped
   back to 0, and any clip with `mediaIn > 0` played from the head of its source
   instead of its in-point. The handler below serves the bytes itself.         */

protocol.registerSchemesAsPrivileged([
  {
    scheme: 've-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      bypassCSP: false,
    },
  },
]);

/**
 * Chromium picks a demuxer from the Content-Type before it sniffs, so a wrong or
 * missing type on an otherwise healthy file reads to the user as an undecodable
 * source. Extensions the importer accepts, and nothing else.
 */
const MEDIA_MIME: Readonly<Record<string, string>> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', ogv: 'video/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  aiff: 'audio/aiff', aif: 'audio/aiff', mka: 'audio/x-matroska', caf: 'audio/x-caf',
  wma: 'audio/x-ms-wma',
};

const mimeForPath = (abs: string): string => {
  const ext = path.extname(abs).slice(1).toLowerCase();
  return MEDIA_MIME[ext] ?? 'application/octet-stream';
};

/** `bytes=<first>-<last>`, the only form Chromium's media stack sends. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  // `bytes=-N` is the last N bytes; the media stack uses it to find a trailing moov atom.
  let start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  let end = rawStart === '' || rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  start = Math.max(0, start);
  return { start, end };
}

/**
 * One local file, served with Range support so `<video>` reports itself seekable.
 * A 416 rather than a clamp on an unsatisfiable range: silently answering a
 * different range than the one asked for corrupts the demuxer's view of the file.
 */
async function serveMediaFile(abs: string, request: Request): Promise<Response> {
  let size: number;
  try {
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile()) return new Response(null, { status: 404 });
    size = stat.size;
  } catch {
    return new Response(null, { status: 404 });
  }

  const type = mimeForPath(abs);
  const range = parseRange(request.headers.get('Range'), size);

  if (request.headers.get('Range') !== null && range === null) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(size === 0 ? 0 : end - start + 1),
    'Cache-Control': 'no-store',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

  const status = range ? 206 : 200;
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers });

  const stream = fs.createReadStream(abs, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
}

let mainWindow: BrowserWindow | null = null;

/* ======================================================== the close guard ===
   SAFETY.md §1. `win.on('close')` is SYNCHRONOUS — preventDefault() must be
   called during that tick, and main cannot read the renderer's zustand store.
   So the renderer mirrors three facts here whenever they change and main
   answers from the mirror with no round trip.

   The mirror starts clean, so a renderer that dies before its first push closes
   without a prompt — which is right, because a renderer that never reported
   dirty never told us it had anything.

   NOT DELIVERED, and stated rather than faked: electron/ipc/export.ts does not
   export `hasActiveExport` / `stopExportsSync` / `holdExportsThroughQuit`
   (SAFETY §9.3), so `exporting` is false everywhere below. Per §1.7's stated
   degradation the export question is never asked, no dialog string promises a
   removal we cannot perform, and a running export dies on close exactly as it
   does today. Wiring those three exports turns the feature on with no other
   change to the shape of this block.                                          */

let projectState: ProjectStateReport = {
  isDirty: false,
  projectName: 'Untitled',
  hasPath: false,
};

/** Approval is per WINDOW, never per process: on darwin `activate` builds a
 *  second window in the same process, and a process-wide boolean would let that
 *  window inherit the first one's approval and close a dirty project silently. */
const closeApproved = new WeakSet<BrowserWindow>();
let quitApproved = false; // reset on the first line of createWindow()
let sessionEnding = false; // the OS is shutting us down — never prompt (§1.8)

const CLOSE_SAVE_WATCHDOG_MS = 60_000;

const saveWaiters = new Map<string, (o: CloseSaveResolution) => void>();

const isProjectStateReport = (v: unknown): v is ProjectStateReport =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as ProjectStateReport).isDirty === 'boolean' &&
  typeof (v as ProjectStateReport).projectName === 'string' &&
  typeof (v as ProjectStateReport).hasPath === 'boolean';

const unresponsiveQuestion = (crashed: boolean): Electron.MessageBoxOptions => ({
  type: 'warning',
  noLink: true,
  title: 'Video Editor',
  // A crashed renderer gets Cancel, not 'Keep waiting': there is nothing to wait
  // for, and a 'Keep waiting' that re-raises the same dialog is a loop.
  buttons: crashed ? ['Close without saving', 'Cancel'] : ['Close without saving', 'Keep waiting'],
  defaultId: 1,
  cancelId: 1,
  message: crashed ? 'The editor has stopped running.' : 'The editor is not responding.',
  detail: hasLiveSnapshot()
    ? 'Its unsaved changes cannot be written. Changes since the last automatic snapshot are lost; the snapshot is kept and offered back the next time the app starts.'
    : 'Its unsaved changes cannot be written. Closing now loses them.',
});

/**
 * Two ways in, one dialog, and the primary button ALWAYS closes the window —
 * that is what makes it impossible for a crashed renderer to produce a window
 * that cannot be closed.
 */
async function watchdog(
  win: BrowserWindow,
  settle: (o: CloseSaveResolution) => void,
  how: { crashed: boolean },
): Promise<void> {
  if (win.isDestroyed()) return settle('abandon');
  let response: number;
  try {
    ({ response } = await dialog.showMessageBox(win, unresponsiveQuestion(how.crashed)));
  } catch {
    // The dialog could not be raised at all — the window is going or gone. Settle
    // rather than leave requestRendererSave pending forever, which would hold the
    // decision mutex and make the window unclosable.
    return settle('abandon');
  }
  if (response === 0) return settle('abandon'); // Close without saving
  if (how.crashed) return settle('cancelled'); // Cancel — abort, the window stays
  // 'Keep waiting' on a merely wedged renderer: re-arm and let it try again.
  setTimeout(() => void watchdog(win, settle, how), CLOSE_SAVE_WATCHDOG_MS);
}

/**
 * The save must be performed BY THE RENDERER — serializeProject(readStore())
 * needs the store. ipcMain has no invoke toward a renderer, so this is a message
 * plus a correlated reply.
 */
function requestRendererSave(win: BrowserWindow): Promise<CloseSaveResolution> {
  if (win.isDestroyed()) return Promise.resolve('abandon');
  return new Promise((resolve) => {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let timer: NodeJS.Timeout | null = null;
    const settle = (o: CloseSaveResolution) => {
      if (timer) clearTimeout(timer);
      saveWaiters.delete(token);
      resolve(o);
    };
    saveWaiters.set(token, settle);

    // A crashed renderer will never reply, so do not arm a 60-second timer to
    // discover something already known. Ask immediately.
    if (win.webContents.isCrashed()) return void watchdog(win, settle, { crashed: true });

    timer = setTimeout(() => void watchdog(win, settle, { crashed: false }), CLOSE_SAVE_WATCHDOG_MS);
    win.webContents.send(CH.appSaveRequest, token);
  });
}

interface CloseApproval {
  /** Re-issue app.quit() after the window goes. Set only on the before-quit path. */
  reissueQuit: boolean;
  /** Delete this session's snapshot. FALSE on every 'abandon'. */
  retireSnapshot: boolean;
}

/**
 * `win.close()` is the last thing that can be skipped, and nothing before it is
 * allowed to throw past this function: `closeApproved` is already set by then,
 * so a throw would leave a window that ignored the X AND whose next X press
 * closes instantly with no prompt.
 */
function approveAndClose(win: BrowserWindow, a: CloseApproval): void {
  closeApproved.add(win);
  quitApproved = true;
  try {
    if (a.retireSnapshot) retireAutosaveSync();
  } catch {
    /* Hygiene is never a reason to fail a close. retireAutosaveSync already
       swallows its own errors; this is the second layer, because a close that
       silently does nothing is the worst outcome in SAFETY.md. */
  }
  if (!win.isDestroyed()) win.close();
  if (a.reissueQuit) app.quit();
}

async function resolveCloseIntent(
  win: BrowserWindow,
  entry: { reissueQuit: boolean },
): Promise<void> {
  if (!beginDecision()) return; // the open guard, or a previous close, owns the dialog
  try {
    const go = (retireSnapshot: boolean) => approveAndClose(win, { ...entry, retireSnapshot });
    if (!projectState.isDirty) return go(true);

    let response: number;
    try {
      ({ response } = await dialog.showMessageBox(
        win,
        unsavedQuestion(projectState, false, 'close'),
      ));
    } catch {
      // The question could not be put. Aborting is the only safe answer: nothing
      // was decided, the preventDefault stands, and the next X asks again.
      return;
    }
    if (response === 2) return; // Cancel genuinely aborts: no approval, the preventDefault stands
    if (response === 1) return go(true); // Do not save — an explicit discard, so the snapshot goes too
    // response === 0 — Save.
    const outcome = await requestRendererSave(win);
    if (outcome === 'saved') return go(true);
    // 'abandon' is the watchdog's: the user chose "close this broken window",
    // not "throw this work away", so the snapshot is KEPT and offered next launch.
    if (outcome === 'abandon') return go(false);
    // 'cancelled' — they declined to name the file; closing anyway would destroy
    // exactly the work they declined to discard. 'failed' — the InlineNotice in
    // the titlebar already says why, and it is readable because the window stays.
    return;
  } finally {
    endDecision();
  }
}

function registerCloseGuard(): void {
  ipcMain.on(CH.appProjectState, (_event, report: unknown) => {
    if (!isProjectStateReport(report)) return;
    projectState = report;
  });

  ipcMain.on(CH.appSaveResult, (_event, token: unknown, outcome: unknown) => {
    if (typeof token !== 'string') return;
    const settle = saveWaiters.get(token);
    if (!settle) return;
    saveWaiters.delete(token);
    // Narrowed to the renderer's three. A message claiming 'abandon' is treated
    // as 'failed'; the decision to close without saving is the user's, made in a
    // dialog main drew.
    settle(outcome === 'saved' || outcome === 'cancelled' ? outcome : 'failed');
  });

  // Registered BEFORE registerExportIpc so this listener runs first: Node's
  // EventEmitter runs every before-quit listener regardless of preventDefault().
  app.on('before-quit', (event) => {
    if (quitApproved) return;
    const win = mainWindow;
    if (!win || win.isDestroyed()) {
      quitApproved = true;
      return;
    }
    if (!projectState.isDirty) {
      quitApproved = true;
      return;
    }
    event.preventDefault();
    if (!isDecisionInFlight()) void resolveCloseIntent(win, { reissueQuit: true });
  });

}

/**
 * Windows gives an application a few seconds at logoff and kills it if it
 * blocks. Prompting there is futile and hostile: the user is looking at a
 * shutdown screen, not at our window. The guarantee at shutdown is the autosave
 * snapshot and nothing else, which is why nothing is retired on this path.
 *
 * SAFETY §1.8 writes this as `app.on('session-end')`; Electron declares the
 * event on BaseWindow/BrowserWindow only (win32), so it is registered per window.
 */
function handleSessionEnd(win: BrowserWindow): void {
  sessionEnding = true;
  // WM_ENDSESSION is not guaranteed to arrive before the WM_CLOSE that raised
  // our dialog. If a decision is outstanding when it lands, stop asking and let
  // the window go: a window that cannot be closed is worse than twenty seconds
  // of lost editing, and the snapshot covers those twenty seconds. The pending
  // dialog's promise resolves afterwards into a resolveCloseIntent whose every
  // remaining branch is isDestroyed()-guarded, so it does nothing.
  if (!win.isDestroyed() && isDecisionInFlight()) {
    approveAndClose(win, { reissueQuit: false, retireSnapshot: false });
  }
}

function createWindow(): BrowserWindow {
  quitApproved = false; // approval never outlives the window that earned it
  const preload = path.join(__dirname, 'preload.js');

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#000000', // paint-flash guard only; never a UI colour
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // The app opens directly into the task: no entrance sequence, no flash.
  win.once('ready-to-show', () => win.show());

  const notifyMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send(CH.windowMaxChanged, win.isMaximized());
  };
  win.on('maximize', notifyMaximized);
  win.on('unmaximize', notifyMaximized);

  win.on('session-end', () => handleSessionEnd(win));

  // preventDefault() runs UNCONDITIONALLY on the undecided path, before any
  // await. That is the whole trick: the close is cancelled first and re-issued
  // later, so every subsequent step is free to be asynchronous.
  win.on('close', (event) => {
    if (closeApproved.has(win) || sessionEnding) return; // let it go
    event.preventDefault();
    if (isDecisionInFlight()) return; // a dialog already has focus; answer that one
    void resolveCloseIntent(win, { reissueQuit: false });
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Nothing in this app opens a second window or navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;

  // Defence in depth against losing the project to a stray file drop.
  // FileDropTarget calls preventDefault() on OS file drags, but it is a React
  // effect: if it ever fails to attach (an error boundary trips, the tree
  // unmounts mid-drop), the default action navigates this window to the dropped
  // file and the unsaved timeline goes with it. setWindowOpenHandler above only
  // covers NEW windows, not navigation of this one.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return; // reload of the current page
    if (devUrl && url.startsWith(devUrl)) return; // vite dev-server HMR reload
    event.preventDefault();
  });
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  return win;
}

/* ------------------------------------------------------ .veproj handoff
   Double-clicking a project in Explorer/Finder, or `Video Editor x.veproj`
   from a shell. Windows and Linux pass the path in argv — of the FIRST launch,
   or of a second launch that the single-instance lock folds into this one.
   darwin passes nothing in argv and fires `open-file` instead, which can fire
   before the app is ready.

   Main does not read the file: `migrateProject` lives in the renderer and is
   what decides whether a JSON file is a project at all (PLAN §2.6), so the
   path is handed over and `project.open(path)` does the rest — the same one
   open path Ctrl+O uses, with the same consequences for the current project. */

const VEPROJ = /\.veproj$/i;

/**
 * Scanned, never indexed by position: argv[1] is `.` under `electron .`, a
 * packaged build has no fixed offset, and Chromium's own switches can appear
 * anywhere. Flags are skipped so `--foo=bar.veproj` cannot be mistaken for a
 * file.
 */
function veprojFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    if (VEPROJ.test(arg)) return path.resolve(arg);
  }
  return null;
}

/** Held until a renderer says it is listening, so a launch-time file is never dropped. */
let pendingOpenPath: string | null = null;

function flushOpenRequest(wc: Electron.WebContents): void {
  if (pendingOpenPath === null || wc.isDestroyed()) return;
  const target = pendingOpenPath;
  pendingOpenPath = null;
  wc.send(CH.projectOpenPath, target);
}

function requestOpen(target: string | null): void {
  if (target === null) return;
  pendingOpenPath = target;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return; // the ready ping will collect it
  if (win.isMinimized()) win.restore();
  win.focus();
  // Mid-load, the renderer has not subscribed yet; its ping flushes this.
  if (!win.webContents.isLoading()) flushOpenRequest(win.webContents);
}

/* ------------------------------------------------------- window controls
   Registered here rather than in an ipc module because the shell agent needs
   these channels and does not own main.ts. */

function registerWindowIpc(): void {
  const target = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) =>
    BrowserWindow.fromWebContents(event.sender);

  ipcMain.on(CH.windowMinimize, (event) => target(event)?.minimize());

  ipcMain.on(CH.windowMaximize, (event) => {
    const win = target(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on(CH.windowClose, (event) => target(event)?.close());

  ipcMain.handle(CH.windowIsMaximized, (event) => target(event)?.isMaximized() ?? false);

  // The same channel in the other direction, carrying nothing: the renderer
  // saying "I am subscribed". It is what removes the race between the OS
  // handing over a file at launch and the window finishing its first load.
  ipcMain.on(CH.projectOpenPath, (event) => flushOpenRequest(event.sender));
}

/* ------------------------------------------------------------------ boot */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Registered before whenReady: on darwin a launch-by-double-click fires this
  // while the app is still starting, and a listener added later misses it.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (VEPROJ.test(filePath)) requestOpen(filePath);
  });

  app.on('second-instance', (_event, argv) => {
    // FIRST: a second launch can arrive while this one is still starting, and
    // `requestOpen` holds the path until a renderer exists to receive it.
    requestOpen(veprojFromArgv(argv));
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    protocol.handle('ve-media', async (request) => {
      try {
        const u = new URL(request.url); // ve-media://file/<encodeURIComponent(abs)>
        if (u.host !== 'file') return new Response(null, { status: 400 });
        const abs = decodeURIComponent(u.pathname.replace(/^\//, ''));
        if (!abs) return new Response(null, { status: 400 });
        return await serveMediaFile(abs, request);
      } catch {
        return new Response(null, { status: 400 });
      }
    });

    // The one startup line worth having. A packaged build has no terminal, so
    // when someone reports "it cannot read my files" this is where the answer is.
    console.log(`[ffmpeg] ${describeFfmpegResolution()}`);

    registerWindowIpc();
    registerMediaIpc(ipcMain);
    registerProjectIpc(ipcMain);
    // Before registerExportIpc: its killEverythingSync is also a before-quit
    // listener, and EventEmitter runs every listener regardless of
    // preventDefault(), so ours has to be listener 0 (SAFETY §1.8).
    registerCloseGuard();
    registerExportIpc(ipcMain);

    mainWindow = createWindow();
    // win32/linux only; on darwin this is null and `open-file` has already run.
    requestOpen(veprojFromArgv(process.argv));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
