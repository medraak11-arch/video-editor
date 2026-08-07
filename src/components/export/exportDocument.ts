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

import type { ExportDocument, ExportSource } from '../../types/api';
import type { Clip, MediaId, Track } from '../../types/model';
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
    if (seen.has(clip.mediaId)) continue;
    seen.add(clip.mediaId);
    const item = s.items[clip.mediaId];
    if (item === undefined) continue;
    out.push({
      mediaId: item.id,
      path: item.path,
      kind: item.kind,
      // A property of the FILE, not of the edit. Every dev-media fixture has an
      // audio stream even though its content is silence; whether a clip is
      // audible is decided by `volume` and the track's `muted` flag.
      hasAudio: item.hasAudio,
      durationFrames: item.durationFrames,
      width: item.width,
      height: item.height,
    });
  }
  return out;
}

export function buildExportDocument(s: StoreState): ExportDocument {
  const clips = Object.values(s.clips);
  return {
    fps: s.fps,
    width: s.width,
    height: s.height,
    tracks: compositeTracks(s),
    clips,
    sources: referencedSources(s, clips),
  };
}
