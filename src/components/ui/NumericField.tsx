/* ---------------------------------------------------------------------------
   NumericField — PLAN §5. The workhorse of the inspector, and the only
   free-numeric input in the app.

   · Drag-scrub in NLE convention: press and move horizontally to adjust,
     Shift = ×0.1, Ctrl = ×10. A press that does not move is a click, which
     focuses and selects the whole value so typing replaces.
   · `onCommit` is REQUIRED: it is where the caller's history transaction
     closes. An optional onCommit leaves transactions open forever, and an open
     transaction suppresses every per-action snapshot — undo would silently die.
   · `value === 'mixed'` renders the literal text `Mixed` in --text-muted, keeps
     the field editable, and never renders blank.
   · data-editor-text-input="true" is set here, once, so no slice can forget it
     and no keystroke in a field ever reaches the shortcut layer (PLAN §5).
--------------------------------------------------------------------------- */

import './ui.css';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactElement } from 'react';
import { AlertCircle } from 'lucide-react';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export interface NumericFieldProps {
  value: number | 'mixed';
  /** Fires continuously during scrub and typing. Cheap: does not open a history entry. */
  onChange(next: number): void;
  /** Fires on pointerup / Enter / blur. REQUIRED: this is where the transaction closes. */
  onCommit(next: number): void;
  /** Fires on Escape. The field reverts to `value` and the caller calls abortHistory(). */
  onCancel?(): void;
  /** Accessible name; PropertyRow renders the visible copy. */
  label: string;
  min?: number;
  max?: number;
  /** Keyboard arrow increment, default 1. */
  step?: number;
  /** Decimals shown, default 0. */
  precision?: number;
  /** Units per pixel of horizontal drag. Default step. Shift = ×0.1, Ctrl = ×10. */
  scrubSensitivity?: number;
  /** '%', '°', '×' */
  suffix?: string;
  disabled?: boolean;
  disabledReason?: string;
  loading?: boolean;
  error?: string | null;
  /** 'panel' (default) = --surface-well inset. 'well' = transparent + hairline underline. */
  surface?: 'panel' | 'well';
  id?: string;
}

const SCRUB_THRESHOLD_PX = 3;

const clamp = (n: number, min?: number, max?: number): number => {
  let out = n;
  if (typeof min === 'number' && out < min) out = min;
  if (typeof max === 'number' && out > max) out = max;
  return out;
};

export function NumericField({
  value,
  onChange,
  onCommit,
  onCancel,
  label,
  min,
  max,
  step = 1,
  precision = 0,
  scrubSensitivity,
  suffix,
  disabled = false,
  disabledReason,
  loading = false,
  error = null,
  surface = 'panel',
  id,
}: NumericFieldProps): ReactElement {
  if (import.meta.env.DEV && disabled && !disabledReason) {
    throw new Error(`NumericField "${label}": \`disabled\` requires a \`disabledReason\`.`);
  }

  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isMixed = value === 'mixed';
  const format = useCallback(
    (n: number) => (isMixed ? 'Mixed' : n.toFixed(precision)),
    [isMixed, precision],
  );

  const [text, setText] = useState<string>(() => (isMixed ? 'Mixed' : format(value)));
  const [editing, setEditing] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);

  // Track the external value while the user is not typing.
  useEffect(() => {
    if (editing) return;
    setText(isMixed ? 'Mixed' : format(value as number));
  }, [value, isMixed, editing, format]);

  const scrub = useRef<{ startX: number; startValue: number; moved: boolean } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLInputElement>) => {
    if (disabled || loading || event.button !== 0) return;
    scrub.current = {
      startX: event.clientX,
      startValue: isMixed ? 0 : (value as number),
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLInputElement>) => {
    const state = scrub.current;
    if (!state) return;
    const dx = event.clientX - state.startX;
    if (!state.moved && Math.abs(dx) < SCRUB_THRESHOLD_PX) return;

    if (!state.moved) {
      state.moved = true;
      setScrubbing(true);
      setEditing(true);
    }

    const base = scrubSensitivity ?? step;
    const modifier = event.shiftKey ? 0.1 : event.ctrlKey || event.metaKey ? 10 : 1;
    const next = clamp(state.startValue + dx * base * modifier, min, max);
    setText(next.toFixed(precision));
    onChange(next);
  };

  const endScrub = (event: PointerEvent<HTMLInputElement>) => {
    const state = scrub.current;
    scrub.current = null;
    if (!state) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!state.moved) {
      // A click, not a scrub: focus and select the whole value so typing replaces.
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    setScrubbing(false);
    setEditing(false);
    const parsed = Number(text);
    onCommit(clamp(Number.isFinite(parsed) ? parsed : state.startValue, min, max));
  };

  const commitText = () => {
    setEditing(false);
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(isMixed ? 'Mixed' : format(value as number));
      return;
    }
    const next = clamp(parsed, min, max);
    setText(next.toFixed(precision));
    onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || loading) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      commitText();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      setText(isMixed ? 'Mixed' : format(value as number));
      onCancel?.();
      inputRef.current?.blur();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const modifier = event.shiftKey ? 0.1 : event.ctrlKey || event.metaKey ? 10 : 1;
      const base = isMixed ? 0 : (value as number);
      const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * modifier;
      const next = clamp(base + delta, min, max);
      setText(next.toFixed(precision));
      onChange(next);
      onCommit(next);
    }
  };

  const input = (
    <input
      ref={inputRef}
      id={fieldId}
      className="ve-field-input"
      data-editor-text-input="true"
      data-mixed={isMixed || undefined}
      data-disabled={disabled || undefined}
      data-invalid={error ? true : undefined}
      data-scrubbing={scrubbing || undefined}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      value={text}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      readOnly={disabled || loading}
      onChange={(e) => {
        if (disabled || loading) return;
        setEditing(true);
        setText(e.target.value);
        const parsed = Number(e.target.value);
        if (Number.isFinite(parsed)) onChange(clamp(parsed, min, max));
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (editing) commitText();
      }}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
    />
  );

  return (
    <div className="ve-field" data-surface={surface}>
      <div className="ve-field-row">
        {disabled && disabledReason ? <Tooltip content={disabledReason}>{input}</Tooltip> : input}
        {loading ? <Spinner /> : null}
        {suffix ? (
          <span className="ve-field-suffix type-numeric" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
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
