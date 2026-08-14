/* ---------------------------------------------------------------------------
   exportDocument.ts — the timeline, flattened for the encoder. EXPORT §6.

   A read-only adapter. It lives in the export folder, reads the store and
   copies plain data out of it; it edits no slice and calls no action. The
   result is handed straight to `ExportBridge.start` and therefore crosses the
   structured-clone boundary, so every value here is a plain object, array,
   string or number — `Selection` is a Set and is deliberately absent.

   IT DOES NOT FILTER. Not by range, not by track flags (`visible`, `muted`),
   not by `opacity`/`volume`, not by offline status. Exclusion has exactly one
   implementation, in electron/export/graph.ts (EXPORT §1.9), so that the rules
   can be exercised without a browser and cannot drift between two copies.

   The one transform it does perform is track order, and it is NOT a reverse —
   see below.
--------------------------------------------------------------------------- */

import type { ExportDocument, ExportSource, ExportTitle } from '../../types/api';
import type { Clip, MediaId, Track } from '../../types/model';
import { clipIsTitle, clipUsesMedia, DEFAULT_SUBTITLE_STYLE } from '../../types/model';
import { drawTitle } from '../../lib/titleRaster';
import type { StoreState } from '../../state/types';

/**
 * COMPOSITE order: video tracks bottom-first, then audio tracks in `trackOrder`
 * order (EXPORT §1.6). `trackOrder` is top-to-bottom with video above audio, so
 * a plain `[...trackOrder].reverse()` would yield audio first and the video
 * stack still needing its own reversal. Reversing ONLY the video segment is the
 * transform the graph builder's input-assignment passes walk.
 *
 * `filter` already allocates, so the `reverse` mutates that copy and never
 * `s.trackOrder` itself.
 */
function compositeTracks(s: StoreState): Track[] {
  const vids = s.trackOrder.filter((id) => s.tracks[id]?.kind === 'video').reverse();
  const auds = s.trackOrder.filter((id) => s.tracks[id]?.kind === 'audio');
  return [...vids, ...auds].map((id) => s.tracks[id]);
}

/**
 * One `ExportSource` per `MediaId` any clip references — not one per library
 * item. A media item nobody cut with is not part of this export and must not be
 * access-checked as if it were.
 *
 * `path` is the absolute filesystem path, never `MediaItem.url` (a
 * 've-media://' URL, which exists for Chromium and which ffmpeg cannot open).
 * `fps` is not carried: no frame calculation may read it (PLAN §2.4).
 *
 * A `mediaId` with no item in the library yields no source, and the graph
 * builder reports that as `source-missing` — which is the truth, and is a
 * decision for one place rather than two.
 */
function referencedSources(s: StoreState, clips: readonly Clip[]): ExportSource[] {
  const seen = new Set<MediaId>();
  const out: ExportSource[] = [];
  for (const clip of clips) {
    // A title clip carries `mediaId: ''` and resolves NOTHING (CREATIVE §5.1).
    // `clipUsesMedia` is the predicate that exists for this; without it every
    // title would produce a lookup miss that the graph builder reports as
    // `source-missing`, and one title would refuse the whole export.
    if (!clipUsesMedia(clip)) continue;
    if (seen.has(clip.mediaId)) continue;
    seen.add(clip.mediaId);
    const item = s.items[clip.mediaId];
    if (item === undefined) continue;
    out.push({
      mediaId: item.id,
      path: item.path,
      kind: item.kind,
      // A property of the FILE, not of the edit. Every dev-media fixture has an
      // audio stream, and since the fixture rework each one carries an audible
      // signature; whether a clip is audible in the export is still decided by
      // `volume` and the track's `muted` flag, never by the content.
      hasAudio: item.hasAudio,
      durationFrames: item.durationFrames,
      width: item.width,
      height: item.height,
    });
  }
  return out;
}

/* --------------------------------------------------- CREATIVE §5.2 titles ---
   ONE rasteriser, used twice. The preview draws a title with `drawTitle` onto a
   <canvas> over the video; the export draws it with THE SAME FUNCTION onto an
   OffscreenCanvas at PROJECT resolution, right here, and ships the PNG. Main
   feeds it to ffmpeg as an ordinary `-loop 1` input.

   That is why this file is now async, and it is worth it: the alternative is
   `drawtext`, which means font resolution, `:` and `\` escaping inside a filter
   script, no web font, no kerning parity, and a preview drawn by Chromium that
   will never agree with a file drawn by freetype — a disagreement that is
   invisible at caption size and glaring at title size, which is the size titles
   are. Rasterising costs one input per title clip and a few hundred KB of IPC,
   and buys a title that is pixel for pixel what the user was looking at.

   ONE ENTRY PER TITLE CLIP IN THE PROJECT, not per clip in range: the builder
   filters by range, and an unused entry costs an unread map lookup.

   A title that cannot be rasterised is DROPPED rather than thrown: the graph
   omits a title clip with no raster, so the failure costs one title and not the
   export. `OffscreenCanvas` is absent from no browser this app runs in, but it
   is absent from a jsdom test environment, which is the realistic way to arrive
   here without one. */

/** ArrayBuffer → base64, WITHOUT a `data:` prefix (api.ts, ExportTitle.png). */
function toBase64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a
  // 4K title, which is several megabytes of pixels before PNG compression.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function rasteriseTitles(s: StoreState, clips: readonly Clip[]): Promise<ExportTitle[]> {
  const out: ExportTitle[] = [];
  if (typeof OffscreenCanvas === 'undefined') return out;

  const w = Math.max(2, Math.round(s.width));
  const h = Math.max(2, Math.round(s.height));

  for (const clip of clips) {
    if (!clipIsTitle(clip) || clip.title === undefined) continue;
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (ctx === null) continue;
      drawTitle(ctx, clip.title, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      out.push({ clipId: clip.id, png: toBase64(bytes), width: w, height: h });
    } catch {
      // Nothing to say to the user here: the export continues without this
      // title, and a title that vanishes is visible in the file itself.
    }
  }
  return out;
}

export async function buildExportDocument(s: StoreState): Promise<ExportDocument> {
  const clips = Object.values(s.clips);
  return {
    fps: s.fps,
    width: s.width,
    height: s.height,
    tracks: compositeTracks(s),
    clips,
    sources: referencedSources(s, clips),
    titles: await rasteriseTitles(s, clips),
    // Project-level and unfiltered, exactly as the clips are: the builder
    // offsets them by the export range and clips them to it, in one place.
    subtitles: Object.values(s.subtitles ?? {}).sort((a, b) => a.start - b.start || a.end - b.end),
    subtitleStyle: s.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE,
  };
}
