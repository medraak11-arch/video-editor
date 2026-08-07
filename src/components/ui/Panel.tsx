/* ---------------------------------------------------------------------------
   Panel — PLAN §5. A bounded region with a heading.

   NESTING IS FORBIDDEN AND ENFORCED: a Panel rendered inside a Panel throws in
   development. Flatten instead — a fifth in-flow plane means the layout is
   nested too deep (DESIGN.md §4, The Four Planes Rule).

   Who renders a Panel, stated once so integration cannot discover it: the shell
   renders bare containers for every region. MediaRail and Inspector each render
   exactly one, at their own root. Timeline, TimelineToolbar and PreviewWell
   render none. Dialog and Menu paint their own --surface-panel body.
--------------------------------------------------------------------------- */

import './ui.css';
import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';

export interface PanelProps {
  /** title type */
  heading?: ReactNode;
  /** right-aligned in the heading row */
  actions?: ReactNode;
  /** default true -> var(--space-lg) */
  padded?: boolean;
  /** default false */
  scroll?: boolean;
  className?: string;
  children: ReactNode;
}

const PanelContext = createContext(false);

export function Panel({
  heading,
  actions,
  padded = true,
  scroll = false,
  className,
  children,
}: PanelProps): ReactElement {
  const insidePanel = useContext(PanelContext);
  if (import.meta.env.DEV && insidePanel) {
    throw new Error('Nested panels are forbidden (DESIGN.md §4)');
  }

  return (
    <PanelContext.Provider value={true}>
      <section className={className ? `ve-panel ${className}` : 've-panel'}>
        {heading || actions ? (
          <header className="ve-panel-head">
            <h2 className="ve-panel-heading type-title">{heading}</h2>
            {actions ? <div className="ve-panel-actions">{actions}</div> : null}
          </header>
        ) : null}
        <div
          className="ve-panel-body"
          data-padded={padded || undefined}
          data-scroll={scroll || undefined}
        >
          {children}
        </div>
      </section>
    </PanelContext.Provider>
  );
}
