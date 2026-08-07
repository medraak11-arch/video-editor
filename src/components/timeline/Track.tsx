/* ---------------------------------------------------------------------------
   Track — one lane of clips.

   It subscribes to `selectClipIdsInTrack`, which returns `clipsByTrack[t]` BY
   REFERENCE (PLAN §3.4). Adding a clip to track 3 therefore re-renders track 3
   and nothing else.

   No handler is passed down to a clip: pointer and keyboard events are
   delegated on the lane viewport and resolved through `data-clip-id`, which is
   what keeps `React.memo` on `Clip` from being defeated by a fresh function
   identity every render (PLAN §8.7).
--------------------------------------------------------------------------- */

import './timeline.css';
import { memo } from 'react';
import type { ReactElement } from 'react';
import type { ClipId, PxPerFrame, TrackId } from '../../types/model';
import { useEditorStore } from '../../state/store';
import { selectClipIdsInTrack } from '../../state/timelineSlice';
import { Clip } from './Clip';

export interface TrackProps {
  trackId: TrackId;
  /** px from the top of the lane content. */
  top: number;
  zoom: PxPerFrame;
  /** The single tab stop among every clip in the timeline, or null. */
  focusedClipId: ClipId | null;
}

export const Track = memo(function Track({
  trackId,
  top,
  zoom,
  focusedClipId,
}: TrackProps): ReactElement | null {
  const track = useEditorStore((s) => s.tracks[trackId]);
  const clipIds = useEditorStore((s) => selectClipIdsInTrack(s, trackId));

  if (!track) return null;

  return (
    <div
      className="tl-lane"
      style={{ top: `${top}px`, height: `${track.height}px` }}
      data-track-id={trackId}
      data-visible={track.visible}
      role="listbox"
      aria-multiselectable="true"
      aria-label={`Track ${track.label}`}
    >
      {clipIds.map((id) => (
        <Clip
          key={id}
          id={id}
          zoom={zoom}
          laneHeight={track.height}
          trackLocked={track.locked}
          trackMuted={track.muted}
          trackHidden={!track.visible}
          focused={id === focusedClipId}
        />
      ))}
    </div>
  );
});
