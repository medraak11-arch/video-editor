/* ---------------------------------------------------------------------------
   Playhead — two elements, two z-index tokens, one write.

   The line through the lanes owns --z-playhead (above every clip); the grabbable
   marker inside the ruler owns --z-playhead-head, because the ruler is a sticky
   sibling that would otherwise paint over the line (PLAN §6).

   Both are positioned IMPERATIVELY from a single `useEditorStore.subscribe`
   callback, so they cannot drift by a frame and neither of them re-renders when
   the playhead moves. During playback this component renders zero times
   (PLAN §1.3 rule 3, §8.3).

   The playhead lives in `playbackSlice`. The timeline reads it and writes it
   through `seek()` — it keeps no shadow copy and never advances it.
--------------------------------------------------------------------------- */

import './timeline.css';
import { forwardRef, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, RefObject } from 'react';
import { useEditorStore, readStore } from '../../state/store';
import { framesToPx, framesToTimecode } from '../../lib/time';
import { selectTimelineDurationFrames } from '../../state/timelineSlice';
import { PLAYHEAD_TAIL_FRAMES } from '../../lib/constants';

/**
 * The single positioning callback. It writes both elements from one store read,
 * and refreshes the marker's accessible value in the same pass so the slider
 * stays truthful without a React render.
 */
export function usePlayheadSync(
  lineRef: RefObject<HTMLDivElement>,
  headRef: RefObject<HTMLDivElement>,
): void {
  const maxFrame = useRef(PLAYHEAD_TAIL_FRAMES);

  useEffect(() => {
    const write = (): void => {
      const s = readStore();
      const x = framesToPx(s.playhead, s.zoom) - s.scrollX;
      const transform = `translate3d(${x}px, 0, 0)`;
      if (lineRef.current) lineRef.current.style.transform = transform;
      const head = headRef.current;
      if (head) {
        head.style.transform = transform;
        head.setAttribute('aria-valuenow', String(s.playhead));
        head.setAttribute('aria-valuetext', framesToTimecode(s.playhead, s.fps));
      }
    };

    /* The slider's range depends on the clip DOCUMENT, not on the playhead, so
       it is refreshed when the document changes rather than 60 times a second
       during playback (PLAN §1.3 rule 1). */
    const writeMax = (): void => {
      const s = readStore();
      maxFrame.current = selectTimelineDurationFrames(s) + PLAYHEAD_TAIL_FRAMES;
      headRef.current?.setAttribute('aria-valuemax', String(maxFrame.current));
    };

    write();
    writeMax();
    const unsubPlayhead = useEditorStore.subscribe((s) => s.playhead, write);
    const unsubScroll = useEditorStore.subscribe((s) => s.scrollX, write);
    const unsubZoom = useEditorStore.subscribe((s) => s.zoom, write);
    const unsubClips = useEditorStore.subscribe((s) => s.clips, writeMax);
    return () => {
      unsubPlayhead();
      unsubScroll();
      unsubZoom();
      unsubClips();
    };
  }, [lineRef, headRef]);
}

/** The 1.5px accent line, full height of the lane area, above every clip. */
export const Playhead = forwardRef<HTMLDivElement>(function Playhead(_props, ref): ReactElement {
  return <div className="tl-playhead-line" ref={ref} aria-hidden="true" />;
});

export interface PlayheadHandleProps {
  onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
}

/**
 * The grab handle in the ruler. It is a real slider: focusable, arrow-operable,
 * and it reports its position as a timecode rather than a raw frame count.
 *
 * It carries NO pointerdown handler. The ruler above it delegates one for the
 * whole strip and recognises the marker by `data-playhead-handle`; a handler
 * here as well would bubble into that one and build two scrub gestures per
 * press.
 */
export const PlayheadHandle = forwardRef<HTMLDivElement, PlayheadHandleProps>(
  function PlayheadHandle({ onKeyDown }, ref): ReactElement {
    return (
      <div
        className="tl-playhead-head"
        ref={ref}
        data-playhead-handle="true"
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuenow={0}
        onKeyDown={onKeyDown}
      />
    );
  },
);
