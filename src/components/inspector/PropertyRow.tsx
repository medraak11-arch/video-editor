/* ---------------------------------------------------------------------------
   PropertyRow — label on the left in label type, control on the right.

   The row is presentational: it owns the two-column geometry and the accessible
   pairing between the visible copy and the control, and nothing else. The
   controls themselves are the scaffold's primitives.
--------------------------------------------------------------------------- */

import './inspector.css';
import type { ReactElement, ReactNode } from 'react';

export interface PropertyRowProps {
  /** Visible copy. Sentence case. */
  label: string;
  /** id of the control this label names. */
  htmlFor: string;
  /** Rendered under the control — a unit note, or a refusal message. */
  children: ReactNode;
}

export function PropertyRow({ label, htmlFor, children }: PropertyRowProps): ReactElement {
  return (
    <div className="ve-prop-row">
      <label className="ve-prop-label type-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="ve-prop-control">{children}</div>
    </div>
  );
}
