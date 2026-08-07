/* ---------------------------------------------------------------------------
   ShortcutOverlay — the `?` sheet. Every registered shortcut, grouped by scope,
   read straight from the registry so it can never fall behind a binding.

   Mounted unconditionally by App.tsx; it reads ui.shortcutOverlayOpen and
   renders null when closed (PLAN §8.1). Escape closes it through the Dialog's
   own `cancel` event — rung (d) of the Escape ladder — so it never falls
   through to clearing the timeline selection underneath.
--------------------------------------------------------------------------- */

import './keyboard.css';
import { useRef } from 'react';
import type { ReactElement } from 'react';
import { Button, Dialog } from '../components/ui';
import { useEditorStore } from '../state/store';
import { SCOPE_LABEL, SCOPE_ORDER, SHORTCUTS } from './shortcuts';
import { ShortcutHint } from './ShortcutHint';
import type { ShortcutScope } from './shortcuts';

export function ShortcutOverlay(): ReactElement {
  const open = useEditorStore((s) => s.shortcutOverlayOpen);
  const setShortcutOverlayOpen = useEditorStore((s) => s.setShortcutOverlayOpen);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = (): void => setShortcutOverlayOpen(false);

  const sections = SCOPE_ORDER.map((scope: ShortcutScope) => ({
    scope,
    rows: SHORTCUTS.filter((def) => def.scope === scope),
  })).filter((section) => section.rows.length > 0);

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Keyboard shortcuts"
      description="Region shortcuts apply while that region has focus."
      width={520}
      initialFocusRef={closeRef}
      footer={
        <Button ref={closeRef} variant="secondary" onClick={close}>
          Close
        </Button>
      }
    >
      <div className="ve-shortcut-sheet">
        {sections.map((section) => (
          <section key={section.scope} className="ve-shortcut-section">
            <h3 className="ve-shortcut-section-heading type-title">
              {SCOPE_LABEL[section.scope]}
            </h3>
            <dl className="ve-shortcut-list">
              {section.rows.map((def) => (
                <div key={def.id} className="ve-shortcut-row">
                  <dt className="ve-shortcut-label type-body">{def.label}</dt>
                  <dd className="ve-shortcut-value">
                    {def.keys.map((_combo, i) => (
                      <ShortcutHint key={def.keys[i]} id={def.id} index={i} />
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
