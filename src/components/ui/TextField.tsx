/* ---------------------------------------------------------------------------
   TextField — free text. PLAN §5.

   INVENTORY NOTE (integration, PLAN §0.2). §5 closed the primitive inventory at
   nine, and no member of that nine holds text: `NumericField` parses numbers and
   `TimecodeField` parses timecode. The export dialog needs a file name and an
   output folder, so the choice was between a tenth primitive here and a bespoke
   `<input>` inside the export slice — which §5 forbids outright ("No slice
   defines its own button, input, tooltip, notice or dialog"). The inventory is
   therefore extended by two, here and in Select.tsx, rather than broken.

   It shares NumericField's markup and every one of its state rules, so the two
   read as one control family: the same `.ve-field` shell, the same inset
   --surface-well recess, the same accent focus ring, the same error slot with
   icon plus message. The differences are only what text implies — the sans
   family rather than the mono, a text cursor rather than ew-resize, and no
   drag-scrub.

   `data-editor-text-input="true"` is set here, once, so a keystroke in this
   field can never reach the shortcut layer (PLAN §5).
--------------------------------------------------------------------------- */

import './ui.css';
import { useEffect, useId, useState } from 'react';
import type { KeyboardEvent, ReactElement, RefObject } from 'react';
import { AlertCircle } from 'lucide-react';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export interface TextFieldProps {
  value: string;
  /** Fires on every keystroke. Cheap: it opens no transaction. */
  onChange(next: string): void;
  /** Fires on Enter and on blur. Where a caller normalises or commits. */
  onCommit(next: string): void;
  /** Fires on Escape; the field reverts to `value` first. */
  onCancel?(): void;
  /** Accessible name. PropertyRow renders the visible copy. */
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  loading?: boolean;
  error?: string | null;
  /** 'panel' (default) = --surface-well inset. 'well' = transparent + hairline underline. */
  surface?: 'panel' | 'well';
  id?: string;
  inputRef?: RefObject<HTMLInputElement>;
}

export function TextField({
  value,
  onChange,
  onCommit,
  onCancel,
  label,
  placeholder,
  readOnly = false,
  disabled = false,
  disabledReason,
  loading = false,
  error = null,
  surface = 'panel',
  id,
  inputRef,
}: TextFieldProps): ReactElement {
  if (import.meta.env.DEV && disabled && !disabledReason) {
    throw new Error(`TextField "${label}": \`disabled\` requires a \`disabledReason\`.`);
  }

  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;

  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);

  // Track the external value while the user is not typing.
  useEffect(() => {
    if (editing) return;
    setText(value);
  }, [value, editing]);

  const commit = (): void => {
    setEditing(false);
    onCommit(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (disabled || loading) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'Escape') {
      // Rung (b) of the Escape ladder (PLAN §8.10): a DIRTY field reverts here and
      // swallows the key, so the dialog underneath does not also close.
      //
      // A CLEAN field must let it through. Swallowing unconditionally means a
      // dialog containing a text field can never be dismissed from the keyboard —
      // focus stays in the field, every Escape is consumed, and the only way out
      // is the mouse. That is a keyboard trap (WCAG 2.1.2).
      if (text === value) return;
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      setText(value);
      onCancel?.();
    }
  };

  const input = (
    <input
      ref={inputRef}
      id={fieldId}
      className="ve-field-input ve-field-input-text"
      data-editor-text-input="true"
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
      data-invalid={error ? true : undefined}
      type="text"
      autoComplete="off"
      spellCheck={false}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      readOnly={readOnly || disabled || loading}
      onChange={(event) => {
        if (readOnly || disabled || loading) return;
        setEditing(true);
        setText(event.target.value);
        onChange(event.target.value);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (editing) commit();
      }}
    />
  );

  return (
    <div className="ve-field" data-surface={surface}>
      <div className="ve-field-row">
        {disabled && disabledReason ? <Tooltip content={disabledReason}>{input}</Tooltip> : input}
        {loading ? <Spinner /> : null}
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
