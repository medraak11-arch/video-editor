/* ---------------------------------------------------------------------------
   electron/ipc/export.ts — OWNER: export. EXPORT §2, §3, §4, §5.

   One ffmpeg process per export, spawned with an ARGUMENT ARRAY. Never
   `shell: true`, never a concatenated command string: the project path on this
   machine is `E:\Desktop\Video Editor`, with a space in it, and argv-array
   spawning is what makes that safe. `windowsHide: true` or a console window
   appears on win32 and stays for the whole encode.

   The three invariants this file exists to hold:
     · exactly ONE terminal event per job id, ever, and no event after it;
     · a cancelled or failed export never leaves a file at the user's chosen
       path — ffmpeg writes a dotted `.part` sibling that is renamed into place
       only after a clean exit;
     · raw stderr is never shown to the user. It is kept, classified, and
       console.error'd; the renderer sees the §4 sentence and nothing else.
--------------------------------------------------------------------------- */

import { app } from 'electron';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as FS, rmSync } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CH, isAudioOnlyCodec } from '../../src/types/api';
import type {
  ExportDocument,
  ExportError,
  ExportProgressEvent,
  ExportRequest,
} from '../../src/types/api';
import type { SubtitleCue } from '../../src/types/model';
import { formatSrt } from '../../src/lib/srt';
import { buildExportGraph, CONTAINER, ERR } from '../export/graph';
import { ffmpegCommand } from '../ffmpeg';

/**
 * Resolved at spawn time, not at module load: electron/ffmpeg.ts reads
 * `app.isPackaged`, and this module is imported by main.ts before the app is
 * ready. The answer is cached there, so this stays a map lookup after the first
 * export. A packaged build gets the bundled binary; development gets PATH; a
 * build whose bundled copy has gone missing falls back to PATH and, failing
 * that, still lands on ERR['ffmpeg-missing'] below — the §4 classification is
 * unchanged.
 */
const ffmpegBinary = (): string => ffmpegCommand('ffmpeg');
/** stderr is kept for classification only, and only the tail of it. */
const STDERR_TAIL_BYTES = 8192;

type Phase = ExportProgressEvent['phase'];

interface Job {
  id: string;
  sender: WebContents;
  state: 'preparing' | 'running' | 'finalizing' | 'settled';
  cancelRequested: boolean;
  child: ChildProcess | null;
  /** Set synchronously by the child's `error` handler so `close` cannot outrace it. */
  spawnError: ExportError | null;
  partPath: string; // path.join(folder, `.${filename}.${ext}.part`)
  finalPath: string; // path.join(folder, `${filename}.${ext}`)
  /**
   * A DIRECTORY of this job's own, not a bare temp file, and it is what ffmpeg
   * is spawned with as its `cwd`.
   *
   * Burn-in needs the SubRip file named RELATIVELY inside the filter script
   * (CREATIVE §6.3): an absolute Windows path there has to be written
   * `C\:/Users/…`, and this machine's paths carry spaces and a drive letter,
   * which is exactly the shape that breaks. A relative name has nothing to
   * escape — and a relative name only resolves if the process runs somewhere
   * known. Giving the job its own directory rather than pointing `cwd` at the
   * whole of `tmpdir()` keeps that guarantee narrow, keeps two jobs' `subs.srt`
   * apart, and makes cleanup one recursive remove.
   */
  jobDir: string; // path.join(tmpdir(), `ve-export-${id}`)
  scriptPath: string; // path.join(jobDir, 'filter.txt')
  framesTotal: number;
  durationSeconds: number;
  lastPhase: Phase;
  lastProgress: number;
  lastFramesDone: number;
  /**
   * CREATIVE §4.3 — what the build had to change about what the user authored.
   * Held from `buildExportGraph` until the next event actually goes out, then
   * cleared: the contract says the FIRST event after the graph is built carries
   * them and that they are not repeated. Null, never `[]`, so the field is
   * absent rather than empty on every ordinary export.
   */
  pendingNotices: string[] | null;
  stderrTail: string;
  onSenderGone: (() => void) | null;
}

const jobs = new Map<string, Job>();

const newJobId = (): string => `exp_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

/* ------------------------------------------------------------- filesystem */

/**
 * `force: true` alone only swallows ENOENT; the retries are what handle a
 * `.part` file Windows has not finished releasing after the child exits.
 */
const removeFile = (p: string): Promise<void> =>
  rm(p, { force: true, maxRetries: 3, retryDelay: 100 }).then(
    () => undefined,
    () => undefined,
  );

/** The job's whole scratch directory: filter script, title PNGs, subs.srt. */
const removeDir = (p: string): Promise<void> =>
  rm(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 }).then(
    () => undefined,
    () => undefined,
  );

/**
 * `fallback` is the residual bucket, and it differs by WHERE the throw came
 * from: a failure in the prepare sequence happened before ffmpeg ran at all, so
 * it must not come back saying the encoder stopped.
 */
function classifyFsError(e: unknown, fallback: ExportError): ExportError {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'EPERM' || code === 'EBUSY') return ERR['output-in-use'];
  if (code === 'EACCES') return ERR['permission-denied'];
  if (code === 'ENOSPC') return ERR['disk-full'];
  return fallback;
}

/** §4, post-mortem. Pre-flight beats post-mortem; this is the residue. */
function classifyExit(stderr: string): ExportError {
  if (/No such file or directory/i.test(stderr)) return ERR['source-missing'];
  if (/Decoder .* not found|Unknown decoder|Unsupported codec|Could not find codec parameters/i.test(stderr))
    return ERR['unsupported-codec'];
  if (/Permission denied/i.test(stderr)) return ERR['permission-denied'];
  if (/No space left on device/i.test(stderr)) return ERR['disk-full'];
  if (/Device or resource busy/i.test(stderr)) return ERR['output-in-use'];
  return ERR['encoder-failed'];
}

/* ------------------------------------------------------------------ events */

interface TerminalExtra {
  error?: ExportError;
  outputPath?: string;
}

/**
 * §2.2 monotonicity, §2.4 suppression. The clamp lives in the `encoding` phase
 * ONLY: `encoding` ends at 1.0 and `finalizing` STARTS at 0.5, so a phase-blind
 * clamp would pin the bar at 100% through finalize.
 */
function emit(
  job: Job,
  phase: Phase,
  progress: number,
  framesDone: number,
  extra?: TerminalExtra,
): void {
  if (phase !== job.lastPhase) job.lastProgress = 0;

  let p = progress;
  if (phase === 'encoding' && p < job.lastProgress) p = job.lastProgress;
  p = Math.min(1, Math.max(0, p));

  const terminal = phase === 'done' || phase === 'cancelled' || phase === 'error';
  if (
    !terminal &&
    phase === job.lastPhase &&
    p === job.lastProgress &&
    framesDone === job.lastFramesDone
  ) {
    return; // §2.4: an identical (phase, progress, framesDone) triple is dropped
  }

  job.lastPhase = phase;
  job.lastProgress = p;
  job.lastFramesDone = framesDone;

  const event: ExportProgressEvent = {
    jobId: job.id,
    phase,
    progress: p,
    framesDone,
    framesTotal: job.framesTotal,
    ...(extra?.error ? { message: extra.error.message, error: extra.error } : {}),
    ...(extra?.outputPath ? { outputPath: extra.outputPath } : {}),
    ...(job.pendingNotices ? { notices: job.pendingNotices } : {}),
  };

  if (job.sender.isDestroyed()) return;
  job.sender.send(CH.exportProgress, event);
  // Cleared only once the event is actually on the wire. The suppression branch
  // above returns before this, so a notice cannot be swallowed by a duplicate
  // (phase, progress, framesDone) triple — it rides the next event that is not.
  job.pendingNotices = null;
}

/**
 * The ONLY code permitted to emit a terminal phase. Idempotent by construction:
 * the first call wins and every later one is a no-op, which is the whole race
 * defence in one line.
 */
function settle(
  job: Job,
  phase: 'done' | 'cancelled' | 'error',
  extra?: ExportError | { outputPath: string },
): void {
  if (job.state === 'settled') return;
  job.state = 'settled';
  jobs.delete(job.id);
  if (job.onSenderGone) {
    try {
      job.sender.removeListener('destroyed', job.onSenderGone);
    } catch {
      /* the sender is already gone; the listener goes with it */
    }
    job.onSenderGone = null;
  }
  void removeDir(job.jobDir);

  const payload: TerminalExtra | undefined =
    extra === undefined
      ? undefined
      : 'code' in extra
        ? { error: extra }
        : { outputPath: extra.outputPath };

  emit(job, phase, phase === 'done' ? 1 : job.lastProgress, job.lastFramesDone, payload);
}

/* -------------------------------------------------------------- validation */

const CODECS: ReadonlyArray<ExportRequest['codec']> = [
  'h264',
  'h265',
  'prores',
  'aac',
  'mp3',
  'wav',
];
const QUALITIES: ReadonlyArray<ExportRequest['quality']> = ['draft', 'good', 'best'];
const RANGES: ReadonlyArray<ExportRequest['range']> = ['entire', 'inout'];

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * The characters Windows rejects in a name, plus every control character. Built
 * with `new RegExp` from escape SEQUENCES so no raw control byte can ever land in
 * this source file.
 */
const ILLEGAL_IN_NAME = new RegExp('[\\\\/:*?"<>|\\u0000-\\u001f]');

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0;

/**
 * §5.2. The renderer's `sanitiseFilename` is an affordance, not a boundary: it
 * runs in the renderer and it leaves several things Windows rejects.
 */
function filenameProblem(filename: unknown, folder: string, ext: string): boolean {
  if (typeof filename !== 'string') return true;
  if (filename.trim() === '') return true;
  if (ILLEGAL_IN_NAME.test(filename)) return true;
  if (/[. ]$/.test(filename)) return true;
  const stem = filename.replace(/\.[^.]*$/, '').toUpperCase();
  if (RESERVED.has(stem)) return true;
  if (process.platform === 'win32' && path.join(folder, `${filename}.${ext}`).length > 259)
    return true;
  return false;
}

/**
 * §5.2. Every rejection here is 'invalid-request': the request never reached a
 * spawn, so an encoder message would name a cause that did not happen. The two
 * exceptions below say something the user can act on and keep their own codes.
 */
function validateRequest(req: unknown): { ok: true; req: ExportRequest } | { ok: false; error: ExportError } {
  if (typeof req !== 'object' || req === null) return { ok: false, error: ERR['invalid-request'] };
  const r = req as Partial<ExportRequest>;

  // ABSOLUTE, and now load-bearing rather than merely expected: ffmpeg is
  // spawned with `cwd` set to the job's scratch directory (CREATIVE §6.3), so a
  // relative output folder would resolve inside the temp directory and the file
  // would appear nowhere the user can find it. The picker only ever produces an
  // absolute path; this is the boundary that says so.
  if (typeof r.folder !== 'string' || r.folder.trim() === '' || !path.isAbsolute(r.folder))
    return { ok: false, error: ERR['output-not-writable'] };
  if (!isPositiveInt(r.width) || !isPositiveInt(r.height))
    return { ok: false, error: ERR['invalid-request'] };
  if (typeof r.fps !== 'number' || !Number.isFinite(r.fps) || r.fps <= 0)
    return { ok: false, error: ERR['invalid-request'] };
  if (!CODECS.includes(r.codec as ExportRequest['codec']))
    return { ok: false, error: ERR['invalid-request'] };
  if (!QUALITIES.includes(r.quality as ExportRequest['quality']))
    return { ok: false, error: ERR['invalid-request'] };
  if (!RANGES.includes(r.range as ExportRequest['range']))
    return { ok: false, error: ERR['invalid-request'] };
  if (typeof r.startFrame !== 'number' || !Number.isInteger(r.startFrame) || r.startFrame < 0)
    return { ok: false, error: ERR['invalid-request'] };
  if (typeof r.durationFrames !== 'number' || !Number.isInteger(r.durationFrames))
    return { ok: false, error: ERR['invalid-request'] };
  if (r.durationFrames < 1) return { ok: false, error: ERR['empty-timeline'] };

  const ext = CONTAINER[r.codec as ExportRequest['codec']];
  if (filenameProblem(r.filename, r.folder, ext))
    return { ok: false, error: ERR['invalid-filename'] };

  // An ABSENT document is 'empty-timeline' (§4) and is handled by the graph
  // builder. A document that is present but the wrong shape is a malformed
  // request, not an empty edit, and says so.
  const doc = r.document as ExportDocument | undefined;
  if (doc !== undefined) {
    if (
      typeof doc !== 'object' ||
      doc === null ||
      typeof doc.fps !== 'number' ||
      !Number.isFinite(doc.fps) ||
      doc.fps <= 0 ||
      !Array.isArray(doc.tracks) ||
      !Array.isArray(doc.clips) ||
      !Array.isArray(doc.sources)
    ) {
      return { ok: false, error: ERR['invalid-request'] };
    }
  }

  return { ok: true, req: r as ExportRequest };
}

/* ----------------------------------------------------------- §2.1 progress */

/** Consumes `-progress pipe:1` blocks. Partial lines are retained across chunks. */
function makeProgressReader(job: Job): (chunk: Buffer) => void {
  let buffer = '';
  let block: Record<string, string> = {};

  return (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (line === '') continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      block[key] = line.slice(eq + 1).trim();
      if (key !== 'progress') continue;
      flushBlock(job, block);
      block = {};
    }
  };
}

function flushBlock(job: Job, block: Record<string, string>): void {
  if (job.state === 'settled' || job.state === 'finalizing') return;

  // out_time_us is 'N/A' in the first block of every run. Parse failure is 0,
  // never NaN, never a skipped block. out_time_ms is MISNAMED and carries
  // microseconds — reading it as milliseconds pegs the bar at 100% immediately.
  const outTimeSec = Number(block.out_time_us) / 1e6;
  const denom = job.durationSeconds;
  const raw = Number.isFinite(outTimeSec) && denom > 0 ? outTimeSec / denom : 0;
  const progress = Math.min(1, Math.max(0, raw));

  const reported = Number(block.frame);
  const framesDone = Number.isFinite(reported)
    ? Math.min(job.framesTotal, Math.max(0, Math.trunc(reported)))
    : Math.round(progress * job.framesTotal);

  // out_time_us is the presentation time of the LAST frame, so the final block
  // falls short by exactly one frame period. The fix is at the end, not in the
  // denominator: the denominator stays an honest statement about file length.
  if (block.progress === 'end') emit(job, 'encoding', 1, job.framesTotal);
  else emit(job, 'encoding', progress, framesDone);
}

/* --------------------------------------------------------------- §3.4 close */

async function onClose(job: Job, code: number | null): Promise<void> {
  try {
    // cancelRequested is checked BEFORE the exit code: a killed ffmpeg exits
    // non-zero with alarming stderr, and a user cancel must not surface as an
    // encoder failure.
    if (job.cancelRequested) {
      await removeFile(job.partPath);
      return settle(job, 'cancelled');
    }
    if (job.spawnError) {
      await removeFile(job.partPath);
      return settle(job, 'error', job.spawnError);
    }
    if (code !== 0) {
      if (job.stderrTail) console.error(`[export] ffmpeg exit ${String(code)}:\n${job.stderrTail}`);
      await removeFile(job.partPath);
      return settle(job, 'error', classifyExit(job.stderrTail));
    }

    job.state = 'finalizing';
    emit(job, 'finalizing', 0.5, job.framesTotal);
    if (job.cancelRequested) {
      await removeFile(job.partPath);
      return settle(job, 'cancelled');
    }
    await rename(job.partPath, job.finalPath);
    if (job.cancelRequested) {
      await removeFile(job.finalPath);
      return settle(job, 'cancelled');
    }
    emit(job, 'finalizing', 1, job.framesTotal);
    settle(job, 'done', { outputPath: job.finalPath });
  } catch (e) {
    console.error('[export] finalize failed', e);
    await removeFile(job.partPath);
    // Here the encoder DID run and exit 0; what failed is the move into place.
    settle(job, 'error', classifyFsError(e, ERR['encoder-failed']));
  } finally {
    // No-op whenever the body already settled, and the only thing standing
    // between a thrown filesystem error and a job that never emits anything.
    settle(job, 'error', ERR['encoder-failed']);
  }
}

/* ------------------------------------------- CREATIVE §5.2 title rasters ---
   The renderer already drew every title clip with `src/lib/titleRaster.ts` —
   the SAME function that drew the preview — onto an OffscreenCanvas at project
   resolution, and sent the PNG as base64. Main's whole job is to turn that back
   into bytes on disk so the graph can feed it as an ordinary `-loop 1` input.
   Nothing here knows what a title looks like, which is the point: the exported
   title is pixel for pixel what the user was looking at.

   A malformed or unwritable entry costs ONE title, never the export. */

async function writeTitlePngs(
  job: Job,
  doc: ExportDocument | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const titles = doc && Array.isArray(doc.titles) ? doc.titles : [];
  let index = 0;
  for (const t of titles) {
    index += 1;
    if (typeof t?.clipId !== 'string' || t.clipId === '' || typeof t.png !== 'string') continue;
    // Named by INDEX, not by clip id: an id is a nanoid over an alphabet that
    // happens to be filename-safe today, and a filename is not the place to bet
    // on that staying true.
    const file = path.join(job.jobDir, `title-${index}.png`);
    try {
      await writeFile(file, Buffer.from(t.png, 'base64'));
      out[t.clipId] = file;
    } catch (e) {
      console.error('[export] a title could not be written, so it was left out', e);
    }
  }
  return out;
}

/* ------------------------------------------- CREATIVE §6.3 subtitle burn-in */

/**
 * Writes `subs.srt` into the job's scratch directory — the SAME directory as the
 * filter script and the one ffmpeg is spawned in — and reports whether it is
 * there.
 *
 * WHO DECIDES is the thing to keep straight, and it is THIS FUNCTION.
 * `buildExportGraph` is a pure module: it opens nothing and writes nothing, so
 * "is there a burn-in" is the same question as "did main put a file there", and
 * a builder handed no `subtitlesFile` correctly emits no filter. Deciding it
 * here and handing the answer over as a path is what stops the graph from ever
 * naming a file that does not exist.
 *
 * The cues are offset by the export range's start and clipped to its end, so an
 * in/out export carries the captions that belong to it at the times it actually
 * runs at. `formatSrt` does the offsetting; this only decides which cues are in.
 */
async function writeSubtitles(job: Job, req: ExportRequest): Promise<string | undefined> {
  if (req.burnSubtitles !== true) return undefined;
  // No picture to burn into. The setting is retained and ignored, exactly as
  // `width`/`height`/`fps` are for an audio codec.
  if (isAudioOnlyCodec(req.codec)) return undefined;

  const doc = req.document;
  const cues = doc && Array.isArray(doc.subtitles) ? doc.subtitles : [];
  if (cues.length === 0 || !doc || !(doc.fps > 0)) return undefined;

  const rangeEnd = req.startFrame + req.durationFrames;
  const inRange: SubtitleCue[] = cues
    .filter((c) => c && c.end > req.startFrame && c.start < rangeEnd)
    .map((c) => (c.end > rangeEnd ? { ...c, end: rangeEnd } : c));

  const text = formatSrt(inRange, doc.fps, req.startFrame);
  if (text.trim() === '') return undefined;

  try {
    // UTF-8, no BOM — for the same reason the filter script is (EXPORT §1.1),
    // and because libass reads a BOM as part of the first cue's index.
    await writeFile(path.join(job.jobDir, SUBTITLE_FILE), text, 'utf8');
  } catch (e) {
    console.error('[export] the subtitle file could not be written, so nothing was burned in', e);
    return undefined;
  }
  // RELATIVE, and that is the whole reason for the `cwd` below.
  return SUBTITLE_FILE;
}

const SUBTITLE_FILE = 'subs.srt';

/* ------------------------------------------------------------- §2.3 prepare */

/** True when the job was cancelled before it spawned; settles and stops the sequence. */
function cancelledBeforeSpawn(job: Job): boolean {
  if (!job.cancelRequested) return false;
  settle(job, 'cancelled');
  return true;
}

async function runJob(job: Job, rawReq: unknown): Promise<void> {
  try {
    // §2.3 — the first event of every job is exactly preparing/0, unconditionally,
    // including for a request that is about to fail validation. ExportDialog adopts
    // a job id from its first event and rejects any opener that is not preparing/0.
    emit(job, 'preparing', 0, 0);

    const validated = validateRequest(rawReq);
    if (!validated.ok) return settle(job, 'error', validated.error);
    const req = validated.req;
    // A best-effort framesTotal as soon as the request is known well-formed, so the
    // dialog's frame counter is honest from the second event rather than the fifth.
    // buildExportGraph replaces it with the authoritative number at 0.55.
    // An audio-only export has no output frames, so the pre-flight agrees with
    // the graph rather than flashing a video frame count and then dropping to
    // zero a few events later.
    if (isAudioOnlyCodec(req.codec)) {
      job.framesTotal = 0;
    } else if (req.document && req.document.fps > 0) {
      job.framesTotal = Math.max(
        1,
        Math.round((req.durationFrames / req.document.fps) * req.fps),
      );
    }
    if (cancelledBeforeSpawn(job)) return;
    emit(job, 'preparing', 0.15, 0);

    const ext = CONTAINER[req.codec];
    job.partPath = path.join(req.folder, `.${req.filename}.${ext}.part`);
    job.finalPath = path.join(req.folder, `${req.filename}.${ext}`);

    try {
      const info = await stat(req.folder);
      if (!info.isDirectory()) return settle(job, 'error', ERR['output-not-writable']);
      await access(req.folder, FS.W_OK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM')
        return settle(job, 'error', ERR['permission-denied']);
      return settle(job, 'error', ERR['output-not-writable']);
    }
    if (cancelledBeforeSpawn(job)) return;
    emit(job, 'preparing', 0.35, 0);

    // The scratch directory, and everything the graph will have to NAME rather
    // than compute. It is made before the graph is built because the builder is
    // a pure module: it joins no paths and writes no files, so whatever it
    // references has to exist and be handed to it (BuildPaths).
    await mkdir(job.jobDir, { recursive: true });
    const titlePngs = await writeTitlePngs(job, req.document);
    // Undefined whenever there is nothing to burn — including when the write
    // itself failed, so the graph can never reference a `subs.srt` that is not
    // there. The export then loses its captions rather than failing to start.
    const subtitlesFile = await writeSubtitles(job, req);

    const built = buildExportGraph(req, {
      scriptPath: job.scriptPath,
      outputPath: job.partPath,
      titlePngs,
      subtitlesFile,
    });
    if (!built.ok) return settle(job, 'error', built.error);
    // CREATIVE §4.3, §4.3d — a dissolve the build could honour only in part was
    // exported as a fade. Not a failure and not a reason to stop, but not silent
    // either: it goes to the renderer on the next event AND to the log, because
    // the two readers are different people at different times.
    if (built.graph.notices.length > 0) {
      job.pendingNotices = built.graph.notices;
      for (const note of built.graph.notices) console.warn(`[export] ${note}`);
    }
    job.framesTotal = built.graph.framesTotal;
    job.durationSeconds = built.graph.durationSeconds;
    if (cancelledBeforeSpawn(job)) return;
    emit(job, 'preparing', 0.55, 0);

    // Only graph.sourcePaths is checked. NEVER document.sources: a file used
    // solely by a clip outside the range, or on a track that is both hidden and
    // muted, never reaches the graph and must not fail the export.
    for (const p of built.graph.sourcePaths) {
      try {
        await access(p, FS.R_OK);
      } catch {
        return settle(job, 'error', ERR['source-missing']);
      }
    }
    if (cancelledBeforeSpawn(job)) return;
    emit(job, 'preparing', 0.8, 0);

    // UTF-8, no BOM. A script whose first three bytes are EF BB BF fails with
    // `No such filter: '<U+FEFF>color'` — ffmpeg reads the BOM as part of the
    // first filter's name.
    await writeFile(job.scriptPath, built.graph.filterScript, 'utf8');
    if (cancelledBeforeSpawn(job)) return;
    emit(job, 'preparing', 0.95, 0);

    // §3.3(a) — the spawn and the assignment are ONE statement, so no cancel can
    // interleave between the process existing and job.child referencing it.
    try {
      // `cwd` is what makes `subtitles=filename=subs.srt` resolve (CREATIVE
      // §6.3). It is safe for everything else because every other path in
      // `args` is absolute — the sources came from `MediaItem.path`, the script
      // and the PNGs from `job.jobDir`, and the output from `path.join(folder,
      // …)` with `folder` checked absolute in validation.
      job.child = spawn(ffmpegBinary(), built.graph.args, {
        windowsHide: true,
        cwd: job.jobDir,
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return settle(
        job,
        'error',
        code === 'ENOENT' ? ERR['ffmpeg-missing'] : ERR['encoder-not-started'],
      );
    }
    job.state = 'running';
    const child = job.child;

    child.on('error', (e: NodeJS.ErrnoException) => {
      // Set synchronously: `error` precedes `close`, and onClose reads this.
      job.spawnError = e.code === 'ENOENT' ? ERR['ffmpeg-missing'] : ERR['encoder-not-started'];
      console.error('[export] ffmpeg could not be started', e);
    });
    child.stdout?.on('data', makeProgressReader(job));
    child.stderr?.on('data', (chunk: Buffer) => {
      job.stderrTail = (job.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    child.on('close', (code) => {
      void onClose(job, code);
    });

    // §3.3 — after the spawn statement there are no more cancel boundaries:
    // the sequence emits preparing/1 and hands off to the child's handlers.
    emit(job, 'preparing', 1, 0);
  } catch (e) {
    console.error('[export] preparing failed', e);
    settle(job, 'error', classifyFsError(e, ERR['encoder-not-started']));
  } finally {
    // The §3.1 backstop, narrowed to the pre-spawn window: once a live child
    // exists the close handler is the single settle point, and settling here
    // would orphan a running encoder writing to a hidden .part file. Nothing
    // has been encoded on this branch, so it is not an encoder failure.
    if (job.child === null) settle(job, 'error', ERR['encoder-not-started']);
  }
}

/* --------------------------------------------------------------- §3.5 life */

function teardown(job: Job): void {
  // The renderer went away: kill, clean up, settle without emitting (emit
  // no-ops on a destroyed sender).
  job.cancelRequested = true;
  if (job.child !== null) job.child.kill();
  void removeFile(job.partPath);
  settle(job, 'cancelled');
}

function killEverythingSync(): void {
  for (const job of jobs.values()) {
    job.cancelRequested = true;
    if (job.child !== null) job.child.kill();
    try {
      rmSync(job.partPath, { force: true });
    } catch {
      /* quitting anyway */
    }
    try {
      rmSync(job.jobDir, { force: true, recursive: true });
    } catch {
      /* quitting anyway */
    }
  }
  jobs.clear();
}

/* ------------------------------------------------------------ registration */

export function registerExportIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CH.exportStart);
  ipcMain.removeHandler(CH.exportCancel);

  app.removeListener('before-quit', killEverythingSync);
  app.on('before-quit', killEverythingSync);

  ipcMain.handle(
    CH.exportStart,
    async (event: IpcMainInvokeEvent, req: unknown): Promise<{ jobId: string }> => {
      const id = newJobId();
      const job: Job = {
        id,
        sender: event.sender,
        state: 'preparing',
        cancelRequested: false,
        child: null,
        spawnError: null,
        partPath: '',
        finalPath: '',
        jobDir: path.join(tmpdir(), `ve-export-${id}`),
        scriptPath: path.join(tmpdir(), `ve-export-${id}`, 'filter.txt'),
        framesTotal: 1,
        durationSeconds: 0,
        lastPhase: 'preparing',
        lastProgress: -1,
        lastFramesDone: -1,
        pendingNotices: null,
        stderrTail: '',
        onSenderGone: null,
      };

      // §3.5 — at most one job per WebContents. A second start reports `busy`
      // for the NEW job id and does not disturb the running one.
      for (const other of jobs.values()) {
        if (other.sender === event.sender) {
          jobs.set(id, job);
          emit(job, 'preparing', 0, 0);
          settle(job, 'error', ERR.busy);
          return { jobId: id };
        }
      }

      jobs.set(id, job);
      const gone = () => teardown(job);
      job.onSenderGone = gone;
      event.sender.once('destroyed', gone);

      // exportStart NEVER rejects: a bad request still resolves with a job id
      // and reports the failure through the event stream.
      void runJob(job, req);
      return { jobId: id };
    },
  );

  ipcMain.handle(
    CH.exportCancel,
    async (event: IpcMainInvokeEvent, jobId: unknown): Promise<void> => {
      if (typeof jobId !== 'string') return;
      const job = jobs.get(jobId);
      if (!job || job.state === 'settled') return; // late cancel: silent no-op, emit NOTHING
      if (job.sender !== event.sender) return; // not this window's job: same silent no-op
      job.cancelRequested = true;
      // SIGTERM; TerminateProcess on win32. No emit here, ever — once a child
      // exists the close handler is the single settle point.
      if (job.child !== null) job.child.kill();
    },
  );
}
