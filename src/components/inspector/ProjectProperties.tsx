/* ---------------------------------------------------------------------------
   ProjectProperties — aspect, resolution, width, height and frame rate, shown
   only when nothing is selected (PLAN §8.15).

   This is the "corrected inline later" path that lets the app open straight
   into the edit instead of asking for a project format up front. The format is
   adopted from the first clip imported; this group is where it is fixed. There
   is no project-setup dialog, ever — PRODUCT.md names modal-first flows as a
   hard anti-reference and this group is the argument that one is unnecessary.

   The four size controls have a relationship: aspect picks a shape, resolution
   picks a tier within it, width and height are the truth underneath both. Frame
   rate is an independent axis and sits last, because that relationship is
   unreadable with a frame-rate field wedged above it (FORMAT §3.4).

   Width and Height stay visible, stay enabled, and are never hidden behind the
   two Selects: the Selects are the fast path, the fields are the truth, and
   typing into a field is always allowed. Typing 4096 then 2160 moves Aspect to
   `Custom` and regenerates the Resolution ladder at 17:9 — no error, no
   refusal, no modal.

   `setProjectFps` recomputes every media duration and then shortens any clip
   whose source no longer covers it — so it runs on commit only, never on the
   continuous `onChange` of a scrub. A frame rate is not something to drag
   through, and neither is a dimension. Both Selects write on the native
   `change` event, which is already a commit.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useId } from 'react';
import type { ReactElement } from 'react';
import { NumericField, Select } from '../ui';
import { readStore, useEditorStore } from '../../state/store';
import type { AspectId } from '../../lib/constants';
import { ASPECT_CUSTOM_LABEL, ASPECT_PRESETS } from '../../lib/constants';
import {
  projectResolutionValue,
  resolutionLadder,
  resolveAspectId,
  sizeForAspect,
} from '../../state/playbackSlice';
import { PropertyRow } from './PropertyRow';

export function ProjectProperties(): ReactElement {
  const fps = useEditorStore((s) => s.fps);
  const width = useEditorStore((s) => s.width);
  const height = useEditorStore((s) => s.height);

  const base = useId();
  const aspectId = `${base}-aspect`;
  const resolutionId = `${base}-resolution`;
  const fpsId = `${base}-fps`;
  const widthId = `${base}-width`;
  const heightId = `${base}-height`;

  const currentAspect = resolveAspectId(width, height);

  /* `Custom` is a DISPLAY value, never a target: it appears only while the current
     size is custom, which means it is always the selected option when present,
     which means a native <select> can never fire `change` for it. There is no dead
     option in the list, and the way to reach a custom shape is Width and Height —
     which is where a custom shape's actual information lives. */
  const aspectOptions: ReadonlyArray<{ value: AspectId; label: string }> = [
    ...ASPECT_PRESETS.map((p) => ({ value: p.id as AspectId, label: p.label })),
    ...(currentAspect === 'custom'
      ? [{ value: 'custom' as AspectId, label: ASPECT_CUSTOM_LABEL }]
      : []),
  ];

  const sizeOptions = resolutionLadder(width, height);

  /** Scrubbing a project value would apply it on every pixel; commit is the write. */
  const noop = (): void => undefined;

  return (
    <>
      <PropertyRow label="Aspect" htmlFor={aspectId}>
        <Select
          id={aspectId}
          label="Aspect"
          value={currentAspect}
          options={aspectOptions}
          onChange={(next: AspectId) => {
            // The TIER is preserved: the short edge is the pixel budget the user
            // already chose, and swapping shape must never silently change it.
            const n = sizeForAspect(width, height, next);
            readStore().setProjectSize(n.width, n.height);
          }}
        />
      </PropertyRow>

      <PropertyRow label="Resolution" htmlFor={resolutionId}>
        {/* numeric: the pixel pair changes while the interface is live, and DESIGN
            §3's Tabular Rule covers dimensions. The tier name renders in mono as a
            consequence — a native <option> cannot mix typefaces, and PLAN §5
            forbids hand-rolling a listbox to get around it.

            `value` comes from projectResolutionValue, never from a raw
            `${width}x${height}`: a project saved with an odd dimension would
            otherwise produce a value absent from its own options, and a native
            <select> with an unmatched value displays its FIRST option. */}
        <Select
          id={resolutionId}
          label="Resolution"
          numeric
          value={projectResolutionValue(width, height)}
          options={sizeOptions}
          onChange={(next: string) => {
            const [nw, nh] = next.split('x').map(Number);
            if (Number.isFinite(nw) && Number.isFinite(nh)) {
              readStore().setProjectSize(nw as number, nh as number);
            }
          }}
        />
      </PropertyRow>

      <PropertyRow label="Width" htmlFor={widthId}>
        <NumericField
          id={widthId}
          value={width}
          label="Width"
          min={16}
          max={8192}
          step={2}
          precision={0}
          onChange={noop}
          onCommit={(next) => readStore().setProjectSize(Math.round(next), readStore().height)}
        />
      </PropertyRow>

      <PropertyRow label="Height" htmlFor={heightId}>
        <NumericField
          id={heightId}
          value={height}
          label="Height"
          min={16}
          max={8192}
          step={2}
          precision={0}
          onChange={noop}
          onCommit={(next) => readStore().setProjectSize(readStore().width, Math.round(next))}
        />
      </PropertyRow>

      <PropertyRow label="Frame rate" htmlFor={fpsId}>
        <NumericField
          id={fpsId}
          value={fps}
          label="Frame rate"
          min={1}
          max={240}
          step={1}
          precision={3}
          scrubSensitivity={0.1}
          onChange={noop}
          onCommit={(next) => readStore().setProjectFps(next)}
        />
      </PropertyRow>
    </>
  );
}
