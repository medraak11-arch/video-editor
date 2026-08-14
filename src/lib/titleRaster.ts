/* ---------------------------------------------------------------------------
   titleRaster.ts — ONE rasteriser, used twice. CREATIVE §5.2.

   The preview draws titles with this function onto a <canvas> over the video.
   The export draws titles with THIS SAME FUNCTION onto an OffscreenCanvas at
   project resolution, and hands the PNG to ffmpeg as an ordinary input.

   That is the entire design, and it exists to avoid drawtext. drawtext means
   resolving a font file by path, escaping `:` and `\` inside a filter script,
   no web font, no kerning parity, and a preview drawn by Chromium that will
   never agree with a file drawn by freetype — a disagreement that is invisible
   at caption size and glaring at title size, which is the size titles are.

   Rasterising instead costs one ffmpeg input per title clip and a few hundred KB
   in the export IPC payload, and buys an exported title that is, pixel for
   pixel, what the user was looking at.

   The function is RESOLUTION-INDEPENDENT: every dimension derives from `h`, so
   the same spec drawn at 480p and at 2160p differs only in sampling.
--------------------------------------------------------------------------- */

import type { TitleSpec } from '../types/model';

/** Baseline-to-baseline, as a multiple of the em size. */
const LINE_HEIGHT = 1.25;
/** Plate padding, as a multiple of the em size. */
const PAD_X = 0.45;
const PAD_Y = 0.3;

/**
 * `sizePct` is CAP HEIGHT as a fraction of frame height, not em size — em size
 * varies by typeface for the same visual size, so a spec authored in one family
 * would change size when the family changed. Cap height is what the eye reads.
 *
 * Chromium's `actualBoundingBoxAscent` for a flat-topped capital gives the real
 * cap height for the family actually resolved, so this measures rather than
 * assumes a ratio.
 */
function emSizeForCapHeight(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  spec: TitleSpec,
  targetCapPx: number,
): number {
  const probe = 200;
  ctx.font = fontString(spec, probe);
  const m = ctx.measureText('H');
  const ratio = m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent / probe : 0.72;
  return targetCapPx / ratio;
}

function fontString(spec: TitleSpec, px: number): string {
  const style = spec.italic ? 'italic ' : '';
  const weight = spec.bold ? '700 ' : '400 ';
  return `${style}${weight}${px}px ${spec.fontFamily}`;
}

/** '#rrggbb' + 0..1 → 'rgba(r,g,b,a)'. Tolerates a malformed hex by falling back. */
function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0xffffff;
  const a = !(alpha > 0) ? 0 : alpha > 1 ? 1 : alpha;
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

/**
 * Draws `spec` into a `w`×`h` context. Does NOT clear the context and does NOT
 * fill a background beyond the plate: a title composites over whatever is
 * beneath it, in the preview and in the graph alike.
 */
export function drawTitle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  spec: TitleSpec,
  w: number,
  h: number,
): void {
  const text = spec.text ?? '';
  if (text === '' || !(w > 0) || !(h > 0)) return;

  const em = emSizeForCapHeight(ctx, spec, spec.sizePct * h);
  ctx.font = fontString(spec, em);
  ctx.textBaseline = 'alphabetic';

  const lines = text.split('\n');
  const lineStep = em * LINE_HEIGHT;
  const blockHeight = lineStep * lines.length;
  const widest = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);

  // anchorX addresses the edge the text is aligned to, so a right-aligned title
  // at anchorX 0.9 keeps its right edge at 0.9 whatever the text says — which is
  // what makes retyping a title not move it. anchorY is the block's CENTRE.
  const anchorPx = spec.anchorX * w;
  const centreY = spec.anchorY * h;
  const top = centreY - blockHeight / 2;

  let left: number;
  if (spec.align === 'left') left = anchorPx;
  else if (spec.align === 'right') left = anchorPx - widest;
  else left = anchorPx - widest / 2;

  if (spec.backgroundOpacity > 0) {
    ctx.fillStyle = rgba(spec.background, spec.backgroundOpacity);
    ctx.fillRect(
      left - em * PAD_X,
      top - em * PAD_Y,
      widest + em * PAD_X * 2,
      blockHeight + em * PAD_Y * 2,
    );
  }

  ctx.fillStyle = rgba(spec.color, 1);
  ctx.textAlign = spec.align === 'center' ? 'center' : spec.align === 'right' ? 'right' : 'left';
  const penX = spec.align === 'center' ? left + widest / 2 : spec.align === 'right' ? left + widest : left;

  lines.forEach((line, i) => {
    // The baseline sits at the line box's top plus the ascent share of the step.
    // Splitting the leading evenly above and below is what makes a one-line and
    // a three-line title centre on the same point.
    const baseline = top + lineStep * i + (lineStep + em * 0.72) / 2 - em * 0.11;
    ctx.fillText(line, penX, baseline);
  });
}
