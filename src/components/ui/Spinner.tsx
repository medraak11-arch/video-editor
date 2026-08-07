/* ---------------------------------------------------------------------------
   Spinner — the loading-state glyph shared by Button and IconButton.

   Not one of the nine primitives; it is never used on its own. Under
   prefers-reduced-motion it becomes a static three-dot glyph occupying exactly
   the same 12px slot, so nothing shifts (PLAN §5, loading state).
--------------------------------------------------------------------------- */

import './ui.css';
import type { ReactElement } from 'react';
import { useReducedMotion } from '../../lib/useReducedMotion';

export function Spinner(): ReactElement {
  const reduced = useReducedMotion();
  if (reduced) {
    return (
      <span className="ve-spinner-static" aria-hidden="true">
        &#183;&#183;&#183;
      </span>
    );
  }
  return <span className="ve-spinner" aria-hidden="true" />;
}
