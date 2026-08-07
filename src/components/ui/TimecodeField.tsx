/* ---------------------------------------------------------------------------
   TimecodeField — PLAN §5. Scaffold-owned, NOT preview-owned.

   A directly-editable timecode is an input, and §5's first sentence forbids a
   slice defining one. Preview's transport and the timeline ruler both use this;
   there is exactly one timecode field implementation in the app.

   Invalid input reverts to `value` and sets the error state with the message
   'Not a timecode'. Valid input commits and clears the error.
--------------------------------------------------------------------------- */

import './ui.css';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { AlertCircle } from 'lucide-react';
import type { Frames } from '../../types/model';
import { framesToTimecode, timecodeToFrames } from '../../lib/time';
import { Tooltip } from './Tooltip';

export interface TimecodeFieldProps {
  value: Frames;
  fps: number;
  /** Parsed with timecodeToFrames. null (invalid) reverts and shows 'Not a timecode'. */
  onCommit(frames: Frames): void;
  onCancel?(): void;
  /** Accessible name, e.g. 'Playhead position'. */
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  /** 'well' is the transport's variant. */
  surface?: 'panel' | 'well';
}

export function TimecodeField({
  value,
  fps,
  onCommit,
  onCancel,
  label,
  disabled = false,
  disabledReason,
  surface = 'panel',
}: TimecodeFieldProps): ReactElement {
  if (import.meta.env.DEV && disabled && !disabledReason) {
    throw new Error(`TimecodeField "${label}": \`disabled\` requires a \`disabledReason\`.`);
  }

  const id = useId();
  const errorId = `${id}-error`;
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [text, setText] = useState(() => framesToTimecode(value, fps));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return;
    setText(framesToTimecode(value, fps));
  }, [value, fps, editing]);

  const commit = () => {
    setEditing(false);
    const frames = timecodeToFrames(text, fps);
    if (frames === null) {
      setError('Not a timecode');
      setText(framesToTimecode(value, fps));
      return;
    }
    setError(null);
    setText(framesToTimecode(frames, fps));
    onCommit(frames);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      inputRef.current?.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      setError(null);
      setText(framesToTimecode(value, fps));
      onCancel?.();
      inputRef.current?.blur();
    }
  };

  const input = (
    <input
      ref={inputRef}
      id={id}
      className="ve-field-input"
      data-editor-text-input="true"
      data-disabled={disabled || undefined}
      data-invalid={error ? true : undefined}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      size={11}
      value={text}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      readOnly={disabled}
      onChange={(e) => {
        if (disabled) return;
        setEditing(true);
        setText(e.target.value);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (editing) commit();
      }}
      onFocus={(e) => e.currentTarget.select()}
      style={{ cursor: 'text' }}
    />
  );

  return (
    <div className="ve-field" data-surface={surface}>
      <div className="ve-field-row">
        {disabled && disabledReason ? <Tooltip content={disabledReason}>{input}</Tooltip> : input}
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
