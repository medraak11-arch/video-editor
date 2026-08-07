/* ---------------------------------------------------------------------------
   electron/ipc/media.ts — OWNER: media.

   Two channels and nothing else (PLAN §8.12): CH.mediaPick and CH.mediaProbe,
   plus the CH.mediaProbeProgress emitter that reports a probe's stages back to
   the renderer.

   ffprobe / ffmpeg resolve on PATH — they are NOT dependencies (PLAN §1.2),
   which is what makes MediaErrorCode 'ffmpeg-missing' a reachable, meaningful
   state rather than dead code. A missing binary is a real error state on the
   affected row, never a silent failure.

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

import { BrowserWindow, dialog } from 'electron';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CH } from '../../src/types/api';
import type { ProbeData, ProbeResult } from '../../src/types/api';
import type { MediaError, MediaKind } from '../../src/types/model';

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

/** Runs a binary from PATH. Never rejects; a missing binary is a distinct outcome. */
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
    'ffmpeg',
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
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '--', abs],
    30000,
  );

  if (outcome.status === 'missing') {
    return fail('ffmpeg-missing', 'ffprobe was not found on PATH, so media cannot be read');
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

/* ------------------------------------------------------------ registration */

export function registerMediaIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CH.mediaPick);
  ipcMain.removeHandler(CH.mediaProbe);

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
}
