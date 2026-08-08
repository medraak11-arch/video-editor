/* ---------------------------------------------------------------------------
   TitleBar — the frameless window's custom titlebar. Shell-owned.

   36 px on --surface-chrome. The bar itself is the drag region; every
   interactive child opts out with .app-no-drag, so a click on a control never
   starts a window drag.

   The dirty indicator is a --text-muted bullet appended to the project name,
   not a free-floating dot (PLAN §7.7): a bare dot is a state with no word and
   no accessible name. The region's accessible name reads
   '<project name>, unsaved changes' and its tooltip reads 'Unsaved changes'.

   AUTOSAVE GETS NO PIXELS (SAFETY.md §4). At rest nothing new is drawn: the
   recovery point and the autosave-failure state are words added to the tooltip
   and the accessible name that were already there. No spinner, no 'Saving…', no
   time that ticks — a label updating every twenty seconds is exactly the
   high-frequency motion at rest that PRODUCT.md forbids.

   The notice strip underneath is one of exactly three InlineNotice host sites
   (PLAN §5). One notice at a time; setNotice replaces, it never queues.
--------------------------------------------------------------------------- */

import './shell.css';
import type { ReactElement } from 'react';
import { PanelLeftClose, PanelLeftOpen, RotateCcw } from 'lucide-react';
import { Button, IconButton, InlineNotice } from '../ui';
import { useEditorStore } from '../../state/store';
import { discardRecovery, restoreRecovery } from '../../keyboard/projectActions';
import { AppMenu } from './AppMenu';
import { WindowControls } from './WindowControls';

/** '14:32' in the viewer's own locale. */
const recoveryPointTime = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** '8 August, 14:32' in the viewer's own locale. */
const offerTime = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export function TitleBar(): ReactElement {
  const projectName = useEditorStore((s) => s.projectName);
  const isDirty = useEditorStore((s) => s.isDirty);
  const notice = useEditorStore((s) => s.notice);
  const railCollapsed = useEditorStore((s) => s.railCollapsed);
  const toggleRail = useEditorStore((s) => s.toggleRail);
  const setNotice = useEditorStore((s) => s.setNotice);
  const autosaveAt = useEditorStore((s) => s.autosaveAt);
  const autosaveFailures = useEditorStore((s) => s.autosaveFailures);
  const recovery = useEditorStore((s) => s.recovery);

  // Two states are dropped on purpose. The failure state adds no icon and no
  // colour here: it has already been said properly, once, through the
  // InlineNotice channel (SAFETY §2.9). And the threshold is >= 2, matching that
  // escalation, so a single transient failure changes nothing on screen.
  const autosaveFailing = autosaveFailures >= 2;
  const dirtyDetail = autosaveFailing
    ? 'autosave is not working'
    : autosaveAt !== null
      ? `last recovery point ${recoveryPointTime(autosaveAt)}`
      : null;
  const titleText = isDirty
    ? dirtyDetail
      ? `Unsaved changes — ${dirtyDetail}`
      : 'Unsaved changes'
    : undefined;
  const spokenDetail = autosaveFailing
    ? ', autosave failed'
    : autosaveAt !== null
      ? `, last recovery point ${recoveryPointTime(autosaveAt)}`
      : '';

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

          <h1 className="shell-titlebar-title type-title" title={titleText}>
            <span className="shell-titlebar-name">{projectName}</span>
            {isDirty ? (
              <>
                <span className="shell-titlebar-dirty" aria-hidden="true">
                  •
                </span>
                <span className="sr-only">, unsaved changes{spokenDetail}</span>
              </>
            ) : null}
          </h1>
        </div>

        <div className="shell-titlebar-right app-no-drag">
          <AppMenu />
          <WindowControls />
        </div>
      </div>

      {/* A previous session died. Not a startup dialog — PRODUCT.md forbids a
          modal-first launch outright — and not the notice channel either, which
          replaces rather than queues and would let a re-probing media item evict
          a whole session of recovered work. role="status" is what announces it,
          politely and once, since nothing here takes focus. */}
      {recovery ? (
        <section
          className="shell-titlebar-recovery"
          role="status"
          aria-label="Recovered unsaved work"
        >
          <RotateCcw
            className="shell-titlebar-recovery-icon"
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <p className="shell-titlebar-recovery-text type-body">
            Recovered unsaved changes to {recovery.projectName} from {offerTime(recovery.savedAt)}.
          </p>
          <div className="shell-titlebar-recovery-actions">
            <Button variant="secondary" size="sm" onClick={() => void restoreRecovery()}>
              Restore
            </Button>
            <Button variant="ghost" size="sm" onClick={() => discardRecovery()}>
              Discard
            </Button>
          </div>
        </section>
      ) : null}

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
