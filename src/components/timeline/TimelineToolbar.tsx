/* ---------------------------------------------------------------------------
   TimelineToolbar — PLAN §8.16.

   Five actions had shortcuts and no control, which makes them keyboard-only and
   undercuts PRODUCT.md principle 3: the UI teaches its shortcuts on the controls
   themselves. Every button here carries `shortcut={<ShortcutHint id="…" />}`,
   read from the one registry, so a label can never drift from its binding.

   The snap toggle is `pressed` WITHOUT `accentWhenPressed` — a lightness change
   plus a distinct glyph, which is enough for a binary state and spends none of
   the accent budget (PLAN §7.4).

   Chrome plane, no Panel, no layout constant of its own.
--------------------------------------------------------------------------- */

import './timeline.css';
import { useCallback } from 'react';
import type { ReactElement, RefObject } from 'react';
import { Bookmark, Magnet, Maximize2, Scissors, Type, ZoomIn, ZoomOut } from 'lucide-react';
import { IconButton } from '../ui';
import { addTitleAtPlayhead } from './titleCommand';
import { ShortcutHint } from '../../keyboard/ShortcutHint';
import { readStore, useEditorStore } from '../../state/store';
import { selectSelectionCount } from '../../state/timelineSlice';
import { TRACK_HEAD_WIDTH, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../../lib/constants';

export interface TimelineToolbarProps {
  laneViewportRef: RefObject<HTMLDivElement>;
}

const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

export function TimelineToolbar({ laneViewportRef }: TimelineToolbarProps): ReactElement {
  const zoom = useEditorStore((s) => s.zoom);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);
  const selectionCount = useEditorStore(selectSelectionCount);

  // `splitAtPlayhead` raises its own refusal notice, so the button and the `S`
  // shortcut cannot explain themselves differently (PLAN §5, §3.4).
  const onSplit = useCallback(() => {
    readStore().splitAtPlayhead();
  }, []);

  const onMarker = useCallback(() => {
    readStore().addMarker();
  }, []);

  // `addTitleAtPlayhead` raises its own refusal notice, so the button and the
  // `T` shortcut cannot explain themselves differently (PLAN §5, §3.4). The
  // button stays ENABLED with no video track to put a title on — a disabled
  // control in a dark UI is nearly invisible and offers no reason (DESIGN.md §5).
  const onAddTitle = useCallback(() => {
    addTitleAtPlayhead();
  }, []);

  const onSnap = useCallback(() => {
    const s = readStore();
    s.setSnapEnabled(!s.snapEnabled);
  }, []);

  const onZoomIn = useCallback(() => {
    const s = readStore();
    s.setZoom(clampZoom(s.zoom * ZOOM_STEP));
  }, []);

  const onZoomOut = useCallback(() => {
    const s = readStore();
    s.setZoom(clampZoom(s.zoom / ZOOM_STEP));
  }, []);

  const onZoomFit = useCallback(() => {
    const width = laneViewportRef.current?.clientWidth;
    readStore().zoomToFit(width && width > 0 ? width : window.innerWidth - TRACK_HEAD_WIDTH);
  }, [laneViewportRef]);

  return (
    <div className="tl-toolbar" role="toolbar" aria-label="Timeline">
      <IconButton
        size="sm"
        icon={<Scissors size={14} strokeWidth={1.75} />}
        label="Split at playhead"
        shortcut={<ShortcutHint id="edit.split" />}
        onClick={onSplit}
      />
      <IconButton
        size="sm"
        icon={<Bookmark size={14} strokeWidth={1.75} />}
        label="Add marker at playhead"
        shortcut={<ShortcutHint id="edit.marker" />}
        onClick={onMarker}
      />
      <IconButton
        size="sm"
        icon={<Type size={14} strokeWidth={1.75} />}
        label="Add title at playhead"
        shortcut={<ShortcutHint id="edit.addTitle" />}
        onClick={onAddTitle}
      />

      <span className="tl-toolbar-sep" aria-hidden="true" />

      <IconButton
        size="sm"
        icon={<Magnet size={14} strokeWidth={1.75} />}
        label={snapEnabled ? 'Turn snapping off' : 'Turn snapping on'}
        pressed={snapEnabled}
        onClick={onSnap}
      />

      <span className="tl-toolbar-sep" aria-hidden="true" />

      <IconButton
        size="sm"
        icon={<ZoomOut size={14} strokeWidth={1.75} />}
        label="Zoom out"
        shortcut={<ShortcutHint id="view.zoomOut" />}
        onClick={onZoomOut}
      />
      <IconButton
        size="sm"
        icon={<ZoomIn size={14} strokeWidth={1.75} />}
        label="Zoom in"
        shortcut={<ShortcutHint id="view.zoomIn" />}
        onClick={onZoomIn}
      />
      <IconButton
        size="sm"
        icon={<Maximize2 size={14} strokeWidth={1.75} />}
        label="Zoom to fit"
        shortcut={<ShortcutHint id="view.zoomFit" />}
        onClick={onZoomFit}
      />

      <span className="tl-toolbar-spacer" />

      {selectionCount > 0 ? (
        <span className="tl-toolbar-count type-numeric-sm">
          {selectionCount}
          <span className="type-label"> selected</span>
        </span>
      ) : null}

      <span className="tl-toolbar-readout type-numeric-sm">
        <span className="sr-only">Zoom </span>
        {zoom < 10 ? zoom.toFixed(2) : zoom.toFixed(1)}
        <span className="type-label"> px/frame</span>
      </span>
    </div>
  );
}
