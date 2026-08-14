/* ---------------------------------------------------------------------------
   TitleLayer — a title clip's pixels, drawn by the EXPORT'S rasteriser.
   CREATIVE §5.2.

   This canvas is the entire point of the titles feature. It calls `drawTitle`
   from src/lib/titleRaster.ts, and the export calls the SAME function on an
   OffscreenCanvas at project resolution and hands the PNG to ffmpeg as an
   ordinary input. There is no second implementation to drift, no font file to
   resolve, no `:` to escape inside a filter script, and no freetype/Chromium
   kerning disagreement — which at caption size is invisible and at title size,
   the size titles are, is not.

   The raster is at `devicePixelRatio`, not at CSS px: a title is the one thing
   in this app made of glyph edges, and a soft title on a high-DPI display reads
   as a rendering fault rather than as a preview approximation.

   A title clip is an ORDINARY clip on a video track. Opacity, scale, position,
   rotation, grade and transitions are handed in as `style` by the caller and are
   the same values every media clip gets; nothing here is special-cased.
--------------------------------------------------------------------------- */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { TitleSpec } from '../../types/model';
import { drawTitle } from '../../lib/titleRaster';

export interface TitleLayerProps {
  spec: TitleSpec;
  /** Stage size in CSS px. The raster is this times the device pixel ratio. */
  width: number;
  height: number;
  /** Opacity, transform and filter, exactly as the <video> element receives them. */
  style: CSSProperties;
}

/**
 * `devicePixelRatio` is not an event target. The matched media query is: moving
 * a window to a display with a different ratio changes which query matches, so
 * one listener per observed value re-arms itself and the canvas re-rasterises.
 * Without this a title stays at the ratio of the display the app opened on.
 */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));

  useEffect(() => {
    const current = window.devicePixelRatio || 1;
    if (current !== dpr) setDpr(current);
    const query = window.matchMedia(`(resolution: ${current}dppx)`);
    const onChange = (): void => setDpr(window.devicePixelRatio || 1);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [dpr]);

  return dpr;
}

export function TitleLayer({ spec, width, height, style }: TitleLayerProps): ReactElement | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dpr = useDevicePixelRatio();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !(width > 0) || !(height > 0)) return;

    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    // Assigning width/height clears the canvas, so it is done only when the size
    // actually changed — otherwise every spec keystroke would clear twice.
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    // drawTitle derives every dimension from the height it is GIVEN, so scaling
    // the context and passing CSS px keeps the geometry identical to the export's
    // and puts the extra resolution entirely into the glyph edges.
    ctx.scale(dpr, dpr);
    drawTitle(ctx, spec, width, height);
  }, [spec, width, height, dpr]);

  if (!(width > 0) || !(height > 0)) return null;

  return (
    <canvas
      className="ve-video-title"
      ref={canvasRef}
      aria-hidden="true"
      style={{ ...style, width: `${width}px`, height: `${height}px` }}
    />
  );
}
