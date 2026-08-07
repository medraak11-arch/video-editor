/* ---------------------------------------------------------------------------
   DropOverlay — the file-drop affordance for the whole window (PLAN §7.7).

   A 2px --border-hairline-strong inset border on a --surface-panel overlay,
   with the FolderInput icon and a word. It spends no accent: a full-window
   accent border is exactly the "never a background for large areas" case
   DESIGN.md rules out, and PLAN §7.4 withdrew it.

   pointer-events are off for the whole overlay, so it can never intercept the
   dragover / drop it is describing.
--------------------------------------------------------------------------- */

import './media.css';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput } from 'lucide-react';

export interface DropOverlayProps {
  open: boolean;
}

export function DropOverlay({ open }: DropOverlayProps): ReactElement | null {
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="media-drop-overlay" role="status">
      <div className="media-drop-overlay-scrim" aria-hidden="true" />
      <div className="media-drop-overlay-frame">
        <span className="ve-icon-slot" aria-hidden="true">
          <FolderInput size={16} strokeWidth={1.75} />
        </span>
        <span className="type-title">Drop video or audio files</span>
      </div>
    </div>,
    document.body,
  );
}
