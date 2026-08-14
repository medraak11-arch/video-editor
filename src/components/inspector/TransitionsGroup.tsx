/* ---------------------------------------------------------------------------
   TransitionsGroup — the in and out edges of a clip. CREATIVE §4.

   THE OUT EDGE OFFERS `fade` AND NOTHING ELSE, and that is the load-bearing
   decision in this file. A dissolve is owned by the INCOMING clip (§4.3), so
   `setClipTransition(id, 'out', {kind:'dissolve'})` is a call the store
   REFUSES. A Select that listed both kinds on both edges would therefore be
   offering a state the model rejects: the user picks `Cross dissolve` on the
   out edge, the store declines, and the control silently springs back with no
   explanation available at the point of the click. A control must not be able
   to express something the model cannot hold — so the option is absent from the
   list rather than present and refused, and the sentence under the row says
   where a dissolve actually lives. Refusing well is the second-best outcome;
   not being able to ask is the first.

   A DISSOLVE IS PICTURE ONLY (§4.3a). It is built from two edits that both live
   in the video chain — the outgoing clip's tail is extended and the incoming
   clip is alpha-ramped over it — and neither touches a sample, so the sound
   cuts at the edit. That is a real asymmetry with `fade`, which ramps both
   through one shared `transitionGain`, and the user has no way to find it out
   except by exporting. So the group says it, and says `Fade` in the same
   sentence: the fix is the other option in the select they are already looking
   at, and a limitation stated without its remedy just reads as a defect.

   SINGLE SELECTION ONLY. `setClipTransition` takes one clip id, and a
   transition is a property of one edge of one clip in a way that `opacity` is
   not: `frames` is clamped against that clip's own duration and, for a
   dissolve, against the handle of the clip before it. Fanning one value across
   a mixed selection would clamp differently per clip and leave the group
   holding four different numbers under one field reading a fifth. So the group
   states the restriction instead of guessing.

   `frames`, not seconds. Everything in this store is whole frames (model.ts
   §2.1) and a transition length is compared against clip durations that are
   also frames; showing seconds would put a rounding step between the number
   typed and the number stored, at exactly the scale — 12 frames — where that
   rounding is a visible fraction of the whole value.

   The store keeps the value the USER authored and clamps at build time (§4.3),
   so this field may legitimately read longer than the available handle. That is
   the design: trimming the outgoing clip longer later restores the transition
   that was asked for rather than one silently shortened forever.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useId } from 'react';
import type { ReactElement } from 'react';
import { NumericField, Select } from '../ui';
import { readStore } from '../../state/store';
import type { Clip, Transition, TransitionKind } from '../../types/model';
import { DEFAULT_TRANSITION_FRAMES } from '../../types/model';
import { PropertyRow } from './PropertyRow';

/** `none` is a UI value only — the model says `undefined`. */
type EdgeKind = TransitionKind | 'none';

const IN_OPTIONS: ReadonlyArray<{ value: EdgeKind; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade from black' },
  { value: 'dissolve', label: 'Cross dissolve' },
];

/** §4.3. No dissolve here, ever. */
const OUT_OPTIONS: ReadonlyArray<{ value: EdgeKind; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade to black' },
];

export interface TransitionsGroupProps {
  clips: readonly Clip[];
}

function Edge({
  clip,
  edge,
  transition,
}: {
  clip: Clip;
  edge: 'in' | 'out';
  transition: Transition | undefined;
}): ReactElement {
  const base = useId();
  const kindId = `${base}-kind`;
  const framesId = `${base}-frames`;

  const kind: EdgeKind = transition?.kind ?? 'none';
  const frames = transition?.frames ?? DEFAULT_TRANSITION_FRAMES;
  const label = edge === 'in' ? 'In' : 'Out';

  const write = (next: Transition | null, historyLabel: string): void => {
    readStore().beginHistory(historyLabel);
    readStore().setClipTransition(clip.id, edge, next);
    readStore().commitHistory();
  };

  return (
    <>
      <PropertyRow label={label} htmlFor={kindId}>
        <Select
          id={kindId}
          label={`${label} transition`}
          value={kind}
          options={edge === 'in' ? IN_OPTIONS : OUT_OPTIONS}
          onChange={(next: EdgeKind) => {
            if (next === 'none') {
              write(null, `Remove ${edge} transition`);
              return;
            }
            // Keeps the length already authored when only the kind changes —
            // switching fade to dissolve is not a request to forget the timing.
            write({ kind: next, frames }, `Set ${edge} transition`);
          }}
        />
      </PropertyRow>

      {/* The length row exists only once there is something to give a length to.
          A frames field above a `None` select is a control with no referent. */}
      {kind === 'none' ? null : (
        <PropertyRow label={`${label} length`} htmlFor={framesId}>
          <NumericField
            id={framesId}
            label={`${label} transition length`}
            value={frames}
            min={1}
            max={Math.max(1, Math.floor(clip.duration / 3))}
            step={1}
            precision={0}
            suffix="f"
            onChange={() => undefined}
            onCommit={(next) =>
              write({ kind: kind as TransitionKind, frames: Math.round(next) }, 'Adjust transition')
            }
          />
        </PropertyRow>
      )}
    </>
  );
}

export function TransitionsGroup({ clips }: TransitionsGroupProps): ReactElement {
  const clip = clips.length === 1 ? clips[0] : undefined;

  if (!clip) {
    return (
      <p className="ve-group-note ve-group-note-block type-label">
        Transitions are edited one clip at a time.
      </p>
    );
  }

  return (
    <>
      <Edge clip={clip} edge="in" transition={clip.transitionIn} />
      <Edge clip={clip} edge="out" transition={clip.transitionOut} />
      {/* Two separate facts, and the second one is the surprising one. Ownership
          (§4.3) explains why the Out edge has no dissolve to pick. PICTURE ONLY
          (§4.3a) is what the user would otherwise discover in the exported file:
          a dissolve extends the outgoing clip's tail and alpha-ramps the
          incoming one, and neither of those touches a sample. Naming `Fade` in
          the same breath matters — without it this reads as a limitation with
          no way out, when in fact the control that ramps the sound is the other
          option in the very same select. */}
      <p className="ve-group-note ve-group-note-block type-label">
        A cross dissolve belongs to the clip it dissolves into, so it is set on
        that clip&rsquo;s In edge. It blends the picture only &mdash; the sound
        cuts at the edit. Fade ramps both picture and sound.
      </p>
    </>
  );
}
