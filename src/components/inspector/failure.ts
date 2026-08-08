/* ---------------------------------------------------------------------------
   Turns a MutationResult refusal into copy a person can act on.

   PLAN §3.4 pins the wording for the timeline's drag ghost; the inspector needs
   the same sentences in a field's error slot, because a `speed` change moves a
   clip's out edge and can be refused for exactly the same reasons (PLAN §2.4
   invariant 4). One sentence, sentence case, no trailing period.
--------------------------------------------------------------------------- */

import { readStore } from '../../state/store';
import type { MoveFailure } from '../../state/timelineSlice';
import type { ClipId } from '../../types/model';

/** The clip that sits immediately after `id` on its own track, if any. */
function nextClipName(id: ClipId): string | null {
  const s = readStore();
  const clip = s.clips[id];
  if (!clip) return null;
  const ids = s.clipsByTrack[clip.trackId];
  if (!ids) return null;
  const at = ids.indexOf(id);
  if (at < 0) return null;
  const nextId = ids[at + 1];
  const next = nextId ? s.clips[nextId] : undefined;
  return next ? next.name : null;
}

export function describeMoveFailure(reason: MoveFailure, ids: readonly ClipId[]): string {
  switch (reason) {
    case 'overlap': {
      const name = ids.length === 1 && ids[0] ? nextClipName(ids[0]) : null;
      return name ? `Blocked by ${name}` : 'Blocked by the next clip';
    }
    case 'no-source':
      return 'End of source media';
    // The lock may be on a clip the user did not select and cannot see from
    // here: a speed change closes over the group, so a linked member on a locked
    // track is in the write set even when nothing the user selected is on one
    // (docs/LINKING.md §5.6). Not a notice, deliberately — ClipPropertyRow calls
    // updateClipProperties on every scrub tick, and the field's error slot is
    // the channel that already exists for exactly this.
    case 'locked': {
      const s = readStore();
      const own = ids.some((id) => {
        const c = s.clips[id];
        return c !== undefined && s.tracks[c.trackId]?.locked === true;
      });
      return own ? 'Track is locked' : 'A linked clip is on a locked track';
    }
    case 'out-of-range':
      return 'Outside the timeline';
    case 'no-track':
      return 'No track for this clip';
    case 'kind-mismatch':
      return 'Wrong track kind for this clip';
    default:
      return 'That change was refused';
  }
}
