/* ---------------------------------------------------------------------------
   electron/ipc/project.ts — OWNER: inspector.

   Three channels and nothing else (PLAN §8.12): CH.projectSave, CH.projectOpen
   and CH.projectPickDir.

   Rules this file obeys without exception:
     · every invoke RESOLVES; nothing throws across the bridge. Failures come
       back as the { ok: false, error } branch of SaveResult / OpenResult;
     · .veproj, JSON, 2-space indent (PLAN §2.6);
     · open() hands back the RAW parsed object. `migrateProject` runs on the
       renderer side and is what decides whether a JSON file is a project at
       all — main only reports that the bytes would not parse;
     · CH is imported, never retyped;
     · the write is ATOMIC. A project is the only irreplaceable thing this app
       owns, and a plain writeFile onto the live path turns a full disk or a
       crash mid-write into a truncated file where a good project used to be.
       We write a sibling temp file and rename it over the target, which is a
       single filesystem operation on both NTFS and APFS;
     · both channels accept an optional PATH and only fall back to the native
       dialog when none is given. Save already worked that way; open now does
       too, which is what makes 'open recent', a file association, and any
       automated test of this file possible at all.
--------------------------------------------------------------------------- */

import { app, BrowserWindow, dialog } from 'electron';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { renameSync, rmSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CH } from '../../src/types/api';
import type {
  AutosavePayload,
  AutosaveSnapshot,
  AutosaveWriteResult,
  DiscardChoice,
  DiscardQuestion,
  OpenResult,
  ProjectStateReport,
  RecoveryOffer,
  SaveResult,
} from '../../src/types/api';
import type { ProjectFile } from '../../src/types/model';

const EXTENSION = 'veproj';
const FILTERS = [
  { name: 'Video editor project', extensions: [EXTENSION] },
  { name: 'All files', extensions: ['*'] },
];

const saveFailed = (
  code: 'cancelled' | 'io-failed',
  message: string,
): SaveResult => ({ ok: false, error: { code, message } });

const openFailed = (
  code: 'cancelled' | 'io-failed' | 'bad-format',
  message: string,
): OpenResult => ({ ok: false, error: { code, message } });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Save dialogs on some platforms return the typed name verbatim. */
const withExtension = (target: string): string =>
  path.extname(target).toLowerCase() === `.${EXTENSION}` ? target : `${target}.${EXTENSION}`;

function defaultName(project: Record<string, unknown>): string {
  const name = typeof project.name === 'string' && project.name.trim() !== ''
    ? project.name.trim()
    : 'Untitled';
  return withExtension(name.replace(/[\\/:*?"<>|]/g, '-'));
}

/** The optional first argument on both channels. '' is treated as absent. */
const requestedPath = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

const errnoOf = (e: unknown): string =>
  isObject(e) && typeof e.code === 'string' ? e.code : '';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------- the atomic write
   SAFETY.md §2.5. Both the .veproj and the autosave snapshot go through this.

   `rename` over an EXISTING destination is MoveFileEx(REPLACE_EXISTING) on
   Windows, and it fails EACCES/EPERM/EBUSY whenever anything holds the
   destination open — an antivirus scanner, an Explorer preview handler, the
   .veproj open in another editor. Node's rename performs no retries of its own.
   This is the same lesson `removeFile` in electron/ipc/export.ts already
   learned, with the same ~300 ms budget. */

async function renameWithRetry(from: string, to: string, attempts = 3): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      const code = errnoOf(e);
      const transient = code === 'EACCES' || code === 'EPERM' || code === 'EBUSY';
      if (!transient || i >= attempts) throw e;
      await delay(100);
    }
  }
}

/**
 * Temp → fsync → rename. The fsync is not optional: filesystems journal metadata
 * more eagerly than data, so without it a power cut immediately after the rename
 * can leave a correctly-named, correctly-timestamped, ZERO-LENGTH file — which
 * for a project is worse than no file, and for a snapshot is an offer to restore
 * garbage. The cost is one fsync per write.
 *
 * Throws on failure, having removed the scratch file. Callers map that to their
 * own { ok: false }; nothing throws across the bridge.
 */
async function writeFileAtomic(target: string, body: string): Promise<void> {
  const scratch = `${target}.${process.pid}.tmp`;
  try {
    const fh = await open(scratch, 'w');
    try {
      await fh.writeFile(body, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameWithRetry(scratch, target);
  } catch (e) {
    await unlink(scratch).catch(() => undefined);
    throw e;
  }
}

/**
 * One sentence the user can act on, sentence case, no trailing period — the
 * Notice contract (PLAN §7.6). 'Something went wrong' is not an error message.
 */
function writeFailureMessage(e: unknown, target: string): string {
  const file = path.basename(target);
  const folder = path.basename(path.dirname(target));
  switch (errnoOf(e)) {
    case 'ENOENT':
      return `The folder ${folder} no longer exists, so ${file} could not be saved`;
    case 'EISDIR':
    case 'ENOTDIR':
      return `${file} is a folder, so the project could not be saved there`;
    case 'EACCES':
    case 'EPERM':
      return `${file} is read-only or in use by another program`;
    case 'ENOSPC':
      return `There is not enough space on the disk to save ${file}`;
    case 'EROFS':
      return `${folder} is on a read-only disk`;
    case 'ENAMETOOLONG':
      return `That file name is too long to save`;
    default:
      return `${file} could not be written`;
  }
}

function readFailureMessage(e: unknown, target: string): string {
  const file = path.basename(target);
  switch (errnoOf(e)) {
    case 'ENOENT':
      return `${file} could not be found`;
    case 'EACCES':
    case 'EPERM':
      return `${file} could not be read — check its permissions`;
    case 'EISDIR':
      return `${file} is a folder, not a project file`;
    default:
      return `${file} could not be read`;
  }
}

/* ------------------------------------------------------------------- save */

async function saveProject(
  event: IpcMainInvokeEvent,
  project: unknown,
  opts: unknown,
): Promise<SaveResult> {
  if (!isObject(project)) {
    return saveFailed('io-failed', 'There was no project to write');
  }

  const options = isObject(opts) ? opts : {};
  const existingPath = requestedPath(options.path);
  const saveAs = options.saveAs === true;

  let target = existingPath;
  if (target === null || saveAs) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.SaveDialogOptions = {
      title: 'Save project',
      buttonLabel: 'Save',
      defaultPath: existingPath ?? defaultName(project),
      filters: FILTERS,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result = win
      ? await dialog.showSaveDialog(win, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
      return saveFailed('cancelled', 'Saving was cancelled');
    }
    target = withExtension(result.filePath);
  }

  let body: string;
  try {
    body = `${JSON.stringify(project, null, 2)}\n`;
  } catch {
    // A cycle or a BigInt in the payload. Better to say so than to leave a
    // half-written file where the project was.
    return saveFailed('io-failed', 'The project could not be encoded as JSON');
  }

  // Write beside the target, fsync it, then rename over it. Until the rename
  // lands the previous good file is untouched, so a full disk or a crash
  // mid-write costs the new edit, never the project.
  try {
    await writeFileAtomic(target, body);
  } catch (e) {
    return saveFailed('io-failed', writeFailureMessage(e, target));
  }

  // Retirement is NOT done here: it is the renderer that knows which write
  // sequence the save covers, and it calls CH.autosaveRetire after markSaved()
  // (SAFETY §2.6). Retiring from this handler would have to pass "everything",
  // which would also silence every LATER snapshot in the session.
  return { ok: true, path: target };
}

/* ------------------------------------------------------------------- open */

async function openProject(event: IpcMainInvokeEvent, wanted: unknown): Promise<OpenResult> {
  // A caller that already knows the path — 'open recent', a .veproj handed to
  // the app by the OS, a test — skips the picker entirely.
  let target = requestedPath(wanted);

  if (target === null) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Open project',
      buttonLabel: 'Open',
      properties: ['openFile'],
      filters: FILTERS,
    };

    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    target = result.canceled ? null : result.filePaths[0] ?? null;
    if (target === null) {
      return openFailed('cancelled', 'Opening was cancelled');
    }
  }

  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (e) {
    return openFailed('io-failed', readFailureMessage(e, target));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncated, half-flushed or overwritten by something else. Saying "damaged"
    // rather than "not a project" is the difference between the user restoring a
    // backup and the user assuming they picked the wrong file.
    return openFailed('bad-format', `${path.basename(target)} is damaged and could not be read`);
  }

  if (!isObject(parsed)) {
    return openFailed('bad-format', `${path.basename(target)} is not a video editor project`);
  }

  // The renderer runs migrateProject over this and is the one that validates it.
  return { ok: true, path: target, project: parsed as unknown as ProjectFile };
}

/* --------------------------------------------------------- pick directory */

/**
 * In flight, keyed by window. The dialog is window-modal, so a person cannot
 * click Browse twice — but the renderer can invoke twice (a double activation,
 * a repeated key, an automated caller), and each invoke raises its own dialog.
 * Two pickers over one window is a state nobody designed: whichever is answered
 * last silently wins. Second and later callers share the first one's answer.
 */
const directoryPickers = new Map<number, Promise<string | null>>();

async function pickDirectory(event: IpcMainInvokeEvent): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender);
  const key = win?.id ?? -1;

  const inFlight = directoryPickers.get(key);
  if (inFlight) return inFlight;

  const dialogOptions: Electron.OpenDialogOptions = {
    title: 'Choose an output folder',
    buttonLabel: 'Choose',
    properties: ['openDirectory', 'createDirectory'],
  };

  const pending = (async () => {
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  })();

  directoryPickers.set(key, pending);
  try {
    return await pending;
  } finally {
    directoryPickers.delete(key);
  }
}

/* ==================================================== the decision mutex ===
   SAFETY.md §1.4. The close guard (electron/main.ts) and the open guard
   (CH.appConfirmDiscard, below) both raise a WINDOW-MODAL native dialog on the
   same window. They are otherwise independent state machines, so without a
   shared flag `Ctrl+O` then `Alt+F4` stacks two of them, and answering the
   second runs a close against a renderer that may be mid-save.

   ONE owner, here, because this file already owns `unsavedQuestion`.           */

let decisionInFlight = false;

export const beginDecision = (): boolean => (decisionInFlight ? false : (decisionInFlight = true));
export const endDecision = (): void => {
  decisionInFlight = false;
};
export const isDecisionInFlight = (): boolean => decisionInFlight;

/* ------------------------------------------------------------ the question
   Native, not an in-app Dialog: the renderer may be tearing down or crashed
   exactly when unsaved work is most at risk, and window-modality, Enter/Escape,
   button order, focus containment and screen-reader labelling are the
   platform's rather than ours (SAFETY §1.2).

   `cancelId` is load-bearing: it maps Escape, the dialog's own close button and
   Alt+F4 on the dialog to Cancel. Without it, dismissing would fall through to
   response 0 and silently start a save the user never asked for. */

export function unsavedQuestion(
  s: ProjectStateReport,
  exporting: boolean,
  reason: 'close' | 'open',
): Electron.MessageBoxOptions {
  return {
    type: 'warning',
    noLink: true, // win32: real buttons, not command links
    title: 'Video Editor',
    buttons: ['Save', 'Do not save', 'Cancel'],
    defaultId: 0, // Enter saves
    cancelId: 2,
    message:
      reason === 'close'
        ? `Save changes to ${s.projectName} before closing?`
        : `Save changes to ${s.projectName} before opening another project?`,
    detail: [
      'If you do not save, your changes since the last save are lost.',
      s.hasPath ? null : 'This project has never been saved, so you will be asked where to put it.',
      // No removal clause: SAFETY §1.5 forbids promising that the partly written
      // file is removed until electron/ipc/export.ts exports stopExportsSync
      // (§9.3). Restore 'and its partly written file removed' with that export.
      exporting ? 'The export still running will be stopped.' : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n\n'),
  };
}

/* ========================================================== autosave =======
   SAFETY.md §2. THE RULE THAT OUTRANKS EVERY OTHER RULE HERE: autosave never
   writes to a path the user chose. Not projectPath, not a sibling of it, not a
   dotfile beside it, not a .bak. The only code in this application that may
   write a .veproj is saveProject above, reached only from an explicit save.    */

const SNAPSHOT_SUFFIX = '.veproj.autosave';
const TOMBSTONE_SUFFIX = '.veproj.discarded';
const TOMBSTONE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;

/** Minted once per main-process launch. Lexicographically sortable; carries the pid. */
const sessionId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${process.pid}`;

let autosaveDirCache: string | null = null;
/** Lazy because app.getPath('userData') is only meaningful once the app object exists. */
const autosaveDir = (): string => {
  autosaveDirCache ??= path.join(app.getPath('userData'), 'autosave');
  return autosaveDirCache;
};
const snapshotPath = (): string => path.join(autosaveDir(), `${sessionId}${SNAPSHOT_SUFFIX}`);

let lastRetiredSeq = 0;
let inFlightWrite: Promise<void> | null = null;
/** True while a snapshot for THIS session is on disk. Read by the §1.6 watchdog. */
let snapshotOnDisk = false;

export function hasLiveSnapshot(): boolean {
  return snapshotOnDisk;
}

/* ---- the write ---------------------------------------------------------- */

const validPayload = (v: unknown): v is AutosavePayload =>
  isObject(v) &&
  typeof v.seq === 'number' &&
  Number.isFinite(v.seq) &&
  isObject(v.project) &&
  typeof v.projectName === 'string' &&
  (typeof v.projectPath === 'string' || v.projectPath === null) &&
  (typeof v.lastExplicitSaveAt === 'string' || v.lastExplicitSaveAt === null);

async function autosaveWrite(payload: unknown): Promise<AutosaveWriteResult> {
  if (!validPayload(payload)) return { ok: false };
  // 1. On entry: a write the renderer dispatched before a retire must not
  //    recreate what the retire removed.
  if (payload.seq <= lastRetiredSeq) return { ok: true, skipped: true };

  const snapshot: AutosaveSnapshot = {
    ...payload,
    project: payload.project as ProjectFile,
    version: 1,
    sessionId,
    savedAt: new Date().toISOString(),
  };

  let body: string;
  try {
    body = `${JSON.stringify(snapshot, null, 2)}\n`;
  } catch {
    return { ok: false };
  }

  const target = snapshotPath();
  try {
    await mkdir(autosaveDir(), { recursive: true });
    const p = writeFileAtomic(target, body);
    inFlightWrite = p.then(
      () => undefined,
      () => undefined,
    );
    await p;
  } catch {
    return { ok: false };
  }

  // 2. After the rename. This is the check that closes the write/retire race:
  //    a snapshot resurrected after an explicit save would make the next launch
  //    offer to recover work the user already has.
  if (payload.seq <= lastRetiredSeq) {
    await rm(target, { force: true }).catch(() => undefined);
    return { ok: true, skipped: true };
  }

  snapshotOnDisk = true;
  return { ok: true, skipped: false, at: Date.now() };
}

/* ---- retirement --------------------------------------------------------- */

async function autosaveRetireInternal(throughSeq: number): Promise<void> {
  lastRetiredSeq = Math.max(lastRetiredSeq, throughSeq);
  // 3. Awaiting the in-flight write is what makes this promise mean "nothing is
  //    left", which openProject relies on before it replaces the project.
  if (inFlightWrite) await inFlightWrite;
  await rm(snapshotPath(), { force: true }).catch(() => undefined);
  snapshotOnDisk = false;
  await tombstoneHeldOffer();
}

/**
 * For approveAndClose — the process may not survive an await. NEVER throws:
 * rm's `force` swallows ENOENT and nothing else, so on Windows a scanner
 * holding the snapshot gives EPERM/EBUSY, and an uncaught throw there would
 * leave a window that ignored the X and whose next X closes with no prompt.
 */
export function retireAutosaveSync(): void {
  // Every write for the rest of this process, in flight or not, now resolves to
  // `skipped` and deletes what it wrote (check 2 above).
  lastRetiredSeq = Number.MAX_SAFE_INTEGER;
  try {
    rmSync(snapshotPath(), { force: true });
    snapshotOnDisk = false;
  } catch {
    /* hygiene is never a reason to fail a close */
  }
  try {
    tombstoneHeldOfferSync();
  } catch {
    /* ditto */
  }
}

/* ---- the launch scan ---------------------------------------------------- */

/** The offer being held for the renderer, with the file it came from. */
let heldOffer: { offer: RecoveryOffer; file: string } | null = null;

const validSnapshot = (v: unknown): v is AutosaveSnapshot =>
  isObject(v) && v.version === 1 && isObject(v.project) && typeof v.sessionId === 'string';

const mtimeOf = async (p: string): Promise<number | null> => {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
};

async function sweepOlderThan(dir: string, name: string, maxAgeMs: number): Promise<void> {
  const full = path.join(dir, name);
  const mtime = await mtimeOf(full);
  if (mtime === null || Date.now() - mtime < maxAgeMs) return;
  await rm(full, { force: true }).catch(() => undefined);
}

/**
 * The existence of a snapshot at launch IS the signal that a session died:
 * app.requestSingleInstanceLock() guarantees exactly one live process, so a
 * snapshot found here cannot belong to a running session, and every clean exit
 * retires its own. No heartbeat, no lock file, no pid liveness check — pids are
 * reused across reboots.
 */
async function scanAutosaveDir(): Promise<RecoveryOffer | null> {
  const dir = autosaveDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // no directory yet — nothing has ever been written
  }

  for (const name of names) {
    if (name.endsWith(TOMBSTONE_SUFFIX)) await sweepOlderThan(dir, name, TOMBSTONE_MAX_AGE_MS);
    else if (name.endsWith('.tmp')) await sweepOlderThan(dir, name, SCRATCH_MAX_AGE_MS);
  }

  const survivors: { file: string; snap: AutosaveSnapshot }[] = [];
  for (const name of names) {
    if (!name.endsWith(SNAPSHOT_SUFFIX)) continue;
    const full = path.join(dir, name);

    let raw: string;
    try {
      raw = await readFile(full, 'utf8');
    } catch {
      // AN IO ERROR IS NOT A VALIDATION FAILURE. A scanner or backup agent
      // holding the file — most likely during boot, which is exactly when this
      // runs — must not cost the user the one artefact this feature exists to
      // produce. Left untouched, skipped for this launch, offered as nothing.
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await rm(full, { force: true }).catch(() => undefined);
      continue;
    }
    if (!validSnapshot(parsed)) {
      // Bytes we have read and cannot use are not a snapshot.
      await rm(full, { force: true }).catch(() => undefined);
      continue;
    }
    survivors.push({ file: full, snap: parsed });
  }

  // Second line of defence, because a delete can fail: a snapshot whose project
  // is on disk and NEWER than the snapshot has nothing to add.
  const fresh: { file: string; snap: AutosaveSnapshot }[] = [];
  for (const s of survivors) {
    const projectPath = typeof s.snap.projectPath === 'string' ? s.snap.projectPath : null;
    const savedAt = Date.parse(typeof s.snap.savedAt === 'string' ? s.snap.savedAt : '');
    if (projectPath !== null && Number.isFinite(savedAt)) {
      const projectMtime = await mtimeOf(projectPath);
      if (projectMtime !== null && projectMtime > savedAt) {
        await rm(s.file, { force: true }).catch(() => undefined);
        continue;
      }
    }
    fresh.push(s);
  }

  // Only the newest is offered. Several survivors means several sessions died;
  // presenting a list is a startup modal wearing a different hat.
  fresh.sort((a, b) => String(b.snap.savedAt).localeCompare(String(a.snap.savedAt)));
  const [newest, ...rest] = fresh;
  for (const stale of rest) await rm(stale.file, { force: true }).catch(() => undefined);
  if (!newest) return null;

  const projectPath = typeof newest.snap.projectPath === 'string' ? newest.snap.projectPath : null;
  const offer: RecoveryOffer = {
    sessionId: newest.snap.sessionId,
    projectName:
      typeof newest.snap.projectName === 'string' && newest.snap.projectName.trim() !== ''
        ? newest.snap.projectName
        : 'Untitled',
    projectPath,
    // Only main can stat the path, so main decides this rather than the strip.
    projectPathExists: projectPath !== null && (await mtimeOf(projectPath)) !== null,
    savedAt: typeof newest.snap.savedAt === 'string' ? newest.snap.savedAt : new Date().toISOString(),
    project: newest.snap.project as ProjectFile,
  };
  heldOffer = { offer, file: newest.file };
  return offer;
}

const tombstonePathFor = (file: string): string =>
  file.slice(0, -SNAPSHOT_SUFFIX.length) + TOMBSTONE_SUFFIX;

/**
 * A previous session's UNANSWERED offer is tombstoned on a clean exit too. A
 * user who saw the strip, worked past it and exited cleanly has answered it;
 * without this, the same offer is re-presented at every launch forever, costing
 * 32 px of the editor each time. Tombstoning rather than deleting follows the
 * Discard path exactly, so a misclick stays recoverable for seven days.
 */
async function tombstoneHeldOffer(): Promise<void> {
  const held = heldOffer;
  if (!held) return;
  heldOffer = null;
  await rename(held.file, tombstonePathFor(held.file)).catch(() => undefined);
}

function tombstoneHeldOfferSync(): void {
  const held = heldOffer;
  if (!held) return;
  heldOffer = null;
  try {
    renameSync(held.file, tombstonePathFor(held.file));
  } catch {
    /* hygiene */
  }
}

async function autosaveResolveOffer(id: unknown, how: unknown): Promise<void> {
  const held = heldOffer;
  if (!held || typeof id !== 'string' || held.offer.sessionId !== id) return;
  heldOffer = null;
  if (how === 'discarded') {
    // Renamed, not deleted: Discard is one click on the loss of a whole
    // session, and a rename makes a misclick recoverable by anyone willing to
    // rename a file back. The launch sweep removes tombstones after 7 days.
    await rename(held.file, tombstonePathFor(held.file)).catch(() => undefined);
    return;
  }
  await rm(held.file, { force: true }).catch(() => undefined);
}

/* ------------------------------------------------------------ registration */

const isDiscardQuestion = (v: unknown): v is DiscardQuestion =>
  isObject(v) && typeof v.projectName === 'string' && typeof v.neverSaved === 'boolean';

/** The launch scan (SAFETY §2.7), hoisted so more than one caller can wait on
 *  the same promise without starting a second one. Null until registration. */
let launchScan: Promise<RecoveryOffer | null> | null = null;

/**
 * Resolves when the launch scan has settled, whatever it found. Never rejects.
 * Resolves immediately when called after it has already settled, and
 * immediately when registerProjectIpc has not run. RELEASE.md §3.10.
 */
export async function whenRecoveryScanSettled(): Promise<void> {
  if (launchScan === null) return;
  await launchScan;
}

export function registerProjectIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CH.projectSave);
  ipcMain.removeHandler(CH.projectOpen);
  ipcMain.removeHandler(CH.projectPickDir);
  ipcMain.removeHandler(CH.appConfirmDiscard);
  ipcMain.removeHandler(CH.autosaveWrite);
  ipcMain.removeHandler(CH.autosaveRecoverable);
  ipcMain.removeHandler(CH.autosaveRetire);
  ipcMain.removeHandler(CH.autosaveResolve);

  // Started NOW, not awaited, and the PROMISE is what the handler returns.
  // registerProjectIpc is synchronous and createWindow() runs on the next line,
  // while the scan is readdir + N readFile + stat — so the renderer's invoke can
  // and will land before it resolves. An early invoke waits on this promise; a
  // late one gets the settled value. That is the mechanism (SAFETY §2.7).
  //
  // Hoisted to module scope so the splash's `recovery` phase can wait on the
  // same promise (RELEASE.md §3.10). The timing and semantics are unchanged and
  // the handler below still returns exactly what it returned before.
  const scan = scanAutosaveDir().catch(() => null);
  launchScan = scan;

  ipcMain.handle(
    CH.projectSave,
    async (event, project: unknown, opts: unknown): Promise<SaveResult> => {
      try {
        return await saveProject(event, project, opts);
      } catch {
        return saveFailed('io-failed', 'Saving the project failed unexpectedly');
      }
    },
  );

  ipcMain.handle(CH.projectOpen, async (event, wanted: unknown): Promise<OpenResult> => {
    try {
      return await openProject(event, wanted);
    } catch {
      return openFailed('io-failed', 'Opening the project failed unexpectedly');
    }
  });

  ipcMain.handle(CH.projectPickDir, async (event): Promise<string | null> => {
    try {
      return await pickDirectory(event);
    } catch {
      return null;
    }
  });

  /* ---- the open guard (SAFETY §1.9) ------------------------------------- */

  ipcMain.handle(CH.appConfirmDiscard, async (event, q: unknown): Promise<DiscardChoice> => {
    if (!isDiscardQuestion(q)) return 'cancel';
    // Cancel is the safe answer when the mutex is taken, and the same one the
    // user gets from Escape: it abandons the open and leaves this project loaded.
    if (!beginDecision()) return 'cancel';
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return 'cancel';
      const mirror: ProjectStateReport = {
        isDirty: true,
        projectName: q.projectName,
        hasPath: !q.neverSaved,
      };
      // `exporting` is main's to compute, not the renderer's. It is false until
      // electron/ipc/export.ts exports hasActiveExport (SAFETY §9.3).
      const { response } = await dialog.showMessageBox(win, unsavedQuestion(mirror, false, 'open'));
      return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
    } catch {
      return 'cancel';
    } finally {
      endDecision();
    }
  });

  /* ---- autosave (SAFETY §2) --------------------------------------------- */

  ipcMain.handle(CH.autosaveWrite, async (_event, payload: unknown): Promise<AutosaveWriteResult> => {
    try {
      return await autosaveWrite(payload);
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(CH.autosaveRecoverable, (): Promise<RecoveryOffer | null> => scan);

  ipcMain.handle(CH.autosaveRetire, async (_event, throughSeq: unknown): Promise<void> => {
    if (typeof throughSeq !== 'number' || !Number.isFinite(throughSeq)) return;
    try {
      await autosaveRetireInternal(throughSeq);
    } catch {
      /* retiring a snapshot is hygiene; it never fails a save or a close */
    }
  });

  ipcMain.handle(CH.autosaveResolve, async (_event, id: unknown, how: unknown): Promise<void> => {
    try {
      await autosaveResolveOffer(id, how);
    } catch {
      /* the strip has already gone; there is nothing to report */
    }
  });
}
