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
--------------------------------------------------------------------------- */

import './media.css';
import { memo, useCallback, useEffect, useRef } from 'react';
import type { DragEvent, KeyboardEvent, PointerEvent, ReactElement, ReactNode } from 'react';
import { AlertCircle, Film, Music, RotateCcw, TriangleAlert, Unplug, X } from 'lucide-react';
import type { MediaId } from '../../types/model';
import type { MoveFailure } from '../../state/timelineSlice';
import { useEditorStore, readStore } from '../../state/store';
import { canRetryMedia } from '../../state/mediaSlice';
import { framesToDuration } from '../../lib/time';
import { DND_MEDIA_MIME } from '../../lib/constants';
import { IconButton, Tooltip } from '../ui';
import { ImportProgress } from './ImportProgress';

/** Why an insert was refused, in the words PLAN §3.4 pins for each reason. */
const REFUSAL: Record<MoveFailure, string> = {
  overlap: 'A clip already occupies that position',
  locked: 'Track is locked',
  'out-of-range': 'Start of timeline',
  'no-track': 'No track for this media',
  'kind-mismatch': 'That media cannot go on this track',
  'no-source': 'End of source media',
};

/** Splits a filename so CSS can ellipse the head while the tail stays whole. */
function splitName(name: string): { head: string; tail: string } {
  const tailLength = name.length <= 12 ? 0 : Math.min(8, Math.floor(name.length / 3));
  if (tailLength === 0) return { head: name, tail: '' };
  return { head: name.slice(0, name.length - tailLength), tail: name.slice(name.length - tailLength) };
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
  const dragImage = useRef<HTMLElement | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);

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
      if (event.key !== 'Enter') return;
      event.preventDefault();
      onActivate(id);
      insertAtPlayhead();
    },
    [id, insertAtPlayhead, onActivate],
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
        aria-busy={probing || undefined}
        tabIndex={current ? 0 : -1}
        data-media-id={id}
        data-active={active || undefined}
        data-status={item.status}
        data-tone={tone}
        draggable={ready}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDoubleClick={ready ? insertAtPlayhead : undefined}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onFocus={() => onFocusRow(id)}
      >
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
          <span className="media-row-name type-body">
            <span className="media-row-name-head">{head}</span>
            {tail ? <span className="media-row-name-tail">{tail}</span> : null}
          </span>

          {probing ? (
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
