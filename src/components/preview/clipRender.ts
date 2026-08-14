/* ---------------------------------------------------------------------------
   clipRender.ts — the preview's half of the grade and the effect catalogue.
   CREATIVE §2.2, §3.

   PURE. No React, no store, no DOM: everything here is a function of its
   arguments, for the same reason audioMonitor.ts is pure — a rule that decides
   what the user sees against what the file will contain has to be assertable
   against a table of numbers rather than against a running app.

   IT CONSUMES `gradeMath` AND NOTHING ELSE. Not `p.brightness`, not
   `p.contrast`: CSS `filter: brightness()` is multiplicative and ffmpeg's
   `eq=brightness` is additive, so wiring the model value into both sides gives a
   preview that agrees with the file only at the default and diverges further the
   harder the user pushes the control — worst exactly where they are looking.
   `src/lib/color.ts` reduces the four corrections to terms an SVG filter and an
   ffmpeg filter chain can BOTH express exactly, and this module's only job is to
   spell those terms as SVG primitives in CREATIVE §2.3's normative order.

   `gradeMath(p).neutral` is honoured to the letter: an ungraded clip gets no
   `<filter>` element and no `filter` property, so the fast path stays exactly as
   fast as it was before this feature existed.
--------------------------------------------------------------------------- */

import type { ClipProperties } from '../../types/model';
import type { GradeMatrix } from '../../lib/color';
import { gradeMath, gradeMatrix } from '../../lib/color';

/** The grade, already reduced to what the two SVG primitives take. */
export interface GradePrimitives {
  slope: number;
  intercept: number;
  /**
   * Saturation AND temperature, folded into one 3×3 by `gradeMatrix` — the
   * function the export reads too, so the two cannot disagree by construction.
   * It is built from the Rec.709 weights `feColorMatrix type="saturate"` is
   * DEFINED with, which is what makes one `feColorMatrix type="matrix"` the
   * exact equivalent of the saturate-then-diagonal pair it replaces.
   */
  matrix: GradeMatrix;
}

/**
 * What, if anything, this clip needs an SVG `<filter>` for.
 *
 * `null` — the whole spec, not just a field — when the clip is ungraded and
 * unsharpened, so the caller can skip emitting the element rather than emit an
 * identity one. An identity SVG filter is not free: it forces the video frame
 * off the compositor fast path and through the filter rasteriser every frame.
 */
export interface ClipFilterSpec {
  /** Null when `gradeMath` reports neutral. */
  grade: GradePrimitives | null;
  /** 0 when off. `unsharp`'s amount, approximated by a 3×3 convolution. */
  sharpen: number;
}

/** Non-negative, and NaN-safe in the `!(n > 0)` direction (see color.ts's clamp). */
const atLeastZero = (n: number): number => (!(n > 0) ? 0 : n);

const clamp01 = (n: number): number => (!(n > 0) ? 0 : n > 1 ? 1 : n);

export function clipFilterSpec(p: ClipProperties): ClipFilterSpec | null {
  const g = gradeMath(p);
  const sharpen = Math.min(2, atLeastZero(p.sharpen));
  if (g.neutral && sharpen === 0) return null;
  return {
    grade: g.neutral
      ? null
      : {
          slope: g.slope,
          intercept: g.intercept,
          matrix: gradeMatrix(g.saturation, g.rGain, g.bGain),
        },
    sharpen,
  };
}

/**
 * `blur` is authored in PROJECT-resolution sigma (CREATIVE §3) and the graph
 * rescales it onto the output grid by `rx`, so a blur authored at 1080 and
 * exported at 4K looks the same. The preview's output grid is the STAGE, so the
 * same rescale is `scaleToStage` — without it the preview lies by exactly the
 * ratio of the window to the project, which is usually a factor of two or more.
 *
 * The divide by the clip's own `scale` is the second half of the same argument
 * and is easy to miss: CSS applies `filter` BEFORE `transform`, so a clip scaled
 * to 200 % would blur at 200 % of the requested sigma. The graph blurs on the
 * output grid, after the clip has been scaled onto it. Dividing here puts the
 * on-screen sigma back on the output grid where the graph has it.
 */
export function blurPx(p: ClipProperties, scaleToStage: number): number {
  const sigma = atLeastZero(p.blur);
  if (sigma === 0 || !(scaleToStage > 0)) return 0;
  const scale = Math.abs(p.scale);
  return (sigma * scaleToStage) / (scale > 1e-6 ? scale : 1);
}

/**
 * The element's `filter` property, or `undefined` when it needs none — which
 * React then omits from the style object entirely.
 *
 * Order inside the list is the order the graph applies them: the SVG filter
 * carries CREATIVE §2.3's contrast → brightness → saturation → temperature and
 * the sharpen after it; `blur()` follows, because `gblur` sits after `eq` and
 * `colorchannelmixer` in the clip chain.
 */
export function cssFilterValue(
  p: ClipProperties,
  filterId: string,
  hasSvgFilter: boolean,
  scaleToStage: number,
): string | undefined {
  const parts: string[] = [];
  if (hasSvgFilter) parts.push(`url(#${filterId})`);
  const blur = blurPx(p, scaleToStage);
  if (blur > 0) parts.push(`blur(${blur.toFixed(3)}px)`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * THE transform for a drawn clip layer. ONE transform, not two: `flipH`/`flipV`
 * are folded into the scale factor rather than appended as a second
 * `transform` on a wrapper, because two transforms on two boxes compose in an
 * order neither of them states and the flip would silently fight the rotation.
 *
 * `positionX`/`positionY` are project-resolution px, so they are rescaled onto
 * the stage exactly as `blur` is.
 */
export function frameTransform(p: ClipProperties, scaleToStage: number): string {
  const sx = p.scale * (p.flipH ? -1 : 1);
  const sy = p.scale * (p.flipV ? -1 : 1);
  return [
    `translate(${p.positionX * scaleToStage}px, ${p.positionY * scaleToStage}px)`,
    `rotate(${p.rotation}deg)`,
    `scale(${sx}, ${sy})`,
  ].join(' ');
}

/** 0 = no overlay at all, and the overlay is not rendered. */
export const vignetteOpacity = (p: ClipProperties): number => clamp01(p.vignette);

/* ------------------------------------------------------- SVG attribute values */

/**
 * `GradeMatrix` spelled as `feColorMatrix type="matrix"`'s 4×5 `values`.
 *
 * The SAME nine numbers `colorchannelmixer` takes as `rr=…:rg=…:…`, in the same
 * roles — which is the point of §2.2 choosing a linear matrix for saturation and
 * temperature rather than a hue rotation neither side can express identically.
 * The alpha row is identity: the transition ramp lives in alpha and no grade
 * term may touch it.
 */
export const colorMatrixValues = (m: GradeMatrix): string =>
  `${m.rr} ${m.rg} ${m.rb} 0 0  ${m.gr} ${m.gg} ${m.gb} 0 0  ${m.br} ${m.bg} ${m.bb} 0 0  0 0 0 1 0`;

/**
 * A 3×3 unsharp approximation of `unsharp=5:5:A:5:5:0`. It is an APPROXIMATION
 * and CREATIVE §3 says so out loud: ffmpeg sharpens against a 5×5 neighbourhood
 * in source pixels, this sharpens against a 3×3 one in DISPLAY pixels, so the
 * two agree in direction and in rough magnitude and not in detail. The kernel
 * sums to 1, so a flat region is untouched at every amount.
 */
export const sharpenKernel = (amount: number): string => {
  const a = amount;
  return `0 ${-a} 0  ${-a} ${1 + 4 * a} ${-a}  0 ${-a} 0`;
};
