/* ---------------------------------------------------------------------------
   ClipToggleRow — one BOOLEAN ClipProperties field, bound across the selection.

   The other half of the fork ClipPropertyRow's header describes. `flipH` and
   `flipV` are not numbers that happen to have two values: there is no range to
   scrub, no step, no precision, no unit, and no `Mixed` you could type into. A
   NumericField holding `0` or `1` would be a worse control in every one of
   those ways, so this is a separate row rather than a widened one.

   The control itself is ToggleControl, shared with TitleGroup; this file is the
   binding — the selection fan-out, the history transaction and the refusal
   slot, which are the three things ClipPropertyRow also owns and which have to
   behave identically here or the two row kinds would undo differently.

   HISTORY. A toggle is one discrete act, not a gesture with a beginning and an
   end, so it opens and closes its transaction in the same handler. A refused
   write ABORTS rather than commits, for ClipPropertyRow's reason: an undo step
   that restores an identical document spends one of the 100 history slots and
   makes Ctrl+Z appear to do nothing.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { AlertCircle } from 'lucide-react';
import { readStore } from '../../state/store';
import type { Clip, ClipProperties } from '../../types/model';
import type { BooleanClipProperty } from './ClipPropertyRow';
import { PropertyRow } from './PropertyRow';
import { ToggleControl } from './ToggleControl';
import { describeMoveFailure } from './failure';

export interface ClipToggleRowProps {
  /** The current selection. Never empty when this row is rendered. */
  clips: readonly Clip[];
  field: BooleanClipProperty;
  /** Visible copy, sentence case. */
  label: string;
  /** Undo-stack label, sentence case imperative: 'Flip horizontally'. */
  historyLabel: string;
}

export function ClipToggleRow({
  clips,
  field,
  label,
  historyLabel,
}: ClipToggleRowProps): ReactElement {
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const [error, setError] = useState<string | null>(null);

  const ids = useMemo(() => clips.map((clip) => clip.id), [clips]);
  const idKey = ids.join(' ');

  /** One shared boolean, or 'mixed' when the selection disagrees. */
  const value = useMemo<boolean | 'mixed'>(() => {
    const first = clips[0];
    if (!first) return 'mixed';
    const base = first.properties[field];
    for (const clip of clips) if (clip.properties[field] !== base) return 'mixed';
    return base;
  }, [clips, field]);

  // Same rule as ClipPropertyRow: a refusal names the clips it was refused for,
  // so it must not survive a change of selection inside a role="alert".
  useEffect(() => {
    setError(null);
  }, [idKey]);

  const onChange = (next: boolean): void => {
    readStore().beginHistory(historyLabel);
    // Sound for the reason the assertion in ClipPropertyRow.apply is sound:
    // `field` is a BooleanClipProperty and `next` is a boolean, so the pair is
    // exactly one of Partial<ClipProperties>'s boolean members. The assertion
    // exists only because a computed key widens to an index signature.
    const patch = { [field]: next } as Partial<ClipProperties>;
    const result = readStore().updateClipProperties(ids, patch);
    if (result.ok) {
      setError(null);
      readStore().commitHistory();
    } else {
      setError(describeMoveFailure(result.reason, ids));
      readStore().abortHistory();
    }
  };

  return (
    <PropertyRow label={label} htmlFor={fieldId}>
      <div className="ve-field" data-surface="panel">
        <ToggleControl
          id={fieldId}
          label={label}
          value={value}
          onChange={onChange}
          invalid={error !== null}
          describedBy={error ? errorId : undefined}
        />
        {error ? (
          <p id={errorId} className="ve-field-message type-label" role="alert">
            <span className="ve-icon-slot" aria-hidden="true">
              <AlertCircle size={14} strokeWidth={1.75} />
            </span>
            {error}
          </p>
        ) : null}
      </div>
    </PropertyRow>
  );
}
