/* ---------------------------------------------------------------------------
   ClipPropertyRow — one ClipProperties field, bound across the whole selection.

   History, exactly as PLAN §8.8 requires it: the first `onChange` of a gesture
   opens a transaction, `onCommit` closes it, Escape aborts it. One drag-scrub
   is therefore one undo step, not one per pixel — and because `onCommit` is
   required on NumericField, a transaction can never be left open. A gesture in
   which no write ever landed *aborts* rather than commits, so a refused edit
   never leaves an undo step that restores an identical document.

   `updateClipProperties` is the inspector's ONLY write path, and it returns a
   result because a `speed` change moves the clip's out edge and can be refused
   (PLAN §2.4 invariant 4). A refusal shows the reason in the field's error slot
   and the field falls back to the value the store still holds — nothing is
   silently clamped.

   RELATIVE vs ABSOLUTE writes. `updateClipProperties` recomputes duration as
   `round(duration * oldSpeed / newSpeed)` against the clip's CURRENT stored
   state. That is correct once per gesture and wrong a hundred times per
   gesture: applied on every pointermove it compounds per-step rounding, and a
   90-frame clip scrubbed 1.00× -> 2.00× in 0.01 steps lands on 63 frames
   instead of 45. So `speed` sets `applyOnCommitOnly` and writes once, from the
   state the gesture started in. `positionX`, `opacity` and friends are absolute
   assignments and stay continuous.

   Mixed values render as the literal word `Mixed`, never as a blank field.

   NUMERIC ONLY, AND THE TYPE SAYS SO. `ClipProperties` stopped being all-number
   when CREATIVE §3 added `flipH` and `flipV`, so `field: keyof ClipProperties`
   started admitting a key whose value is a boolean — which `toDisplay`,
   `min/max/step`, drag-scrub and `toFixed` all have no meaning for. The fix is
   not a cast at the two lines that stopped compiling: a boolean is not a number
   this control could render if only the types agreed, it is a different control
   (ClipToggleRow). So `field` narrows to the numeric keys, the boolean keys get
   their own row, and `keyof ClipProperties` appears in neither — adding a
   sixteenth property of either kind lands in exactly one of the two unions
   without anybody editing this file.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { NumericField } from '../ui';
import { readStore } from '../../state/store';
import type { MutationResult } from '../../state/timelineSlice';
import type { Clip, ClipProperties } from '../../types/model';
import { PropertyRow } from './PropertyRow';
import { describeMoveFailure } from './failure';

/**
 * The keys of `ClipProperties` whose value is a number — everything a
 * NumericField can hold. Derived, never listed: a new numeric property joins
 * this union by existing, and a property that changes type moves between the
 * two unions and breaks at its call site rather than at runtime.
 */
export type NumericClipProperty = {
  [K in keyof ClipProperties]: ClipProperties[K] extends number ? K : never;
}[keyof ClipProperties];

/** The keys whose value is a boolean. `flipH` and `flipV` today. */
export type BooleanClipProperty = {
  [K in keyof ClipProperties]: ClipProperties[K] extends boolean ? K : never;
}[keyof ClipProperties];

export interface ClipPropertyRowProps {
  /** The current selection. Never empty when this row is rendered. */
  clips: readonly Clip[];
  field: NumericClipProperty;
  /** Visible copy, sentence case. */
  label: string;
  /** Undo-stack label, sentence case imperative: 'Adjust opacity'. */
  historyLabel: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  scrubSensitivity?: number;
  suffix?: string;
  /** Stored value -> the number shown. Opacity is 0..1 stored, 0..100 shown. */
  toDisplay?(stored: number): number;
  /** The number shown -> stored value. Must invert `toDisplay`. */
  fromDisplay?(shown: number): number;
  /**
   * Write through `updateClipProperties` on commit only. Set it for any field
   * the store applies RELATIVE to its own current value — `speed` is the one
   * such field — so a drag produces exactly one write, computed from the state
   * the gesture began in, instead of a hundred compounding ones. `onChange`
   * still opens the history transaction and still updates the field's own text.
   */
  applyOnCommitOnly?: boolean;
}

const identity = (n: number): number => n;

export function ClipPropertyRow({
  clips,
  field,
  label,
  historyLabel,
  min,
  max,
  step = 1,
  precision = 0,
  scrubSensitivity,
  suffix,
  toDisplay = identity,
  fromDisplay = identity,
  applyOnCommitOnly = false,
}: ClipPropertyRowProps): ReactElement {
  const fieldId = useId();
  const [error, setError] = useState<string | null>(null);
  const openTxn = useRef(false);
  /** Did any write in the current gesture actually land? */
  const wrote = useRef(false);

  const ids = useMemo(() => clips.map((clip) => clip.id), [clips]);
  /** Content identity of the selection — a store write does not change it. */
  const idKey = ids.join(' ');

  /** One shared number, or 'mixed' when the selection disagrees. */
  const value = useMemo<number | 'mixed'>(() => {
    const first = clips[0];
    if (!first) return 'mixed';
    const base = toDisplay(first.properties[field]);
    for (const clip of clips) {
      if (toDisplay(clip.properties[field]) !== base) return 'mixed';
    }
    return base;
  }, [clips, field, toDisplay]);

  // The snapshot must predate the first write, so the transaction opens on the
  // first onChange — even for an applyOnCommitOnly field, whose write lands
  // later. `closeTxn` is what decides whether that snapshot was worth keeping.
  const beginTxn = useCallback(() => {
    if (openTxn.current) return;
    openTxn.current = true;
    wrote.current = false;
    readStore().beginHistory(historyLabel);
  }, [historyLabel]);

  /**
   * Closes an open gesture. Committing a gesture in which every write was
   * refused would push an undo step that restores the document unchanged —
   * Ctrl+Z would appear to do nothing and would spend one of the 100 history
   * slots. Aborting pops that snapshot instead.
   */
  const closeTxn = useCallback(() => {
    if (!openTxn.current) return;
    openTxn.current = false;
    if (wrote.current) readStore().commitHistory();
    else readStore().abortHistory();
    wrote.current = false;
  }, []);

  const apply = useCallback(
    (shown: number): MutationResult => {
      // A computed key widens to an index signature, which is the only reason
      // this needs an assertion. It is SOUND rather than papered over: `field`
      // is a NumericClipProperty and `fromDisplay` returns a number, so the
      // pair is exactly one of `Partial<ClipProperties>`'s numeric members.
      const patch = { [field]: fromDisplay(shown) } as Partial<ClipProperties>;
      const result = readStore().updateClipProperties(ids, patch);
      if (result.ok) wrote.current = true;
      return result;
    },
    [field, fromDisplay, ids],
  );

  // A gesture interrupted by unmount (the selection was cleared mid-drag) must
  // still close its transaction, or every later snapshot would be suppressed.
  useEffect(() => () => closeTxn(), [closeTxn]);

  // The refusal message describes the clips it was refused for. Selecting a
  // different clip must not leave the previous one's message announced by the
  // field's role="alert".
  useEffect(() => {
    setError(null);
  }, [idKey]);

  const onChange = (next: number): void => {
    beginTxn();
    // A relative field shows the dragged number but does not write it: the
    // single write happens in onCommit, from the gesture's starting state.
    if (applyOnCommitOnly) return;
    const result = apply(next);
    setError(result.ok ? null : describeMoveFailure(result.reason, ids));
  };

  const onCommit = (next: number): void => {
    beginTxn();
    const result = apply(next);
    setError(result.ok ? null : describeMoveFailure(result.reason, ids));
    closeTxn();
  };

  const onCancel = (): void => {
    if (openTxn.current) {
      openTxn.current = false;
      wrote.current = false;
      readStore().abortHistory();
    }
    setError(null);
  };

  return (
    <PropertyRow label={label} htmlFor={fieldId}>
      <NumericField
        id={fieldId}
        value={value}
        label={label}
        min={min}
        max={max}
        step={step}
        precision={precision}
        scrubSensitivity={scrubSensitivity}
        suffix={suffix}
        error={error}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </PropertyRow>
  );
}
