/* ---------------------------------------------------------------------------
   electron/splash.ts — the start-up splash's window, phases and lifecycle.
   docs/RELEASE.md §3.4, §3.5, §3.9.

   THE SPLASH IS NOT AN ENTRANCE SEQUENCE. It does not animate, it is not held
   open for effect, and on a fast launch it is never composited at all. It
   exists only in the window of time where "the app opens directly into the
   task" was already going to be broken — by the machine, not by us — and it
   spends that window saying what the app is doing.

   Three mechanisms enforce that, and all three are in this file: the deferred
   show (SPLASH_SHOW_DELAY_MS), the status line that only appears once a phase
   has genuinely been in flight (SPLASH_STATUS_DELAY_MS), and the watchdog that
   makes it impossible for a frameless, unfocusable, taskbar-less window to
   outlive anything (SPLASH_MAX_MS).

   It imports appBuild()/BUILD_ARG from ./main. That is a cycle, and it is the
   same one RELEASE.md §1.8 already requires between main.ts and update.ts:
   every access happens inside a function, long after both modules have
   finished loading, so the partial exports object a CommonJS cycle hands back
   at require time is never read.
--------------------------------------------------------------------------- */

import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { CH } from '../src/types/api';
import type { SplashStatus } from '../src/types/api';
import { BUILD_ARG, appBuild } from './main';

/**
 * Delay before showing. 0 because the splash is now shown on EVERY launch.
 *
 * It was 250ms, gated so the splash only appeared once the launch was already
 * slow. That is the more principled behaviour and it is not what was asked for:
 * on this machine the splash was destroyed 342ms after spawn, before the delay
 * and the paint gate could both be met, so it was never composited even once.
 * A splash nobody ever sees is not a splash. The user asked for one that shows
 * the version, so it shows.
 */
const SPLASH_SHOW_DELAY_MS = 0;

/**
 * Once shown, stay up at least this long. Without a floor the splash appears and
 * vanishes inside a frame or two on a fast launch, which reads as a flicker
 * rather than as a splash — worse than not drawing it at all.
 *
 * This is a REAL cost: the main window is held for the remainder (see
 * splashHoldMs). It is the honest trade for having a splash on a machine with
 * nothing slow to report, and it is the only place in this app where something
 * is held open to be looked at.
 */
const SPLASH_MIN_VISIBLE_MS = 450;

/**
 * Hard ceiling on the whole splash wait, counted from the editor being ready.
 * The splash renderer can simply lose the paint race on a fast machine; without
 * a cap the editor would sit finished behind a window that never appeared.
 */
const SPLASH_SETTLE_CAP_MS = 1_800;
/** Do not draw a status LINE until a phase has actually been in flight this long. */
const SPLASH_STATUS_DELAY_MS = 400;
/** Hard ceiling. Past this the splash is destroyed and the main window is shown regardless. */
const SPLASH_MAX_MS = 20_000;
/** How long main waits for `splash:ready` after the splash window's own
 *  ready-to-show before treating the splash as ready anyway. */
const SPLASH_READY_FALLBACK_MS = 300;

export type SplashPhaseId = 'ffmpeg' | 'recovery' | 'editor';

/** Three, always three, decided before the splash can be shown so the
 *  denominator is honest. `recovery` is counted unconditionally rather than
 *  probed first: whether the autosave directory exists is not knowable until
 *  the readdir has already run, and a phase that settles instantly simply never
 *  reaches SPLASH_STATUS_DELAY_MS and is never named. */
const PHASE_TOTAL = 3;

const PHASE_LABEL: Readonly<Record<SplashPhaseId, string>> = {
  ffmpeg: 'Resolving ffmpeg',
  recovery: 'Checking for recovered work',
  editor: 'Preparing the editor',
};

let splash: BrowserWindow | null = null;
/** Overrides PHASE_LABEL.editor when the launch came from a double-clicked file. */
let editorLabel: string = PHASE_LABEL.editor;

/* ---- the three conditions of the deferred show (§3.4) ------------------- */
let delayElapsed = false;
/** When the splash was actually composited, or null if it never was. */
let shownAt: number | null = null;
let paintedAndSettled = false;

let showTimer: NodeJS.Timeout | null = null;
let readyFallbackTimer: NodeJS.Timeout | null = null;
let maxTimer: NodeJS.Timeout | null = null;

/* ---- phase state -------------------------------------------------------- */
let settled = 0;
let active: SplashPhaseId | null = null;
let statusTimer: NodeJS.Timeout | null = null;
/** True once the active phase has been in flight for SPLASH_STATUS_DELAY_MS. */
let statusVisible = false;

const clear = (t: NodeJS.Timeout | null): null => {
  if (t) clearTimeout(t);
  return null;
};

function currentStatus(): SplashStatus {
  const label =
    statusVisible && active !== null
      ? active === 'editor'
        ? editorLabel
        : PHASE_LABEL[active]
      : null;
  return { label, done: settled, total: PHASE_TOTAL };
}

function pushStatus(): void {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents.send(CH.splashStatus, currentStatus());
}

/**
 * The one place `splash.show()` is called. Does nothing unless the launch is
 * already known to be slow AND the splash has painted with its fonts settled.
 * The third condition — the editor is not ready yet — is enforced by
 * closeSplash(), which main calls from the main window's ready-to-show and
 * which nulls the reference below: once the editor has won, there is nothing
 * left here to show and the splash is destroyed having never been composited.
 */
function maybeShow(): void {
  if (!splash || splash.isDestroyed() || splash.isVisible()) return;
  if (!delayElapsed || !paintedAndSettled) return;
  splash.showInactive(); // never takes focus, and never steals the caret
  shownAt = Date.now();
  pushStatus();
}

/**
 * Resolves once the splash has been on screen for SPLASH_MIN_VISIBLE_MS, so it
 * is seen rather than flickering. main.ts awaits this before closing the splash
 * and showing the editor, which keeps the invariant that the two are never both
 * on screen.
 *
 * Two escapes, both necessary. If the splash was never created — no splash on
 * this launch — it resolves immediately and launch pays nothing. And the whole
 * wait is capped by SPLASH_SETTLE_CAP_MS: the splash renderer can lose the paint
 * race to the editor on a fast machine, and an uncapped wait for a paint that
 * may never come would hang the launch behind a decoration. The editor always
 * wins in the end.
 */
export function whenSplashSeen(): Promise<void> {
  if (!splash || splash.isDestroyed()) return Promise.resolve();

  const deadline = Date.now() + SPLASH_SETTLE_CAP_MS;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (!splash || splash.isDestroyed() || Date.now() >= deadline) return resolve();
      if (shownAt === null) return void setTimeout(tick, 25); // not painted yet
      const remaining = SPLASH_MIN_VISIBLE_MS - (Date.now() - shownAt);
      if (remaining <= 0) return resolve();
      setTimeout(tick, Math.min(remaining, 25));
    };
    tick();
  });
}

function onSplashReady(): void {
  paintedAndSettled = true;
  readyFallbackTimer = clear(readyFallbackTimer);
  pushStatus();
  maybeShow();
}

/**
 * The watchdog is not belt-and-braces. The splash is frameless, has no close
 * button, is not in the taskbar and cannot be focused: if loadFile fails or the
 * renderer never reaches ready-to-show, a naive implementation leaves a
 * rectangle the user cannot get rid of without Task Manager. It also fixes an
 * exposure main.ts already has — a renderer that never reaches ready-to-show
 * leaves an invisible window and an app with no UI at all.
 */
function watchdog(): void {
  const others = BrowserWindow.getAllWindows().filter((w) => w !== splash && !w.isDestroyed());
  closeSplash();
  for (const w of others) if (!w.isVisible()) w.show();
}

export function createSplash(launchProjectName: string | null): void {
  if (splash) return;
  editorLabel = launchProjectName === null ? PHASE_LABEL.editor : `Opening ${launchProjectName}`;

  const win = new BrowserWindow({
    width: 960,
    height: 560,
    show: false, // §3.4 — shown by a timer, or never
    frame: false,
    transparent: true, // the 10px card corners
    backgroundColor: '#00000000', // fully transparent; never a UI colour
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false, // never steals focus; also keeps it out of Alt-Tab on win32
    skipTaskbar: true,
    // A splash that floats above every other application asserts that this
    // launch matters more than what the user is currently doing. It does not.
    alwaysOnTop: false,
    // A native shadow on a transparent frameless window renders inconsistently
    // on Windows; the 1px keyline is what separates the card from the desktop.
    hasShadow: false,
    center: true,
    title: 'Video Editor',
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: [`${BUILD_ARG}${encodeURIComponent(JSON.stringify(appBuild()))}`],
    },
  });
  splash = win;

  ipcMain.on(CH.splashReady, onSplashReady);

  // Only condition 2's FALLBACK. ready-to-show means first paint is possible,
  // not that the fonts have settled — and a renderer that fails to boot must
  // not be able to hold the launch hostage.
  win.once('ready-to-show', () => {
    readyFallbackTimer = setTimeout(() => {
      paintedAndSettled = true;
      maybeShow();
    }, SPLASH_READY_FALLBACK_MS);
  });

  win.on('closed', () => {
    if (splash === win) splash = null;
  });

  showTimer = setTimeout(() => {
    delayElapsed = true;
    maybeShow();
  }, SPLASH_SHOW_DELAY_MS);

  maxTimer = setTimeout(watchdog, SPLASH_MAX_MS);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(`${devUrl}/splash.html`);
  else void win.loadFile(path.join(__dirname, '../../dist/splash.html'));
}

export function beginPhase(id: SplashPhaseId): void {
  if (!splash) return;
  active = id;
  statusVisible = false;
  statusTimer = clear(statusTimer);
  pushStatus(); // between phases the reserved block is empty
  statusTimer = setTimeout(() => {
    statusVisible = true;
    pushStatus();
  }, SPLASH_STATUS_DELAY_MS);
}

export function endPhase(id: SplashPhaseId): void {
  if (!splash) return;
  if (active !== id) return; // an end with no begin, or a stale one
  settled += 1;
  active = null;
  statusVisible = false;
  statusTimer = clear(statusTimer);
  pushStatus();
}

/**
 * Idempotent. destroy(), not close() — there is nothing to prompt about and a
 * splash must never be able to refuse. Safe on a window that was never shown,
 * and safe to call twice.
 *
 * Called from six places, and the list is exhaustive on purpose: the main
 * window's ready-to-show (before show(), so the two never overlap), the main
 * window's closed, render-process-gone, before-quit, the SPLASH_MAX_MS
 * watchdog, and maybeShow()'s own no-op once this has nulled the reference.
 */
export function closeSplash(): void {
  showTimer = clear(showTimer);
  readyFallbackTimer = clear(readyFallbackTimer);
  maxTimer = clear(maxTimer);
  statusTimer = clear(statusTimer);
  ipcMain.removeListener(CH.splashReady, onSplashReady);
  const win = splash;
  splash = null;
  shownAt = null;
  if (win && !win.isDestroyed()) win.destroy();
}
