/* ---------------------------------------------------------------------------
   InspectorGroup — a named, collapsible disclosure. PLAN §8.15.

   Seven numeric rows always open in a 280px column is a miniature of the
   wall-of-controls anti-reference, so capability discloses under a name instead.
   Open state lives in ui.inspectorGroups and persists with the rest of the view
   state.

   The header is a real button: aria-expanded, the standard focus ring from
   base.css, hover and active along the tonal ramp, and a chevron that rotates
   at var(--dur-feedback). It is never disabled and never loads, so those two of
   the seven states do not arise here.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useEditorStore } from '../../state/store';
import type { InspectorGroupId } from '../../state/uiSlice';

export interface InspectorGroupProps {
  id: InspectorGroupId;
  /** Sentence case. */
  heading: string;
  children: ReactNode;
}

export function InspectorGroup({ id, heading, children }: InspectorGroupProps): ReactElement {
  const open = useEditorStore((s) => s.inspectorGroups[id]);
  const setInspectorGroup = useEditorStore((s) => s.setInspectorGroup);
  const bodyId = `${useId()}-body`;

  return (
    <section className="ve-group">
      <h3 className="ve-group-heading">
        <button
          type="button"
          className="ve-group-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setInspectorGroup(id, !open)}
        >
          <span className="ve-group-chevron" data-open={open || undefined} aria-hidden="true">
            <ChevronRight size={14} strokeWidth={1.75} />
          </span>
          <span className="type-title">{heading}</span>
        </button>
      </h3>
      <div id={bodyId} className="ve-group-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
