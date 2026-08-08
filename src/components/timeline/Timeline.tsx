/* ---------------------------------------------------------------------------
   Timeline — the region root. Takes no props and reads the store itself
   (PLAN §8.1). Renders no Panel: the timeline is chrome, not a panel (§7.0).

   LAYOUT. One grid: a fixed 88px track-head column beside a horizontally
   scrollable lane area, with the ruler across the top of the lane column. The
   head column and the lane content share the same scrollY write, so they can
   never drift vertically.

   SCROLL. `scrollX` / `scrollY` live in the store and are applied EXACTLY ONCE,
   as a transform on the lane content, the head content and the ruler content,
   written imperatively from one subscription (PLAN §8.6). Nothing else
   subscribes to scroll, so a horizontal scroll re-renders nothing — which is
   what makes "a pointermove causes zero React renders" achievable at 40 clips
   across 6 tracks.

   The overlay elements (snap guide, marquee, refusal bar, drag badge, trim
   read-out, drop line) are mounted once and driven by the interaction layer
   through their refs. They are hidden, not unmounted, so a gesture never
   allocates DOM at pointer rate.
--------------------------------------------------------------------------- */

import './timeline.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, ReactElement } from 'react';
import { AlertCircle, Lock, Unplug } from 'lucide-react';
import type { ClipId } from '../../types/model';
import { readStore, useEditorStore } from '../../state/store';
import {
  selectClipCount,
  selectLaneHeight,
  selectTimelineDurationFrames,
} from '../../state/timelineSlice';
import { framesToPx } from '../../lib/time';
import { PLAYHEAD_TAIL_FRAMES } from '../../lib/constants';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineRuler } from './TimelineRuler';
import { TrackHead } from './TrackHead';
import { Track } from './Track';
import { Playhead, PlayheadHandle, usePlayheadSync } from './Playhead';
import { ClipContextMenu } from './ClipContextMenu';
import type { ClipContextMenuHandle } from './ClipContextMenu';
import { useTimelineInteraction } from './useTimelineInteraction';

export function Timeline(): ReactElement {
  const trackOrder = useEditorStore((s) => s.trackOrder);
  const tracks = useEditorStore((s) => s.tracks);
  const zoom = useEditorStore((s) => s.zoom);
  const durationFrames = useEditorStore(selectTimelineDurationFrames);
  const laneHeight = useEditorStore(selectLaneHeight);
  const clipCount = useEditorStore(selectClipCount);
  const mediaCount = useEditorStore((s) => s.order.length);
  /** First clip in the topmost busy track — the fallback roving tab stop. */
  const firstClipId = useEditorStore((s) => {
    for (const trackId of s.trackOrder) {
      const ids = s.clipsByTrack[trackId];
      if (ids && ids.length > 0) return ids[0];
    }
    return null;
  });

  const laneViewport = useRef<HTMLDivElement>(null);
  const laneContent = useRef<HTMLDivElement>(null);
  const headsContent = useRef<HTMLDivElement>(null);
  const rulerContent = useRef<HTMLDivElement>(null);
  const playheadLine = useRef<HTMLDivElement>(null);
  const playheadHead = useRef<HTMLDivElement>(null);

  const overflowRail = useRef<HTMLDivElement>(null);
  const overflowThumb = useRef<HTMLDivElement>(null);

  const snapGuide = useRef<HTMLDivElement>(null);
  const marquee = useRef<HTMLDivElement>(null);
  const refuseBar = useRef<HTMLDivElement>(null);
  const refuseLane = useRef<HTMLDivElement>(null);
  const dragBadge = useRef<HTMLDivElement>(null);
  const dragBadgeText = useRef<HTMLSpanElement>(null);
  const trimBadge = useRef<HTMLDivElement>(null);
  const dropLine = useRef<HTMLDivElement>(null);

  const clipMenu = useRef<ClipContextMenuHandle>(null);

  const [viewportWidth, setViewportWidth] = useState(0);

  // Refs are stable, so this bag is built once. A fresh object every render
  // would rebuild every gesture callback and re-attach the window listeners on
  // each of them, for nothing.
  const overlayRefs = useMemo(
    () => ({
      laneViewport,
      laneContent,
      snapGuide,
      marquee,
      refuseBar,
      refuseLane,
      dragBadge,
      dragBadgeText,
      trimBadge,
      dropLine,
    }),
    [],
  );

  const interaction = useTimelineInteraction(overlayRefs, clipMenu);

  usePlayheadSync(playheadLine, playheadHead);

  /**
   * The vertical overflow cue. Written imperatively from the same places the
   * scroll transform is written, so a scroll still re-renders nothing. It is an
   * indicator only — the lanes are scrolled by wheel and by the store, never by
   * dragging this.
   */
  const syncOverflow = useCallback((): void => {
    const rail = overflowRail.current;
    const thumb = overflowThumb.current;
    const viewport = laneViewport.current;
    if (!rail || !thumb || !viewport) return;

    const view = viewport.clientHeight;
    const content = laneContent.current?.offsetHeight ?? 0;
    if (view <= 0 || content <= view) {
      rail.hidden = true;
      return;
    }
    rail.hidden = false;
    const height = Math.max(24, Math.round((view * view) / content));
    const travel = view - height;
    const progress = Math.min(1, Math.max(0, readStore().scrollY / (content - view)));
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translate3d(0, ${Math.round(progress * travel)}px, 0)`;
  }, []);

  /* The lane viewport width feeds the ruler's tick band and zoom-to-fit. */
  useLayoutEffect(() => {
    const element = laneViewport.current;
    if (!element) return;
    setViewportWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportWidth(Math.round(entry.contentRect.width));
      syncOverflow();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [syncOverflow]);

  /* Adding, removing or resizing a track changes the extent without a scroll. */
  useLayoutEffect(syncOverflow, [syncOverflow, laneHeight]);

  /* The single scroll write. Three elements, one callback, no re-render. */
  useEffect(() => {
    const write = (): void => {
      const s = readStore();
      if (laneContent.current) {
        laneContent.current.style.transform = `translate3d(${-s.scrollX}px, ${-s.scrollY}px, 0)`;
      }
      if (headsContent.current) {
        headsContent.current.style.transform = `translate3d(0, ${-s.scrollY}px, 0)`;
      }
      if (rulerContent.current) {
        rulerContent.current.style.transform = `translate3d(${-s.scrollX}px, 0, 0)`;
      }
      syncOverflow();
    };
    write();
    const unsubX = useEditorStore.subscribe((s) => s.scrollX, write);
    const unsubY = useEditorStore.subscribe((s) => s.scrollY, write);
    return () => {
      unsubX();
      unsubY();
    };
  }, [syncOverflow]);

  /* Lane tops are summed from Track.height — the one runtime source (PLAN §2.4). */
  const rows: { id: string; top: number }[] = [];
  let top = 0;
  for (const id of trackOrder) {
    rows.push({ id, top });
    top += tracks[id]?.height ?? 0;
  }

  const contentWidth = Math.max(
    framesToPx(durationFrames + PLAYHEAD_TAIL_FRAMES, zoom),
    viewportWidth,
  );

  /* Zooming out, deleting the last clip or removing a track all shrink the
     scrollable extent under a scroll offset that is still valid state. Clamp it
     here, where the viewport is measured, rather than in the store. */
  useEffect(() => {
    const element = laneViewport.current;
    if (!element) return;
    const s = readStore();
    const maxX = Math.max(0, contentWidth - element.clientWidth);
    const maxY = Math.max(0, laneHeight - element.clientHeight);
    if (s.scrollX > maxX || s.scrollY > maxY) {
      s.setScroll(Math.min(s.scrollX, maxX), Math.min(s.scrollY, maxY));
    }
  }, [contentWidth, laneHeight, viewportWidth]);

  /* `.tl-heads` is `overflow: clip`, so the browser will not scroll a Tab-ed
     track head into view — and it must not, because a native scroll there would
     desynchronise the head column from the lanes. The store owns that scroll, so
     the reveal is done through it, exactly like `scrollClipIntoView`. */
  const onHeadFocus = useCallback((event: ReactFocusEvent<HTMLDivElement>): void => {
    const head = (event.target as HTMLElement).closest<HTMLElement>('.tl-head');
    const element = laneViewport.current;
    if (!head || !element) return;
    const s = readStore();
    const headTop = head.offsetTop;
    const headBottom = headTop + head.offsetHeight;
    let y = s.scrollY;
    if (headTop < s.scrollY) y = Math.max(0, headTop);
    else if (headBottom > s.scrollY + element.clientHeight) y = headBottom - element.clientHeight;
    if (y !== s.scrollY) s.setScroll(s.scrollX, y);
  }, []);

  // Roving tab stop: exactly one clip is reachable by Tab, and it is the focused
  // one when there is one, otherwise the first clip in the topmost busy track.
  const focusedStillExists = useEditorStore((s) =>
    interaction.focusedClipId ? s.clips[interaction.focusedClipId] !== undefined : false,
  );
  const rovingClipId: ClipId | null = focusedStillExists ? interaction.focusedClipId : firstClipId;

  return (
    <div className="tl-root">
      <TimelineToolbar laneViewportRef={laneViewport} />

      <div className="tl-grid">
        <div className="tl-corner" />

        <TimelineRuler
          contentRef={rulerContent}
          contentWidth={contentWidth}
          viewportWidth={viewportWidth}
          onPointerDown={interaction.onRulerPointerDown}
        >
          {/* No pointerdown handler here: the ruler delegates one for the whole
              strip, including this marker (see PlayheadHandle). */}
          <PlayheadHandle ref={playheadHead} onKeyDown={interaction.onPlayheadKeyDown} />
        </TimelineRuler>

        <div className="tl-heads" onFocus={onHeadFocus}>
          <div className="tl-heads-content" ref={headsContent} style={{ height: `${laneHeight}px` }}>
            {rows.map((row) => (
              <TrackHead key={row.id} trackId={row.id} top={row.top} />
            ))}
          </div>
        </div>

        <div
          className="tl-lanes"
          ref={laneViewport}
          data-lane-viewport="true"
          tabIndex={-1}
          role="group"
          aria-label="Timeline tracks"
          onPointerDown={interaction.onLanePointerDown}
          onContextMenu={interaction.onLaneContextMenu}
          onKeyDown={interaction.onLaneKeyDown}
          onFocus={interaction.onLaneFocus}
          onDragEnter={interaction.onDragEnter}
          onDragOver={interaction.onDragOver}
          onDragLeave={interaction.onDragLeave}
          onDrop={interaction.onDrop}
          onDragStart={interaction.onDragStart}
        >
          <div
            className="tl-lane-content"
            ref={laneContent}
            style={{ width: `${contentWidth}px`, height: `${laneHeight}px` }}
          >
            {rows.map((row) => (
              <Track
                key={row.id}
                trackId={row.id}
                top={row.top}
                zoom={zoom}
                focusedClipId={rovingClipId}
              />
            ))}
          </div>

          {clipCount === 0 ? (
            <p className="tl-empty-hint type-body">
              {mediaCount > 0
                ? 'Drag a clip from the media rail onto a track, or press Enter on a media row to place it at the playhead'
                : 'Import media to place your first clip'}
            </p>
          ) : null}

          <ClipContextMenu ref={clipMenu} />

          <Playhead ref={playheadLine} />

          <div className="tl-lanes-overflow" ref={overflowRail} hidden aria-hidden="true">
            <div className="tl-lanes-overflow-thumb" ref={overflowThumb} />
          </div>

          <div className="tl-snap-guide" ref={snapGuide} hidden aria-hidden="true" />
          <div className="tl-marquee" ref={marquee} hidden aria-hidden="true" />
          <div className="tl-refuse-bar" ref={refuseBar} hidden aria-hidden="true" />
          <div className="tl-refuse-lane" ref={refuseLane} hidden aria-hidden="true" />
          <div className="tl-drop-line" ref={dropLine} hidden aria-hidden="true" />

          <div className="tl-drag-badge type-label" ref={dragBadge} hidden role="status">
            <span className="tl-drag-badge-icon" data-icon="alert" aria-hidden="true">
              <AlertCircle size={14} strokeWidth={1.75} />
            </span>
            <span className="tl-drag-badge-icon" data-icon="lock" aria-hidden="true">
              <Lock size={14} strokeWidth={1.75} />
            </span>
            <span className="tl-drag-badge-icon" data-icon="unplug" aria-hidden="true">
              <Unplug size={14} strokeWidth={1.75} />
            </span>
            <span ref={dragBadgeText} />
          </div>

          <div className="tl-trim-badge type-numeric-sm" ref={trimBadge} hidden role="status" />
        </div>
      </div>
    </div>
  );
}
