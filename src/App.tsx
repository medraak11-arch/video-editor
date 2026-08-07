/* ---------------------------------------------------------------------------
   App — composition root. Shell-owned. PLAN §8.1.

   ThemeProvider is the outermost element. useShortcuts() is mounted here, once,
   and nowhere else. FileDropTarget, ExportDialog and ShortcutOverlay render
   unconditionally at the end of the tree: they read the store themselves and
   render nothing in flow when idle, so the shell passes them no open/close props
   and never conditionally mounts them.

   FileDropTarget is here, and not inside MediaRail, on purpose (PLAN §8.5): the
   rail unmounts when it is collapsed, and the window-level dragover listener is
   the only thing calling preventDefault() on an OS file drag. Without it alive,
   the browser default takes over and an Electron window navigates away to the
   dropped file, taking the unsaved timeline with it.

   The shell owns mounting and chrome; the contents are each slice's.
--------------------------------------------------------------------------- */

import './components/shell/shell.css';
import type { ReactElement } from 'react';
import { ThemeProvider } from './components/shell/ThemeProvider';
import { TitleBar } from './components/shell/TitleBar';
import { PanelGroup } from './components/shell/PanelGroup';
import { useUiPersistence } from './components/shell/useUiPersistence';
import { FileDropTarget } from './components/media/FileDropTarget';
import { ExportDialog } from './components/export/ExportDialog';
import { ShortcutOverlay } from './keyboard/ShortcutOverlay';
import { useShortcuts } from './keyboard/useShortcuts';
import { useOpenHandoff } from './keyboard/useOpenHandoff';

export function App(): ReactElement {
  useShortcuts();
  useUiPersistence();
  useOpenHandoff();

  return (
    <ThemeProvider>
      <TitleBar />
      <PanelGroup />
      <FileDropTarget />
      <ExportDialog />
      <ShortcutOverlay />
    </ThemeProvider>
  );
}
