/* ---------------------------------------------------------------------------
   insertCommand — "insert the selection at the playhead", CREATIVE §12.

   The KEYBOARD half of insert. It is deliberately NOT a keyboard version of the
   drag: the nudge keys stay ordinary moves that refuse on overlap, because
   making the most casual key in the application able to rearrange the timeline
   is the thing §12.2 spent a section preventing. This is a named command with
   an explicit key instead — you cannot arrive here by drifting one frame too
   far.

   It is the THIRD caller of `planInsert`, after the drag ghost and the drop, and
   that is the whole reason that planner is pure and exported: the cascade, the
   lock rule, the link closure and the "source gap stays open" decision are
   computed in exactly one place, and this file contributes none of them. What it
   contributes is the one thing the drag gets from the pointer and the keyboard
   has to derive — WHERE to put the clips.
--------------------------------------------------------------------------- */

import type { ClipId, Frames, TrackId } from '../../types/model';
import { readStore } from '../../state/store';
import { selectLinkedClosure } from '../../state/timelineSlice';
import type { StoreState } from '../../state/types';
import { refusalLabel } from './refusalLabel';

export interface SelectionInsert {
  /** The selection itself. `insertClips` takes its own link closure from these. */
  ids: ClipId[];
  /** Translation that puts the selection's LEADING EDGE on the playhead. */
  delta: Frames;
  /** Only ever decides which lane list an offset applies to; the offset is 0 here. */
  primaryTrackId: TrackId | undefined;
}

/**
 * What an insert-at-playhead would do, or null when there is nothing selected.
 *
 * Exported because two callers need it and they MUST agree: the command below,
 * and the context-menu item that has to decide whether to enable itself and
 * why. A menu that computed its own delta would eventually offer an enabled item
 * that then refused, or grey out one that would have worked.
 *
 * THE ANCHOR IS THE EARLIEST START IN THE LINK CLOSURE, not in the selection.
 * `insertClips` closes over links itself, so selecting one half of a linked pair
 * moves both — and an anchor computed over the selection alone would land the
 * WRONG member on the playhead whenever the unselected one starts earlier. On an
 * ungrouped timeline the closure is the selection and this costs one pass.
 */
export function selectionInsert(s: StoreState): SelectionInsert | null {
  const ids = [...s.selection];
  if (ids.length === 0) return null;

  const closure = selectLinkedClosure(s, ids);
  let earliest: Frames | null = null;
  for (const id of closure) {
    const clip = s.clips[id];
    if (!clip) continue;
    if (earliest === null || clip.start < earliest) earliest = clip.start;
  }
  if (earliest === null) return null;

  // Kind-scoping makes `primaryTrackId` matter only when the track offset is
  // non-zero, and it is 0 here — "on each clip's own track" — so every member
  // resolves to its own lane whatever this is (docs/LINKING.md §5.2b). Resolved
  // honestly anyway, so all three callers of `insertClips` pass the same shape.
  const primaryTrackId = s.clips[ids[0]]?.trackId;

  return { ids, delta: Math.round(s.playhead) - earliest, primaryTrackId };
}

/**
 * Places the selection at the playhead on each clip's own track, pushing
 * whatever is in the way by §12.3's cascade. Refuses whole, and raises the
 * refusal itself so the command and the menu item cannot word it differently.
 *
 * ONE history entry, and it needs no transaction: `insertClips` snapshots once
 * and writes the moved and the displaced clips in a single pass.
 */
export function insertSelectionAtPlayhead(): void {
  const store = readStore();
  const plan = selectionInsert(store);
  if (plan === null) {
    store.setNotice({
      tone: 'danger',
      title: 'Could not insert',
      message: 'Select a clip first',
    });
    return;
  }

  const result = store.insertClips(plan.ids, plan.delta, 0, plan.primaryTrackId);
  if (result.ok) return;

  // `blockingClipId` is not available on a MutationResult — only `planInsert`
  // carries it — so the label falls to its unnamed wording ("Blocked by the next
  // clip"). That is the honest reading here anyway: a command aimed at the
  // playhead has no single clip under a pointer to name.
  store.setNotice({
    tone: 'danger',
    title: 'Could not insert',
    message: refusalLabel(readStore(), result.reason, null),
  });
}
