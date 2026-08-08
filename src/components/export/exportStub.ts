/* ---------------------------------------------------------------------------
   exportStub — the `dev:web` export bridge, and nothing else.

   `npm run dev:web` has no main process, so `getEditorAPI().export` is
   undefined and ExportDialog falls back here. Inside Electron the real
   ffmpeg-backed bridge (electron/ipc/export.ts) is defined and this module is
   never reached. It is therefore NOT deleted when that bridge lands — see
   EXPORT.md, "What replaces what".

   The stub simulates an encode; the progress it reports is real. It counts
   actual elapsed time against an actual frame total and emits what it has
   genuinely reached, `cancel` genuinely stops it, and the dialog above it never
   interpolates, never runs a timer of its own and never shows a number the
   bridge did not send. When the real bridge lands, `getEditorAPI().export`
   becomes defined, this module stops being reached, and NOTHING in the UI
   changes.
--------------------------------------------------------------------------- */

import type { ExportBridge, ExportProgressEvent, ExportRequest } from '../../types/api';
import { isAudioOnlyCodec } from '../../types/api';

/** Wall-clock shape of the simulated encode. */
const PREPARE_MS = 450;
const FINALIZE_MS = 350;
const MS_PER_FRAME = 6;
const ENCODE_MIN_MS = 1500;
const ENCODE_MAX_MS = 12000;
/** Roughly 15 events per second: enough to look live, few enough to be cheap. */
const EMIT_INTERVAL_MS = 66;

type Phase = ExportProgressEvent['phase'];

interface Job {
  id: string;
  framesTotal: number;
  encodeMs: number;
  startedAt: number;
  raf: number | null;
  lastEmit: number;
  framesDone: number;
  progress: number;
  phase: Phase;
}

const listeners = new Set<(event: ExportProgressEvent) => void>();
const jobs = new Map<string, Job>();
let counter = 0;

function emit(job: Job, phase: Phase, progress: number, framesDone: number, message?: string): void {
  job.phase = phase;
  job.progress = progress;
  job.framesDone = framesDone;
  const event: ExportProgressEvent = {
    jobId: job.id,
    phase,
    progress,
    framesDone,
    framesTotal: job.framesTotal,
    ...(message === undefined ? {} : { message }),
  };
  for (const listener of listeners) listener(event);
}

function stop(job: Job): void {
  if (job.raf !== null) {
    cancelAnimationFrame(job.raf);
    job.raf = null;
  }
  jobs.delete(job.id);
}

function tick(job: Job, now: number): void {
  const elapsed = now - job.startedAt;

  if (elapsed < PREPARE_MS) {
    if (now - job.lastEmit >= EMIT_INTERVAL_MS) {
      job.lastEmit = now;
      emit(job, 'preparing', elapsed / PREPARE_MS, 0);
    }
    return;
  }

  const encodeElapsed = elapsed - PREPARE_MS;
  if (encodeElapsed < job.encodeMs) {
    const fraction = encodeElapsed / job.encodeMs;
    const framesDone = Math.min(job.framesTotal, Math.floor(job.framesTotal * fraction));
    if (now - job.lastEmit >= EMIT_INTERVAL_MS || job.phase !== 'encoding') {
      job.lastEmit = now;
      emit(job, 'encoding', fraction, framesDone);
    }
    return;
  }

  const finalizeElapsed = encodeElapsed - job.encodeMs;
  if (finalizeElapsed < FINALIZE_MS) {
    if (now - job.lastEmit >= EMIT_INTERVAL_MS || job.phase !== 'finalizing') {
      job.lastEmit = now;
      emit(job, 'finalizing', finalizeElapsed / FINALIZE_MS, job.framesTotal);
    }
    return;
  }

  emit(job, 'done', 1, job.framesTotal);
  stop(job);
}

function schedule(job: Job): void {
  job.raf = requestAnimationFrame((now) => {
    job.raf = null;
    if (!jobs.has(job.id)) return;
    tick(job, now);
    if (jobs.has(job.id)) schedule(job);
  });
}

export const exportStub: ExportBridge = {
  /** Takes the full `ExportRequest` and ignores `document`: there is no graph to build
      here, and a stub that refused the field the real bridge requires would not be
      interchangeable with it. */
  start(req: ExportRequest): Promise<{ jobId: string }> {
    counter += 1;
    // An audio-only export has no output frames, so it reports 0 — the same
    // number the real bridge reports (AUDIO-FEATURES §2.8). The encode's wall
    // clock still comes from the range, because there is still a range.
    const rangeFrames = Math.max(1, Math.round(req.durationFrames));
    const framesTotal = isAudioOnlyCodec(req.codec) ? 0 : rangeFrames;
    const job: Job = {
      id: `stub_${counter}`,
      framesTotal,
      encodeMs: Math.min(ENCODE_MAX_MS, Math.max(ENCODE_MIN_MS, rangeFrames * MS_PER_FRAME)),
      startedAt: performance.now(),
      raf: null,
      lastEmit: 0,
      framesDone: 0,
      progress: 0,
      phase: 'preparing',
    };
    jobs.set(job.id, job);
    emit(job, 'preparing', 0, 0);
    schedule(job);
    return Promise.resolve({ jobId: job.id });
  },

  cancel(jobId: string): Promise<void> {
    const job = jobs.get(jobId);
    if (!job) return Promise.resolve();
    stop(job);
    emit(job, 'cancelled', job.progress, job.framesDone);
    return Promise.resolve();
  },

  onProgress(cb: (event: ExportProgressEvent) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};
