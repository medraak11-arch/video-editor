/* ---------------------------------------------------------------------------
   PanelGroup — the 2D application frame. Shell-owned.

   One CSS grid: [media rail | rail resizer | stage] over a full-width
   [timeline resizer / timeline]. The stage is where the preview lives and where
   the inspector overlays it.

   THE STRUCTURAL DECISION (PRODUCT.md principle 2, PLAN §8.11): the inspector
   is NOT resident. It mounts only when selectInspectorVisible is true and
   animates in over var(--dur-panel) with transform and opacity alone. It is
   never a grid column — it is absolutely positioned over the stage at every
   width, and the stage reserves --inspector-width permanently, mounted or not,
   so the preview's letterbox box is invariant across selection changes.
   Clicking through six clips must not resize the video frame six times
   (PRODUCT.md principle 1).

   Geometry is written as CSS custom properties on the grid element so a resize
   drag can move the layout imperatively and commit to the store exactly once,
   on pointerup (PLAN §1.3 rule 4). --timeline-h is derived from the measured
   grid height by a ResizeObserver rather than a percentage track, because a
   percentage row against an indefinite flex height resolves to auto.

   The shell renders BARE CONTAINERS. It never wraps a slice component in a
   Panel: MediaRail and Inspector each render exactly one at their own root, and
   Timeline and PreviewWell render none (PLAN §5, §7.0).
--------------------------------------------------------------------------- */

import './shell.css';
import { useCallback, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import {
  RAIL_MAX,
  RAIL_MIN,
  TIMELINE_MAX_PCT,
  TIMELINE_MIN_PCT,
} from '../../lib/constants';
import { useEditorStore } from '../../state/store';
import { selectInspectorVisible } from '../../state/uiSlice';
import { Resizer } from './Resizer';
import { MediaRail } from '../media/MediaRail';
import { PreviewWell } from '../preview/PreviewWell';
import { Timeline } from '../timeline/Timeline';
import { Inspector } from '../inspector/Inspector';

const pxText = (v: number): string => `${Math.round(v)} pixels`;
const pctText = (v: number): string => `${Math.round(v * 100)} percent of the editor height`;

export function PanelGroup(): ReactElement {
  const railWidth = useEditorStore((s) => s.railWidth);
  const railCollapsed = useEditorStore((s) => s.railCollapsed);
  const timelineHeightPct = useEditorStore((s) => s.timelineHeightPct);
  const setRailWidth = useEditorStore((s) => s.setRailWidth);
  const setTimelineHeightPct = useEditorStore((s) => s.setTimelineHeightPct);
  const inspectorVisible = useEditorStore(selectInspectorVisible);

  const gridRef = useRef<HTMLDivElement | null>(null);
  /** Last measured height of the grid — the denominator for timelineHeightPct. */
  const gridHeight = useRef(0);
  /**
   * The committed percentage, for the ResizeObserver to re-apply after a window
   * resize. Written from a layout effect, never during render: a render pass that
   * React discards must not be able to leave this holding a value the store never
   * took.
   */
  const pctRef = useRef(timelineHeightPct);

  const applyTimelineHeight = useCallback((pct: number) => {
    const element = gridRef.current;
    if (!element || gridHeight.current <= 0) return;
    element.style.setProperty('--timeline-h', `${Math.round(gridHeight.current * pct)}px`);
  }, []);

  const applyRailWidth = useCallback((px: number) => {
    gridRef.current?.style.setProperty('--rail-w', `${Math.round(px)}px`);
  }, []);

  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element) return;

    const measure = (height: number) => {
      if (height <= 0 || height === gridHeight.current) return;
      gridHeight.current = height;
      applyTimelineHeight(pctRef.current);
    };

    measure(element.getBoundingClientRect().height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [applyTimelineHeight]);

  useLayoutEffect(() => {
    pctRef.current = timelineHeightPct;
    applyTimelineHeight(timelineHeightPct);
  }, [timelineHeightPct, applyTimelineHeight]);

  /**
   * Collapsing the rail unmounts it, and with it whatever had focus inside. Focus
   * then falls to <body>, where `activeScope()` reads null and every timeline- and
   * media-scoped shortcut goes dead until the user clicks something. Hand it to the
   * control that did the collapsing — but only when it really was dropped, so a
   * click on the toggle (which focuses the toggle itself) is left alone.
   */
  useLayoutEffect(() => {
    if (!railCollapsed) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    document.querySelector<HTMLElement>('[data-rail-toggle]')?.focus();
  }, [railCollapsed]);

  const gridStyle = {
    '--rail-w': railCollapsed ? '0px' : `${railWidth}px`,
    '--rail-gutter': railCollapsed ? '0px' : 'var(--resizer-hit)',
  } as CSSProperties;

  return (
    <div className="shell-body" ref={gridRef} style={gridStyle}>
      {railCollapsed ? null : (
        <>
          <div className="shell-rail" data-shortcut-scope="media" tabIndex={-1}>
            <MediaRail />
          </div>
          <Resizer
            className="shell-rail-resizer"
            orientation="vertical"
            label="Media rail width"
            value={railWidth}
            min={RAIL_MIN}
            max={RAIL_MAX}
            unitsPerPx={() => 1}
            onPreview={applyRailWidth}
            onCommit={setRailWidth}
            toAriaValue={Math.round}
            toAriaText={pxText}
          />
        </>
      )}

      <div className="shell-stage" data-shortcut-scope="preview" tabIndex={-1}>
        <PreviewWell />
        {inspectorVisible ? (
          <aside className="shell-inspector" aria-label="Inspector">
            <Inspector />
          </aside>
        ) : null}
      </div>

      <Resizer
        className="shell-timeline-resizer"
        orientation="horizontal"
        label="Timeline height"
        value={timelineHeightPct}
        min={TIMELINE_MIN_PCT}
        max={TIMELINE_MAX_PCT}
        // Dragging the divider down shrinks the timeline, hence the negative sign.
        unitsPerPx={() => (gridHeight.current > 0 ? -1 / gridHeight.current : 0)}
        onPreview={applyTimelineHeight}
        onCommit={setTimelineHeightPct}
        toAriaValue={(v) => Math.round(v * 100)}
        toAriaText={pctText}
      />

      <div className="shell-timeline" data-shortcut-scope="timeline" tabIndex={-1}>
        <Timeline />
      </div>
    </div>
  );
}
