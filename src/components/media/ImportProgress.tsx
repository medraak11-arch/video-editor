/* ---------------------------------------------------------------------------
   ImportProgress — the per-file probe indicator on a media row.

   Determinate, always. The bar is driven by MediaItem.progress, which the probe
   bridge reports through media:probe-progress; nothing here interpolates or
   runs its own timer. The percentage is stated beside the bar in tabular mono,
   so the bar is never the only signal (PLAN §7.7).
--------------------------------------------------------------------------- */

import './media.css';
import type { ReactElement } from 'react';

export interface ImportProgressProps {
  /** 0..1. Values outside the range are clamped rather than trusted. */
  progress: number;
  /** Accessible name for the bar, e.g. 'Importing cliff-jump.mp4'. */
  label: string;
}

export function ImportProgress({ progress, label }: ImportProgressProps): ReactElement {
  const fraction = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const percent = Math.round(fraction * 100);

  return (
    <span className="media-progress">
      <span
        className="media-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%`}
      >
        <span className="media-progress-fill" style={{ transform: `scaleX(${fraction})` }} />
      </span>
      <span className="media-progress-value media-row-muted type-numeric-sm">{percent}%</span>
    </span>
  );
}
