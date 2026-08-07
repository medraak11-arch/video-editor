/* ---------------------------------------------------------------------------
   electron/main.ts — the main process. PLAN §1.1, §1.4, §8.12.

   Owns: the frameless BrowserWindow, the privileged ve-media:// scheme, the
   window-control channels, and the only child_process spawn in the app (which
   currently lives in electron/ipc/media.ts).

   Emits to dist-electron/electron/main.js, so __dirname at runtime is
   dist-electron/electron: preload.js is its sibling and the built renderer is
   two levels up.
--------------------------------------------------------------------------- */

import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CH } from '../src/types/api';
import { registerMediaIpc } from './ipc/media';
import { registerProjectIpc } from './ipc/project';

const MIN_WINDOW = { width: 1024, height: 640 };

/** The one URL builder. Stated once so main and electron/ipc/media.ts cannot drift. */
export const mediaUrlForPath = (abs: string): string =>
  `ve-media://file/${encodeURIComponent(abs)}`;

/* --------------------------------------------------------------- protocol
   Must run BEFORE app.whenReady(). `stream: true` is what makes <video>
   seekable; without it the element downloads the whole file before it plays. */

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
}

/* ------------------------------------------------------------------ boot */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    protocol.handle('ve-media', (request) => {
      try {
        const u = new URL(request.url); // ve-media://file/<encodeURIComponent(abs)>
        if (u.host !== 'file') return new Response(null, { status: 400 });
        const abs = decodeURIComponent(u.pathname.replace(/^\//, ''));
        if (!abs) return new Response(null, { status: 400 });
        return net.fetch(pathToFileURL(abs).toString()); // supports Range, so <video> can seek
      } catch {
        return new Response(null, { status: 400 });
      }
    });

    registerWindowIpc();
    registerMediaIpc(ipcMain);
    registerProjectIpc(ipcMain);

    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
