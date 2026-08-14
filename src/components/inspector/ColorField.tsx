/* ---------------------------------------------------------------------------
   ColorField — a '#rrggbb' the USER owns.

   THE ONE PLACE A LITERAL COLOUR IS CORRECT. Everything in this app draws from
   the semantic token layer, and this control's value is the exception the rule
   is written around: `TitleSpec.color` and `SubtitleStyle.color` are the user's
   own DATA, going into their own frame, and rendering the swatch in anything
   but the actual colour would be showing them something other than what they
   chose. The chrome around it — recess, hairline, focus ring, the hex field —
   is all tokens.

   TWO CONTROLS FOR ONE VALUE, and both are the point. `<input type="color">`
   opens the platform picker, which is the right tool for choosing and the wrong
   one for stating: it announces nothing useful, cannot be typed into, and its
   value is legible only to someone who can see it. So the hex is a real text
   field beside it — keyboard-complete, screen-reader-complete, copyable and
   pasteable between the title and the subtitle style, which is the thing a user
   matching two colours actually wants to do. Neither is decoration for the
   other.

   The swatch carries a hairline because a pure-black swatch on a dark panel and
   a pure-white one on daylight both otherwise dissolve into the surface, and a
   control whose boundary vanishes at the extremes of its own range fails
   DESIGN.md's ≥3:1 floor for non-text UI at exactly the values people pick most.

   THE FALLBACK IS THE MODEL'S OWN DEFAULT, passed in. When the stored string is
   not a well-formed colour there has to be something to hand the platform
   picker, which accepts no token and no empty value — but that something must
   not be a literal invented here. `DEFAULT_TITLE.color` and
   `DEFAULT_SUBTITLE_STYLE.color` already declare what each field falls back to,
   so the caller supplies it and there is one source of truth per field rather
   than a black that is wrong for any field whose default is not black.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';

/** Six digits, hash required. The model's format, not a tolerant superset. */
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Three-digit shorthand and a bare hash-less pair are what people paste; both
 *  normalise to the six-digit, hash-prefixed shape the model declares. */
function normalizeHex(raw: string): string | null {
  const s = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toLowerCase()}`;
  return null;
}

export interface ColorFieldProps {
  /** '#rrggbb'. */
  value: string;
  onCommit(next: string): void;
  /** Accessible name. PropertyRow renders the visible copy. */
  label: string;
  /**
   * Shown when `value` is not a well-formed '#rrggbb'. REQUIRED, and always the
   * model's declared default for this field — see the header.
   */
  fallback: string;
  id?: string;
}

export function ColorField({
  value,
  onCommit,
  label,
  fallback,
  id,
}: ColorFieldProps): ReactElement {
  const generated = useId();
  const swatchId = id ?? generated;
  const hexId = `${swatchId}-hex`;

  const safe = (HEX.test(value) ? value : fallback).toLowerCase();
  const [text, setText] = useState(safe);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (editing) return;
    setText(safe);
  }, [safe, editing]);

  const commitText = (): void => {
    setEditing(false);
    const next = normalizeHex(text);
    // An unparseable hex reverts rather than erroring: there is no partially
    // valid colour to warn about, and the swatch beside it already shows the
    // value that is still in force.
    if (next === null) setText(safe);
    else {
      setText(next);
      if (next !== safe) onCommit(next);
    }
  };

  return (
    <div className="ve-field" data-surface="panel">
      <div className="ve-field-row ve-color-row">
        <input
          id={swatchId}
          className="ve-color-swatch"
          type="color"
          value={safe}
          aria-label={label}
          onChange={(event) => onCommit(event.target.value.toLowerCase())}
        />
        <input
          id={hexId}
          className="ve-field-input ve-field-input-text ve-color-hex"
          data-editor-text-input="true"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={text}
          aria-label={`${label} hex value`}
          onChange={(event) => {
            setEditing(true);
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitText();
              return;
            }
            if (event.key === 'Escape' && text !== safe) {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
              setText(safe);
            }
          }}
          onBlur={() => {
            if (editing) commitText();
          }}
        />
      </div>
    </div>
  );
}
