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
import type { Clip, LinkId } from '../../types/model';
import { clipStreams } from '../../types/model';
import { ClipPropertyRow } from './ClipPropertyRow';
import { InspectorGroup } from './InspectorGroup';
import { NamePropertyRow } from './NamePropertyRow';
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

  /**
   * The one place the stream fact is SPELLED OUT rather than encoded. It states
   * the non-default only: a selection that is all `av`, or mixed, says nothing.
   *
   * Controls then disclose by relevance, in BOTH directions (PLAN preamble S4:
   * the answer to an inapplicable control is to not render it, never to disable
   * it). An audio-only clip has no transform and no blend; a video-only clip has
   * no live Volume — `monitorAudible`, `VideoSurface`'s gain and the export's
   * `wantsAudio` are all gated off, so the slider would change a stored number
   * to no audible and no exported effect. Speed stays for both: it retimes the
   * picture, retimes the sound and rescales duration, so `timeAndSound` itself
   * never disappears and `InspectorGroupId` is unchanged.
   *
   * A MIXED selection renders everything: `updateClipProperties` writes one
   * patch to every id all-or-nothing, and an inert write is not a wrong one.
   */
  const uniformStreams = useMemo(() => {
    if (clips.length === 0) return null;
    const first = clipStreams(clips[0]);
    return clips.every((c) => clipStreams(c) === first) ? first : null;
  }, [clips]);
  const audioOnly = uniformStreams === 'audio';
  const videoOnly = uniformStreams === 'video';

  /**
   * The group's size, spelled out on the same pattern (docs/LINKING.md §8.5).
   * One number per GROUP, never one number across groups: "Linked, 4 clips" over
   * two independent pairs asserts a four-member group that does not exist, which
   * is a fabricated fact in a read-out whose whole job is to name the group's
   * size. Both branches are plural by construction — a group holds at least two
   * clips, and the `groups` branch is only reached at two or more.
   *
   * Counting WITHIN the selection is counting the whole group, because the
   * selection is always a closure.
   */
  const linked = useMemo(() => {
    const sizes = new Map<LinkId, number>();
    for (const c of clips) {
      if (c.linkId !== undefined) sizes.set(c.linkId, (sizes.get(c.linkId) ?? 0) + 1);
    }
    if (sizes.size === 0) return null;
    if (sizes.size > 1) return `Linked, ${sizes.size} groups`;
    return `Linked, ${[...sizes.values()][0]} clips`;
  }, [clips]);

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
            {/* Above Transform and outside every group: the file's name is the
                one thing here that is not a property of the edit, and it is not
                something to have to disclose to reach (RENAME.md §Inspector). */}
            <div className="ve-inspector-identity">
              <NamePropertyRow clips={clips} />
              {audioOnly || videoOnly ? (
                <p className="ve-inspector-streams type-label">
                  {audioOnly ? 'Audio only' : 'Video only'}
                </p>
              ) : null}
              {/* The same kind of thing as `Audio only`: a spelled-out fact at
                  the same type step, in the same identity block, so it reuses
                  .ve-inspector-streams rather than inventing a second class name
                  with identical declarations. A READ-OUT, not a control — Link
                  and Unlink live in the context menu and on the keyboard, where
                  every other structural edit in this app lives. The count uses
                  the sans, not .type-numeric: it changes when the selection
                  changes, which is a re-render, not a tick. */}
              {linked !== null ? (
                <p className="ve-inspector-streams type-label">{linked}</p>
              ) : null}
            </div>

            {audioOnly ? null : (
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
            )}

            {audioOnly ? null : (
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
            )}

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
              {videoOnly ? null : (
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
              )}
            </InspectorGroup>
          </>
        )}
      </div>
    </Panel>
  );
}
