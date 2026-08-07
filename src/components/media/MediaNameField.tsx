/* ---------------------------------------------------------------------------
   MediaNameField — the ONE rename affordance, used by the media rail row and by
   the inspector's Name row. RENAME.md §Rename affordance.

   Inline, never a dialog. PRODUCT.md names modal-first as an anti-reference, and
   a modal to edit one string is exactly that: a window, a title, two buttons and
   a focus trap, wrapped around a text field that already knows how to commit.

   The field holds the BASE NAME. The extension is rendered beside it as static
   --text-muted and cannot be edited, because the container and the codec are
   bound to it and letting someone turn .mp4 into .mov produces a file that lies
   about itself (RENAME.md §Scope). It reads as `interview_wide_a` + `.mp4`.

   Two things here are not obvious and are both consequences of TextField being a
   scaffold primitive this slice may not edit:

   · `value` echoes every keystroke. TextField's Escape rung compares its own
     text to `value`, so an echoed value means Escape is never swallowed there —
     which is why the Escape ladder is implemented on the wrapper below instead.
     The alternative (passing the stored name as `value`) makes TextField's
     post-commit resync wipe a REFUSED name out of the field, taking the user's
     input with it the moment they are told it is illegal.
   · reverting therefore remounts the input through `key`, which is the only way
     to clear the `editing` latch inside a primitive that owns its own text.

   Validation runs on every keystroke against the same predicate the main process
   uses (src/lib/filename.ts), so an illegal name is refused before Enter and
   before the disk is touched.
--------------------------------------------------------------------------- */

import './media.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactElement } from 'react';
import type { MediaId } from '../../types/model';
import { readStore, useEditorStore } from '../../state/store';
import { selectRenameDisabledReason, selectRenameState } from '../../state/mediaSlice';
import { checkBaseName, splitMediaPath } from '../../lib/filename';
import { TextField } from '../ui';

/** Why the field closed. The rail restores focus for the first two, not for a blur. */
export type RenameExit = 'commit' | 'cancel' | 'blur';

export interface MediaNameFieldProps {
  id: MediaId;
  /** Accessible name. The extension is appended to it, so it is announced too. */
  label: string;
  /** Set by PropertyRow's htmlFor. Omit and one is generated. */
  inputId?: string;
  /** Forwarded to TextField. 'well' is the inspector's flatter treatment. */
  surface?: 'panel' | 'well';
  /**
   * A refusal the caller knows about and this field cannot see — the inspector's
   * multi-selection case. Merged with the store's own gate.
   */
  extraDisabledReason?: string | null;
  /** Focus and select the base name on mount. The rail's inline editor sets it. */
  autoFocus?: boolean;
  /**
   * Present when the field is a transient editor that can close. Absent in the
   * inspector, where the field is resident and Escape belongs to the app.
   */
  onExit?(reason: RenameExit): void;
}

export function MediaNameField({
  id,
  label,
  inputId,
  surface = 'panel',
  extraDisabledReason = null,
  autoFocus = false,
  onExit,
}: MediaNameFieldProps): ReactElement | null {
  const item = useEditorStore((s) => s.items[id]);
  const rename = useEditorStore(useCallback((s) => selectRenameState(s, id), [id]));
  const gateReason = useEditorStore(useCallback((s) => selectRenameDisabledReason(s, id), [id]));

  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  /** True from the commit that started a rename until the bridge answers. */
  const pending = useRef(false);
  /** One exit per editor. A commit that also blurs must not report twice. */
  const exited = useRef(false);

  const exit = useCallback(
    (reason: RenameExit): void => {
      if (exited.current) return;
      exited.current = true;
      onExit?.(reason);
    },
    [onExit],
  );

  const path = item?.path ?? '';
  const { base, ext } = splitMediaPath(path);

  const [draft, setDraft] = useState(base);
  /** Bumped to remount the input, which is how a revert clears its text latch. */
  const [seed, setSeed] = useState(0);

  // The stored name moved — a successful rename, an undo of an import, a project
  // open. The draft follows it; there is nothing left to validate against.
  useEffect(() => {
    setDraft(base);
  }, [base]);

  useEffect(() => {
    if (!autoFocus) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [autoFocus]);

  if (!item) return null;

  const disabledReason = extraDisabledReason ?? gateReason;
  const disabled = disabledReason !== null;

  // Live validation, blocking the commit. `draft === base` is always legal: it is
  // the name the file already has, and reporting it would put an error on a field
  // nobody has touched.
  const check = draft === base ? { ok: true as const } : checkBaseName(draft, path);
  const localError = check.ok ? null : check.message;
  const error = localError ?? rename.error?.message ?? null;

  const revert = (): void => {
    setDraft(base);
    setSeed((n) => n + 1);
    readStore().clearRenameError(id);
  };

  const commit = (next: string): void => {
    if (disabled || rename.busy) return;
    if (!checkBaseName(next, path).ok) {
      setDraft(next); // keep the refused text on screen with its reason under it
      return;
    }
    if (next === base) {
      // Nothing to do, and nothing to tell main: an unchanged name is not an
      // edit, and detaching the preview's source to confirm that would be a
      // black frame in exchange for no information.
      readStore().clearRenameError(id);
      exit('commit');
      return;
    }
    pending.current = true;
    void readStore()
      .renameMedia(id, next)
      .then((result) => {
        pending.current = false;
        // A refusal keeps the field open with the typed name and the reason, so
        // the fix is one edit away rather than a retype from memory.
        if (result.ok) exit('commit');
      });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    // The Escape ladder (PLAN §8.10), one rung per state: a dirty field reverts,
    // a clean transient editor closes, a clean resident field lets the key pass
    // to whatever owns the selection underneath.
    if (draft !== base || error !== null) {
      event.preventDefault();
      event.stopPropagation();
      revert();
      return;
    }
    if (!onExit) return;
    event.preventDefault();
    event.stopPropagation();
    exit('cancel');
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!onExit || pending.current || rename.busy) return;
    const next = event.relatedTarget;
    if (next instanceof Node && wrapperRef.current?.contains(next)) return;
    // Focus left the editor without a decision. TextField has already committed
    // if anything was typed; this only takes the editor back down.
    if (draft === base && error === null) exit('blur');
  };

  return (
    <div className="media-name-field" ref={wrapperRef} onKeyDown={onKeyDown} onBlur={onBlur}>
      <TextField
        key={seed}
        id={inputId}
        inputRef={inputRef}
        value={draft}
        label={ext ? `${label}, the ${ext} extension is kept` : label}
        surface={surface}
        loading={rename.busy}
        disabled={disabled}
        disabledReason={disabledReason ?? undefined}
        error={error}
        onChange={(next) => {
          setDraft(next);
          if (rename.error) readStore().clearRenameError(id);
        }}
        onCommit={commit}
        onCancel={revert}
      />
      {ext ? (
        <span className="media-name-ext type-body" aria-hidden="true">
          {ext}
        </span>
      ) : null}
    </div>
  );
}
