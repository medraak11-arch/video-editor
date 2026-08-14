/* ---------------------------------------------------------------------------
   titleCommand — "add a title at the playhead", written once (CREATIVE §5).

   Three surfaces reach for it: the timeline toolbar button, the `T` binding,
   and — with an explicit track and frame — the track context menu. Only the
   first two need to CHOOSE a track, and they must choose it identically or the
   button and the key would put the title on different lanes.

   The choice is deliberately dumb and explainable: the selected clip's own
   track when that is an unlocked video track, otherwise the first unlocked
   video track. A title belongs on a video track above the footage (§5.1), and
   "wherever you were already working" is the answer that needs no rule learnt.

   The refusal is raised HERE rather than at the call sites, so the button and
   the keystroke cannot explain themselves differently (PLAN §5, §3.4).
--------------------------------------------------------------------------- */

import { flushSync } from 'react-dom';
import type { ClipId, TrackId } from '../../types/model';
import { readStore } from '../../state/store';
import type { StoreState } from '../../state/types';

/** The lane a title would land on right now, or null when there is none. */
export function titleTargetTrackId(s: StoreState): TrackId | null {
  const usable = (id: TrackId | undefined): boolean => {
    const track = id ? s.tracks[id] : undefined;
    return track !== undefined && track.kind === 'video' && !track.locked;
  };

  // Where the user already is. `selection` is unordered, so the FOCUSED clip is
  // asked first and the selection only breaks a tie — otherwise a two-clip
  // selection would pick a different lane on different runs.
  const focused = document
    .querySelector<HTMLElement>('.tl-lane-content [data-clip-id]:focus')
    ?.dataset.clipId;
  const preferred = focused ?? [...s.selection][0];
  const preferredTrack = preferred ? s.clips[preferred]?.trackId : undefined;
  if (usable(preferredTrack)) return preferredTrack as TrackId;

  return s.trackOrder.find(usable) ?? null;
}

/**
 * Adds a title at the playhead and leaves it selected and focused.
 *
 * Flushed, because the caller's next act is to put focus on the new clip and
 * React has not rendered it yet — the same reason the track menu flushes.
 */
export function addTitleAtPlayhead(): void {
  const s = readStore();
  const trackId = titleTargetTrackId(s);
  if (trackId === null) {
    s.setNotice({
      tone: 'danger',
      title: 'Could not add title',
      message: 'Titles go on a video track, and every video track is locked',
    });
    return;
  }

  const created: { id: ClipId | null } = { id: null };
  flushSync(() => {
    created.id = readStore().addTitleClip(trackId, Math.max(0, Math.round(s.playhead)));
  });
  const id = created.id;
  if (id === null) {
    s.setNotice({
      tone: 'danger',
      title: 'Could not add title',
      message: 'Another clip already occupies the playhead on that track',
    });
    return;
  }

  readStore().select(id, 'replace');
  // `preventScroll` because `.tl-lanes` scroll is store-owned (PLAN §8.6); the
  // focus event bubbles to the lane viewport, which moves the roving tab stop
  // onto the new clip and reveals it through the store.
  document
    .querySelector<HTMLElement>(`.tl-lane-content [data-clip-id="${id}"]`)
    ?.focus({ preventScroll: true });
}
