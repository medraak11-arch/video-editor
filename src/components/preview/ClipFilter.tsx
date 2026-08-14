/* ---------------------------------------------------------------------------
   ClipFilter — the grade, as SVG filter primitives. CREATIVE §2.2.

   The same maths as the export's `eq` + `colorchannelmixer`, in the same
   normative order (CREATIVE §2.3): a linear transfer per channel, then a
   saturation matrix, then the diagonal temperature matrix. The terms come from
   `gradeMath` through `clipRender.ts` and are never read off the model, for the
   reason color.ts's header states at length.

   `color-interpolation-filters="sRGB"` IS LOAD-BEARING AND MUST NOT BE REMOVED.
   SVG's default for filter primitives is linearRGB, and ffmpeg's `eq` operates
   on the gamma-encoded values it is handed. Leave the default in place and every
   term is applied to a differently-transferred signal from the one the file gets
   — a mid-grey lift that reads as roughly twice its size in the preview, which
   is precisely the class of quiet disagreement this whole feature is built to
   avoid.

   Rendered only when `spec` is non-null. An identity filter is not free: it
   takes the video frame off the compositor's fast path and pushes every frame
   through the filter rasteriser, so an ungraded clip gets no element at all.
--------------------------------------------------------------------------- */

import type { ReactElement } from 'react';
import type { ClipFilterSpec } from './clipRender';
import { colorMatrixValues, sharpenKernel } from './clipRender';

export interface ClipFilterProps {
  /** Must be unique per drawn layer and stable across re-renders of that layer. */
  id: string;
  spec: ClipFilterSpec;
}

export function ClipFilter({ id, spec }: ClipFilterProps): ReactElement {
  const { grade, sharpen } = spec;
  return (
    <svg className="ve-video-filter-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id={id} colorInterpolationFilters="sRGB">
          {grade !== null ? (
            <feComponentTransfer>
              {/* out = slope·in + intercept, which is `eq`'s own rearrangement —
                  see color.ts. The three channels take the SAME line: contrast
                  and brightness are achromatic, and temperature is the matrix
                  two primitives below, not a per-channel intercept. */}
              <feFuncR type="linear" slope={grade.slope} intercept={grade.intercept} />
              <feFuncG type="linear" slope={grade.slope} intercept={grade.intercept} />
              <feFuncB type="linear" slope={grade.slope} intercept={grade.intercept} />
            </feComponentTransfer>
          ) : null}
          {/* ONE matrix, from `gradeMatrix` — saturation and temperature folded
              together in §2.3's order. It replaced a `type="saturate"` primitive
              followed by a diagonal one: the pair was arithmetically identical,
              but it left the preview holding its own copy of the fold while the
              export held another, which is the shape of every disagreement this
              plan exists to prevent. */}
          {grade !== null ? (
            <feColorMatrix type="matrix" values={colorMatrixValues(grade.matrix)} />
          ) : null}
          {sharpen > 0 ? (
            /* preserveAlpha, because the ramp of a transition is carried in the
               alpha channel and a convolution that touched it would put a halo
               on the fade rather than on the picture. */
            <feConvolveMatrix
              order="3"
              divisor={1}
              preserveAlpha="true"
              kernelMatrix={sharpenKernel(sharpen)}
            />
          ) : null}
        </filter>
      </defs>
    </svg>
  );
}
