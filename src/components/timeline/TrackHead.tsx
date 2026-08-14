/* ---------------------------------------------------------------------------
   TrackHead — 88px of fixed column, one per lane.

   The track identifier is the only uppercase string permitted in the interface
   (DESIGN.md §3), and it is a name rather than styling — it is written `V1` in
   the data, not upper-cased in CSS.

   Every toggle carries a DISTINCT ICON per state (Volume2/VolumeX,
   LockOpen/Lock, Eye/EyeOff), so state never depends on colour. These are the
   only three controls in the build that set `accentWhenPressed` — accent use 5
   of the six in PLAN §7.4.

   THE FADER (CREATIVE §1.4) sits under those three, on EVERY track — not only
   on the audio ones. A video track carries audio in this model (`clipHasAudio`
   is true for an `av` clip on V1), so a fader gated on `track.kind === 'audio'`
   would be missing from exactly the lane most of the programme's sound is on.

   It is hidden below DENSE_HEIGHT, where there is no room for a third row, and
   the value stays reachable there through the track context menu — which is
   also the keyboard route to it, and the reason this component now answers to
   ContextMenu / Shift+F10 the way a focused clip already does.
--------------------------------------------------------------------------- */

import './timeline.css';
import { memo, useCallback } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  RefObject,
} from 'react';
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from 'lucide-react';
import type { TrackId } from '../../types/model';
import { trackVolume } from '../../types/model';
import { Fader, IconButton } from '../ui';
import { readStore, useEditorStore } from '../../state/store';
import type { TrackContextMenuHandle } from './TrackContextMenu';

/** Below this the head puts its label and its toggles on adjacent rows with no gap. */
const DENSE_HEIGHT = 48;

/**
 * The height at which the fader actually fits, MEASURED from its three rows
 * rather than assumed: an 11px label at the label step's 1.3 line height is
 * 14.3px, a `size="sm"` IconButton is 24px, and `.ve-fader` is 14px. That is
 * 52.3px of content, so 53 is the first height at which nothing spills into the
 * lane below.
 *
 * CREATIVE §1.4 names DENSE_HEIGHT (48) as the threshold, and the REASON it
 * gives is "where there is no room". It was written before the Fader had a
 * height; at 48px there is still no room, by 4.3px. This is that sentence's
 * reason applied to the component that now exists, not a departure from it —
 * and nothing is lost, because §1.4's own fallback covers every height below
 * this one: the value stays reachable, and keyboard-reachable, in the track
 * context menu. The 48-52px band simply joins the band that already uses it.
 *
 * Reported to the planner rather than left as a silent adjustment.
 */
const FADER_MIN_HEIGHT = 53;

/**
 * Above this the three rows have slack, so they take the standard hair gap.
 * Between FADER_MIN_HEIGHT and here the gaps are what give way — they are the
 * only thing in the head carrying no information.
 */
const ROOMY_HEIGHT = 64;

/** Inset of the keyboard-opened menu from the head's bottom-left corner. */
const GAP_FROM_HEAD = 8;

export interface TrackHeadProps {
  trackId: TrackId;
  /** px from the top of the head column content. */
  top: number;
  /**
   * The one shared track menu, mounted by Timeline. A ref object is stable, so
   * `memo` still holds — this is deliberately not a callback prop.
   */
  menu: RefObject<TrackContextMenuHandle | null>;
}

export const TrackHead = memo(function TrackHead({
  trackId,
  top,
  menu,
}: TrackHeadProps): ReactElement | null {
  const track = useEditorStore((s) => s.tracks[trackId]);
  const toggleMute = useEditorStore((s) => s.toggleMute);
  const toggleLock = useEditorStore((s) => s.toggleLock);
  const toggleVisible = useEditorStore((s) => s.toggleVisible);
  const setTrackVolume = useEditorStore((s) => s.setTrackVolume);

  const onMute = useCallback(() => toggleMute(trackId), [toggleMute, trackId]);
  const onLock = useCallback(() => toggleLock(trackId), [toggleLock, trackId]);
  const onVisible = useCallback(() => toggleVisible(trackId), [toggleVisible, trackId]);
  const onVolume = useCallback(
    (next: number) => setTrackVolume(trackId, next),
    [setTrackVolume, trackId],
  );

  /** The menu opens on the head, so it acts at the playhead rather than at a pointer. */
  const openMenu = useCallback(
    (element: HTMLElement, top: number, left: number): void => {
      element.focus({ preventScroll: true });
      menu.current?.openAt(trackId, readStore().playhead, top, left);
    },
    [menu, trackId],
  );

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      openMenu(event.currentTarget, event.clientY, event.clientX);
    },
    [openMenu],
  );

  // Both platform conventions, exactly as the lane already answers for a clip:
  // the menu is the keyboard route to the fader on a dense track, so it cannot
  // be pointer-only. The listener sits on the head and catches the keydown
  // bubbling out of whichever toggle holds focus.
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu(event.currentTarget, rect.bottom - GAP_FROM_HEAD, rect.left + GAP_FROM_HEAD);
    },
    [openMenu],
  );

  if (!track) return null;

  const dense = track.height < DENSE_HEIGHT;
  const showFader = track.height >= FADER_MIN_HEIGHT;
  const gain = trackVolume(track);

  const states: string[] = [];
  if (track.muted) states.push('muted');
  if (track.locked) states.push('locked');
  if (!track.visible) states.push('hidden');

  return (
    <div
      className="tl-head"
      style={{ top: `${top}px`, height: `${track.height}px` }}
      data-track-id={trackId}
      data-dense={dense}
      data-compact={track.height < ROOMY_HEIGHT}
      data-locked={track.locked}
      data-hidden={!track.visible}
      role="group"
      aria-label={`Track ${track.label}${states.length > 0 ? `, ${states.join(', ')}` : ''}`}
      tabIndex={-1}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
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

      {/* CREATIVE §1.4: not rendered at all where it does not fit — the caller
          decides that, not the Fader. `muted` does NOT disable it: mute is a
          separate, restorable state, and a fader that went dead while a track
          was muted would lose the value the user set before muting it. */}
      {showFader ? (
        <div className="tl-head-fader">
          <Fader value={gain} onChange={onVolume} label={`track ${track.label}`} />
        </div>
      ) : null}
    </div>
  );
});
