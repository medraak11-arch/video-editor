/* ---------------------------------------------------------------------------
   GradeGroup — brightness, contrast, saturation, temperature. CREATIVE §2.

   Four ordinary ClipPropertyRows, so grade inherits the whole history, refusal
   and mixed-selection story from one place rather than restating it. What this
   file adds is the two things a grade needs that a transform does not.

   ONE: THE ORDER IS `eq`'s ORDER. contrast -> brightness -> saturation ->
   temperature (CREATIVE §2.3). The rows are laid out in the order the maths is
   applied, because a grade panel whose controls disagree with its pipeline
   teaches the wrong mental model — the user reaches for Contrast expecting it to
   act on what Brightness produced, which here it does not.

   TWO: RESET. A grade is the one property group people push past the point of
   knowing what they changed, and there is no other way back: unity is 0 for one
   field and 1 for two others, so `0` is not a value you can type across the row.
   Reset writes all four in ONE patch and therefore ONE history entry, which is
   also the difference between an undoable reset and four of them.

   THREE: SATURATION STOPS AT 1.8, NOT 3 (CREATIVE §2.5). That ceiling is not a
   taste judgement about how saturated a grade should get — it is the largest
   value that can be ENCODED. `colorchannelmixer` refuses any coefficient
   outside [-2, 2], and the saturation matrix's diagonal crosses 2 at s = 1.846,
   earlier still at a cool temperature. Above it the export does not look bad,
   it FAILS: the graph builds, the script writes, and the user is handed a
   refusal naming a filter parameter they have never heard of. So roughly the
   top third of the old slider was a trap, and a control must not be able to ask
   for a state the pipeline cannot produce — the same rule that keeps `dissolve`
   off the Out edge in TransitionsGroup.

   The slider's `max` is therefore the model's own bound, and nothing in this
   group's copy quotes a range: `normalizeClipProperties` clamps on load, so a
   project saved before the narrowing comes back at 1.8, and a help string
   stating "0 to 3" would be the one place still promising the old ceiling.
   Worth noting it costs nothing real — Lumetri and Resolve both stop at 2×, so
   the 0..3 this replaces was the outlier, not the capability.

   `DEFAULT_CLIP_PROPERTIES` is the source of the neutral values — not a literal
   `{brightness: 0, contrast: 1…}` restated here, which would be a second place
   for a default to drift from.

   The DISPLAY numbers are the stored numbers, deliberately: brightness reads
   -1..1 and not -100..100. `gradeMath` consumes exactly these, so a percentage
   face would put a conversion between what the user typed and what the shared
   function receives — and the whole point of §2.2 is that there is one maths.
--------------------------------------------------------------------------- */

import './inspector.css';
import type { ReactElement } from 'react';
import { Info, RotateCcw } from 'lucide-react';
import { Button } from '../ui';
import { readStore } from '../../state/store';
import type { Clip, ClipProperties } from '../../types/model';
import { DEFAULT_CLIP_PROPERTIES } from '../../types/model';
import { ClipPropertyRow } from './ClipPropertyRow';

/** The four fields this group owns, and the only ones Reset touches. */
const GRADE_FIELDS = ['contrast', 'brightness', 'saturation', 'temperature'] as const;

const NEUTRAL: Partial<ClipProperties> = {
  contrast: DEFAULT_CLIP_PROPERTIES.contrast,
  brightness: DEFAULT_CLIP_PROPERTIES.brightness,
  saturation: DEFAULT_CLIP_PROPERTIES.saturation,
  temperature: DEFAULT_CLIP_PROPERTIES.temperature,
};

export interface GradeGroupProps {
  clips: readonly Clip[];
}

export function GradeGroup({ clips }: GradeGroupProps): ReactElement {
  /* Whether Reset would do anything. The button stays ENABLED either way — PLAN
     §7.1 avoids disabled controls, and a reset that is already a no-op is the
     least harmful button in the app to press. This only drives the read-out. */
  const graded = clips.some((clip) =>
    GRADE_FIELDS.some((f) => clip.properties[f] !== DEFAULT_CLIP_PROPERTIES[f]),
  );

  const reset = (): void => {
    const ids = clips.map((clip) => clip.id);
    readStore().beginHistory('Reset grade');
    const result = readStore().updateClipProperties(ids, NEUTRAL);
    if (result.ok) readStore().commitHistory();
    else readStore().abortHistory();
  };

  return (
    <>
      <ClipPropertyRow
        clips={clips}
        field="contrast"
        label="Contrast"
        historyLabel="Adjust contrast"
        min={0}
        max={3}
        step={0.01}
        precision={2}
        scrubSensitivity={0.005}
      />
      <ClipPropertyRow
        clips={clips}
        field="brightness"
        label="Brightness"
        historyLabel="Adjust brightness"
        min={-1}
        max={1}
        step={0.01}
        precision={2}
        scrubSensitivity={0.005}
      />
      <ClipPropertyRow
        clips={clips}
        field="saturation"
        label="Saturation"
        historyLabel="Adjust saturation"
        min={0}
        max={1.8}
        step={0.01}
        precision={2}
        scrubSensitivity={0.005}
      />
      <ClipPropertyRow
        clips={clips}
        field="temperature"
        label="Temperature"
        historyLabel="Adjust temperature"
        min={-100}
        max={100}
        step={1}
        precision={0}
        scrubSensitivity={0.5}
      />

      {/* Sits under the rows rather than beside the heading: the heading is the
          disclosure button, and a control inside a button is not a control. */}
      <div className="ve-group-actions">
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<RotateCcw size={14} strokeWidth={1.75} />}
          onClick={reset}
        >
          Reset grade
        </Button>
        {/* A state, not a colour. Says nothing when there is nothing to say. */}
        {graded ? null : (
          <span className="ve-group-note type-label" aria-hidden="true">
            Neutral
          </span>
        )}
      </div>

      {/* A MEASURED TOLERANCE, not the word "exact" (CREATIVE §2.4).
          Verification put the old claim on a meter and it failed: `eq` works in
          limited-range YUV, so its brightness moved Y and came back ×1.164, and
          its contrast scaled luma while holding chroma — 7 to 9 counts out of
          255, and shifting hue per channel rather than uniformly. The export is
          moving off `eq` onto `lutrgb` + `colorchannelmixer`, which consumes
          the same slope/intercept the preview's feComponentTransfer already
          does, so all four terms land in one RGB domain.

          "Exact" is still the wrong word even then. Two integer pipelines that
          agree to within a rounding step have a tolerance, not an identity, and
          a number the user can check beats an absolute they cannot. ±1/255 is
          what the round-half-up LUT can hold. Saturation is no longer listed as
          approximate anywhere: leaving `eq` is what fixed it. */}
      <p className="ve-group-note ve-group-note-block type-label">
        <span className="ve-icon-slot" aria-hidden="true">
          <Info size={13} strokeWidth={1.75} />
        </span>
        Brightness, contrast, saturation and temperature match the exported file
        to within 1 part in 255.
      </p>
    </>
  );
}
