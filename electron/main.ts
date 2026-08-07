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

import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CH } from '../src/types/api';
import { describeFfmpegResolution } from './ffmpeg';
import { registerExportIpc } from './ipc/export';
import { registerMediaIpc } from './ipc/media';
import { registerProjectIpc } from './ipc/project';

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

function createWindow(): BrowserWindow {
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
