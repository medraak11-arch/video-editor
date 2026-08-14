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

   THE INITIAL OPEN STATE IS NOT THIS COMPONENT'S TO DECIDE. Every id in
   `InspectorGroupId` has an entry in `INITIAL_INSPECTOR_GROUPS`, so the lookup
   below always finds a real boolean and there is nothing for a component-level
   default to fill in. That is deliberate rather than incidental: a prop default
   here could not tell "the user has never touched this group" from "the user
   collapsed it", so it would reopen a group on every launch that the user had
   deliberately closed — the one group in the panel that forgets. The seed value
   belongs in `INITIAL_INSPECTOR_GROUPS`, where persistence can override it.
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
