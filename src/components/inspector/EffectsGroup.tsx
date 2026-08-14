/* ---------------------------------------------------------------------------
   EffectsGroup — blur, sharpen, vignette, flip H, flip V. CREATIVE §3.

   A fixed catalogue rendered as a fixed list, which is the UI half of §3's
   argument for not building an effect stack: there is no add button, no reorder
   handle and no empty state, because there is nothing to add to. Five rows that
   are always the same five rows are also five rows the user learns the position
   of once.

   The three numeric ones are ClipPropertyRows and the two booleans are
   ClipToggleRows — the fork ClipPropertyRow's header describes, in the one
   group where both halves of it actually appear.

   THE APPROXIMATION NOTE IS NOT DECORATION. This is the one place in the app
   where the preview knowingly disagrees with the file, and the project's
   governing rule is that a disagreement is stated out loud rather than
   discovered in an export. So the note names the exact fields — not a vague
   "results may vary" — and it renders whether or not any of them is currently
   set, because the moment it is most needed is the moment before the user
   reaches for the control.

   TWO FIELDS, AND THE GRADE IS NOT ONE OF THEM. Saturation was briefly listed
   here as a third approximation; it is not one. It read as approximate only
   because the export ran the whole grade through `eq` in limited-range YUV, and
   CREATIVE §2.4 moves it into RGB where the preview already lives. The grade's
   own tolerance is stated in the Grade group, beside the controls it describes.
   This footnote covers only what this group owns.

   `blur` is in PROJECT-resolution sigma (§3), which is why its unit reads `px`
   and why the number is stable across output sizes: the graph rescales it onto
   the export grid the same way `positionX` is rescaled.
--------------------------------------------------------------------------- */

import './inspector.css';
import type { ReactElement } from 'react';
import { Info } from 'lucide-react';
import type { Clip } from '../../types/model';
import { ClipPropertyRow } from './ClipPropertyRow';
import { ClipToggleRow } from './ClipToggleRow';

export interface EffectsGroupProps {
  clips: readonly Clip[];
}

export function EffectsGroup({ clips }: EffectsGroupProps): ReactElement {
  return (
    <>
      <ClipPropertyRow
        clips={clips}
        field="blur"
        label="Blur"
        historyLabel="Adjust blur"
        min={0}
        max={50}
        step={0.5}
        precision={1}
        scrubSensitivity={0.25}
        suffix="px"
      />
      <ClipPropertyRow
        clips={clips}
        field="sharpen"
        label="Sharpen"
        historyLabel="Adjust sharpen"
        min={0}
        max={2}
        step={0.05}
        precision={2}
        scrubSensitivity={0.01}
      />
      <ClipPropertyRow
        clips={clips}
        field="vignette"
        label="Vignette"
        historyLabel="Adjust vignette"
        min={0}
        max={1}
        step={0.01}
        precision={2}
        scrubSensitivity={0.005}
      />
      <ClipToggleRow
        clips={clips}
        field="flipH"
        label="Flip horizontal"
        historyLabel="Flip horizontally"
      />
      <ClipToggleRow
        clips={clips}
        field="flipV"
        label="Flip vertical"
        historyLabel="Flip vertically"
      />

      {/* Not an InlineNotice: nothing has gone wrong and nothing needs
          acknowledging. This is a standing fact about two controls, so it reads
          as a footnote to the group and takes --text-muted rather than a status
          colour. The icon is the second signal; the words are the first. */}
      <p className="ve-group-note ve-group-note-block type-label">
        <span className="ve-icon-slot" aria-hidden="true">
          <Info size={13} strokeWidth={1.75} />
        </span>
        Sharpen and vignette are approximated in the preview, so the exported
        file differs slightly. Blur and flip are exact.
      </p>
    </>
  );
}
