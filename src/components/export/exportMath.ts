/* ---------------------------------------------------------------------------
   The two numbers the export dialog states before you commit: how long the
   output is, and roughly how big it will be.

   The size is computed from a fixed bitrate table (PLAN §8.9), not guessed, so
   the same settings always produce the same figure and the number is
   reproducible by hand.
--------------------------------------------------------------------------- */

import type { ExportSettings } from '../../types/api';
import type { Frames } from '../../types/model';
import type { StoreState } from '../../state/types';
import { selectTimelineDurationFrames } from '../../state/timelineSlice';

export const BITRATE_KBPS: Record<
  ExportSettings['codec'],
  Record<ExportSettings['quality'], number>
> = {
  h264: { draft: 4000, good: 12000, best: 24000 },
  h265: { draft: 2500, good: 8000, best: 16000 },
  prores: { draft: 45000, good: 82000, best: 122000 },
};

const REFERENCE_PIXELS = 1920 * 1080;

export interface ExportRange {
  startFrame: Frames;
  durationFrames: Frames;
}

/**
 * The dialog resolves `range` into absolute frames before calling the bridge —
 * a real ffmpeg-backed bridge cannot know where an in/out range begins
 * otherwise, and the stub and the real bridge must be interchangeable.
 */
export function resolveExportRange(s: StoreState, range: ExportSettings['range']): ExportRange {
  const useInOut = range === 'inout';
  const startFrame = useInOut && s.inPoint !== null ? s.inPoint : 0;
  const endFrame =
    useInOut && s.outPoint !== null ? s.outPoint + 1 : selectTimelineDurationFrames(s);
  return { startFrame, durationFrames: Math.max(1, endFrame - startFrame) };
}

/**
 * `durationSeconds` is the range measured at the PROJECT frame rate: the length
 * of the cut does not change because a different output rate was chosen.
 */
export function estimateBytes(
  settings: Pick<ExportSettings, 'codec' | 'quality' | 'width' | 'height'>,
  durationSeconds: number,
): number {
  const kbps = BITRATE_KBPS[settings.codec][settings.quality];
  const pixelScale = (settings.width * settings.height) / REFERENCE_PIXELS;
  return ((kbps * 1000) / 8) * durationSeconds * pixelScale;
}

/** Decimal units, matching the decimal bitrate the estimate is built from. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / 1_000_000;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (mb < 1000) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1000).toFixed(2)} GB`;
}

/** '29.97', '30' — the exact stored decimal, without trailing zeros. */
export function formatFps(fps: number): string {
  return String(Number(fps.toFixed(3)));
}
