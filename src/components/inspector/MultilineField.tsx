/* ---------------------------------------------------------------------------
   MultilineField — free text that contains newlines.

   NOT a thirteenth ui primitive, and deliberately local to the inspector. The
   difference from TextField is not styling, it is a semantic one that only two
   surfaces in the app have: a title's `text` and a cue's `text` are the only
   strings in the model where `\n` is DATA (model.ts: "'\n' separates lines").
   Everywhere else a newline is either impossible or meaningless. A primitive
   earns its place by being needed by more than one slice; this is needed by one,
   twice.

   It borrows TextField's classes rather than its component, so the recess, the
   focus ring and the disabled treatment are the shared ones and there is no
   second definition of any of them.

   ENTER INSERTS A NEWLINE, so commit moves to blur. That is the one place this
   diverges from every other field in the inspector, and it has to: Enter is the
   only key that can produce the character this field exists to hold. Escape
   still reverts a dirty field and still falls through when clean — the same rung
   of the Escape ladder TextField documents, because a keyboard trap here would
   be no less of one for being in a textarea.

   `Ctrl+Enter` IS FIELD-SCOPED AND THAT IS THE WHOLE POINT (CREATIVE §6.6.1).
   It is handled here, on the element that has focus, rather than globally —
   because "which cue does this close" must never need answering. There is
   deliberately no most-recently-touched-cue concept anywhere in this slice; the
   cue being closed is the cue whose field has focus, by construction. The
   handler receives the field's CURRENT text so the caller can write the text
   and the out-point in one transaction rather than racing its own blur.

   `textarea` is inside TEXT_INPUT_SELECTOR, so every keystroke here — `C`,
   Space, the lot — is already inert at the shortcut layer. That is what keeps
   playback running through the whole authoring loop (§6.6.1), and it is a
   property of the element type rather than of anything this component does, so
   it cannot be lost by editing this file.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useEffect, useState } from 'react';
import type { KeyboardEvent, ReactElement, Ref } from 'react';

export interface MultilineFieldProps {
  value: string;
  onCommit(next: string): void;
  /** Accessible name. PropertyRow renders the visible copy. */
  label: string;
  /** Visible rows before it scrolls. */
  rows?: number;
  placeholder?: string;
  id?: string;
  /**
   * FALSE inside the windowed cue list. A user-resizable row would make the
   * list's row height depend on the row, which §6.6.4 forbids outright: the
   * window's geometry is computed from a constant, and a row that could grow
   * would put every row below it at the wrong offset.
   */
  resizable?: boolean;
  /** CREATIVE §6.6.1. Receives the field's current text; caller commits both. */
  onCtrlEnter?(currentText: string): void;
  inputRef?: Ref<HTMLTextAreaElement>;
}

export function MultilineField({
  value,
  onCommit,
  label,
  rows = 3,
  placeholder,
  id,
  resizable = true,
  onCtrlEnter,
  inputRef,
}: MultilineFieldProps): ReactElement {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (editing) return;
    setText(value);
  }, [value, editing]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      if (!onCtrlEnter) return;
      // Swallowed so the newline Enter would otherwise insert never lands: the
      // gesture means "this line is finished", and leaving a trailing blank line
      // in every cue the user closed with it would be a silent data change.
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      onCtrlEnter(text);
      return;
    }
    if (event.key !== 'Escape') return;
    if (text === value) return; // clean: let the dialog/panel have it
    event.preventDefault();
    event.stopPropagation();
    setEditing(false);
    setText(value);
  };

  return (
    <div className="ve-field" data-surface="panel">
      <div className="ve-field-row">
        <textarea
          ref={inputRef}
          id={id}
          className="ve-field-input ve-field-input-text ve-field-input-multiline"
          data-editor-text-input="true"
          data-fixed={resizable ? undefined : true}
          rows={rows}
          value={text}
          placeholder={placeholder}
          aria-label={label}
          spellCheck
          onChange={(event) => {
            setEditing(true);
            setText(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (!editing) return;
            setEditing(false);
            onCommit(text);
          }}
        />
      </div>
    </div>
  );
}
