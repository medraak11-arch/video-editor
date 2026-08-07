/* ---------------------------------------------------------------------------
   constants.ts — PLAN §7.3, the TypeScript half of the layout tokens.

   Cross-cutting and scaffold-owned. A slice that needs a new constant states
   the exact declaration it needs in its final message (PLAN §0.2); it does not
   add a parallel constant in its own file.
--------------------------------------------------------------------------- */

import type { ExportSettings } from '../types/api';

export const TITLEBAR_HEIGHT = 36;

export const RAIL_DEFAULT = 260;
export const RAIL_MIN = 200;
export const RAIL_MAX = 420;

export const INSPECTOR_WIDTH = 280;

export const MIN_WINDOW = { width: 1024, height: 640 };

export const TIMELINE_DEFAULT_PCT = 0.38;
export const TIMELINE_MIN_PCT = 0.22;
export const TIMELINE_MAX_PCT = 0.65;

export const TRACK_HEAD_WIDTH = 88;
export const RULER_HEIGHT = 28;
export const TIMELINE_TOOLBAR_HEIGHT = 32;

/** Seed defaults for Track.height only — never read at render time (PLAN §2.4). */
export const TRACK_HEIGHT_VIDEO = 56;
export const TRACK_HEIGHT_AUDIO = 40;
export const TRACK_HEIGHT_MIN = 28;
export const TRACK_HEIGHT_MAX = 160;

export const MEDIA_ROW_HEIGHT = 44;
export const MEDIA_THUMB = { width: 32, height: 18 };

export const CLIP_RADIUS = 3;
/** Below this, drop the name. */
export const CLIP_MIN_LABEL_WIDTH = 24;
/** A clip is never painted narrower than this. */
export const CLIP_MIN_RENDER_WIDTH = 2;
/** Its pointer target is never narrower than this. */
export const CLIP_MIN_HIT_WIDTH = 6;

/** SCREEN px. */
export const SNAP_THRESHOLD_PX = 8;
/** Hard cap, so a low zoom cannot make the snap threshold minutes wide. */
export const SNAP_THRESHOLD_MAX_FRAMES = 30;

/** px per frame. ZOOM_MIN fits ~108k frames (1 hour at 30fps) in a 2160px lane. */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 40;
export const ZOOM_STEP = 1.25;
/**
 * Initial `timelineSlice.zoom`. Not in PLAN §7.3's list; added by scaffold because the
 * store needs a starting value and three slices would otherwise each pick one.
 * At 0.25 px/frame a 24 px clip is 96 frames (3.2 s at 30 fps), which is what makes the
 * fixture's sub-24 px clips exercise the degrade path on first load (PLAN §4.4).
 */
export const ZOOM_DEFAULT = 0.25;

/** How far past the last clip the playhead may park. */
export const PLAYHEAD_TAIL_FRAMES = 300;
export const SHUTTLE_REVERSE_MAX_SEEKS_PER_SEC = 15;

/* Timeline motion — DESIGN.md §5's "instrument, not software" exception, made
   reproducible. useReducedMotion() zeroes all four; snapping still lands, instantly. */
/** per animation frame */
export const SCRUB_MOMENTUM_DECAY = 0.94;
/** below this velocity, stop */
export const SCRUB_MOMENTUM_CUTOFF_PX = 0.5;
export const DRAG_INERTIA_MS = 120;
/** maps to var(--ease-out) */
export const SNAP_MAGNET_CURVE = 'ease-out';

export const RESIZER_HIT = 5;
export const RESIZER_KEY_STEP = 16;

export const HISTORY_LIMIT = 100;

/** payload: MediaId */
export const DND_MEDIA_MIME = 'application/x-editor-media';
/** reserved; NOT used — internal clip drags are pointer-events only (PLAN §8.5). */
export const DND_CLIP_MIME = 'application/x-editor-clip';

export const LS_UI_KEY = 've.ui.v1';

/** Output container per codec. The export dialog needs it to show the final filename. */
export const CONTAINER: Record<ExportSettings['codec'], string> = {
  h264: 'mp4',
  h265: 'mp4',
  prores: 'mov',
};
