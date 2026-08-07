/* ---------------------------------------------------------------------------
   ProjectProperties — frame rate, width and height, shown only when nothing is
   selected (PLAN §8.15).

   This is the "corrected inline later" path that lets the app open straight
   into the edit instead of asking for a project format up front. The format is
   adopted from the first clip imported; this group is where it is fixed.

   `setProjectFps` recomputes every media duration and then shortens any clip
   whose source no longer covers it — so it runs on commit only, never on the
   continuous `onChange` of a scrub. A frame rate is not something to drag
   through.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useId } from 'react';
import type { ReactElement } from 'react';
import { NumericField } from '../ui';
import { readStore, useEditorStore } from '../../state/store';
import { PropertyRow } from './PropertyRow';

export function ProjectProperties(): ReactElement {
  const fps = useEditorStore((s) => s.fps);
  const width = useEditorStore((s) => s.width);
  const height = useEditorStore((s) => s.height);

  const base = useId();
  const fpsId = `${base}-fps`;
  const widthId = `${base}-width`;
  const heightId = `${base}-height`;

  /** Scrubbing a project value would apply it on every pixel; commit is the write. */
  const noop = (): void => undefined;

  return (
    <>
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
    </>
  );
}
