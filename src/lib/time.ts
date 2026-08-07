/* ---------------------------------------------------------------------------
   time.ts — PLAN §2.1. The one conversion point between frames, seconds and
   timecode. Signatures are final.

   Timecode is non-drop-frame: FF counts 0 … ceil(fps)-1. Frame rates are stored
   as the exact decimal (23.976, 29.97) and are never rounded on the way in.
--------------------------------------------------------------------------- */

import type { Frames, PxPerFrame, Seconds } from '../types/model';

/** Frame-count denominator for timecode: FF counts 0 … ceil(fps)-1. */
const timecodeBase = (fps: number): number => {
  const base = Math.ceil(fps - 1e-6);
  return base > 0 ? base : 1;
};

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');

export function framesToSeconds(frames: Frames, fps: number): Seconds {
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return frames / fps;
}

export function secondsToFrames(seconds: Seconds, fps: number): Frames {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(seconds)) return 0;
  return Math.round(seconds * fps);
}

/** "HH:MM:SS:FF" */
export function framesToTimecode(frames: Frames, fps: number): string {
  const base = timecodeBase(fps);
  const total = Math.max(0, Math.round(frames));
  const ff = total % base;
  const totalSeconds = Math.floor(total / base);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/**
 * Accepts HH:MM:SS:FF, MM:SS:FF, SS:FF and bare FF, tolerating `.` or `;` as the frame
 * separator. Returns null (not NaN, not 0) on anything else. MM/SS >= 60 and FF >= fps
 * are invalid, not wrapped.
 */
export function timecodeToFrames(tc: string, fps: number): Frames | null {
  if (typeof tc !== 'string') return null;
  const trimmed = tc.trim();
  if (trimmed === '') return null;

  // Normalise the frame separator, then require plain digits between colons.
  const normalised = trimmed.replace(/[.;]/g, ':');
  const parts = normalised.split(':');
  if (parts.length < 1 || parts.length > 4) return null;
  if (!parts.every((p) => /^\d{1,3}$/.test(p))) return null;

  const base = timecodeBase(fps);
  const nums = parts.map((p) => Number(p));

  let hh = 0;
  let mm = 0;
  let ss = 0;
  let ff = 0;

  if (nums.length === 4) [hh, mm, ss, ff] = nums as [number, number, number, number];
  else if (nums.length === 3) [mm, ss, ff] = nums as [number, number, number];
  else if (nums.length === 2) [ss, ff] = nums as [number, number];
  else [ff] = nums as [number];

  if (mm >= 60 || ss >= 60) return null;
  if (ff >= base) return null;

  return ((hh * 60 + mm) * 60 + ss) * base + ff;
}

/** "1:23" / "1:02:03" — a human duration, not a timecode. */
export function framesToDuration(frames: Frames, fps: number): string {
  const totalSeconds = Math.max(0, Math.floor(framesToSeconds(Math.round(frames), fps)));
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

export function clampFrames(f: Frames, min: Frames, max: Frames): Frames {
  if (max < min) return min;
  return f < min ? min : f > max ? max : f;
}

export function framesToPx(frames: Frames, zoom: PxPerFrame): number {
  return frames * zoom;
}

/** Math.round. NEVER use inside an accumulating calculation — see pxToFramesExact. */
export function pxToFrames(px: number, zoom: PxPerFrame): Frames {
  return Math.round(pxToFramesExact(px, zoom));
}

/** No rounding. For zoom anchoring and any accumulating maths (PLAN §3.4 zoomAround). */
export function pxToFramesExact(px: number, zoom: PxPerFrame): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 0;
  return px / zoom;
}

/** Math.round, >= 0. */
export function snapToFrame(f: number): Frames {
  const r = Math.round(f);
  return r < 0 ? 0 : r;
}

/** The one rounding rule for second-sized jumps. Preview and inspector both call this. */
export function secondStepFrames(fps: number): Frames {
  const step = Math.round(fps);
  return step > 0 ? step : 1;
}
