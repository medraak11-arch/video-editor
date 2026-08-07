/* ---------------------------------------------------------------------------
   electron/ipc/media.ts — OWNER: media.

   Four channels and nothing else (PLAN §8.12, RENAME.md §IPC contract):
   CH.mediaPick, CH.mediaProbe, CH.mediaRename and CH.mediaReveal, plus the
   CH.mediaProbeProgress emitter that reports a probe's stages back to the
   renderer.

   CH.mediaReveal is the shell integration RENAME.md §UI already puts in the
   media row's context menu. Without a main-process side the menu item was
   permanently disabled — the renderer detects the capability and there was
   nothing to detect.

   ffprobe / ffmpeg are resolved by electron/ffmpeg.ts — the bundled copy in a
   packaged build, PATH in development — and they are still NOT npm dependencies
   (PLAN §1.2), which is what keeps MediaErrorCode 'ffmpeg-missing' a reachable,
   meaningful state rather than dead code. A missing binary is a real error state
   on the affected row, never a silent failure.

   Invocations are pinned by PLAN §4.3:
     ffprobe -v error -print_format json -show_streams -show_format -- <abs>
     ffmpeg  -v error -ss <min(1, dur/2)> -i <abs> -frames:v 1
             -vf scale=320:-2 -y <tmp>/<hash>.jpg

   Rules this file obeys without exception:
     · every invoke RESOLVES; nothing throws across the bridge;
     · never resolve ok with partial data;
     · the url is always ve-media://, never '' and never file:// (PLAN §1.4);
     · no temp thumbnail is left behind on failure.
--------------------------------------------------------------------------- */

import { BrowserWindow, dialog, shell } from 'electron';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import { access, mkdir, rename as renameOnDisk, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkBaseName,
  isCaseOnlyRename,
  renamedFileName,
  renamedPath,
  splitMediaPath,
} from '../../src/lib/filename';
import { CH } from '../../src/types/api';
import type { ProbeData, ProbeResult, RenameError, RenameResult } from '../../src/types/api';
import type { MediaError, MediaKind } from '../../src/types/model';
import { ffmpegCommand } from '../ffmpeg';

/* ----------------------------------------------------------------- shared */

/**
 * The one URL builder, restated from PLAN §1.4 / §4.3. It is duplicated here
 * rather than imported from electron/main.ts on purpose: main.ts imports this
 * module, and reaching back into it would make the app entry point a cycle.
 */
const mediaUrlForPath = (abs: string): string => `ve-media://file/${encodeURIComponent(abs)}`;

const VIDEO_EXTENSIONS = [
  'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg', 'mts', 'm2ts', 'ts',
  'flv', 'ogv', '3gp', 'mxf',
];
const AUDIO_EXTENSIONS = [
  'wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'wma', 'caf', 'mka',
];

/** What this Chromium can actually decode. Anything else is 'unsupported-codec'. */
const DECODABLE_VIDEO = new Set(['h264', 'hevc', 'h265', 'vp8', 'vp9', 'av1', 'theora']);
const DECODABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac']);

const THUMB_DIR = path.join(tmpdir(), 'video-editor-thumbs');
/** A probe of the same file reuses its frame instead of re-extracting it. */
const thumbName = (abs: string): string =>
  `${createHash('sha1').update(abs).digest('hex').slice(0, 16)}.jpg`;

const fail = (code: MediaError['code'], message: string): ProbeResult => ({
  ok: false,
  error: { code, message },
});

/* ------------------------------------------------------- child processes */

type RunOutcome =
  | { status: 'ok'; code: number; stdout: string; stderr: string }
  | { status: 'missing' }
  | { status: 'failed'; message: string };

/**
 * Runs a resolved binary (electron/ffmpeg.ts decides bundled vs PATH). Never
 * rejects; a missing binary is a distinct outcome.
 */
function run(bin: string, args: string[], timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    // Declared before finish(), because a synchronous spawn() throw calls
    // finish() before the timer exists. Reading `timer` in its temporal dead
    // zone would throw inside the executor, reject a promise this function
    // promises never rejects, and downgrade 'ffmpeg-missing' — the one error the
    // brief singles out — into a generic 'probe-failed'.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch {
      finish({ status: 'missing' });
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      finish({ status: 'failed', message: `${bin} timed out` });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' ? { status: 'missing' } : { status: 'failed', message: error.message });
    });

    child.on('close', (code) => {
      finish({ status: 'ok', code: code ?? 0, stdout, stderr });
    });
  });
}

/* --------------------------------------------------------- ffprobe output */

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

interface FfProbeJson {
  streams?: FfStream[];
  format?: { duration?: string };
}

/** '30000/1001' -> 29.97. Returns 0 for '0/0', '', and anything unparseable. */
function evaluateRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  const value = n / d;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

const toSeconds = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* ---------------------------------------------------------------- probing */

function sendProgress(event: IpcMainInvokeEvent, filePath: string, progress: number): void {
  if (event.sender.isDestroyed()) return;
  event.sender.send(CH.mediaProbeProgress, { path: filePath, progress });
}

/**
 * Best effort, video only. A failure yields thumbnailUrl: null, never an error
 * result, and never leaves a partial file behind.
 */
async function extractThumbnail(abs: string, durationSeconds: number): Promise<string | null> {
  const target = path.join(THUMB_DIR, thumbName(abs));
  try {
    const existing = await stat(target);
    if (existing.size > 0) return mediaUrlForPath(target);
  } catch {
    // not cached yet — extract it below
  }

  try {
    await mkdir(THUMB_DIR, { recursive: true });
  } catch {
    return null;
  }

  const at = Math.min(1, durationSeconds / 2);
  const outcome = await run(
    ffmpegCommand('ffmpeg'),
    ['-v', 'error', '-ss', String(at), '-i', abs, '-frames:v', '1', '-vf', 'scale=320:-2', '-y', target],
    20000,
  );

  if (outcome.status !== 'ok' || outcome.code !== 0) {
    await rm(target, { force: true }).catch(() => undefined);
    return null;
  }

  try {
    const written = await stat(target);
    if (written.size === 0) {
      await rm(target, { force: true }).catch(() => undefined);
      return null;
    }
  } catch {
    return null;
  }

  return mediaUrlForPath(target);
}

async function probeFile(event: IpcMainInvokeEvent, abs: string): Promise<ProbeResult> {
  try {
    await access(abs, FS_CONSTANTS.R_OK);
  } catch {
    return fail('not-found', 'The file is missing or cannot be read');
  }
  sendProgress(event, abs, 0.1);

  const outcome = await run(
    ffmpegCommand('ffprobe'),
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '--', abs],
    30000,
  );

  if (outcome.status === 'missing') {
    // Not "…on PATH": a packaged build looks in its own resources first, so the
    // sentence has to be true whichever lookup came up empty (electron/ffmpeg.ts).
    return fail('ffmpeg-missing', 'ffprobe could not be found, so media cannot be read');
  }
  if (outcome.status === 'failed') {
    return fail('probe-failed', 'ffprobe did not finish reading this file');
  }
  if (outcome.code !== 0) {
    return fail('probe-failed', 'ffprobe could not read this file');
  }
  sendProgress(event, abs, 0.45);

  let parsed: FfProbeJson;
  try {
    parsed = JSON.parse(outcome.stdout) as FfProbeJson;
  } catch {
    return fail('probe-failed', 'ffprobe returned output this build could not parse');
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const kind: MediaKind = videoStream ? 'video' : 'audio';
  const chosen = videoStream ?? audioStream;

  if (!chosen) {
    return fail('probe-failed', 'The file carries no audio or video stream');
  }

  const durationSeconds = toSeconds(parsed.format?.duration) || toSeconds(chosen.duration);
  if (durationSeconds <= 0) {
    return fail('probe-failed', 'The file reports no usable duration');
  }

  const codec = chosen.codec_name ?? '';
  const decodable = kind === 'video' ? DECODABLE_VIDEO : DECODABLE_AUDIO;
  const isPcm = kind === 'audio' && codec.startsWith('pcm_');
  if (codec === '' || (!decodable.has(codec) && !isPcm)) {
    return fail(
      'unsupported-codec',
      codec === ''
        ? 'The file uses a codec this build cannot identify'
        : `${codec} is not a codec this build can decode`,
    );
  }
  sendProgress(event, abs, 0.7);

  const thumbnailUrl =
    kind === 'video' ? await extractThumbnail(abs, durationSeconds) : null;
  sendProgress(event, abs, 0.95);

  const data: ProbeData = {
    kind,
    durationSeconds,
    width: kind === 'video' ? videoStream?.width ?? 0 : 0,
    height: kind === 'video' ? videoStream?.height ?? 0 : 0,
    fps:
      kind === 'video'
        ? evaluateRate(videoStream?.r_frame_rate) || evaluateRate(videoStream?.avg_frame_rate)
        : 0,
    codec,
    hasAudio: audioStream !== undefined,
    url: mediaUrlForPath(abs),
    thumbnailUrl,
  };

  return { ok: true, data };
}

/* -------------------------------------------------------------- the picker */

async function pickFiles(event: IpcMainInvokeEvent): Promise<string[]> {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: 'Import media',
    buttonLabel: 'Import',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video and audio', extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
      { name: 'Video', extensions: VIDEO_EXTENSIONS },
      { name: 'Audio', extensions: AUDIO_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  };

  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);

  return result.canceled ? [] : result.filePaths;
}

/* ------------------------------------------------------------- renaming */

/**
 * The sentences the user reads. Fixed strings, chosen here: an errno, a raw
 * filesystem message or a path never crosses the bridge (RENAME.md §IPC
 * contract). 'file-in-use' is quoted verbatim from RENAME.md §The file-lock
 * problem — it is the one message the spec pins, because it is the only one that
 * tells the user what to actually do.
 */
const RENAME_MESSAGE = {
  notFound: 'That file could not be found on disk',
  nameTaken: 'A file with that name already exists in this folder',
  permission: 'You do not have permission to rename that file',
  fileInUse: 'Another program is using that file. Close it and try again.',
  ioFailed: 'That file could not be renamed',
} as const;

const renameFail = (code: RenameError['code'], message: string): RenameResult => ({
  ok: false,
  error: { code, message },
});

/**
 * errno -> taxonomy.
 *
 * EPERM is split by platform deliberately. On Windows a rename blocked by an
 * open handle — the exact case RENAME.md §The file-lock problem is written
 * about, a <video> element still holding the source — surfaces as EPERM, not
 * EBUSY; EBUSY is what a directory in use gives. Reporting that as 'permission'
 * would tell the user to change an ACL when what they need to do is close the
 * other program. On POSIX, EPERM really is a permission failure and is reported
 * as one.
 */
function renameErrnoResult(error: unknown): RenameResult {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'ENOENT':
      return renameFail('not-found', RENAME_MESSAGE.notFound);
    case 'EACCES':
      return renameFail('permission', RENAME_MESSAGE.permission);
    case 'EPERM':
      return process.platform === 'win32'
        ? renameFail('file-in-use', RENAME_MESSAGE.fileInUse)
        : renameFail('permission', RENAME_MESSAGE.permission);
    case 'EBUSY':
    case 'ETXTBSY':
      return renameFail('file-in-use', RENAME_MESSAGE.fileInUse);
    default:
      return renameFail('io-failed', RENAME_MESSAGE.ioFailed);
  }
}

/** Existence only. A path that cannot be stat'd for any reason is not a collision. */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target, FS_CONSTANTS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * RENAME.md §Validation, in the process that owns the filesystem. The renderer
 * validates too, for feedback while typing, but this is the trust boundary and
 * repeats every check through the SAME predicate (src/lib/filename.ts) so the
 * two can never disagree about what a legal name is.
 */
async function renameMedia(rawPath: unknown, rawBaseName: unknown): Promise<RenameResult> {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return renameFail('not-found', RENAME_MESSAGE.notFound);
  }
  if (typeof rawBaseName !== 'string') {
    return renameFail('invalid-name', 'A file name cannot be empty');
  }

  const abs = path.resolve(rawPath);
  const { base: currentBase, ext } = splitMediaPath(abs);

  // Validate BEFORE any filesystem call: an illegal name must be refused without
  // the disk having been touched at all (RENAME.md §Definition of done).
  const check = checkBaseName(rawBaseName, abs);
  if (!check.ok) return renameFail('invalid-name', check.message);

  // Unchanged: succeed without touching the disk. Note this is an exact compare —
  // a change of case only is a real rename and falls through.
  if (rawBaseName === currentBase) {
    return { ok: true, path: abs, url: mediaUrlForPath(abs), name: `${currentBase}${ext}` };
  }

  // Checked explicitly so a missing source reports 'not-found' rather than being
  // mistaken for a collision by the check below.
  try {
    await access(abs, FS_CONSTANTS.F_OK);
  } catch (error) {
    return renameErrnoResult(error);
  }

  const target = renamedPath(abs, rawBaseName);

  // NEVER overwrite. On Windows `access` is case-insensitive because the volume
  // is, which is exactly the comparison the spec asks for — with one exception:
  // for a case-only rename the file it finds IS the source, so the check is
  // skipped and fs.rename is left to do what it does correctly on NTFS.
  if (!isCaseOnlyRename(currentBase, rawBaseName) && (await exists(target))) {
    return renameFail('name-taken', RENAME_MESSAGE.nameTaken);
  }

  try {
    await renameOnDisk(abs, target);
  } catch (error) {
    return renameErrnoResult(error);
  }

  return {
    ok: true,
    path: target,
    // The same builder the probe uses, so a renamed file's url is encoded
    // identically to the one it replaces.
    url: mediaUrlForPath(target),
    name: renamedFileName(abs, rawBaseName),
  };
}

/* ------------------------------------------------------------ registration */

export function registerMediaIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CH.mediaPick);
  ipcMain.removeHandler(CH.mediaProbe);
  ipcMain.removeHandler(CH.mediaRename);
  ipcMain.removeAllListeners(CH.mediaReveal);

  // One-way, and the only channel here that is not an invoke: there is nothing
  // to report back. A path that no longer exists opens its containing folder
  // rather than doing nothing at all — an offline row is exactly the row whose
  // folder you want to look at.
  ipcMain.on(CH.mediaReveal, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.trim() === '') return;
    void access(filePath, FS_CONSTANTS.F_OK).then(
      () => shell.showItemInFolder(filePath),
      () => shell.openPath(path.dirname(filePath)).then(
        () => undefined,
        () => undefined,
      ),
    );
  });

  ipcMain.handle(CH.mediaPick, async (event): Promise<string[]> => {
    try {
      return await pickFiles(event);
    } catch {
      // A picker that cannot open reports nothing to import; it never rejects.
      return [];
    }
  });

  ipcMain.handle(CH.mediaProbe, async (event, filePath: unknown): Promise<ProbeResult> => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return fail('probe-failed', 'No file path was given to probe');
    }
    try {
      return await probeFile(event, filePath);
    } catch {
      return fail('probe-failed', 'Reading this file failed unexpectedly');
    }
  });

  ipcMain.handle(
    CH.mediaRename,
    async (_event, filePath: unknown, baseName: unknown): Promise<RenameResult> => {
      try {
        return await renameMedia(filePath, baseName);
      } catch {
        // renameMedia catches everything it expects; this is the guarantee that
        // the invoke RESOLVES even when it does not, because a rejection here
        // would surface in the renderer as a thrown Error with a main-process
        // stack in it rather than as one of the six codes.
        return renameFail('io-failed', RENAME_MESSAGE.ioFailed);
      }
    },
  );
}
