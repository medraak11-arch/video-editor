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
    case 'locked':
      return 'Track is locked';
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
