/* ---------------------------------------------------------------------------
   Dialog — PLAN §5. Native <dialog>, so the focus trap, focus restore, the
   Escape `cancel` event and the ::backdrop scrim are the platform's rather than
   ours. Rare by design.

   It paints its own --surface-panel body with --shadow-dialog and must not
   wrap a Panel (PLAN §7.0).

   The <dialog> ELEMENT stays mounted for the component's whole life; only its
   contents are conditional. Returning null while the element was still open used
   to tear it out of the DOM before `close()` ran, so the platform's close steps
   never fired and focus landed on <body> instead of returning to whatever opened
   the dialog. A closed <dialog> is display:none, so keeping it costs no layout.
--------------------------------------------------------------------------- */

import './ui.css';
import { useEffect, useRef } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';

export interface DialogProps {
  open: boolean;
  onClose(): void;
  /** headline type; becomes the accessible name */
  title: string;
  description?: string;
  /** action row, right-aligned, primary last */
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement>;
  /** px, default 480 */
  width?: number;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  initialFocusRef,
  width = 480,
  children,
}: DialogProps): ReactElement {
  const ref = useRef<HTMLDialogElement | null>(null);
  /** What the caller currently believes. Committed values only — never written in render. */
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // The dialog's own initial focus, once the element is in the top layer.
      window.requestAnimationFrame(() => initialFocusRef?.current?.focus());
    } else if (!open && el.open) {
      // The platform's close steps run here — including returning focus to whatever
      // had it when showModal() was called.
      el.close();
    }
  }, [open, initialFocusRef]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (event: Event) => {
      // Escape is consumed here (rung d of PLAN §8.10's ladder) and must not fall
      // through to edit.clearSelection on the timeline underneath.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    // `close` also fires from OUR own el.close() above, which runs because the caller
    // already set open to false. Reporting that back would be an echo, and for the
    // export dialog an echo means requestClose runs a second time and cancels a job
    // that was never running. Only a close the element decided on is reported.
    const onNativeClose = () => {
      if (openRef.current) onClose();
    };
    el.addEventListener('cancel', onCancel);
    el.addEventListener('close', onNativeClose);
    return () => {
      el.removeEventListener('cancel', onCancel);
      el.removeEventListener('close', onNativeClose);
    };
  }, [onClose]);

  // Closing on unmount, so a dialog torn down while open still returns focus.
  useEffect(
    () => () => {
      openRef.current = false;
      const el = ref.current;
      if (el?.open) el.close();
    },
    [],
  );

  return (
    <dialog
      ref={ref}
      className="ve-dialog"
      aria-label={title}
      style={{ zIndex: 'var(--z-dialog)' }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> itself.
        if (event.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div className="ve-dialog-surface" style={{ width }}>
          <header className="ve-dialog-head">
            <h2 className="ve-dialog-title type-headline">{title}</h2>
            {description ? <p className="ve-dialog-description type-body">{description}</p> : null}
          </header>
          <div className="ve-dialog-body">{children}</div>
          {footer ? <footer className="ve-dialog-foot">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}
