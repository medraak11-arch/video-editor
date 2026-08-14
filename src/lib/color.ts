/* ---------------------------------------------------------------------------
   color.ts — the grade maths. CREATIVE §2.2.

   PURE MODULE. No React, no DOM, no node imports: it is compiled into BOTH the
   renderer bundle and dist-electron, the same way src/types/model.ts is, and for
   the same reason — the preview and the export must not be able to disagree.

   THIS IS THE WHOLE POINT OF THE FILE. CSS `filter: brightness()` is
   MULTIPLICATIVE; ffmpeg's `eq=brightness` is ADDITIVE. Wiring
   ClipProperties.brightness into both would give a preview that agrees with the
   file only at the default, with the error growing as the correction grows —
   worst exactly where the user is looking hardest. So neither side consumes a
   model value. Both consume `gradeMath`.
--------------------------------------------------------------------------- */

import type { ClipProperties } from '../types/model';

/**
 * The four corrections, reduced to terms that BOTH an ffmpeg filter chain and an
 * SVG filter can express exactly.
 *
 * `slope`/`intercept` are a straight line through the channel value, which is
 * literally what `eq` computes and literally what `feComponentTransfer
 * type="linear"` computes. `saturation` is passed through because both sides
 * spell it the same way. The three gains are a diagonal matrix, which
 * `colorchannelmixer` and `feColorMatrix` both are.
 */
export interface GradeMath {
  /** out = slope·in + intercept, on 0..1. */
  slope: number;
  intercept: number;
  /** 0..3, 1 = untouched. */
  saturation: number;
  /** Diagonal per-channel gain. 1 = untouched. */
  rGain: number;
  gGain: number;
  bGain: number;
  /** True when every term is unity. The caller then emits NO filter AT ALL. */
  neutral: boolean;
}

/**
 * How far temperature pushes red against blue at the extremes. 0.12 is chosen
 * so ±100 is a visible but recoverable correction rather than a colour effect —
 * a white balance control that clips the highlights at its own maximum is a
 * control nobody can use the top half of.
 */
const TEMPERATURE_GAIN = 0.12;

const EPS = 1e-6;
const isUnity = (n: number): boolean => Math.abs(n - 1) < EPS;
const isZero = (n: number): boolean => Math.abs(n) < EPS;

/**
 * ffmpeg's `eq` computes, per channel, on 0..1:
 *
 *     out = (in − 0.5) · contrast + 0.5 + brightness
 *
 * which rearranges to `out = contrast·in + (0.5 − 0.5·contrast + brightness)`.
 * That is a slope and an intercept, and it is exactly the form
 * `feComponentTransfer type="linear"` takes. The identity is the reason the two
 * sides can be made to agree at all, and it is why `contrast` is applied before
 * `brightness` in CREATIVE §2.3 rather than after: swap them and the intercept
 * is no longer expressible without a second primitive.
 */
/**
 * The combined 3×3 RGB colour matrix: SATURATION then TEMPERATURE, in §2.3's
 * order, multiplied into one operator.
 *
 * One matrix rather than two filters because both operands ARE 3×3 RGB matrices
 * and the product is another one — so the export spends a single
 * `colorchannelmixer` and the preview a single `feColorMatrix`, and there is no
 * intermediate result for the two sides to round differently.
 *
 * The saturation terms are Rec.709 (0.213 / 0.715 / 0.072) because those are the
 * weights `feColorMatrix type="saturate"` is DEFINED with in the Filter Effects
 * spec. Restating them here is what makes the export match the preview by
 * construction instead of by hope — the earlier version delegated saturation to
 * `eq`, which does it in YUV with the frame's own luma weights, and that was one
 * of the three terms D4 found disagreeing.
 */
export interface GradeMatrix {
  rr: number; rg: number; rb: number;
  gr: number; gg: number; gb: number;
  br: number; bg: number; bb: number;
}

const LUMA_R = 0.213;
const LUMA_G = 0.715;
const LUMA_B = 0.072;

export function gradeMatrix(saturation: number, rGain: number, bGain: number): GradeMatrix {
  const s = saturation;
  // feColorMatrix type="saturate", verbatim from the spec.
  const sat = {
    rr: LUMA_R + (1 - LUMA_R) * s, rg: LUMA_G - LUMA_G * s, rb: LUMA_B - LUMA_B * s,
    gr: LUMA_R - LUMA_R * s, gg: LUMA_G + (1 - LUMA_G) * s, gb: LUMA_B - LUMA_B * s,
    br: LUMA_R - LUMA_R * s, bg: LUMA_G - LUMA_G * s, bb: LUMA_B + (1 - LUMA_B) * s,
  };
  // Temperature is a diagonal applied AFTER saturation (§2.3), so it scales
  // whole ROWS of the saturation matrix. Left-multiplication, not right — the
  // other order would tint before desaturating and the tint would be partly
  // removed by the very operation it is meant to survive.
  return {
    rr: sat.rr * rGain, rg: sat.rg * rGain, rb: sat.rb * rGain,
    gr: sat.gr, gg: sat.gg, gb: sat.gb,
    br: sat.br * bGain, bg: sat.bg * bGain, bb: sat.bb * bGain,
  };
}

export function gradeMath(p: ClipProperties): GradeMath {
  const contrast = clamp(p.contrast, 0, 3, 1);
  const brightness = clamp(p.brightness, -1, 1, 0);
  // 1.8, not 3 — CREATIVE §2.5, and this line is the one that MATTERS. The
  // model's declaration and `normalizeClipProperties` were narrowed first and
  // this was left at 3, so a value that never reaches the store legitimately
  // could still reach the emitter through any caller that does not launder its
  // input through the sanitiser — and the binary refuses the whole filtergraph,
  // not the coefficient. A bound is only real at the point that emits.
  const saturation = clamp(p.saturation, 0, 1.8, 1);
  const t = clamp(p.temperature, -100, 100, 0) / 100;

  const slope = contrast;
  const intercept = 0.5 - 0.5 * contrast + brightness;
  const rGain = 1 + TEMPERATURE_GAIN * t;
  const gGain = 1;
  const bGain = 1 - TEMPERATURE_GAIN * t;

  const neutral =
    isUnity(slope) && isZero(intercept) && isUnity(saturation) && isUnity(rGain) && isUnity(bGain);

  return { slope, intercept, saturation, rGain, gGain, bGain, neutral };
}

/**
 * Clamp to `lo..hi`, but land a NON-NUMBER on `neutral` — the value at which the
 * term does nothing — rather than on `lo`.
 *
 * The distinction is the whole point and the first version of this function got
 * it wrong. An out-of-range NUMBER is a value the user chose and overshot, so the
 * nearest legal value is the right answer. An ABSENT or NaN field is not a value
 * at all: it is a `.veproj` written before CREATIVE, or one hand-edited past the
 * sanitiser, and the honest reading of "this project does not mention contrast"
 * is "this project is not graded". Landing it on `lo` read it as
 * `contrast: 0` instead and exported the clip as FLAT BLACK — a silent, total
 * loss of picture on every project that predates the feature.
 *
 * `!(n >= lo)` is still what catches NaN, where `n < lo` is false; the two arms
 * are now separated so that NaN takes `neutral` and a real underflow takes `lo`.
 * `neutral` is also what makes `gradeMath`'s `neutral` flag come out TRUE for an
 * ungraded legacy project, which is what keeps it off the filter path entirely.
 */
function clamp(n: number, lo: number, hi: number, neutral: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return neutral;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/* ------------------------------------------------------------------ effects */

/** True when this clip asks for no effect at all — the fast path stays fast. */
export function effectsNeutral(p: ClipProperties): boolean {
  return isZero(p.blur) && isZero(p.sharpen) && isZero(p.vignette) && !p.flipH && !p.flipV;
}

/* ------------------------------------------------------------- transitions */

/**
 * The ramp multiplier for one clip at one PROJECT frame, 0..1. CREATIVE §4.2.
 *
 * ONE function for picture and for sound. The preview multiplies the rendered
 * opacity by it and multiplies the voice gain by it, so a fade cannot go out of
 * step between the two — which is the failure nobody notices in a screenshot and
 * everybody notices in the file.
 *
 * `frame` is absolute timeline position. Returns 1 outside both ramps, so a clip
 * with no transitions costs one comparison.
 *
 * For PICTURE a `dissolve` ramps identically to a `fade`: the difference between
 * them is what is underneath, and that is the export graph's business (it extends
 * the outgoing clip's tail) and the preview's (the previous clip stays drawn), not
 * this function's.
 *
 * For SOUND a `dissolve` ramps NOTHING — CREATIVE §4.3a. A cross dissolve is a
 * picture event: it consumes the outgoing clip's picture handle and leaves the
 * audio edit exactly as it was, a hard cut, the same cut every ordinary edit
 * point already makes. Ramping only the incoming side is the audible hole the
 * transitions gate caught; ramping both would mean carrying the outgoing clip's
 * audio tail through the preview as a fourth voice to buy an effect the model
 * already expresses as `fade out` + `fade in`, which the user can author and
 * which both consumers already build correctly.
 *
 * `stream` is REQUIRED rather than defaulted, so `tsc` enumerates every call
 * site instead of leaving one silently on the picture rule. This is the one
 * place the rule is written; no consumer restates it.
 */
export function transitionGain(
  clip: {
    start: number;
    duration: number;
    transitionIn?: { kind?: string; frames: number } | undefined;
    transitionOut?: { kind?: string; frames: number } | undefined;
  },
  frame: number,
  stream: 'video' | 'audio',
): number {
  let gain = 1;

  const tIn = stream === 'audio' && clip.transitionIn?.kind === 'dissolve'
    ? undefined
    : clip.transitionIn;
  if (tIn && tIn.frames > 0) {
    const elapsed = frame - clip.start;
    if (elapsed < tIn.frames) {
      /* The frame's LEADING EDGE, not its centre. ffmpeg's `fade` evaluates at
         the frame's PTS, so the first frame of an export ramp is exactly 0; a
         frame-centre sample here would show 1/2N instead and the preview would
         be permanently half a frame ahead of the file at the start of every
         ramp. `fade` rejects a negative `st`, so the export cannot be moved to
         meet the preview — the preview moves to meet the export, which is the
         direction this document's governing rule always resolves in.

         The frame-centre convention the export's `enable=` uses (EXPORT §1.6) is
         a different problem: `enable` is a STEP function and the centre is what
         keeps a clip's first and last frames on the right side of it. A ramp is
         a continuous function sampled at the same instant ffmpeg samples it.

         The visible consequence is that the first frame of a fade-in renders
         fully transparent. That is not a regression — it is what the exported
         file has always contained, and the preview was previously hiding it. */
      gain *= clamp01(elapsed / tIn.frames);
    }
  }

  const tOut = clip.transitionOut;
  if (tOut && tOut.frames > 0) {
    const remaining = clip.start + clip.duration - frame;
    if (remaining <= tOut.frames) {
      // Same alignment, verified against the export's own arithmetic: with
      // `fade=t=out:st=(L−N)/F:d=N/F`, the clip's LAST frame sits at PTS
      // (L−1)/F and evaluates to 1/N. `remaining` is 1 on that frame, so
      // `remaining / N` is the same 1/N. The two agree frame for frame.
      gain *= clamp01(remaining / tOut.frames);
    }
  }

  return gain;
}

const clamp01 = (n: number): number => (!(n > 0) ? 0 : n > 1 ? 1 : n);

/**
 * The number of frames a cross dissolve ACTUALLY runs for, CREATIVE §4.3.
 *
 * The authored value is what the user asked for and is never written back; what
 * can be honoured depends on how much unused source sits after the OUTGOING
 * clip's out point, and that is a fact about the media, not about the edit. So
 * the clamp happens at build/draw time, every time, and trimming the outgoing
 * clip longer later restores the transition the user asked for.
 *
 * It lives HERE, in the module both bundles compile, for the reason the whole
 * plan turns on: the export graph clamps it to decide how far to extend the
 * outgoing input's `-t`, and the preview's dissolve underlay clamps it to decide
 * how long to keep the outgoing clip on screen. Two copies of this arithmetic is
 * two answers to "how long is this dissolve", and the user would see the
 * disagreement as a preview that runs the ramp longer than the file does.
 *
 * `sourceDurationFrames` is null when the media has not reported a duration yet
 * — which is NOT the same as "no handle": refusing the transition on an
 * unprobed source would make a dissolve appear and disappear as the probe lands.
 * Any non-finite value reads the same way, so a caller cannot express "unknown"
 * two ways and get two answers.
 *
 * **A TITLE IS DECIDED HERE, NOT BY THE CALLER.** It is a still fed through
 * `-loop 1` with no out point to run past, so its handle is unlimited and
 * `sourceDurationFrames` is not consulted at all. An earlier version of this
 * comment said a title "passes `Infinity`" while the signature took
 * `number | null` and only `null` reached the unlimited branch — so the two
 * consumers adopted two different call conventions for the same case and agreed
 * only because `Infinity` happened to survive `Math.min`. Agreement by
 * coincidence is exactly what this function was extracted to stop, so the case
 * is no longer expressible: pass the outgoing clip's `kind` and the function
 * answers. There is one convention because there is one decision.
 *
 * Returns 0 when there is no handle at all, which is the caller's signal to
 * degrade to a plain fade (§4.3) rather than to fail.
 */
export function dissolveFrames(
  authored: number,
  outgoing: {
    duration: number;
    mediaIn: number;
    properties: { speed: number };
    /** `'title'` ⇒ unlimited handle. Absent ≡ 'media', per model.ts. */
    kind?: string | undefined;
  },
  sourceDurationFrames: number | null,
): number {
  if (!(authored >= 1)) return 0;
  const speed = outgoing.properties.speed > 0 ? outgoing.properties.speed : 1;
  const unlimited =
    outgoing.kind === 'title' ||
    sourceDurationFrames === null ||
    !Number.isFinite(sourceDurationFrames);
  const handle = unlimited
    ? Number.MAX_SAFE_INTEGER
    : Math.max(
        0,
        Math.floor(
          ((sourceDurationFrames as number) -
            (outgoing.mediaIn + Math.round(outgoing.duration * speed))) /
            speed,
        ),
      );
  // Never longer than the outgoing clip itself: a ramp that reaches back past
  // its own in point is dissolving out of a clip that was not on screen.
  const n = Math.min(Math.round(authored), handle, outgoing.duration);
  return n >= 1 ? n : 0;
}
