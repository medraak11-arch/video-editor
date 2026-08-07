/* ---------------------------------------------------------------------------
   Inspector — the properties of whatever is selected. PLAN §8.1, §8.15.

   The shell decides whether this is mounted at all and owns the entry
   animation and the width; this component fills its container and renders
   exactly one Panel (PLAN §7.0). It has no mount condition, no width and no
   animation of its own — two owners would double the transition.

   Subscriptions are deliberately O(1): `selection` and `clips` are both
   references that only change when the thing they describe changes, so the
   selected clips are derived here rather than through an allocating selector
   that would run on every store write (PLAN §1.3 rule 1).
--------------------------------------------------------------------------- */

import './inspector.css';
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { Panel } from '../ui';
import { useEditorStore } from '../../state/store';
import type { Clip } from '../../types/model';
import { ClipPropertyRow } from './ClipPropertyRow';
import { InspectorGroup } from './InspectorGroup';
import { ProjectProperties } from './ProjectProperties';

/* Stored -> shown, and back. Declared at module scope so the identities stay
   stable across renders and the value memo in ClipPropertyRow holds. */
const toPercent = (stored: number): number => stored * 100;
const fromPercent = (shown: number): number => shown / 100;

export function Inspector(): ReactElement {
  const selection = useEditorStore((s) => s.selection);
  const clipsById = useEditorStore((s) => s.clips);

  const clips = useMemo<Clip[]>(() => {
    const out: Clip[] = [];
    for (const id of selection) {
      const clip = clipsById[id];
      if (clip) out.push(clip);
    }
    return out;
  }, [selection, clipsById]);

  const first = clips[0];
  const heading =
    clips.length === 0
      ? 'Project'
      : clips.length === 1 && first
        ? first.name
        : `${clips.length} clips`;

  return (
    <Panel className="ve-inspector" heading={heading} scroll padded={false}>
      <div className="ve-inspector-groups">
        {clips.length === 0 ? (
          <InspectorGroup id="project" heading="Project">
            <ProjectProperties />
          </InspectorGroup>
        ) : (
          <>
            <InspectorGroup id="transform" heading="Transform">
              <ClipPropertyRow
                clips={clips}
                field="scale"
                label="Scale"
                historyLabel="Adjust scale"
                min={1}
                max={1000}
                step={1}
                precision={0}
                scrubSensitivity={0.5}
                suffix="%"
                toDisplay={toPercent}
                fromDisplay={fromPercent}
              />
              <ClipPropertyRow
                clips={clips}
                field="positionX"
                label="Position X"
                historyLabel="Adjust position"
                step={1}
                precision={0}
                suffix="px"
              />
              <ClipPropertyRow
                clips={clips}
                field="positionY"
                label="Position Y"
                historyLabel="Adjust position"
                step={1}
                precision={0}
                suffix="px"
              />
              <ClipPropertyRow
                clips={clips}
                field="rotation"
                label="Rotation"
                historyLabel="Adjust rotation"
                min={-180}
                max={180}
                step={1}
                precision={0}
                suffix="°"
              />
            </InspectorGroup>

            <InspectorGroup id="blend" heading="Blend">
              <ClipPropertyRow
                clips={clips}
                field="opacity"
                label="Opacity"
                historyLabel="Adjust opacity"
                min={0}
                max={100}
                step={1}
                precision={0}
                scrubSensitivity={0.5}
                suffix="%"
                toDisplay={toPercent}
                fromDisplay={fromPercent}
              />
            </InspectorGroup>

            <InspectorGroup id="timeAndSound" heading="Time and sound">
              <ClipPropertyRow
                clips={clips}
                field="speed"
                label="Speed"
                historyLabel="Adjust speed"
                min={0.1}
                max={8}
                step={0.1}
                precision={2}
                scrubSensitivity={0.01}
                suffix="×"
                // Speed is the one property the store applies relative to the
                // clip's current duration and speed, so it writes once per
                // gesture. See ClipPropertyRow's header.
                applyOnCommitOnly
              />
              <ClipPropertyRow
                clips={clips}
                field="volume"
                label="Volume"
                historyLabel="Adjust volume"
                min={0}
                max={200}
                step={1}
                precision={0}
                scrubSensitivity={0.5}
                suffix="%"
                toDisplay={toPercent}
                fromDisplay={fromPercent}
              />
            </InspectorGroup>
          </>
        )}
      </div>
    </Panel>
  );
}
