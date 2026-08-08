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
import type { AppBuild } from '../../types/api';
import { getEditorAPI } from '../../lib/editorApi';
import { readStore, useEditorStore } from '../../state/store';
import { THEME_LABELS, THEME_NAMES } from '../../state/uiSlice';
import { ShortcutHint } from '../../keyboard/ShortcutHint';
import { openProject, saveProject } from '../../keyboard/projectActions';

/**
 * A menu item that starts async work closes the menu and reports through the
 * notice channel (PLAN §5). saveProject / openProject already report their own
 * failures; this only catches the case where the bridge itself is unreachable,
 * so a rejection is never swallowed silently.
 *
 * `message` is defaulted rather than hardcoded because `Copy version` fails for
 * a different reason than a file operation does — a clipboard write can be
 * refused when the window is not focused — and telling that user the editor
 * could not reach the file system would be false. A default rather than a local
 * .catch() so there is still exactly one place in this component that turns a
 * rejected promise into a notice (docs/RELEASE.md §2.3).
 */
function run(
  work: Promise<unknown>,
  title: string,
  message = 'The editor could not reach the file system',
): void {
  void work.catch(() => {
    readStore().setNotice({ tone: 'danger', title, message });
  });
}

/**
 * What `Copy version` puts on the clipboard: the block a bug report actually
 * needs, built in the renderer from api.build and nothing else. Three lines,
 * \n-joined, no trailing newline. A bug reported from a dev run and one
 * reported from an installer are different bugs, so the first line says which.
 */
function diagnosticBlock(build: AppBuild, platform: string): string {
  return [
    `Video Editor ${build.version}${build.packaged ? '' : ' (development build)'}`,
    `${platform} ${build.os} ${build.arch}`,
    `Electron ${build.electron} · Chromium ${build.chromium}`,
  ].join('\n');
}

export function AppMenu(): ReactElement {
  // Both are constant for the life of the process, so neither is store state:
  // `build` arrives in this renderer's argv at window creation (RELEASE.md
  // §2.2) and `update` is present only in a build whose feed was configured at
  // package time (§1.3).
  const { build, platform, update } = getEditorAPI();
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
        label: 'Export',
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
          // Exactly one theme holds at a time. Announced as checkboxes, a screen
          // reader would offer three independent toggles.
          selection: 'radio' as const,
          onSelect: () => setTheme(name),
        })),
      },
      { kind: 'separator', id: 'sep-help' },
      // Rendered ONLY when a feed is configured. An item that always answers
      // "you're up to date" on a build that can never update is a lie, and it
      // is the kind that makes a user stop believing the rest of the interface.
      // The result lands in the update strip, not here.
      ...(update
        ? [
            {
              kind: 'item' as const,
              id: 'check-updates',
              label: 'Check for updates',
              onSelect: () => update.check(),
            },
          ]
        : []),
      {
        kind: 'item',
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        shortcut: <ShortcutHint id="help.shortcuts" />,
        onSelect: () => setShortcutOverlayOpen(true),
      },
      { kind: 'separator', id: 'sep-version' },
      // The numerals ride the `shortcut` slot: it is already ReactNode, already
      // right-aligned, already muted, already read as "the secondary fact about
      // this row", and Menu.tsx does not aria-hide it — so this item's
      // accessible name is "Copy version 0.1.0", which is correct, because the
      // number IS the information. A kind:'label' row would be neither
      // focusable nor copyable (docs/RELEASE.md §2.3).
      {
        kind: 'item',
        id: 'version',
        label: 'Copy version',
        shortcut: <span className="type-numeric">{build.version}</span>,
        onSelect: () =>
          run(
            navigator.clipboard.writeText(diagnosticBlock(build, platform)),
            'Copy failed',
            'The version could not be copied to the clipboard',
          ),
      },
    ],
    [
      build,
      platform,
      update,
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
