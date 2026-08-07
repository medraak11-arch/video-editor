/* ---------------------------------------------------------------------------
   TrackHead — 88px of fixed column, one per lane.

   The track identifier is the only uppercase string permitted in the interface
   (DESIGN.md §3), and it is a name rather than styling — it is written `V1` in
   the data, not upper-cased in CSS.

   Every toggle carries a DISTINCT ICON per state (Volume2/VolumeX,
   LockOpen/Lock, Eye/EyeOff), so state never depends on colour. These are the
   only three controls in the build that set `accentWhenPressed` — accent use 5
   of the six in PLAN §7.4.
--------------------------------------------------------------------------- */

import './timeline.css';
import { memo, useCallback } from 'react';
import type { ReactElement } from 'react';
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from 'lucide-react';
import type { TrackId } from '../../types/model';
import { IconButton } from '../ui';
import { useEditorStore } from '../../state/store';

/** Below this the head puts its label and its toggles on adjacent rows with no gap. */
const DENSE_HEIGHT = 48;

export interface TrackHeadProps {
  trackId: TrackId;
  /** px from the top of the head column content. */
  top: number;
}

export const TrackHead = memo(function TrackHead({
  trackId,
  top,
}: TrackHeadProps): ReactElement | null {
  const track = useEditorStore((s) => s.tracks[trackId]);
  const toggleMute = useEditorStore((s) => s.toggleMute);
  const toggleLock = useEditorStore((s) => s.toggleLock);
  const toggleVisible = useEditorStore((s) => s.toggleVisible);

  const onMute = useCallback(() => toggleMute(trackId), [toggleMute, trackId]);
  const onLock = useCallback(() => toggleLock(trackId), [toggleLock, trackId]);
  const onVisible = useCallback(() => toggleVisible(trackId), [toggleVisible, trackId]);

  if (!track) return null;

  const states: string[] = [];
  if (track.muted) states.push('muted');
  if (track.locked) states.push('locked');
  if (!track.visible) states.push('hidden');

  return (
    <div
      className="tl-head"
      style={{ top: `${top}px`, height: `${track.height}px` }}
      data-track-id={trackId}
      data-dense={track.height < DENSE_HEIGHT}
      data-locked={track.locked}
      data-hidden={!track.visible}
      role="group"
      aria-label={`Track ${track.label}${states.length > 0 ? `, ${states.join(', ')}` : ''}`}
      tabIndex={-1}
    >
      <span className="tl-head-label type-label">{track.label}</span>
      <div className="tl-head-toggles">
        <IconButton
          size="sm"
          icon={
            track.muted ? (
              <VolumeX size={14} strokeWidth={1.75} />
            ) : (
              <Volume2 size={14} strokeWidth={1.75} />
            )
          }
          label={track.muted ? `Unmute track ${track.label}` : `Mute track ${track.label}`}
          pressed={track.muted}
          accentWhenPressed
          onClick={onMute}
        />
        <IconButton
          size="sm"
          icon={
            track.locked ? (
              <Lock size={14} strokeWidth={1.75} />
            ) : (
              <LockOpen size={14} strokeWidth={1.75} />
            )
          }
          label={track.locked ? `Unlock track ${track.label}` : `Lock track ${track.label}`}
          pressed={track.locked}
          accentWhenPressed
          onClick={onLock}
        />
        <IconButton
          size="sm"
          icon={
            track.visible ? (
              <Eye size={14} strokeWidth={1.75} />
            ) : (
              <EyeOff size={14} strokeWidth={1.75} />
            )
          }
          label={track.visible ? `Hide track ${track.label}` : `Show track ${track.label}`}
          pressed={!track.visible}
          accentWhenPressed
          onClick={onVisible}
        />
      </div>
    </div>
  );
});
