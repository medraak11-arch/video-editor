/* ---------------------------------------------------------------------------
   TitleBar — the frameless window's custom titlebar. Shell-owned.

   36 px on --surface-chrome. The bar itself is the drag region; every
   interactive child opts out with .app-no-drag, so a click on a control never
   starts a window drag.

   The dirty indicator is a --text-muted bullet appended to the project name,
   not a free-floating dot (PLAN §7.7): a bare dot is a state with no word and
   no accessible name. The region's accessible name reads
   '<project name>, unsaved changes' and its tooltip reads 'Unsaved changes'.

   The notice strip underneath is one of exactly three InlineNotice host sites
   (PLAN §5). One notice at a time; setNotice replaces, it never queues.
--------------------------------------------------------------------------- */

import './shell.css';
import type { ReactElement } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { IconButton, InlineNotice } from '../ui';
import { useEditorStore } from '../../state/store';
import { AppMenu } from './AppMenu';
import { WindowControls } from './WindowControls';

export function TitleBar(): ReactElement {
  const projectName = useEditorStore((s) => s.projectName);
  const isDirty = useEditorStore((s) => s.isDirty);
  const notice = useEditorStore((s) => s.notice);
  const railCollapsed = useEditorStore((s) => s.railCollapsed);
  const toggleRail = useEditorStore((s) => s.toggleRail);
  const setNotice = useEditorStore((s) => s.setNotice);

  return (
    <header className="shell-titlebar">
      <div className="shell-titlebar-bar app-drag-region">
        <div className="shell-titlebar-left">
          <IconButton
            className="app-no-drag"
            // PanelGroup hands focus here when collapsing the rail would otherwise
            // drop it on <body>, which leaves no active data-shortcut-scope.
            data-rail-toggle="true"
            icon={
              railCollapsed ? (
                <PanelLeftOpen size={16} strokeWidth={1.75} />
              ) : (
                <PanelLeftClose size={16} strokeWidth={1.75} />
              )
            }
            label="Media rail"
            size="sm"
            pressed={!railCollapsed}
            onClick={() => toggleRail()}
          />

          <h1
            className="shell-titlebar-title type-title"
            title={isDirty ? 'Unsaved changes' : undefined}
          >
            <span className="shell-titlebar-name">{projectName}</span>
            {isDirty ? (
              <>
                <span className="shell-titlebar-dirty" aria-hidden="true">
                  •
                </span>
                <span className="sr-only">, unsaved changes</span>
              </>
            ) : null}
          </h1>
        </div>

        <div className="shell-titlebar-right app-no-drag">
          <AppMenu />
          <WindowControls />
        </div>
      </div>

      {notice ? (
        <div className="shell-titlebar-notice">
          <InlineNotice
            tone={notice.tone}
            title={notice.title}
            message={notice.message}
            onDismiss={() => setNotice(null)}
          />
        </div>
      ) : null}
    </header>
  );
}
