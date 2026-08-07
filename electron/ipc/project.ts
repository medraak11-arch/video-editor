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
     · CH is imported, never retyped.
--------------------------------------------------------------------------- */

import { BrowserWindow, dialog } from 'electron';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
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
  const existingPath = typeof options.path === 'string' && options.path !== '' ? options.path : null;
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

  try {
    await writeFile(target, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  } catch {
    return saveFailed('io-failed', `The project could not be written to ${path.basename(target)}`);
  }

  return { ok: true, path: target };
}

/* ------------------------------------------------------------------- open */

async function openProject(event: IpcMainInvokeEvent): Promise<OpenResult> {
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

  const target = result.canceled ? undefined : result.filePaths[0];
  if (target === undefined) {
    return openFailed('cancelled', 'Opening was cancelled');
  }

  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    return openFailed('io-failed', `${path.basename(target)} could not be read`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return openFailed('bad-format', `${path.basename(target)} is not a project file`);
  }

  if (!isObject(parsed)) {
    return openFailed('bad-format', `${path.basename(target)} is not a project file`);
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

  ipcMain.handle(CH.projectOpen, async (event): Promise<OpenResult> => {
    try {
      return await openProject(event);
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
