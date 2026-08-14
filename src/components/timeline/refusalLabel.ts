/* ---------------------------------------------------------------------------
   refusalLabel — PLAN §3.4's table, in the timeline's own words. One sentence,
   sentence case, safe to show verbatim.

   It lived inside `useTimelineInteraction` while the drag ghost and the nudge
   keys were its only two callers. `edit.insertAtPlayhead` is the third, and it
   is not a gesture — so the copy moved here rather than being exported out of a
   hook module, which is the shape the rest of the codebase uses for text that
   several surfaces must not word differently ("one copy of the copy, living in
   the action").

   No React, no DOM: a refusal is a string, and every caller decides for itself
   whether that string becomes a drag badge or a notice.
--------------------------------------------------------------------------- */

import type { ClipId } from '../../types/model';
import type { MoveFailure } from '../../state/timelineSlice';
import type { StoreState } from '../../state/types';

export function refusalLabel(
  s: StoreState,
  reason: MoveFailure,
  blockingClipId: ClipId | null,
): string {
  switch (reason) {
    case 'overlap': {
      const name = blockingClipId ? s.clips[blockingClipId]?.name : undefined;
      return name ? `Blocked by ${name}` : 'Blocked by the next clip';
    }
    // A trim can be refused `locked` because a MEMBER of the group is on a locked
    // track while the clip under the pointer is not, and a bare 'Track is locked'
    // would name a track the user is not touching (docs/LINKING.md §5.3). The
    // planner returns a null `blockingClipId` for the named clip's own track and
    // the member's id for anyone else's, so the two cases are distinguishable here.
    case 'locked': {
      const name = blockingClipId ? s.clips[blockingClipId]?.name : undefined;
      return name ? `${name} is on a locked track` : 'Track is locked';
    }
    case 'out-of-range':
      return 'Start of timeline';
    case 'no-track':
      return 'No track for this media';
    case 'kind-mismatch':
      return 'Video cannot go on an audio track';
    case 'no-source':
      return 'End of source media';
    default:
      return 'That move was refused';
  }
}
