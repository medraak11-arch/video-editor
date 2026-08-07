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

import { BrowserWindow, dialog } from 'electron';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CH } from '../../src/types/api';
import type { OpenResult, SaveResult } from '../../src/types/api';
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

  // Write beside the target, then rename over it. Until the rename lands the
  // previous good file is untouched, so a full disk or a crash mid-write costs
  // the new edit, never the project.
  const scratch = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(scratch, body, 'utf8');
    await rename(scratch, target);
  } catch (e) {
    await unlink(scratch).catch(() => undefined);
    return saveFailed('io-failed', writeFailureMessage(e, target));
  }

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

async function pickDirectory(event: IpcMainInvokeEvent): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender);
  const dialogOptions: Electron.OpenDialogOptions = {
    title: 'Choose an output folder',
    buttonLabel: 'Choose',
    properties: ['openDirectory', 'createDirectory'],
  };

  const result = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

/* ------------------------------------------------------------ registration */

export function registerProjectIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CH.projectSave);
  ipcMain.removeHandler(CH.projectOpen);
  ipcMain.removeHandler(CH.projectPickDir);

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
}
