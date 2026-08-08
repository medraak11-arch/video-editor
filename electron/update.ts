/* ---------------------------------------------------------------------------
   electron/update.ts — auto-update. docs/RELEASE.md §1.

   SILENT BY DEFAULT, AND THAT IS A STRUCTURAL PROPERTY RATHER THAN A SETTING.
   The build that ships today has no feed, so updateFeedConfigured() is false,
   registerUpdate() returns on its first line, and electron-updater is never
   imported: no network request, no timer, no listener, no IPC handler, no
   pixel. Nothing is "disabled" — nothing exists.

   The endpoint lives in exactly one place: electron-builder.yml's `publish:`
   key, which the packager turns into resources/app-update.yml. There is no
   constant in TypeScript, no .env and no second copy. VE_UPDATE_FEED is a
   testing override only — packaged builds only, https:// only.

   THE ONLY CALL TO quitAndInstall IN THIS APPLICATION IS runUpdateInstaller(),
   at the bottom of this file, and its only sanctioned caller is
   electron/main.ts's approveAndClose — which has already been through the
   unsaved-changes guard. Ask first, install second, always.

   The `./main` import is a cycle. It is deliberate (§1.8): the entry point that
   ends this process for an install has to be the one that owns the guard, and
   every access below happens inside a function, long after both modules have
   finished loading.
--------------------------------------------------------------------------- */

import { BrowserWindow, app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CH } from '../src/types/api';
import type { UpdatePhase } from '../src/types/api';
import { requestInstallAndRestart } from './main';

const UPDATE_FIRST_CHECK_MS = 10 * 60_000; // 10 minutes after registerUpdate()
const UPDATE_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours
const UPDATE_CHECK_FAILURE_LIMIT = 2; // consecutive automatic failures
/** `download-progress` fires many times a second and the numeral has to be
 *  readable rather than flickering. One push per interval, plus one at 100 %. */
const PROGRESS_PUSH_MS = 500;

const FEED_ENV = 'VE_UPDATE_FEED';

/* ============================================================== the gate ===
   Four conditions, all of which must hold. Condition 3 is what makes the
   default silent, and it is a filesystem fact rather than a flag, so it cannot
   be got wrong by a build that forgot to set something.                      */

/** The whole of condition 4. `js-yaml` is a packaging entry (§1.11), NOT an
 *  import this file is permitted to make: the check runs BEFORE the lazy
 *  import, so there is no YAML parser in scope and there is not permitted to be
 *  one. app-update.yml is a flat file of four or five scalar keys written by
 *  electron-builder and never by a human, and this is a single-key lookup. */
const GENERIC_URL = /^\s*url:\s*(\S+)\s*$/m;

/** True when the yml declares no generic url, or declares one that is https://. */
function feedUrlIsSafe(ymlText: string): boolean {
  const m = GENERIC_URL.exec(ymlText);
  return m === null || m[1].startsWith('https://');
}

let cached: boolean | null = null;

/**
 * Whether this build can update AT ALL. Every other function in this module is
 * unreachable when this returns false.
 *
 * MEMOISED: it is asked twice — once by registerUpdate() and once by
 * createWindow(), which needs the answer to decide whether the renderer's
 * preload gets an `update` member (§1.11) — and two filesystem reads that could
 * disagree would produce a menu item with no handler behind it.
 */
export function updateFeedConfigured(): boolean {
  if (cached === null) cached = computeFeedConfigured();
  return cached;
}

function computeFeedConfigured(): boolean {
  // 1. A dev run has no resources/app-update.yml and autoUpdater throws on it.
  if (!app.isPackaged) return false;
  // 2. A portable exe cannot be updated in place: the NSIS installer would
  //    install a SECOND, separate copy and the portable one would keep
  //    reporting the old version forever. electron-builder sets this variable
  //    in portable builds and nothing else does.
  if (process.env.PORTABLE_EXECUTABLE_FILE) return false;

  // 3 + 4. The override first, because it is the narrower statement. A feed
  //    that fails the https:// test does not warn, does not log and does not
  //    fall back: the whole feature ceases to exist, exactly as it does on a
  //    build with no feed at all.
  const override = process.env[FEED_ENV];
  if (override) return override.startsWith('https://');

  const yml = path.join(process.resourcesPath, 'app-update.yml');
  if (!existsSync(yml)) return false;
  try {
    return feedUrlIsSafe(readFileSync(yml, 'utf8'));
  } catch {
    return false;
  }
}

/* ============================================================== the logger ==
   The one startup-diagnostic channel this feature has, matching main.ts's
   `[ffmpeg]` line. A packaged build has no terminal, so when someone reports
   "it never finds an update" this is where the answer is. Deliberately NOT
   electron-log: that is a second dependency, a second log file and a probe on
   every launch, and §1.3's whole argument is that a feedless build pays
   nothing.                                                                   */

const veUpdateLogger = {
  info: (...a: unknown[]) => console.log('[update]', ...a),
  warn: (...a: unknown[]) => console.warn('[update]', ...a),
  error: (...a: unknown[]) => console.error('[update]', ...a),
  debug: () => undefined,
};

/* ======================================================= the phase machine == */

type Updater = import('electron-updater').AppUpdater;
type CancellationTokenCtor = typeof import('electron-updater').CancellationToken;

let updater: Updater | null = null;
let Cancellation: CancellationTokenCtor | null = null;
/** Non-null for exactly the length of one download. Cleared on EVERY terminal
 *  transition and nowhere else: a token that outlives its download is a Cancel
 *  press that silently kills the next one. */
let inFlight: InstanceType<CancellationTokenCtor> | null = null;
/** True between a Cancel press and the cancellation's own rejection. */
let cancelling = false;

let phase: UpdatePhase = { kind: 'idle' };
/** The version the current offer is about, held across `downloading`. */
let offered: { version: string; notesUrl: string | null } | null = null;

/** True for the length of a check the USER started. Silence is a property of
 *  the transport: main does not push `checking`, `current` or `failed` for an
 *  automatic check, so those three phases can only have come from a press and
 *  the renderer needs no rule to enforce (§1.5). */
let manual = false;
let checking = false;
let consecutiveFailures = 0;
let intervalTimer: NodeJS.Timeout | null = null;
let firstCheckTimer: NodeJS.Timeout | null = null;
let lastProgressPush = 0;

function setPhase(next: UpdatePhase): void {
  phase = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CH.updatePhase, next);
  }
}

/* ---- the closed table of failure strings (§1.6). One sentence, sentence
       case, no trailing period, safe to render verbatim. Never a URL, a path,
       an errno or a stack. ----------------------------------------------- */

function describeCheckFailure(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? '');
  if (/status code|\bhttp\b|\b40\d\b|\b50\d\b/i.test(text))
    return 'The update server answered with an error';
  if (/yaml|parse|unexpected token|invalid|malformed/i.test(text))
    return 'The update information could not be read';
  return 'The update server could not be reached';
}

function describeDownloadFailure(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return /sha512|checksum|hash/i.test(text)
    ? 'The downloaded file did not match its checksum'
    : 'The update could not be downloaded';
}

/* ---- the triggers (§1.5) ------------------------------------------------- */

function scheduleNext(): void {
  if (intervalTimer) clearTimeout(intervalTimer);
  intervalTimer = null;
  // The timer STOPS after two consecutive automatic failures, for the rest of
  // the session. A machine that is offline, behind a proxy or pointed at a dead
  // host does not get a network attempt every six hours forever. Two rather
  // than one for the same reason SAFETY §2.9 escalates at two: one failure is a
  // blip, two is a condition. A manual check re-arms it.
  if (consecutiveFailures >= UPDATE_CHECK_FAILURE_LIMIT) return;
  intervalTimer = setTimeout(() => void checkNow({ manual: false }), UPDATE_INTERVAL_MS);
}

async function checkNow(opts: { manual: boolean }): Promise<void> {
  if (!updater) return;

  // Nothing is scheduled while a check or a download is already in flight;
  // checkForUpdates() is not re-entrant, and electron-updater's own guard
  // returns the in-flight promise, which is easy to mistake for a second result.
  if (checking || inFlight) return;

  // An update already downloaded is not a question the server can answer
  // better. A manual press re-states the offer — which is what brings the strip
  // back after a Later — rather than starting a check that would discard it.
  if (phase.kind === 'downloading' || phase.kind === 'ready') {
    if (opts.manual) setPhase(phase);
    return;
  }

  manual = opts.manual;
  checking = true;
  if (opts.manual) {
    consecutiveFailures = 0;
    setPhase({ kind: 'checking' });
  }
  try {
    await updater.checkForUpdates();
  } catch {
    /* the 'error' listener already pushed whatever there was to push */
  } finally {
    checking = false;
    // A manual check re-arms the periodic timer, because a manual check is the
    // user saying the condition may have changed.
    scheduleNext();
  }
}

function download(): void {
  if (!updater || !Cancellation || inFlight) return; // one download at a time
  if (offered === null) return;
  cancelling = false;
  lastProgressPush = 0;
  inFlight = new Cancellation();
  setPhase({ kind: 'downloading', version: offered.version, percent: 0 });
  void updater.downloadUpdate(inFlight).catch(() => {
    // The cancellation's own rejection is a terminal transition and it is the
    // one that returns the row to `available` — not to `idle`. The update is
    // still available, Download must stay pressable, and `available` is the
    // same row height, so §1.7 commits it immediately.
    inFlight = null;
    if (!cancelling) return; // a real failure; the 'error' listener owns it
    cancelling = false;
    if (offered) setPhase({ kind: 'available', ...offered });
    else setPhase({ kind: 'idle' });
  });
}

/** electron-updater has NO post-hoc cancel. The only supported form is a
 *  CancellationToken constructed before the download and handed to it; a button
 *  wired to anything else either does nothing or lies. */
function cancelDownload(): void {
  if (!inFlight) return;
  cancelling = true;
  inFlight.cancel();
}

/** 'Not now' / 'Later' / 'Dismiss'. THIS SESSION only: a downloaded update is
 *  not deleted and is offered again on the next launch. */
function dismiss(): void {
  setPhase({ kind: 'idle' });
}

/* ============================================================ registration = */

/**
 * Called from app.whenReady(), after registerExportIpc and BEFORE
 * createWindow(). Returns immediately and does nothing at all when
 * updateFeedConfigured() is false — no import of electron-updater, no
 * ipcMain.handle, no setTimeout, no listener.
 *
 * It is `void`, it registers SYNCHRONOUSLY, and the lazy import happens beside
 * it rather than inside it. An `async` registrar would register the
 * `update:current` handler a microtask later than createWindow(), and the strip
 * invokes it on its first paint — which would reject with "No handler
 * registered for 'update:current'". Registering synchronously and arming
 * asynchronously keeps the gate's "nothing exists when the feed is absent"
 * property AND removes the race.
 */
export function registerUpdate(ipcMain: Electron.IpcMain): void {
  if (!updateFeedConfigured()) return;

  // 1. Every handler, registered NOW, synchronously. They close over the
  //    module-level `phase`, so they answer correctly whether or not the import
  //    below has landed.
  ipcMain.removeHandler(CH.updateCurrent);
  ipcMain.handle(CH.updateCurrent, () => phase);
  ipcMain.on(CH.updateCheck, () => void checkNow({ manual: true }));
  ipcMain.on(CH.updateDownload, () => download());
  ipcMain.on(CH.updateCancel, () => cancelDownload());
  ipcMain.on(CH.updateInstall, () => requestInstallAndRestart());
  ipcMain.on(CH.updateDismiss, () => dismiss());

  // 2. The import, the settings, the listeners and the timers, fire-and-forget.
  //    This is the ONE dynamic import in electron/**, and §1.3 is its reason.
  void (async () => {
    let mod: typeof import('electron-updater');
    try {
      mod = await import('electron-updater');
    } catch (err) {
      // An asar missing the dependency closure (§1.11). Reported to the log and
      // nowhere else: there is no UI path from here, and a feature that cannot
      // load is indistinguishable from the feature this build usually ships.
      veUpdateLogger.error('electron-updater could not be loaded', err);
      return;
    }
    const u = mod.autoUpdater;
    updater = u;
    Cancellation = mod.CancellationToken;

    u.autoDownload = false; // §1.6 — the user presses Download
    // THE SINGLE MOST IMPORTANT LINE IN THIS FEATURE. Its default is true, and
    // left at the default electron-updater installs a downloaded update on ANY
    // will-quit — including the quit that follows the unsaved-changes dialog,
    // and including a session-end shutdown. The user would be handed a
    // different version than the one they closed, with no press and no
    // question. With it false, the only path to an installer is §1.8.
    u.autoInstallOnAppQuit = false;
    u.allowPrerelease = false;
    u.allowDowngrade = false;
    u.forceDevUpdateConfig = false; // never synthesise a feed in dev
    u.logger = veUpdateLogger;

    const override = process.env[FEED_ENV];
    if (override) u.setFeedURL({ provider: 'generic', url: override, channel: 'latest' });

    u.on('update-available', (info) => {
      consecutiveFailures = 0;
      offered = { version: String(info.version), notesUrl: notesUrlOf(info.releaseNotes) };
      setPhase({ kind: 'available', ...offered });
    });

    u.on('update-not-available', (info) => {
      consecutiveFailures = 0;
      // An automatic check that finds nothing pushes NOTHING and leaves the
      // interface byte-identical to how it was.
      if (manual) setPhase({ kind: 'current', version: String(info.version) });
    });

    u.on('download-progress', (p) => {
      if (!offered) return;
      const percent = Math.max(0, Math.min(100, Math.round(p.percent)));
      const now = Date.now();
      if (percent < 100 && now - lastProgressPush < PROGRESS_PUSH_MS) return;
      lastProgressPush = now;
      setPhase({ kind: 'downloading', version: offered.version, percent });
    });

    u.on('update-downloaded', (info) => {
      inFlight = null;
      cancelling = false;
      offered = { version: String(info.version), notesUrl: notesUrlOf(info.releaseNotes) };
      setPhase({ kind: 'ready', version: offered.version, notesUrl: offered.notesUrl });
    });

    u.on('error', (err) => {
      const wasDownloading = inFlight !== null || phase.kind === 'downloading';
      inFlight = null;
      if (cancelling) return; // the download() catch owns the cancel transition
      if (wasDownloading) {
        setPhase({
          kind: 'failed',
          at: 'download',
          message: describeDownloadFailure(err),
          retryable: true,
        });
        return;
      }
      consecutiveFailures += 1;
      if (manual) {
        setPhase({ kind: 'failed', at: 'check', message: describeCheckFailure(err), retryable: true });
      }
    });

    // NEVER ON LAUNCH. A launch is the moment the user wants to be editing.
    firstCheckTimer = setTimeout(() => {
      firstCheckTimer = null;
      void checkNow({ manual: false });
    }, UPDATE_FIRST_CHECK_MS);
  })();
}

/** electron-updater types `releaseNotes` as string | ReleaseNoteInfo[] | null.
 *  Rendering markdown inside a 32px strip is not possible and expanding the
 *  strip to fit it turns it into the modal this design refuses, so the only
 *  thing carried across is a URL — and only an https:// one. */
function notesUrlOf(notes: unknown): string | null {
  if (typeof notes !== 'string') return null;
  const m = /https:\/\/[^\s"'<>)]+/.exec(notes);
  return m ? m[0] : null;
}

/* ========================================================== the one exit === */

/**
 * The ONLY call to autoUpdater.quitAndInstall in this application.
 * isSilent=false: the user sees the same installer they installed with.
 * isForceRunAfter=true: the app comes back up on the new version.
 *
 * A no-op when the feed is not configured, or when the lazy arm above has not
 * landed — unreachable from `ready`, but it is the honest guard. An
 * `installUpdate: true` that somehow reached a feedless build therefore closes
 * the window and does nothing else.
 */
export function runUpdateInstaller(): void {
  if (!updateFeedConfigured() || !updater) return;
  if (firstCheckTimer) clearTimeout(firstCheckTimer);
  if (intervalTimer) clearTimeout(intervalTimer);
  updater.quitAndInstall(false, true);
}
