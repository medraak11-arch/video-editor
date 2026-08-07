/* ---------------------------------------------------------------------------
   TimelineRuler — tick marks and timecode across the top of the lane area.

   Two decisions carry this component.

   1. DENSITY ADAPTS TO ZOOM, AND LABELS NEVER OVERLAP. The step is chosen from
      a ladder derived from the project frame rate (frames, then seconds,
      minutes, hours), and a step is only accepted if its marks are at least
      8 px apart and its labels at least a label-width apart. The label format
      drops the frame field the moment the step is a whole second or more, so
      the marks stay readable as you zoom out.

   2. MINOR TICKS ARE A GRADIENT, NOT ELEMENTS. A repeating-linear-gradient over
      the content element aligns exactly with frame 0 and costs nothing to
      scroll; only the labelled marks are real nodes, and only for the band
      around the viewport. Scrolling therefore re-renders this component roughly
      once per viewport of travel instead of once per frame.

   Marks are `.type-numeric-sm`: 11 px from the Label step, mono and tabular
   from the numeric step (PLAN §7.2 resolves the two rules in mono's favour).
--------------------------------------------------------------------------- */

import './timeline.css';
import { useEffect, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement, RefObject } from 'react';
import { Bookmark } from 'lucide-react';
import type { Frames, PxPerFrame } from '../../types/model';
import { useEditorStore, readStore } from '../../state/store';
import { framesToPx, framesToTimecode } from '../../lib/time';

/** Smallest gap between two minor ticks before the ladder steps up. */
const MIN_TICK_PX = 8;
/** Widths the label needs at 11px mono: "00:00:00:00" against "00:00". */
const MIN_LABEL_PX_FRAMES = 92;
const MIN_LABEL_PX_SECONDS = 64;

export interface RulerScale {
  minorStep: Frames;
  labelStep: Frames;
  /** True while the step is finer than a second, so the frame field is meaningful. */
  showFrames: boolean;
}

/** Frames, then seconds, minutes and hours — never an arbitrary "nice number". */
function ladder(fps: number): number[] {
  const f = Math.max(1, Math.round(fps));
  const sub = [1, 2, 5, 10, 15].filter((v) => v < f);
  const seconds = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * f);
  return [...sub, ...seconds];
}

export function chooseScale(zoom: PxPerFrame, fps: number): RulerScale {
  const steps = ladder(fps);
  const last = steps[steps.length - 1];
  const first = (min: number, minPx: number): number =>
    steps.find((s) => s >= min && s * zoom >= minPx) ?? last;

  /**
   * Every labelled mark must land ON a minor tick, never between two. The
   * ladder is not uniformly divisible (minor 2 with label 5 is reachable), so
   * the minor step is stepped DOWN to the coarsest ladder entry that divides
   * the label step. 1 divides everything and is always in the ladder, so this
   * always terminates.
   */
  const alignMinor = (minor: number, label: number): number => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const step = steps[i];
      if (step <= minor && label % step === 0) return step;
    }
    return 1;
  };

  const f = Math.max(1, Math.round(fps));
  const coarsest = first(1, MIN_TICK_PX);
  const wide = first(coarsest, MIN_LABEL_PX_FRAMES);

  const labelStep =
    wide >= f ? first(Math.max(coarsest, f), MIN_LABEL_PX_SECONDS) : wide;
  return { minorStep: alignMinor(coarsest, labelStep), labelStep, showFrames: wide < f };
}

/** "MM:SS:FF" / "H:MM:SS:FF" / "M:SS" / "H:MM:SS" — one conversion point, trimmed. */
export function formatMark(frame: Frames, fps: number, showFrames: boolean): string {
  const tc = framesToTimecode(frame, fps); // HH:MM:SS:FF
  const [hh, mm, ss, ff] = tc.split(':');
  const hours = Number(hh);
  if (showFrames) return hours > 0 ? `${hours}:${mm}:${ss}:${ff}` : `${mm}:${ss}:${ff}`;
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${Number(mm)}:${ss}`;
}

export interface TimelineRulerProps {
  /** The element carrying the shared -scrollX transform. */
  contentRef: RefObject<HTMLDivElement>;
  contentWidth: number;
  viewportWidth: number;
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  /** The playhead marker, rendered in the ruler VIEWPORT so scrolling cannot clip it. */
  children?: ReactElement | null;
}

interface Band {
  from: number;
  to: number;
}

export function TimelineRuler({
  contentRef,
  contentWidth,
  viewportWidth,
  onPointerDown,
  children,
}: TimelineRulerProps): ReactElement {
  const zoom = useEditorStore((s) => s.zoom);
  const fps = useEditorStore((s) => s.fps);
  const markers = useEditorStore((s) => s.markers);

  // The rendered band, in content px. It only moves when the viewport nears its
  // edge, so a scroll costs one render per viewport of travel, not per frame.
  const [band, setBand] = useState<Band>({ from: 0, to: 0 });

  useEffect(() => {
    const width = Math.max(1, viewportWidth);
    const margin = width * 0.25;
    const update = (scrollX: number): void => {
      setBand((prev) => {
        if (scrollX >= prev.from + margin && scrollX + width <= prev.to - margin) return prev;
        return { from: Math.max(0, scrollX - width), to: scrollX + width * 2 };
      });
    };
    update(readStore().scrollX);
    return useEditorStore.subscribe((s) => s.scrollX, update);
  }, [viewportWidth]);

  const scale = chooseScale(zoom, fps);
  const stepPx = Math.max(1, framesToPx(scale.minorStep, zoom));

  const fromFrame = Math.max(0, Math.floor(band.from / Math.max(zoom, 1e-6)));
  const toFrame = Math.max(fromFrame, Math.ceil(band.to / Math.max(zoom, 1e-6)));
  const firstLabel = Math.ceil(fromFrame / scale.labelStep) * scale.labelStep;

  const marks: ReactElement[] = [];
  for (let frame = firstLabel; frame <= toFrame; frame += scale.labelStep) {
    const x = framesToPx(frame, zoom);
    marks.push(
      <div key={`m${frame}`} className="tl-ruler-major" style={{ left: `${x}px` }} aria-hidden="true" />,
    );
    marks.push(
      <span key={`l${frame}`} className="tl-ruler-label type-numeric-sm" style={{ left: `${x + 4}px` }}>
        {formatMark(frame, fps, scale.showFrames)}
      </span>,
    );
    if (marks.length > 400) break; // hard stop; the band is bounded, this is belt and braces
  }

  const tickStyle = {
    width: `${contentWidth}px`,
    '--tl-tick-step': `${stepPx}px`,
  } as CSSProperties;

  return (
    <div className="tl-ruler" onPointerDown={onPointerDown} data-timeline-ruler="true">
      <div className="tl-ruler-content" ref={contentRef} style={{ width: `${contentWidth}px` }}>
        <div className="tl-ruler-ticks" style={tickStyle} aria-hidden="true" />
        {marks}
        {Object.values(markers).map((marker) => (
          <div
            key={marker.id}
            className="tl-marker"
            style={{ left: `${framesToPx(marker.frame, zoom)}px` }}
            role="note"
            aria-label={`Marker at ${framesToTimecode(marker.frame, fps)}${
              marker.label ? `, ${marker.label}` : ''
            }`}
          >
            <span className="tl-marker-glyph type-numeric-sm">
              <Bookmark size={11} strokeWidth={1.75} aria-hidden="true" />
              {marker.label}
            </span>
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}
