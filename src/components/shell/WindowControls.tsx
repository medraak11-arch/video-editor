/* ---------------------------------------------------------------------------
   WindowControls — the frameless window's minimise / maximise / close cluster.

   This is one of the three sanctioned isElectron() branches (PLAN §1.1): there
   is no window to command in the browser, so the cluster renders nothing under
   `npm run dev:web` rather than shipping three dead controls.

   Everything goes through getEditorAPI() — no component in src/** touches
   window.editorAPI directly.
--------------------------------------------------------------------------- */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { IconButton } from '../ui';
import { getEditorAPI, isElectron } from '../../lib/editorApi';

export function WindowControls(): ReactElement | null {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isElectron()) return;
    const api = getEditorAPI();
    let alive = true;

    void api.window.isMaximized().then((value) => {
      if (alive) setMaximized(value);
    });

    const unsubscribe = api.window.onMaximizeChange((value) => {
      if (alive) setMaximized(value);
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  if (!isElectron()) return null;

  const api = getEditorAPI();

  return (
    <div className="shell-window-controls app-no-drag">
      <IconButton
        icon={<Minus size={16} strokeWidth={1.75} />}
        label="Minimise"
        size="sm"
        onClick={() => api.window.minimize()}
      />
      <IconButton
        icon={
          maximized ? (
            <Copy size={14} strokeWidth={1.75} />
          ) : (
            <Square size={14} strokeWidth={1.75} />
          )
        }
        label={maximized ? 'Restore' : 'Maximise'}
        size="sm"
        onClick={() => api.window.maximizeToggle()}
      />
      <IconButton
        icon={<X size={16} strokeWidth={1.75} />}
        label="Close"
        size="sm"
        tone="danger"
        onClick={() => api.window.close()}
      />
    </div>
  );
}
