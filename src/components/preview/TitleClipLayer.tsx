/* ---------------------------------------------------------------------------
   TitleClipLayer — one title clip in the composite, and the selectors that say
   which titles are in it and in what order. CREATIVE §5.1, §5.2.

   THE DEFECT THIS REPLACES. The preview used to draw a title only when it was
   the one clip the <video> pool was pointed at. A title on V2 over footage on
   V1 is the placement §5.1 prescribes, and in that arrangement the preview
   created no canvas at all while the export composited it correctly: §5.2's
   whole thesis, that
   the exported title is pixel for pixel what the user was looking at, failed in
   the ordinary case and failed silently, in the direction where the user
   believes the title is missing and goes looking for the bug in their edit.

   THE RULE NOW, and it is the export's own: a title draws when it is IN RANGE
   ON A VISIBLE VIDEO TRACK, and the stack composites in track order. It is not
   conditioned on the clock clip in any way — the clock clip is a fact about
   which element carries the playback clock and the sound, and it was never a
   fact about what is on screen.

   ORDER IS TAKEN FROM `trackOrder` ITSELF, not from a second list built here.
   `trackOrder` is top-to-bottom (timelineSlice `createDefaultTracks`: the
   default set is V2, V1, A1, A2), and the export composites the video segment
   REVERSED (exportDocument `compositeTracks`), so the last thing overlaid — the
   top of the picture — is the track EARLIEST in `trackOrder`. Both sides
   therefore read one fact, "earlier in trackOrder is higher", and this module
   needs only to sort by that index descending to be bottom-first. There is no
   ordering table here to drift out of step with the graph's, because there is no
   ordering table here at all.
--------------------------------------------------------------------------- */

import type { ReactElement } from 'react';
import { useCallback } from 'react';
import type { ClipId, Frames } from '../../types/model';
import { clipIsTitle } from '../../types/model';
import type { StoreState } from '../../state/types';
import { useEditorStore } from '../../state/store';
import { selectClipIdInTrackAtFrame } from '../../state/timelineSlice';
import { selectPictureClipIdAtFrame } from './pictureClip';
import { ClipFilter } from './ClipFilter';
import { TitleLayer } from './TitleLayer';
import { useClipLayer } from './useClipLayer';

/** Ids are nanoid-based and contain no '|', so this joins and splits losslessly. */
const SEPARATOR = '|';

export type StackSide = 'above' | 'below';

/**
 * The title clips covering `frame` on one side of the clock clip, bottom-first,
 * joined into ONE string.
 *
 * A string, not an array, for the reason every selector in this directory
 * returns a scalar: it runs on every store notification, and a fresh array would
 * fail the identity check and re-render the preview at frame rate whether or not
 * the set of visible titles changed.
 *
 * The split at the clock clip is what keeps the preview honest about the one
 * thing it genuinely cannot do. It draws a single MEDIA clip — the clock clip —
 * so a title that composites BELOW that clip must be drawn below it, where the
 * footage covers it exactly as the file's overlay does. Drawing every title on
 * top would be the same class of lie in the opposite direction: a title the user
 * can see in the preview and cannot find in the file.
 */
export function selectTitleClipIds(s: StoreState, frame: Frames, side: StackSide): string {
  // The split is against the PICTURE clip — the one media clip this surface
  // draws — because the question each title asks is "does the footage cover me".
  // Splitting at the clock clip would be meaningless now that the two differ.
  const pictureId = selectPictureClipIdAtFrame(s, frame);
  const picture = pictureId ? s.clips[pictureId] : undefined;
  // No picture under the playhead at all: there is nothing to be underneath, so
  // every title is drawn, and it is drawn over the bare well.
  const pictureRank = picture ? s.trackOrder.indexOf(picture.trackId) : Number.POSITIVE_INFINITY;

  let found: { rank: number; id: ClipId }[] | null = null;

  for (let rank = 0; rank < s.trackOrder.length; rank += 1) {
    const trackId = s.trackOrder[rank];
    const track = s.tracks[trackId];
    // `visible` is the same gate the picture selector applies and the same one
    // the export document applies when it drops a hidden track's clips.
    if (!track || track.kind !== 'video' || !track.visible) continue;

    const id = selectClipIdInTrackAtFrame(s, trackId, frame);
    if (id === null) continue;
    const clip = s.clips[id];
    if (!clip || !clipIsTitle(clip) || !clip.title) continue;

    // A title on the picture clip's OWN track cannot exist at this frame — clips
    // on a track cannot overlap — so the boundary case is only reachable when
    // there is no picture, where every title is 'above'.
    if ((rank <= pictureRank) !== (side === 'above')) continue;
    (found ??= []).push({ rank, id });
  }

  if (found === null) return '';
  if (found.length > 1) found.sort((a, b) => b.rank - a.rank); // descending = bottom-first
  return found.map((f) => f.id).join(SEPARATOR);
}

/** '' is no titles, not one title with an empty id. */
export const splitTitleClipIds = (joined: string): ClipId[] =>
  joined === '' ? [] : joined.split(SEPARATOR);

export interface TitleClipLayerProps {
  clipId: ClipId;
  scaleToStage: number;
  stageWidth: number;
  stageHeight: number;
}

/**
 * One title, drawn with its OWN clip's opacity, geometry, grade and transition —
 * not the clock clip's. A title is an ordinary clip on a video track (§5.1), so
 * it goes through `useClipLayer` like every other drawn layer and gets the whole
 * chain or none of it.
 */
export function TitleClipLayer({
  clipId,
  scaleToStage,
  stageWidth,
  stageHeight,
}: TitleClipLayerProps): ReactElement | null {
  const clip = useEditorStore(useCallback((s) => s.clips[clipId] ?? null, [clipId]));
  const { style, filterSpec, filterId } = useClipLayer(clip, scaleToStage);

  const spec = clip && clipIsTitle(clip) ? (clip.title ?? null) : null;
  if (spec === null) return null;

  return (
    <>
      {filterSpec !== null ? <ClipFilter id={filterId} spec={filterSpec} /> : null}
      <TitleLayer spec={spec} width={stageWidth} height={stageHeight} style={style} />
    </>
  );
}
