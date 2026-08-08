/* ---------------------------------------------------------------------------
   electron/splash-preload.ts — the splash window's bridge. RELEASE.md §3.10.

   Deliberately NOT EditorAPI. The splash gets the smallest surface that does
   its job: the build payload it renders in its footer, one subscription, and
   one message back. The editor's bridge has no business being reachable from a
   window with no user in it.

   Emits as CommonJS, for the same reason electron/preload.ts does.
--------------------------------------------------------------------------- */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CH } from '../src/types/api';
import type { AppBuild, SplashAPI, SplashStatus } from '../src/types/api';

const BUILD_ARG = '--ve-build=';

/** Never throws. A malformed argument yields a build whose every field is
 *  'unknown', which is a visible, reportable state rather than a crash during
 *  preload. Identical to electron/preload.ts's — RELEASE.md §2.2. */
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

const api: SplashAPI = {
  build: readBuild(),
  onStatus: (cb) => {
    const listener = (_event: IpcRendererEvent, payload: SplashStatus) => cb(payload);
    ipcRenderer.on(CH.splashStatus, listener);
    return () => {
      ipcRenderer.removeListener(CH.splashStatus, listener);
    };
  },
  ready: () => ipcRenderer.send(CH.splashReady),
};

contextBridge.exposeInMainWorld('splashAPI', api);
