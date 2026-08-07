/* ---------------------------------------------------------------------------
   MediaItem — one row of the media rail. 44px, dense, list not grid.

   Thumbnail 32×18, filename truncated from the MIDDLE so the head and the tail
   both stay readable, duration in tabular mono. The row is an HTML5 drag source
   for the timeline (DND_MEDIA_MIME + a custom drag image) and double-click or
   Enter inserts it at the playhead.

   The row is a plain `listitem`, not an `option`: it carries two interactive
   IconButtons, and ARIA forbids focusable descendants inside an option — the
   buttons' names would be flattened into the row's announcement and most screen
   readers would not expose them as operable at all. The roving tabindex and the
   arrow-key model are unchanged; the highlight moved to aria-current.

   States: probing carries a determinate progress bar and aria-busy; error
   carries an icon, a word and a --status-danger hairline with Retry and Remove;
   a format mismatch carries the same treatment in --status-warning. Colour is
   the third signal in every case (PLAN §7.6).

   The full filename and the status message are carried by the Tooltip primitive
   rather than the native `title` attribute, so they open on focus-visible as
   well as on hover and are styled by the token system (PLAN §5).

   CONTEXT MENU (RENAME.md §Media rail context menu). Right-click, or the Menu
   key / Shift+F10 with the row focused. It is the existing `Menu` primitive and
   it adds no resident chrome: its trigger is a zero-size button parked at the
   pointer, which is what lets one shared popover open where the user clicked
   instead of under a kebab that would sit on all forty rows forever. Menu
   restores focus to its trigger when it closes, and the trigger hands that focus
   straight to the row — which is what RENAME.md asks for.
--------------------------------------------------------------------------- */

import './media.css';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactElement, ReactNode } from 'react';
import {
  AlertCircle,
  Film,
  FolderOpen,
  Music,
  PenLine,
  RotateCcw,
  TriangleAlert,
  Unplug,
  X,
} from 'lucide-react';
import type { MediaId } from '../../types/model';
import type { MoveFailure } from '../../state/timelineSlice';
import { useEditorStore, readStore } from '../../state/store';
import { canRetryMedia, selectRenameDisabledReason, selectRenameState } from '../../state/mediaSlice';
import { framesToDuration } from '../../lib/time';
import { DND_MEDIA_MIME } from '../../lib/constants';
import { getEditorAPI } from '../../lib/editorApi';
import { IconButton, Menu, Spinner, Tooltip } from '../ui';
import type { MenuItem as MenuItemSpec } from '../ui';
import { ImportProgress } from './ImportProgress';
import { MediaNameField } from './MediaNameField';
import type { RenameExit } from './MediaNameField';

/** Why an insert was refused, in the words PLAN §3.4 pins for each reason. */
const REFUSAL: Record<MoveFailure, string> = {
  overlap: 'A clip already occupies that position',
  locked: 'Track is locked',
  'out-of-range': 'Start of timeline',
  'no-track': 'No track for this media',
  'kind-mismatch': 'That media cannot go on this track',
  'no-source': 'End of source media',
};

/** Inset of the keyboard-opened menu from the row's bottom-left corner. */
const GAP_FROM_ROW = 8;

/** Splits a filename so CSS can ellipse the head while the tail stays whole. */
function splitName(name: string): { head: string; tail: string } {
  const tailLength = name.length <= 12 ? 0 : Math.min(8, Math.floor(name.length / 3));
  if (tailLength === 0) return { head: name, tail: '' };
  return { head: name.slice(0, name.length - tailLength), tail: name.slice(name.length - tailLength) };
}

/**
 * `Reveal in folder` needs `shell.showItemInFolder`, which lives in the main
 * process. `EditorAPI.media` declares no `reveal` member in this build, so the
 * capability is DETECTED rather than assumed: the item is in the menu because
 * RENAME.md puts it there, it runs the moment the bridge grows the member, and
 * until then it says plainly why it cannot. Nothing here reaches around
 * src/types/api.ts to invent an IPC channel — the declaration this needs is
 * stated in this slice's final note (PLAN §0.2).
 */
interface RevealCapableMedia {
  reveal?(path: string): void | Promise<void>;
}

function revealCapability(): ((path: string) => void) | null {
  let media: RevealCapableMedia;
  try {
    media = getEditorAPI().media as RevealCapableMedia;
  } catch {
    return null;
  }
  const reveal = media.reveal;
  if (typeof reveal !== 'function') return null;
  return (path: string) => {
    void reveal.call(media, path);
  };
}

function buildDragImage(name: string, duration: string): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'media-drag-chip';

  const label = document.createElement('span');
  label.className = 'type-label';
  label.textContent = name;
  chip.appendChild(label);

  if (duration) {
    const time = document.createElement('span');
    time.className = 'media-drag-chip-duration type-numeric-sm';
    time.textContent = duration;
    chip.appendChild(time);
  }
  return chip;
}

export interface MediaItemProps {
  id: MediaId;
  /** The roving-tabindex anchor. Bookkeeping only — it paints nothing. */
  current: boolean;
  /** The row the user actually chose. A row highlight, NOT the timeline selection. */
  active: boolean;
  /** Focus moved here; move the roving anchor but do not choose the row. */
  onFocusRow(id: MediaId): void;
  /** A pointerdown, an Enter or a drag start — a real choice. */
  onActivate(id: MediaId): void;
  /** The rail removes the row and moves focus to its neighbour. */
  onRemove(id: MediaId): void;
}

export const MediaItem = memo(function MediaItem({
  id,
  current,
  active,
  onFocusRow,
  onActivate,
  onRemove,
}: MediaItemProps): ReactElement | null {
  const item = useEditorStore((s) => s.items[id]);
  const fps = useEditorStore((s) => s.fps);
  const renameBlocked = useEditorStore(
    useCallback((s) => selectRenameDisabledReason(s, id), [id]),
  );
  const renaming = useEditorStore(useCallback((s) => selectRenameState(s, id).busy, [id]));
  const dragImage = useRef<HTMLElement | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);

  /** The inline rename editor. Transient, and never more than one row at a time. */
  const [editing, setEditing] = useState(false);
  /** Viewport point the context menu should open at. */
  const [menuPoint, setMenuPoint] = useState<{ top: number; left: number } | null>(null);
  const openWanted = useRef(false);

  // The Menu primitive reads its trigger's rect on click, so the trigger has to
  // be at the pointer BEFORE the click. Position lands in a committed layout,
  // then the click opens the popover exactly there.
  useLayoutEffect(() => {
    if (!openWanted.current || menuPoint === null) return;
    openWanted.current = false;
    rowRef.current
      ?.querySelector<HTMLButtonElement>('.media-row-menu-anchor')
      ?.click();
  }, [menuPoint]);

  const openMenuAt = useCallback((top: number, left: number) => {
    openWanted.current = true;
    setMenuPoint({ top, left });
  }, []);

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLLIElement>) => {
      event.preventDefault();
      // A context-menu press is not a choice (see handlePointerDown), but it does
      // move the roving anchor: the menu acts on the row it opened on, so that
      // row must be the one the keyboard comes back to.
      rowRef.current?.focus();
      openMenuAt(event.clientY, event.clientX);
    },
    [openMenuAt],
  );

  const handleRenameExit = useCallback((reason: RenameExit) => {
    setEditing(false);
    // A commit or a cancel is a decision made at the keyboard, so the keyboard
    // gets the row back. A blur means focus is already somewhere the user put it.
    if (reason !== 'blur') rowRef.current?.focus();
  }, []);

  // A drag can outlive the row: the item is removed, hydrateMedia lands, or the
  // shell collapses the rail mid-drag. dragend never fires on a detached source,
  // so the chip is torn down with the component instead of leaking into <body>.
  useEffect(
    () => () => {
      dragImage.current?.remove();
      dragImage.current = null;
    },
    [],
  );

  // Retry unmounts the button that was just pressed — the row takes the focus
  // rather than dropping it on the body.
  const handleRetry = useCallback(() => {
    readStore().retryItem(id);
    rowRef.current?.focus();
  }, [id]);

  const insertAtPlayhead = useCallback(() => {
    const s = readStore();
    const media = s.items[id];
    if (!media || media.status !== 'ready') return;
    const result = s.insertMediaAt(id, s.playhead);
    if (!result.ok) {
      s.setNotice({
        tone: 'danger',
        title: 'Could not insert',
        message: REFUSAL[result.reason],
      });
    }
  }, [id]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLLIElement>) => {
      if (event.target !== event.currentTarget) return; // a row action owns its own keys

      // Both platform conventions for "open the context menu on the focused
      // thing", so the menu is reachable on a keyboard that has no Menu key.
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openMenuAt(rect.bottom - GAP_FROM_ROW, rect.left + GAP_FROM_ROW);
        return;
      }

      if (event.key !== 'Enter') return;
      event.preventDefault();
      onActivate(id);
      insertAtPlayhead();
    },
    [id, insertAtPlayhead, onActivate, openMenuAt],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLLIElement>) => {
      if (event.button > 0) return; // a context-menu press is not a choice
      onActivate(id);
    },
    [id, onActivate],
  );

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLLIElement>) => {
      const media = readStore().items[id];
      if (!media || media.status !== 'ready') {
        event.preventDefault();
        return;
      }
      onActivate(id);
      event.dataTransfer.setData(DND_MEDIA_MIME, id);
      event.dataTransfer.effectAllowed = 'copy';
      const chip = buildDragImage(media.name, framesToDuration(media.durationFrames, readStore().fps));
      document.body.appendChild(chip);
      event.dataTransfer.setDragImage(chip, 12, 12);
      dragImage.current = chip;
    },
    [id, onActivate],
  );

  const handleDragEnd = useCallback(() => {
    dragImage.current?.remove();
    dragImage.current = null;
  }, []);

  if (!item) return null;

  const probing = item.status === 'probing';
  const ready = item.status === 'ready';
  const failed = item.status === 'error';
  const warning = ready && item.warnings.length > 0;
  const tone = failed ? 'danger' : warning ? 'warning' : undefined;

  const offline = failed && item.error?.code === 'not-found';
  const StatusIcon = failed ? (offline ? Unplug : AlertCircle) : TriangleAlert;
  const statusWord = failed ? (offline ? 'Offline' : 'Error') : 'Mismatch';
  const statusMessage = failed ? (item.error?.message ?? '') : (item.warnings[0]?.message ?? '');

  const { head, tail } = splitName(item.name);
  const duration = framesToDuration(item.durationFrames, fps);
  const KindIcon = item.kind === 'audio' ? Music : Film;

  const reveal = revealCapability();
  const menuItems: MenuItemSpec[] = [
    {
      kind: 'item',
      id: 'rename',
      label: 'Rename file…',
      icon: <PenLine size={14} strokeWidth={1.75} />,
      disabled: renameBlocked !== null,
      disabledReason: renameBlocked ?? undefined,
      onSelect: () => setEditing(true),
    },
    {
      kind: 'item',
      id: 'reveal',
      label: 'Reveal in folder',
      icon: <FolderOpen size={14} strokeWidth={1.75} />,
      disabled: reveal === null,
      disabledReason:
        reveal === null ? 'Opening the folder is not available in this build' : undefined,
      onSelect: () => reveal?.(item.path),
    },
    { kind: 'separator', id: 'sep' },
    {
      kind: 'item',
      id: 'remove',
      label: 'Remove from project',
      icon: <X size={14} strokeWidth={1.75} />,
      onSelect: () => onRemove(id),
    },
  ];

  // The name is truncated from the middle and the status message is ellipsed at
  // 44px, so both need a full reading somewhere that the keyboard can reach.
  const tip: ReactNode =
    tone && statusMessage ? (
      <span className="media-row-tip">
        <span>{item.name}</span>
        <span className="media-row-tip-status">
          {statusWord}: {statusMessage}
        </span>
      </span>
    ) : (
      item.name
    );

  return (
    <Tooltip content={tip} placement="right">
      <li
        ref={rowRef}
        className="media-row"
        role="listitem"
        aria-current={active || undefined}
        aria-busy={probing || renaming || undefined}
        tabIndex={current ? 0 : -1}
        data-media-id={id}
        data-active={active || undefined}
        data-status={item.status}
        data-tone={tone}
        data-editing={editing || undefined}
        // A draggable ancestor eats the caret and the text selection inside the
        // field, so the row stops being a drag source while it is being renamed.
        draggable={ready && !editing}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDoubleClick={ready && !editing ? insertAtPlayhead : undefined}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onContextMenu={handleContextMenu}
        onFocus={() => onFocusRow(id)}
      >
        {/* Zero-size, parked at the pointer, out of the tab order: the anchor the
            Menu opens from and hands focus back to. Not resident chrome — it
            paints nothing and occupies no space in the row's grid. */}
        <Menu
          items={menuItems}
          trigger={
            <button
              type="button"
              className="media-row-menu-anchor"
              tabIndex={-1}
              aria-hidden="true"
              style={{ top: menuPoint?.top ?? 0, left: menuPoint?.left ?? 0 }}
              onFocus={() => rowRef.current?.focus()}
            />
          }
        />

        <span className="media-row-thumb">
          {item.thumbnailUrl ? (
            <img src={item.thumbnailUrl} alt="" draggable={false} />
          ) : (
            <span className="ve-icon-slot" aria-hidden="true">
              <KindIcon size={14} strokeWidth={1.75} />
            </span>
          )}
        </span>

        <span className="media-row-text">
          {editing ? (
            <MediaNameField
              id={id}
              label={`File name for ${item.name}`}
              autoFocus
              onExit={handleRenameExit}
            />
          ) : (
            <span className="media-row-name type-body">
              <span className="media-row-name-head">{head}</span>
              {tail ? <span className="media-row-name-tail">{tail}</span> : null}
            </span>
          )}

          {editing ? null : probing ? (
            <ImportProgress progress={item.progress} label={`Importing ${item.name}`} />
          ) : tone ? (
            <span className="media-row-status">
              <span className="media-row-status-icon ve-icon-slot" aria-hidden="true">
                <StatusIcon size={14} strokeWidth={1.75} />
              </span>
              <span className="media-row-status-word type-label">{statusWord}</span>
              <span className="media-row-status-message type-label">{statusMessage}</span>
            </span>
          ) : null}
        </span>

        <span className="media-row-trailing">
          {/* A rename started from the inspector busies this row too — the file
              is the same file, and the row is where the user would look. */}
          {renaming && !editing ? <Spinner /> : null}
          {ready ? (
            <span className="media-row-duration media-row-muted type-numeric-sm">{duration}</span>
          ) : null}
          <span className="media-row-actions">
            {failed && canRetryMedia(item) ? (
              <IconButton
                icon={<RotateCcw size={14} strokeWidth={1.75} />}
                label={`Retry ${item.name}`}
                size="sm"
                tabIndex={current ? 0 : -1}
                onClick={handleRetry}
              />
            ) : null}
            <IconButton
              icon={<X size={14} strokeWidth={1.75} />}
              label={`Remove ${item.name}`}
              size="sm"
              tabIndex={current ? 0 : -1}
              onClick={() => onRemove(id)}
            />
          </span>
        </span>
      </li>
    </Tooltip>
  );
});
