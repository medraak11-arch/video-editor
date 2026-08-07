/* ---------------------------------------------------------------------------
   useOpenHandoff — the renderer end of a .veproj handed over by the OS.

   Mounted once, in App, beside useShortcuts. Main sends a path (double-click in
   Explorer/Finder, or a second launch folded into this one by the
   single-instance lock) and this hook routes it into `openProject` — the same
   function Ctrl+O calls, so a project arriving from the OS behaves exactly like
   one opened from the picker, including its guard against a second open while
   one is in flight.
--------------------------------------------------------------------------- */

import { useEffect } from 'react';
import { getEditorAPI } from '../lib/editorApi';
import { openProject } from './projectActions';

export function useOpenHandoff(): void {
  useEffect(() => {
    // getEditorAPI throws only if nothing registered a bridge at boot; there is
    // no handoff to listen for in that case either.
    try {
      return getEditorAPI().project.onOpenRequest((path) => {
        void openProject(path);
      });
    } catch {
      return undefined;
    }
  }, []);
}
