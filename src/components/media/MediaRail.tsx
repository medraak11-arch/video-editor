/* ---------------------------------------------------------------------------
   MediaRail — the media library. OWNER: media.

   Renders exactly one Panel, at its own root (PLAN §5 / §7.0); the shell gives
   it a bare container and its width. Inside: the heading, one secondary Import
   button — the accent belongs to the export action, not to this one (PLAN §7.4
   use 6) — and a dense LIST of rows.

   Two independent concepts, deliberately NOT collapsed into one:
     · `current` is the roving-tabindex anchor. Exactly one row is tabbable at
       any time, and it defaults to the first row so the list is reachable. It
       is bookkeeping, not state the user chose, so it paints nothing.
     · `active` is the row the user actually picked (pointerdown, Enter, drag
       start). It starts null, so a freshly populated rail highlights nothing
       and announces nothing as current.

   Arrows move, Home / End jump, Enter inserts the current row at the playhead,
   and each row is an HTML5 drag source for the timeline. The row highlight is
   not the timeline selection and never takes the accent.

   The whole-window file drop is NOT mounted here: MediaRail is unmounted when
   the rail is collapsed, and the listeners must outlive that. See
   FileDropTarget.tsx.

   Empty, it shows the one empty state in the application (PLAN §8.14).
--------------------------------------------------------------------------- */

import './media.css';
import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import { FolderInput } from 'lucide-react';
import type { MediaId } from '../../types/model';
import { useEditorStore, readStore } from '../../state/store';
import { selectIsImporting, selectMediaOrder } from '../../state/mediaSlice';
import { MEDIA_ROW_HEIGHT, MEDIA_THUMB } from '../../lib/constants';
import { Button, Panel, Tooltip } from '../ui';
import { ShortcutHint } from '../../keyboard/ShortcutHint';
import { MediaItem } from './MediaItem';
import { MediaEmptyState } from './MediaEmptyState';

export function MediaRail(): ReactElement {
  const order = useEditorStore(selectMediaOrder);
  const dropActive = useEditorStore((s) => s.dropActive);
  const importing = useEditorStore(selectIsImporting);
  const [preferredId, setPreferredId] = useState<MediaId | null>(null);
  const [activeId, setActiveId] = useState<MediaId | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // The tabbable row survives a removal by falling back to the first row. This
  // is the roving anchor only — it is never rendered as a highlight.
  const current = preferredId !== null && order.includes(preferredId) ? preferredId : order[0] ?? null;
  // The chosen row, on the other hand, is only ever a row the user touched.
  const active = activeId !== null && order.includes(activeId) ? activeId : null;

  const focusRow = useCallback((id: MediaId) => {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
    listRef.current?.querySelector<HTMLElement>(`[data-media-id="${escaped}"]`)?.focus();
  }, []);

  /** Focus moved the roving anchor; it did not choose the row. */
  const handleFocusRow = useCallback((id: MediaId) => setPreferredId(id), []);

  /** A pointerdown, an Enter or a drag start is a choice: it moves both. */
  const handleActivate = useCallback((id: MediaId) => {
    setPreferredId(id);
    setActiveId(id);
  }, []);

  /** Removal moves the focus to the neighbour rather than dropping it on the body. */
  const handleRemove = useCallback(
    (id: MediaId) => {
      const s = readStore();
      const index = s.order.indexOf(id);
      const neighbour = s.order[index + 1] ?? s.order[index - 1] ?? null;
      s.removeItem(id);
      setPreferredId(neighbour);
      setActiveId((prev) => (prev === id ? null : prev));
      if (neighbour !== null) focusRow(neighbour);
    },
    [focusRow],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      const target = event.target as HTMLElement;
      if (!target.classList.contains('media-row')) return; // a row action owns its own keys

      const index = current === null ? -1 : order.indexOf(current);
      let nextIndex: number;
      switch (event.key) {
        case 'ArrowDown':
          nextIndex = Math.min(order.length - 1, index + 1);
          break;
        case 'ArrowUp':
          nextIndex = Math.max(0, index - 1);
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = order.length - 1;
          break;
        default:
          return;
      }

      const nextId = order[nextIndex];
      if (nextId === undefined) return;
      event.preventDefault();
      setPreferredId(nextId);
      focusRow(nextId);
    },
    [current, focusRow, order],
  );

  return (
    <Panel
      className="media-rail"
      heading="Media"
      padded={false}
      scroll
      actions={
        <Tooltip content="Import media" shortcut={<ShortcutHint id="file.import" />}>
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<FolderInput size={14} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => void readStore().importFromPicker()}
          >
            Import
          </Button>
        </Tooltip>
      }
    >
      {order.length === 0 ? (
        <MediaEmptyState dropActive={dropActive} />
      ) : (
        <ul
          ref={listRef}
          className="media-list"
          role="list"
          aria-label="Imported media"
          aria-busy={importing || undefined}
          onKeyDown={handleKeyDown}
          style={{
            '--media-row-h': `${MEDIA_ROW_HEIGHT}px`,
            '--media-thumb-w': `${MEDIA_THUMB.width}px`,
            '--media-thumb-h': `${MEDIA_THUMB.height}px`,
          } as CSSProperties}
        >
          {order.map((id) => (
            <MediaItem
              key={id}
              id={id}
              current={id === current}
              active={id === active}
              onFocusRow={handleFocusRow}
              onActivate={handleActivate}
              onRemove={handleRemove}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
