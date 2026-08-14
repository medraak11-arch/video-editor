/* ---------------------------------------------------------------------------
   cueCommand — "add a subtitle cue at the playhead", CREATIVE §6.6.

   The producer half of the cue-focus protocol documented on `uiSlice.focusCueId`.
   It only ever SETS the request; the inspector row clears it the moment it takes
   focus, because only the consumer knows the focus actually landed.

   THE COMMAND IS "CREATE AND FOCUS", NOT "CREATE". A binding that adds a blank
   row and leaves the caret where it was has bought nothing — the user is
   authoring by ear, and the reach for the mouse between every line is the whole
   cost this removes. So `requestCueFocus` is not a nicety at the end of the
   function; it is the half of it that matters.

   PLAYBACK MUST NOT STOP, at any step, and this file is written so that is
   structurally true rather than true by luck:

     · It calls exactly three store actions — `addCue`, `setInspectorGroup` and
       `requestCueFocus` — and NONE of them is a transport action. There is no
       `seek`, no `pause`, no `togglePlay`, and no `setPlayhead` anywhere in this
       file or reachable from it. That is the property to preserve; adding a
       fourth call means checking it against this list first.
     · It does NOT `flushSync`. `titleCommand` does, because it has to focus a
       DOM node that React has not rendered yet. This one never touches the DOM:
       focus is the consumer's job, so there is nothing to flush, and forcing a
       synchronous render out of a keystroke while the transport is running is
       exactly the kind of stall that shows up as a dropped frame.
     · The playhead is read ONCE, synchronously, before anything else runs. That
       is the clause's real substance: the command has to be correct while the
       playhead is MOVING, and a frame re-read after the first store write would
       be a different frame. The cue lands on the frame the user was watching
       when they pressed the key, not on wherever transport had reached by the
       time the inspector re-rendered.
--------------------------------------------------------------------------- */

import { readStore } from '../../state/store';

/**
 * Adds a two-second cue at the playhead, opens the subtitles group, and asks
 * the row for the new cue to take focus. In that order, which is the order
 * CREATIVE §6.6 names: the group has to be open for the row to exist, and the
 * row has to exist for the request to find a consumer.
 *
 * There is deliberately no "most recently touched cue" retained anywhere, here
 * or in the store. The request names one cue, once, and is cleared on arrival.
 */
export function addCueAtPlayhead(): void {
  const store = readStore();

  // ONE read, first, before any write — see the header. `Math.round` because
  // everything in this store is whole frames (model.ts §2.1), and `Math.max`
  // because a cue start is a timeline position and those are never negative.
  const frame = Math.max(0, Math.round(store.playhead));

  const id = store.addCue(frame);
  store.setInspectorGroup('subtitles', true);
  store.requestCueFocus(id);
}
