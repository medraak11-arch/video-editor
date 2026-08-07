/* ---------------------------------------------------------------------------
   AppMenu — the titlebar overflow menu. Shell-owned.

   This is the only theme control in the app (PLAN §7.1): a `Theme` submenu with
   three checked items. Without it two of the three verified palettes would be
   unreachable and would ship untested.

   It also carries `Project settings`, which toggles ui.inspectorPinned — the
   "corrected inline later" path that keeps project format out of a setup modal
   (PLAN §8.15, PRODUCT.md's modal-first anti-reference).

   `checked` renders a Check glyph in the leading slot, never a colour change,
   so every toggle in here survives deuteranopia and spends no accent.
--------------------------------------------------------------------------- */

import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { FolderOpen, MoreHorizontal, PanelLeft, Save, Sliders, Upload } from 'lucide-react';
import { IconButton, Menu } from '../ui';
import type { MenuItem } from '../ui';
import { readStore, useEditorStore } from '../../state/store';
import { THEME_LABELS, THEME_NAMES } from '../../state/uiSlice';
import { ShortcutHint } from '../../keyboard/ShortcutHint';
import { openProject, saveProject } from '../../keyboard/projectActions';

/**
 * A menu item that starts async work closes the menu and reports through the
 * notice channel (PLAN §5). saveProject / openProject already report their own
 * failures; this only catches the case where the bridge itself is unreachable,
 * so a rejection is never swallowed silently.
 */
function run(work: Promise<void>, title: string): void {
  void work.catch(() => {
    readStore().setNotice({
      tone: 'danger',
      title,
      message: 'The editor could not reach the file system',
    });
  });
}

export function AppMenu(): ReactElement {
  const theme = useEditorStore((s) => s.theme);
  const railCollapsed = useEditorStore((s) => s.railCollapsed);
  const inspectorPinned = useEditorStore((s) => s.inspectorPinned);

  const setTheme = useEditorStore((s) => s.setTheme);
  const toggleRail = useEditorStore((s) => s.toggleRail);
  const setInspectorPinned = useEditorStore((s) => s.setInspectorPinned);
  const setExportDialogOpen = useEditorStore((s) => s.setExportDialogOpen);
  const setShortcutOverlayOpen = useEditorStore((s) => s.setShortcutOverlayOpen);

  const items = useMemo<MenuItem[]>(
    () => [
      {
        kind: 'item',
        id: 'open',
        label: 'Open project',
        icon: <FolderOpen size={14} strokeWidth={1.75} />,
        onSelect: () => run(openProject(), 'Could not open'),
      },
      {
        kind: 'item',
        id: 'save',
        label: 'Save',
        icon: <Save size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="file.save" />,
        onSelect: () => run(saveProject(), 'Save failed'),
      },
      {
        kind: 'item',
        id: 'save-as',
        label: 'Save as',
        onSelect: () => run(saveProject({ saveAs: true }), 'Save failed'),
      },
      { kind: 'separator', id: 'sep-export' },
      {
        kind: 'item',
        id: 'export',
        label: 'Export video',
        icon: <Upload size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="file.export" />,
        onSelect: () => setExportDialogOpen(true),
      },
      { kind: 'separator', id: 'sep-view' },
      {
        kind: 'item',
        id: 'rail',
        label: 'Media rail',
        icon: <PanelLeft size={14} strokeWidth={1.75} />,
        checked: !railCollapsed,
        onSelect: () => toggleRail(),
      },
      {
        kind: 'item',
        id: 'project-settings',
        label: 'Project settings',
        icon: <Sliders size={14} strokeWidth={1.75} />,
        checked: inspectorPinned,
        onSelect: () => setInspectorPinned(!inspectorPinned),
      },
      {
        kind: 'submenu',
        id: 'theme',
        label: 'Theme',
        items: THEME_NAMES.map((name) => ({
          kind: 'item' as const,
          id: `theme.${name}`,
          label: THEME_LABELS[name],
          checked: theme === name,
          onSelect: () => setTheme(name),
        })),
      },
      { kind: 'separator', id: 'sep-help' },
      {
        kind: 'item',
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        shortcut: <ShortcutHint id="help.shortcuts" />,
        onSelect: () => setShortcutOverlayOpen(true),
      },
    ],
    [
      theme,
      railCollapsed,
      inspectorPinned,
      setTheme,
      toggleRail,
      setInspectorPinned,
      setExportDialogOpen,
      setShortcutOverlayOpen,
    ],
  );

  return (
    <Menu
      align="end"
      items={items}
      trigger={
        <IconButton
          className="app-no-drag"
          icon={<MoreHorizontal size={16} strokeWidth={1.75} />}
          label="Application menu"
          size="sm"
        />
      }
    />
  );
}
