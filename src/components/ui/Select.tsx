/* ---------------------------------------------------------------------------
   Select — one value out of a short, closed list. PLAN §5.

   INVENTORY NOTE (integration, PLAN §0.2). See TextField.tsx: §5's nine
   primitives hold no enumeration control, and the export dialog needs five.
   Menu is a command popover, not a form control — it has no value, no label
   association and no form semantics — so composing it here would have meant
   re-implementing a listbox inside a slice, which §5 forbids. The inventory is
   extended by two rather than broken.

   It is a NATIVE <select>. The platform popup is keyboard-operable, type-ahead
   searchable and screen-reader correct on every OS for free, and it is the one
   control where a hand-rolled listbox reliably loses. Only the closed face is
   styled, and it is styled to match NumericField exactly: the same `.ve-field`
   shell, the same inset recess, the same focus ring, the same error slot.

   `numeric` swaps the face to the mono family with tabular figures, for the
   values §7.2's Tabular Rule covers — resolution and frame rate.

   A native <select> is inside TEXT_INPUT_SELECTOR, so keys pressed while it has
   focus never reach the shortcut layer.
--------------------------------------------------------------------------- */

import './ui.css';
import { useId } from 'react';
import type { ReactElement } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { Tooltip } from './Tooltip';

export interface SelectOption<T extends string> {
  value: T;
  /** Sentence case, or a formatted numeral. */
  label: string;
}

export interface SelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange(next: T): void;
  /** Accessible name. PropertyRow renders the visible copy. */
  label: string;
  /** Render the face in the mono family with tabular figures. */
  numeric?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  error?: string | null;
  id?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  numeric = false,
  disabled = false,
  disabledReason,
  error = null,
  id,
}: SelectProps<T>): ReactElement {
  if (import.meta.env.DEV && disabled && !disabledReason) {
    throw new Error(`Select "${label}": \`disabled\` requires a \`disabledReason\`.`);
  }

  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;

  const control = (
    <span className="ve-select-shell">
      <select
        id={fieldId}
        className="ve-field-input ve-select"
        data-numeric={numeric || undefined}
        data-disabled={disabled || undefined}
        data-invalid={error ? true : undefined}
        value={value}
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="ve-select-chevron ve-icon-slot" aria-hidden="true">
        <ChevronDown size={14} strokeWidth={1.75} />
      </span>
    </span>
  );

  return (
    <div className="ve-field" data-surface="panel">
      <div className="ve-field-row">
        {disabled && disabledReason ? (
          <Tooltip content={disabledReason}>{control}</Tooltip>
        ) : (
          control
        )}
      </div>
      {error ? (
        <p id={errorId} className="ve-field-message type-label" role="alert">
          <span className="ve-icon-slot" aria-hidden="true">
            <AlertCircle size={14} strokeWidth={1.75} />
          </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}
