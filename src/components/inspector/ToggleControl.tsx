/* ---------------------------------------------------------------------------
   ToggleControl — a boolean, or a selection that disagrees about one.

   The presentational half of the fork described in ClipPropertyRow's header,
   split out because two callers need it against different backing stores:
   ClipToggleRow writes `ClipProperties` through `updateClipProperties`, and
   TitleGroup writes `TitleSpec` through `setClipTitle`. Only the write differs,
   so only the write is duplicated.

   role="checkbox", NOT role="switch", because `aria-checked="mixed"` is the
   standard way to say "some of the selection, not all" and `switch` is defined
   as on-or-off with no third state. A switch here would have to either lie
   about a mixed selection or invent a word for it.

   STATE IS THE WORD FIRST, the glyph second, the surface lightness third —
   never hue. `On` / `Off` / `Mixed` is readable under every colour-vision
   deficiency and by a screen reader, which is what DESIGN.md's Icon Tax Rule
   asks. There is no accent here: the accent budget (PLAN §7.4) spends nothing
   in the inspector, and a checked box is not one of its three permitted uses.
--------------------------------------------------------------------------- */

import './inspector.css';
import type { ReactElement } from 'react';
import { Check, Minus } from 'lucide-react';

export interface ToggleControlProps {
  /** 'mixed' when the selection disagrees. */
  value: boolean | 'mixed';
  /** Receives the state being ASSERTED, never a flip. Mixed asserts `true`. */
  onChange(next: boolean): void;
  /** Accessible name. PropertyRow renders the visible copy. */
  label: string;
  id?: string;
  invalid?: boolean;
  describedBy?: string;
}

export function ToggleControl({
  value,
  onChange,
  label,
  id,
  invalid = false,
  describedBy,
}: ToggleControlProps): ReactElement {
  const mixed = value === 'mixed';
  /* A mixed selection resolves to `true` rather than flipping each clip on its
     own: per-clip flipping would leave the selection still mixed, so the
     control could not say what it had just done, and pressing it twice would
     not be a round trip. */
  const next = mixed ? true : !value;
  const word = mixed ? 'Mixed' : value ? 'On' : 'Off';

  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      className="ve-toggle"
      aria-checked={mixed ? 'mixed' : value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-state={mixed ? 'mixed' : value ? 'on' : 'off'}
      data-invalid={invalid || undefined}
      onClick={() => onChange(next)}
    >
      <span className="ve-toggle-box ve-icon-slot" aria-hidden="true">
        {mixed ? (
          <Minus size={12} strokeWidth={2.25} />
        ) : value ? (
          <Check size={12} strokeWidth={2.25} />
        ) : null}
      </span>
      <span className="ve-toggle-word type-label">{word}</span>
    </button>
  );
}
