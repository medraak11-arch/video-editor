/* ---------------------------------------------------------------------------
   FileDropTarget — the whole-window OS file drop. OWNER: media (PLAN §8.5,
   "Media slice owns the window-level listeners and dropActive").

   It renders no in-flow chrome: it mounts the window listeners and the portalled
   affordance, nothing else. It exists as its own component because the listeners
   must NOT live inside a collapsible region — the media rail is unmounted when
   the rail is collapsed, and with no dragover handler alive nothing calls
   preventDefault(), so the browser default takes over and an Electron window
   navigates away to the dropped file, destroying the session.

   The shell therefore mounts this once, unconditionally, at the app root
   alongside ExportDialog and ShortcutOverlay (PLAN §0.2 integration change).
--------------------------------------------------------------------------- */

import './media.css';
import type { ReactElement } from 'react';
import { useEditorStore } from '../../state/store';
import { DropOverlay } from './DropOverlay';
import { useFileDropTarget } from './useFileDropTarget';

export function FileDropTarget(): ReactElement | null {
  const dropActive = useEditorStore((s) => s.dropActive);
  useFileDropTarget();
  return <DropOverlay open={dropActive} />;
}
