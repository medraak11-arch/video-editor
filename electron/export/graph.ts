/* ---------------------------------------------------------------------------
   electron/export/graph.ts — the ffmpeg graph builder. EXPORT §1, §6.

   PURE MODULE. No `electron`, no `node:child_process`, no `node:fs`, no
   `node:path`. It takes an ExportRequest plus two already-joined paths and
   returns argv + the filter script as strings. That is the point: the part most
   likely to be wrong is the part that can be exercised with `node -e` against
   dist-electron/electron/export/graph.js, with no window, no app and no encode.

   Every construct here is EXPORT §1. The three worked examples in EXPORT §1.8
   are the acceptance test for this file and must be diffed byte-for-byte before
   anything is wired.
--------------------------------------------------------------------------- */

import type {
  ExportDocument,
  ExportError,
  ExportErrorCode,
  ExportRequest,
  ExportSource,
  VideoCodec,
} from '../../src/types/api';
import { isAudioOnlyCodec } from '../../src/types/api';
import type { Clip, SubtitleStyle } from '../../src/types/model';
// A VALUE import, not a type one. It resolves at runtime because
// tsconfig.electron.json already compiles src/types/model.ts into
// dist-electron/src/types/model.js — the same mechanism that makes `CH` work.
// model.ts has no React, no DOM and no node import, which is what permits it.
import {
  clipHasAudio,
  clipHasVideo,
  clipIsTitle,
  DEFAULT_CLIP_PROPERTIES,
  DEFAULT_SUBTITLE_STYLE,
  trackVolume,
} from '../../src/types/model';
// Same mechanism, same reason: src/lib/color.ts is pure and is compiled into
// dist-electron beside model.ts. It is imported rather than reimplemented
// because the WHOLE POINT of that file is that the preview and this builder
// cannot disagree about what a grade means (CREATIVE §2.2).
import { dissolveFrames, effectsNeutral, gradeMath, gradeMatrix } from '../../src/lib/color';

/* --------------------------------------------------------------- §4 errors
   One frozen table so a message is written once. graph.ts owns it because it is
   the first module that needs to name an error; electron/ipc/export.ts imports
   it rather than restating a sentence. */

export const ERR: Readonly<Record<ExportErrorCode, ExportError>> = Object.freeze({
  'ffmpeg-missing': {
    code: 'ffmpeg-missing',
    message: 'ffmpeg was not found on PATH, so nothing can be encoded',
    retryable: false,
  },
  'invalid-filename': {
    code: 'invalid-filename',
    message: 'That file name cannot be used on this system',
    retryable: false,
  },
  /**
   * The request itself is malformed — a missing or non-numeric field, an
   * unknown codec, a negative start frame. ffmpeg is never launched, so this
   * must NOT arrive as 'encoder-failed': that sentence sends whoever reads it
   * looking for a broken encoder that was never started.
   */
  'invalid-request': {
    code: 'invalid-request',
    message: 'The export settings are not valid, so nothing was encoded',
    retryable: false,
  },
  'empty-timeline': {
    code: 'empty-timeline',
    message: 'There is nothing on the timeline to export',
    retryable: false,
  },
  'source-missing': {
    code: 'source-missing',
    message: 'A source file is no longer where the project expects it',
    retryable: false,
  },
  'unsupported-codec': {
    code: 'unsupported-codec',
    message: 'A source uses a codec this build cannot decode',
    retryable: false,
  },
  'output-not-writable': {
    code: 'output-not-writable',
    message: 'The output folder is missing, so nothing can be written',
    retryable: false,
  },
  'permission-denied': {
    code: 'permission-denied',
    message: 'The output folder does not allow this app to write',
    retryable: false,
  },
  'disk-full': {
    code: 'disk-full',
    message: 'The drive ran out of space before the export finished',
    retryable: false,
  },
  'output-in-use': {
    code: 'output-in-use',
    message: 'The output file is open in another program',
    retryable: true,
  },
  busy: {
    code: 'busy',
    message: 'Another export is already running',
    retryable: true,
  },
  /**
   * ffmpeg was found but the run never began: `spawn` threw or emitted `error`
   * with something other than ENOENT, or preparation failed before the spawn
   * point. Distinct from 'encoder-failed' for the same reason as above — one
   * says the encoder died mid-run, this one says it never ran.
   */
  'encoder-not-started': {
    code: 'encoder-not-started',
    message: 'The encoder could not be started, so nothing was encoded',
    retryable: true,
  },
  'encoder-failed': {
    code: 'encoder-failed',
    message: 'The encoder stopped before it finished',
    retryable: true,
  },
});

/* --------------------------------------------------------------- §1.10 codec */

/** PLAN §7.3, restated so this pure module needs no renderer import. */
export const CONTAINER: Record<ExportRequest['codec'], string> = {
  h264: 'mp4',
  h265: 'mp4',
  prores: 'mov',
  // `.m4a` IS the mp4 container; `-f mp4` is what was verified, and `-map [aout]`
  // alone is what makes the file audio-only.
  aac: 'm4a',
  mp3: 'mp3',
  wav: 'wav',
};

interface CodecShape {
  /** base + terminal `format`, and the encoder's -pix_fmt. */
  basePixFmt: string;
  /** per-clip `format` — carries alpha, which opacity and the letterbox need. */
  clipPixFmt: string;
  /**
   * What a GRADED clip's chain runs in instead of `clipPixFmt` — CREATIVE §2.4.
   * Planar RGB **with alpha**, because opacity and the letterbox still need the
   * alpha plane and `gbrp` would silently drop it.
   *
   * It is TWO BITS DEEPER than `clipPixFmt`, always. Two reasons, and the second
   * was measured rather than assumed:
   *
   *  - the ProRes path is 10-bit, and grading it through an 8-bit intermediate
   *    would quantise to 8 bits behind correct-looking 10-bit metadata — the
   *    same class of defect as the 4:2:0-behind-ProRes one §1.10 prevents;
   *  - the grade is TWO filters, so it quantises TWICE. At `gbrap` the h264 path
   *    landed 1.02/255 off the float answer on a four-term grade — over the
   *    ±1 bar by itself. The headroom absorbs the intermediate rounding: the
   *    same grade at `gbrap10le` lands within 0.83.
   */
  gradePixFmt: string;
  /** `overlay`'s `format=` option. A CODEC decision, not a constant. */
  overlayFmt: string;
}

/**
 * NARROWED to `VideoCodec`, so there is no row to invent for an audio codec.
 * An invented `basePixFmt` for `wav` would compile, emit a `[vout]` label, and
 * ffmpeg would then fail on an unconnected filtergraph output.
 */
const CODEC_SHAPE: Record<VideoCodec, CodecShape> = {
  h264: { basePixFmt: 'yuv420p', clipPixFmt: 'yuva420p', gradePixFmt: 'gbrap10le', overlayFmt: 'yuv420' },
  h265: { basePixFmt: 'yuv420p', clipPixFmt: 'yuva420p', gradePixFmt: 'gbrap10le', overlayFmt: 'yuv420' },
  prores: {
    basePixFmt: 'yuv422p10le',
    clipPixFmt: 'yuva422p10le',
    gradePixFmt: 'gbrap12le',
    overlayFmt: 'yuv422p10',
  },
};

/** The `-b:a` argument for an audio-only export. Mirrors `AUDIO_BITRATE_KBPS`. */
const AUDIO_BITRATE: Record<'aac' | 'mp3', Record<ExportRequest['quality'], string>> = {
  aac: { draft: '128k', good: '192k', best: '256k' },
  mp3: { draft: '128k', good: '192k', best: '320k' },
};

/** WAV's `-c:a`. `best` is 24-bit because a lossless handoff is what WAV is for. */
const WAV_PCM: Record<ExportRequest['quality'], string> = {
  draft: 'pcm_s16le',
  good: 'pcm_s16le',
  best: 'pcm_s24le',
};

const X264: Record<ExportRequest['quality'], { preset: string; crf: string }> = {
  draft: { preset: 'veryfast', crf: '28' },
  good: { preset: 'medium', crf: '20' },
  best: { preset: 'slow', crf: '16' },
};

const X265: Record<ExportRequest['quality'], { preset: string; crf: string }> = {
  draft: { preset: 'veryfast', crf: '32' },
  good: { preset: 'medium', crf: '24' },
  best: { preset: 'slow', crf: '20' },
};

/** prores_ks -profile:v. 0 proxy, 2 422, 3 422 HQ. */
const PRORES_PROFILE: Record<ExportRequest['quality'], string> = {
  draft: '0',
  good: '2',
  best: '3',
};

/* ------------------------------------------------------------- §1.3 formats
   Fixed so the graph is byte-reproducible: the same document and settings must
   always produce the same script. That is what makes a bug reportable. */

/** Seconds. */
const sec = (n: number): string => n.toFixed(6);
/** Factors: speed, opacity, volume. */
const fac = (n: number): string => n.toFixed(3);
/** A frame rate as ffmpeg spells it: 30, 24, 29.97, 23.976. */
const rate = (n: number): string => String(n);
/** An overlay position offset, as a signed expression tail: '+0', '-40', '+12.500'. */
function offset(n: number): string {
  const magnitude = Math.abs(n);
  const text = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(3);
  return (n < 0 ? '-' : '+') + text;
}

/* ------------------------------------------- CREATIVE §2, §3 grade + effects

   ORDER, and it is normative because it must be reproducible and because two
   different orders are two different pictures:

     hflip → vflip → lutrgb → gblur → unsharp → vignette → colorchannelmixer

   1. The flips are GEOMETRY and run first, so every tonal and spatial filter
      after them sees the frame the user is actually looking at. (A flip commutes
      with all of them; running it first is a statement of intent, not a fix.)
   2. `lutrgb` is contrast then brightness — CREATIVE §2.3's first two terms, in
      one straight line through the channel value.
   3. blur, then sharpen, then vignette: sharpening a blur is a legitimate look
      and blurring a sharpen just undoes it, and the vignette is a darkening of
      the finished frame rather than something to be sharpened.
   4. `colorchannelmixer` is saturation × temperature — §2.3's last two terms,
      as one matrix — and opacity's `aa` rides in the same filter.

      It sits AFTER the three spatial filters rather than immediately after the
      tone curve, and that is safe rather than convenient: a constant 3×3 applied
      per pixel COMMUTES with all three. gblur and unsharp are per-channel
      convolutions with the same kernel on every channel, and a linear operator
      passes through a convolution unchanged; vignette is a per-pixel scalar, and
      a scalar commutes with a matrix. Putting it last is what lets the graded
      and ungraded branches share one order instead of documenting two.

   THE WHOLE BLOCK RUNS IN `gradePixFmt` — planar RGB with alpha — when there is
   a grade, and in `clipPixFmt` when there is not. One `format` in, one `format`
   back out, so the spatial effects on a graded clip run at full chroma
   resolution rather than on an already-subsampled 4:2:0 plane.

   Everything here is emitted ONLY when it is not neutral, so an ungraded clip's
   chain is byte-for-byte the chain EXPORT §1.5 already specifies. That is what
   keeps the three worked examples in EXPORT §1.8 valid. */

/**
 * The nine grade and effect fields, guaranteed to be numbers.
 *
 * `gradeMath`'s clamp lands a NaN or an `undefined` on the LOW bound, which is
 * the right answer for a hand-edited value out of range and the WRONG one for a
 * field that is simply not there: `contrast` would arrive at 0 rather than 1 and
 * the clip would export as flat black. A `.veproj` written before CREATIVE has
 * none of these keys, and while `normalizeClipProperties` fills them in the
 * renderer, this is the main process reading a structured-clone payload — the
 * same boundary at which `validateRequest` re-checks the filename the renderer
 * already sanitised, and for the same reason.
 *
 * Returns the object UNTOUCHED in the ordinary case, so a well-formed document
 * costs nine comparisons and no allocation.
 */
function withGradeDefaults(p: Clip['properties']): Clip['properties'] {
  const ok =
    Number.isFinite(p.brightness) &&
    Number.isFinite(p.contrast) &&
    Number.isFinite(p.saturation) &&
    Number.isFinite(p.temperature) &&
    Number.isFinite(p.blur) &&
    Number.isFinite(p.sharpen) &&
    Number.isFinite(p.vignette);
  if (ok) return p;
  return {
    ...p,
    brightness: Number.isFinite(p.brightness) ? p.brightness : DEFAULT_CLIP_PROPERTIES.brightness,
    contrast: Number.isFinite(p.contrast) ? p.contrast : DEFAULT_CLIP_PROPERTIES.contrast,
    saturation: Number.isFinite(p.saturation) ? p.saturation : DEFAULT_CLIP_PROPERTIES.saturation,
    temperature: Number.isFinite(p.temperature)
      ? p.temperature
      : DEFAULT_CLIP_PROPERTIES.temperature,
    blur: Number.isFinite(p.blur) ? p.blur : DEFAULT_CLIP_PROPERTIES.blur,
    sharpen: Number.isFinite(p.sharpen) ? p.sharpen : DEFAULT_CLIP_PROPERTIES.sharpen,
    vignette: Number.isFinite(p.vignette) ? p.vignette : DEFAULT_CLIP_PROPERTIES.vignette,
    flipH: p.flipH === true,
    flipV: p.flipV === true,
  };
}

/* THE EXPORT DOES NOT USE `eq`, AND THAT IS THE POINT OF §2.4.

   It used to, and the result did not match the preview. `eq` works on Y in
   LIMITED-RANGE YUV: `brightness=0.2` moves an RGB value by about 58/255 rather
   than 51, because of the ×1.164 range expansion, and its `contrast` scales luma
   while holding chroma, which shifts hue by an amount no per-channel scalar can
   absorb. Measured on 46,95,158: `eq=brightness=0.2` gave 104,153,216 where
   `gradeMath` says 97,146,209, and `eq=saturation=0` gave 86,88,85 — not even a
   neutral grey. That is a DOMAIN disagreement, not a coefficient to correct, so
   the fix is to leave the domain.

   Both filters below run on planar RGB, which is the domain the preview's SVG
   primitives are defined in, and they consume `gradeMath`'s output with no
   arithmetic of their own. `lutrgb` IS `feComponentTransfer type="linear"`;
   `colorchannelmixer` IS `feColorMatrix`. The two sides now agree by
   construction rather than by correction.

   DO NOT reintroduce `eq` for one term while the others are here. Two colour
   domains in one chain is exactly how the defect happened. */

/** Grade coefficients. Four places, not three: nine matrix terms accumulate. */
const coef = (n: number): string => n.toFixed(4);

/**
 * Contrast and brightness, as the straight line `out = slope·in + intercept`
 * that `gradeMath` already emits and that `feComponentTransfer type="linear"`
 * already consumes. No inversion, no second identity to keep in step — the same
 * two numbers, spelled in the units of the pixel format.
 *
 * `maxval`/`minval` rather than a literal 255: they are 1023 on the ProRes
 * path's `gbrap10le`, so one expression is correct at both depths and
 * `intercept` stays a fraction of full scale exactly as `gradeMath` defines it.
 *
 * The `+0.5` is round-half-up. `lutrgb` builds an integer table by truncation,
 * so without it every value drifts up to 1 LSB downward AT THE TABLE'S OWN
 * DEPTH. Keep it: it is correct and it costs nothing.
 *
 * But do not mistake it for what holds the error budget — it is not, and this
 * comment used to say it was. The table runs at `gradePixFmt`, which is two bits
 * deeper than the output, so the drift arrives at 8-bit already divided by four:
 * removing the `+0.5` at `gbrap10le` measures under 0.25/255, invisible against
 * the ±1/255 bar. Gates tried to build a check that would catch its removal —
 * including a systematic-bias statistic, on the theory that truncation biases
 * one way where rounding centres — and got 0.027/255 unmutated against
 * 0.022/255 mutated. No discrimination at either depth, so the check was
 * removed rather than shipped unable to fail.
 *
 * THE TERM ACTUALLY HOLDING THE BUDGET IS THE WORKING DEPTH. The grade is two
 * filters and therefore quantises twice, and at 8-bit `gbrap` that compounding
 * measured 1.02/255 — over the bar on its own. `CodecShape.gradePixFmt` is what
 * absorbs it, and a mutation of THAT is caught. Defend the depth.
 */
function toneFilter(p: Parameters<typeof gradeMath>[0]): string | null {
  const g = gradeMath(p);
  if (Math.abs(g.slope - 1) < 1e-6 && Math.abs(g.intercept) < 1e-6) return null;
  const sign = g.intercept < 0 ? '-' : '+';
  const expr =
    `clip(val*${coef(g.slope)}${sign}${coef(Math.abs(g.intercept))}*maxval+0.5,minval,maxval)`;
  // Quoted, because `clip()` takes commas and a comma is the filtergraph's own
  // filter separator. Inside single quotes it is literal.
  return `lutrgb=r='${expr}':g='${expr}':b='${expr}'`;
}

/**
 * Saturation and temperature as ONE 3×3, from `gradeMatrix` — plus `aa` for
 * opacity, which shares the filter because it is the alpha row of the same
 * operator and a second `colorchannelmixer` would be a filter spent on nothing.
 *
 * Returns just the opacity when the grade is neutral, which is byte-for-byte
 * the line EXPORT §1.5 already specifies.
 */
function mixerFilter(p: Parameters<typeof gradeMath>[0], opacity: number): string {
  const g = gradeMath(p);
  if (g.neutral) return `colorchannelmixer=aa=${fac(opacity)}`;
  const m = gradeMatrix(g.saturation, g.rGain, g.bGain);
  return (
    `colorchannelmixer=` +
    `rr=${coef(m.rr)}:rg=${coef(m.rg)}:rb=${coef(m.rb)}:` +
    `gr=${coef(m.gr)}:gg=${coef(m.gg)}:gb=${coef(m.gb)}:` +
    `br=${coef(m.br)}:bg=${coef(m.bg)}:bb=${coef(m.bb)}:` +
    `aa=${fac(opacity)}`
  );
}

/**
 * `vignette`'s `a` is the lens angle in RADIANS, not a 0..1 strength, so the
 * model's 0..1 needs a maximum. π/4 is it: ffmpeg's own default is π/5, which is
 * a mild and pleasant vignette, and π/2 crushes the corners to black. π/4 is
 * therefore "clearly stronger than the stock look, still recoverable" — the same
 * judgement TEMPERATURE_GAIN makes in color.ts, and for the same reason: a
 * control whose top half is unusable is a control with half the range.
 */
const VIGNETTE_MAX_ANGLE = Math.PI / 4;

/**
 * CREATIVE §3.1. `gblur` is not a Gaussian convolution — it is a recursive IIR
 * approximation of one, and `steps` is how many passes it spends converging.
 * IT DEFAULTS TO 1, and at 1 it is about 11% NARROW: the file was visibly
 * softer-edged than the preview at the same authored sigma, which is what §3.1
 * was raised for.
 *
 * Measured on this build, on a STEP EDGE — the only fixture the Gaussian-edge
 * relation actually holds for; a title glyph is a narrow stroke, not a step, and
 * yields a number that is not the filter's. The estimator is the 10–90%
 * transition width, applied identically to ffmpeg's output and to an ANALYTIC
 * ideal at the same sigma, so the estimator's own bias cancels out of the ratio.
 * Values are measured width / ideal width:
 *
 *   sigma   steps1  steps2  steps3  steps4  steps5  steps6
 *       2   0.8893  0.9242  0.9376  0.9455  0.9493  0.9496
 *       4   0.8782  0.9309  0.9512  0.9589  0.9662  0.9708
 *      10   0.8861  0.9354  0.9514  0.9614  0.9700  0.9744
 *      25   0.8895  0.9362  0.9519  0.9652  0.9697  0.9742
 *      50   0.8870  0.9338  0.9546  0.9650  0.9702  0.9754
 *
 * It CONVERGES, which is why this is a setting to raise rather than an error to
 * label — but it also PLATEAUS, so 6 is chosen as the last step that still buys
 * anything and the largest the filter accepts. The residual is then within 3% of
 * the authored sigma for sigma >= 4, widening to 5% at sigma 2 — where the blur
 * is two pixels wide and 5% of it is a tenth of a pixel. The percentage is worst
 * exactly where the absolute error is smallest.
 *
 * THAT PERCENTAGE NAMES ITS ESTIMATOR, and it has to, because `gblur`'s output
 * is not a Gaussian and no single sigma describes it. A true Gaussian yields the
 * same implied sigma from every crossing pair; this one does not — at sigma 25:
 *
 *    5–95%  -0.30%      25–75%  -5.35%
 *   10–90%  -2.58%      40–60%  -6.26%
 *
 * Heavy tails, narrow core, which is the IIR signature. So "within 3%" is a
 * 10–90 TRANSITION-WIDTH statement; measured across the core it is nearer 6%.
 * Do not quote one of these numbers against a measurement taken with another.
 *
 * And the comparison that actually decides whether the user was lied to is
 * PREVIEW PROFILE against FILE PROFILE, not either against an ideal Gaussian:
 * CSS `filter: blur()` is three box passes and is no more Gaussian than this is.
 * Both engines approximate; agreement is the requirement, not Gaussianness.
 *
 * The cost is five extra IIR passes per blurred clip on an offline export, which
 * is the cheapest currency this project spends.
 */
const GBLUR_STEPS = 6;

/**
 * `rx` is the project→output width ratio. `blur` is authored in
 * PROJECT-resolution sigma (CREATIVE §3), so it is rescaled here exactly as
 * `positionX` is in the collect loop: an unscaled sigma authored at 1080 would be
 * half as strong at 4K, which is the one thing a resolution-independent effect
 * must not do.
 */
function effectFilters(
  p: Parameters<typeof effectsNeutral>[0],
  rx: number,
): { geometry: string[]; spatial: string[] } {
  if (effectsNeutral(p)) return { geometry: [], spatial: [] };
  const geometry: string[] = [];
  const spatial: string[] = [];
  if (p.flipH) geometry.push('hflip');
  if (p.flipV) geometry.push('vflip');
  if (p.blur > 0) spatial.push(`gblur=sigma=${fac(p.blur * rx)}:steps=${GBLUR_STEPS}`);
  if (p.sharpen > 0) spatial.push(`unsharp=5:5:${fac(p.sharpen)}:5:5:0`);
  if (p.vignette > 0) spatial.push(`vignette=a=${fac(p.vignette * VIGNETTE_MAX_ANGLE)}`);
  return { geometry, spatial };
}

/* ------------------------------------------------- CREATIVE §6.3 burn-in */

/**
 * libass renders an ASS script in the script's OWN coordinate space and scales
 * that space onto the frame. ffmpeg's SubRip decoder synthesises a default ASS
 * header, and that header's `PlayResY` is 288 — so a `FontSize` here is 288ths
 * of the frame height whatever the output resolution is, and a style built from
 * `sizePct` needs no output height at all to be resolution-independent.
 *
 * That is the claim this constant rests on, and it was checked rather than
 * assumed: the same style burned at 1080 and at 540 produced a caption whose
 * height was the same FRACTION of the frame in both, which is only true if the
 * scale is PlayRes-relative. A build whose SubRip header carried a different
 * PlayResY would need this number changed and nothing else.
 */
const ASS_PLAY_RES_Y = 288;


/**
 * ASS `FontSize` is an EM size; `SubtitleStyle.sizePct` is a CAP HEIGHT, for the
 * reason `TitleSpec.sizePct` is (titleRaster.ts): em size varies by typeface for
 * the same visual size, and cap height is what the eye reads. So the two are not
 * the same number and the conversion is the ratio between them.
 *
 * 0.643 is MEASURED, on this build, against the font libass resolves for a
 * SubRip stream with no `Fontname`: a capital H rendered 77 px tall at an em of
 * 120, 155 at 240 and 241 at 375 — 0.642, 0.646, 0.643. Assuming the usual 0.72
 * would have made every burn-in 12% smaller than the number asked for.
 */
const ASS_CAP_RATIO = 0.643;

/** '#rrggbb' → ASS's '&H00BBGGRR&'. ASS is little-endian BGR, not RGB. */
function assColour(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? '').trim());
  const v = m ? parseInt(m[1], 16) : 0xffffff;
  const hx = (n: number): string => (n & 255).toString(16).toUpperCase().padStart(2, '0');
  return `&H00${hx(v)}${hx(v >> 8)}${hx(v >> 16)}&`;
}

/**
 * `force_style` from `SubtitleStyle`, in the PlayRes space above.
 *
 * `Alignment=2` is bottom-centre and `MarginV` is measured up from the bottom,
 * which is what `marginPct` means. `outline` is documented as px AT 1080, so it
 * is converted into the same space rather than passed through — an outline that
 * did not scale would be four times as heavy at 4K.
 */
function subtitleForceStyle(style: SubtitleStyle): string {
  const num = (n: number, lo: number, hi: number, fallback: number): number =>
    !(n >= lo) ? (Number.isFinite(n) ? lo : fallback) : n > hi ? hi : n;

  const size = Math.max(
    1,
    Math.round((num(style.sizePct, 0.02, 0.2, 0.055) * ASS_PLAY_RES_Y) / ASS_CAP_RATIO),
  );
  const margin = Math.max(0, Math.round(num(style.marginPct, 0, 0.4, 0.08) * ASS_PLAY_RES_Y));
  const outline = Math.round(num(style.outline, 0, 4, 2) * (ASS_PLAY_RES_Y / 1080) * 10) / 10;

  return [
    `FontSize=${size}`,
    `PrimaryColour=${assColour(style.color)}`,
    'OutlineColour=&H00000000&',
    'BorderStyle=1',
    `Outline=${outline}`,
    'Shadow=0',
    'Alignment=2',
    `MarginV=${margin}`,
  ].join(',');
}

/* ------------------------------------------------------------- §1.7 atempo */

/**
 * atempo's real range on this build is [0.5, 100], so only the LOW end needs
 * decomposing. Chaining atempo=2 three times for speed 8 would be three lossy
 * resamples where one is legal.
 *
 * The `out.length === 0` guard is load-bearing: without it a speed-1 clip emits
 * an empty slot and the chain gets a double comma.
 */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let f = speed;
  while (f < 0.5) {
    out.push('atempo=0.500');
    f /= 0.5;
  }
  if (Math.abs(f - 1) > 1e-6 || out.length === 0) out.push(`atempo=${fac(f)}`);
  return out;
}

/* ------------------------------------------------------------------ result */

export interface BuiltGraph {
  /** argv after the binary name, in order: inputs, -filter_complex_script, maps, encoder, output. */
  args: string[];
  /** The filter script contents. The caller writes it to `scriptPath` UTF-8, no BOM (§1.1). */
  filterScript: string;
  framesTotal: number;
  durationSeconds: number;
  /**
   * Absolute paths every input in `args` references, in input order. The caller
   * access()-checks exactly these, pre-flight (§2.3). NOT `document.sources`: a source
   * used only by a clip outside the range, or on a track that is both hidden and muted,
   * never reaches the graph and must not fail the export.
   */
  sourcePaths: string[];
  /**
   * Things the build had to change to be buildable, in the order it found them.
   * CREATIVE §4.3: a dissolve with no source handle left degrades to a `fade`
   * and the export CONTINUES — a transition that cannot be honoured is not a
   * reason to refuse an export — but it must not do so silently.
   *
   * Empty on every ordinary build, so a caller can test it rather than parse it.
   */
  notices: string[];
}

export type BuildResult = { ok: true; graph: BuiltGraph } | { ok: false; error: ExportError };

/* ---------------------------------------------------------------- the build */

/** One clip that survived range intersection and the §1.9 track flags. */
interface Contributor {
  clip: Clip;
  /** null for a TITLE clip, which resolves no media at all (CREATIVE §5.1). */
  source: ExportSource | null;
  /**
   * What `-i` names: the source file, or — for a title — the PNG the RENDERER
   * rasterised and main decoded beside the filter script. A title is fed as
   * `-loop 1 -framerate <OF> -t <dur>` instead of `-ss/-t`, and after that one
   * difference it is an ordinary input: scale, opacity, grade, effects,
   * placement and transitions all apply with no branch anywhere below.
   */
  inputPath: string;
  isTitle: boolean;
  /** Assigned by the two-pass walk in §1.4. */
  input: number;
  contributesVideo: boolean;
  contributesAudio: boolean;
  /** Input-level -ss / -t, on the PROJECT rate: a source offset is a TIME, not a grid position. */
  ssSec: number;
  tSec: number;
  /**
   * `tSec` BEFORE a dissolve tail extension (CREATIVE §4.3, §4.3a). The
   * extension buys `frames` more PICTURE to dissolve out of; it must not buy
   * `frames` more SOUND, which is audio the edit does not contain. When the two
   * differ the audio chain trims itself back to this with an `atrim`.
   */
  audioTrimSec: number;
  /**
   * §4.3a — the audio fade-in, which is NOT the video one.
   *
   * A cross dissolve is a PICTURE event: the sound at one is a hard cut, the
   * same cut every ordinary edit point makes. So a `dissolve` ramps `[i:v]` and
   * leaves `[i:a]` alone, while a `fade` ramps both. Deriving this from
   * `transitionIn.frames` without consulting `transitionIn.kind` is exactly the
   * bug that puts a one-sided ramp on a dissolve — the incoming clip climbing out
   * of silence with nothing fading down to meet it.
   *
   * A `transitionOut` needs no such split: its `kind` is always `fade`.
   */
  audioFadeInSec: number;
  /** CREATIVE §1.3 — the PRODUCT of clip and track gain. `muted` is already 0. */
  gain: number;
  /** CREATIVE §4.2, in the clip's own LOCAL time base — see the chain below. */
  fadeInSec: number;
  fadeOutAtSec: number;
  fadeOutSec: number;
  /** Placement, always on the OUTPUT grid. */
  startSec: number;
  startMs: number;
  enableFrom: number;
  enableTo: number;
  /** Target box: where ClipProperties.scale is honoured. */
  tw: number;
  th: number;
  /** Overlay offset, converted from PROJECT-resolution px onto the OUTPUT grid. */
  px: number;
  py: number;
}

/**
 * Everything main had to put on disk before the graph could name it. This module
 * joins no paths and writes no files (see the header): the caller decides where
 * the temp directory is, and hands back what it wrote.
 */
export interface BuildPaths {
  scriptPath: string;
  outputPath: string;
  /**
   * CREATIVE §5.2 — clip id → the ABSOLUTE path of the PNG main decoded from
   * `ExportDocument.titles`. A title clip whose id is absent here contributes
   * nothing: a missing raster is a reason to lose one title, never to lose the
   * export.
   */
  titlePngs?: Record<string, string>;
  /**
   * CREATIVE §6.3 — the RELATIVE name of the SubRip file main wrote into the
   * SAME directory as `scriptPath`, or absent when there is nothing to burn.
   *
   * Relative, and that is the entire reason main spawns ffmpeg with `cwd` set to
   * that directory: an absolute Windows path inside a filter script has to be
   * written `C\:/Users/…`, and this machine's paths contain spaces and a
   * drive letter — precisely the shape that breaks. A bare name has nothing to
   * escape.
   */
  subtitlesFile?: string;
}

export function buildExportGraph(req: ExportRequest, paths: BuildPaths): BuildResult {
  const doc: ExportDocument | undefined = req.document;
  if (!doc) return { ok: false, error: ERR['empty-timeline'] };

  const audioOnly = isAudioOnlyCodec(req.codec);

  const F = doc.fps; // PROJECT rate. The unit every frame field in the DOCUMENT is in.
  // OUTPUT rate. What the base, every clip chain and the encoder RUN at — except
  // that an audio-only export has NO output frame grid, and `req.fps` is a
  // retained value from whenever the user last picked a video format. Leaving
  // OF = req.fps there would quantise `adelay` onto a grid that no longer
  // exists: a clip at project frame 7 of a 30 fps project, with a retained 24,
  // lands 17 ms early. This is amendment A2 to EXPORT §1.3.
  const OF = audioOnly ? F : req.fps;
  if (!(F > 0) || !(OF > 0)) return { ok: false, error: ERR['empty-timeline'] };

  const startFrame = req.startFrame;
  const durationFrames = req.durationFrames;
  if (!(durationFrames >= 1)) return { ok: false, error: ERR['empty-timeline'] };

  const rangeEnd = startFrame + durationFrames;
  const durationSeconds = durationFrames / F; // base d=, output -t, §2 denominator
  // 0 is the honest answer to "how many OUTPUT frames" for a file that has none,
  // and it is what `ExportProgressEvent.framesTotal` documents itself as. It has
  // to be made rather than assumed: `runJob` assigns this over its own
  // pre-flight estimate, so without it the dialog is back to a fabricated count.
  const framesTotal = audioOnly ? 0 : Math.max(1, Math.round(durationSeconds * OF));

  const toOut = (projectFrame: number): number => Math.round((projectFrame / F) * OF);

  // Placement is in PROJECT-resolution px (model.ts, ClipProperties.positionX), but the
  // overlay runs on the OUTPUT grid. When the two differ the offset must be rescaled, or
  // a clip the user reframed in the preview lands somewhere else in the file. Both
  // ratios are computed rather than one shared factor: the dialog locks the export
  // aspect to the project aspect (FORMAT §6.3), but force_divisible_by rounding can
  // still leave them a fraction of a percent apart, and two exact ratios are free.
  const rx = doc.width > 0 ? req.width / doc.width : 1;
  const ry = doc.height > 0 ? req.height / doc.height : 1;

  const sourceById = new Map<string, ExportSource>();
  for (const s of doc.sources) sourceById.set(s.mediaId, s);

  const clipsByTrack = new Map<string, Clip[]>();
  for (const c of doc.clips) {
    const list = clipsByTrack.get(c.trackId);
    if (list) list.push(c);
    else clipsByTrack.set(c.trackId, [c]);
  }
  for (const list of clipsByTrack.values()) list.sort((a, b) => a.start - b.start);

  const notices: string[] = [];
  const titlePngs = paths.titlePngs ?? {};


  /* ------------------------------------------- CREATIVE §4.3 dissolve tails
     A cross-dissolve is TWO edits to the graph this builder already emits, and
     it is resolved here — before the collect loop — because one of the two edits
     lands on a DIFFERENT clip from the one that authored it.

     Same-track clips are emitted in ascending `start` order and each overlays
     the previous composite (EXPORT §1.6), so the incoming clip is ALREADY on top
     of the outgoing one. That is why there is no `xfade` anywhere below:

       1. extend the OUTGOING clip's tail by N frames — more source through its
          input `-t`, a longer `enable` window — so it is still on screen;
       2. alpha-ramp the INCOMING clip in over the same N frames.

     N is clamped by `dissolveFrames` from src/lib/color.ts — NOT by arithmetic
     written here. That function is in the module both bundles compile precisely
     because the preview's dissolve underlay clamps the same number to decide how
     long to keep the outgoing clip on screen: two implementations would be two
     answers to "how long is this dissolve", and the user would see the
     disagreement as a preview whose ramp outruns the file's. It clamps at BUILD
     time and never writes back, so trimming the outgoing clip longer later
     restores the transition the user asked for; it returns 0 when there is no
     handle at all, which is the signal to degrade to a plain `fade` and keep
     going — see `notices`. */

  /**
   * How much source the outgoing clip's media has, for `dissolveFrames`.
   *
   * There is deliberately NO title branch here. `dissolveFrames` reads
   * `outgoing.kind` and treats a title as unlimited itself — a title is a still
   * fed through `-loop 1` and has no out point to run past — so a branch here
   * would be a second copy of that rule, free to drift from the one the preview
   * also calls. A title carries `mediaId: ''`, misses the map, and lands on the
   * same 0 a genuinely missing source does; `kind` is what separates them, and
   * it is checked in the one place that owns the question.
   */
  const sourceDurationOf = (c: Clip): number =>
    sourceById.get(c.mediaId)?.durationFrames ?? 0;

  /** Outgoing clip id → clamped tail extension, in TIMELINE frames. */
  const tailExtension = new Map<string, number>();
  /** Incoming clip id → the clamped ramp that matches that extension. */
  const dissolveRamp = new Map<string, number>();

  for (const list of clipsByTrack.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const incoming = list[i];
      const t = incoming.transitionIn;
      if (!t || t.kind !== 'dissolve' || !(t.frames >= 1)) continue;

      const outgoing = list[i - 1];
      // A dissolve is with the clip IMMEDIATELY before it. Across a gap there is
      // nothing to dissolve out of, so it is a fade from black, which is what a
      // ramp with no extension already is.
      if (outgoing.start + outgoing.duration !== incoming.start) continue;

      /* §4.3d — dissolving OUT OF A TITLE is refused here, and the refusal is
         deliberate rather than a limitation of this builder.

         It works. Extending a title's tail is the one case with an unlimited
         handle, so two title cards cross-dissolve correctly and silently — and
         that is the problem, because the PREVIEW cannot show it. Its
         `DissolveUnderlay` is a single element at the bottom of the stage, in the
         picture plane; a title's underlay drawn there would sit beneath the
         footage rather than above it, so the preview shows the incoming title
         fading up over black while the file cross-fades two cards. Credits and
         lower-third sequences are made of exactly that, so it is not a corner.

         Shipping the better picture is still the wrong answer: the plan's rule is
         that preview and export are computed from one shared truth, and §4.3a
         already deleted a working, measured audio cross-fade for the same reason.
         Ruling the other way here would make that decision arbitrary in hindsight.

         THE LIFT IS ONE LINE. When preview grows a per-title underlay living
         INSIDE the title stack rather than at the bottom of the stage, delete
         this branch. Nothing below needs redesigning for it — the tail extension
         and the ramp are indifferent to what kind of clip they act on, which is
         why this reads as a `continue` and not as a missing feature. */
      if (clipIsTitle(outgoing)) {
        // Names the CAUSE, not the mechanism. "The source ran out of frames" is
        // what the zero-handle branch below says, and it would be false here —
        // a title has no source to run out of — and would send whoever read it
        // hunting through trim points for a problem that is not there.
        notices.push(
          `${incoming.name || 'A clip'} cannot cross dissolve out of a title card, so it was exported as a fade`,
        );
        continue;
      }

      const n = dissolveFrames(t.frames, outgoing, sourceDurationOf(outgoing));
      if (n < 1) {
        notices.push(
          `${incoming.name || 'A clip'} has no source left to dissolve from, so its cross dissolve was exported as a fade`,
        );
        continue;
      }
      tailExtension.set(outgoing.id, Math.max(tailExtension.get(outgoing.id) ?? 0, n));
      dissolveRamp.set(incoming.id, n);
    }
  }

  /* -- collect, in §1.6 order: tracks as given (bottom-first), start ascending -- */

  const collected: Contributor[] = [];

  for (const track of doc.tracks) {
    for (const clip of clipsByTrack.get(track.id) ?? []) {
      // Intersection with the range. Clips outside it are not emitted at all.
      if (clip.start + clip.duration <= startFrame || clip.start >= rangeEnd) continue;

      const props = clip.properties;
      const speed = props.speed;

      const headFrames = Math.max(0, startFrame - clip.start); // trimmed off the clip's head
      const S = Math.max(0, clip.start - startFrame); // PROJECT frame within the range
      const E = Math.min(durationFrames, clip.start + clip.duration - startFrame);

      const timelineFrames = E - S; // >= 1 by the intersection test

      const nStart = toOut(S); // output frame index of the clip's first frame

      const isTitle = clipIsTitle(clip);
      // A title clip carries `mediaId: ''` and must never reach a media lookup
      // (CREATIVE §5.1). Its pixels came from the renderer, through main, as a
      // PNG; with no PNG there is nothing to draw and the clip is simply absent.
      const titlePng = isTitle ? (titlePngs[clip.id] ?? null) : null;

      // §4.3, edit 1: this clip is the OUTGOING side of a dissolve, so its tail
      // holds `extend` frames longer. Clamped to the range end, because a window
      // that runs past the base draws nothing anyway and an unclamped number is
      // one more thing that can be wrong.
      const extend = Math.max(
        0,
        Math.min(tailExtension.get(clip.id) ?? 0, durationFrames - E),
      );
      const nEnd = toOut(E + extend); // output frame index one past its last

      // Forcing the video predicate false empties the two chain loops — it is
      // necessary and NOT sufficient; four constructs sit outside them and each
      // gets its own branch below.
      const wantsVideo =
        !audioOnly &&
        track.kind === 'video' &&
        track.visible &&
        props.opacity > 0 &&
        nEnd > nStart &&
        clipHasVideo(clip) &&
        (!isTitle || titlePng !== null);
      // `streams` is a property of the EDIT, like `volume` and `muted`, so it
      // belongs here and not in `contributesAudio`, where `hasAudio` — a
      // property of the FILE — stays on its own. `trackVolume` joins them for the
      // same reason `muted` is already here (CREATIVE §1.3): a track faded to
      // silence must contribute no input at all, not a silent one.
      const wantsAudio =
        !track.muted &&
        props.volume > 0 &&
        trackVolume(track) > 0 &&
        clipHasAudio(clip) &&
        // A title has no media and therefore no stream to be audible.
        !isTitle;
      if (!wantsVideo && !wantsAudio) continue; // no input, no chain, no overlay

      const source = isTitle ? null : (sourceById.get(clip.mediaId) ?? null);
      if (!isTitle && source === null) return { ok: false, error: ERR['source-missing'] };

      const contributesVideo = wantsVideo;
      const contributesAudio = source !== null && source.hasAudio && wantsAudio;
      if (!contributesVideo && !contributesAudio) continue;

      const sourceInFrames = clip.mediaIn + Math.round(headFrames * speed);
      // max(1, …) guards the degenerate `-t 0.000000` a 1-frame clip at speed 0.1
      // would otherwise produce; on every case EXPORT §1.3 actually names, the
      // round() is already >= 1 and this clamp is invisible.
      const sourceLenFrames = Math.max(1, Math.round(timelineFrames * speed));
      // The extension is a PICTURE event, so it only exists when there is a
      // picture. `* speed` is what makes it `extend` more TIMELINE frames rather
      // than `extend` more source ones.
      const extendedLenFrames = contributesVideo
        ? Math.max(1, Math.round((timelineFrames + extend) * speed))
        : sourceLenFrames;

      /* §4.2 — the ramps, in the clip's LOCAL time base.

         Local time is what the chain sees between `setpts=(PTS-STARTPTS)/speed`
         (which zeroes the trimmed segment and divides by speed) and the
         placement `setpts=PTS+startSec/TB`. It runs 0 … (clip.duration −
         headFrames)/F, i.e. real timeline seconds with the clip's start at zero,
         at BOTH rates — the speed division is exactly what cancels `-t`'s
         speed multiplication. The audio chain's local base is the same after
         `asetpts` + `atempo`, which is why one pair of numbers serves both.

         `headFrames` is the range eating into the clip's head. A fade the range
         starts halfway through cannot be expressed by `fade`, which has no
         "start already partly open" — so what is left of it finishes at the
         right moment from a hard zero. That is a range-boundary approximation
         and it is the only one in this file. */
      const localFrames = clip.duration - headFrames;
      const tIn = clip.transitionIn;
      const isDissolveIn = tIn !== undefined && tIn.kind === 'dissolve';
      const rampInAuthored = tIn
        ? isDissolveIn
          ? (dissolveRamp.get(clip.id) ?? tIn.frames)
          : tIn.frames
        : 0;
      const rampIn = Math.max(0, Math.min(Math.round(rampInAuthored), clip.duration) - headFrames);

      const tOut = clip.transitionOut;
      const rampOut = tOut ? Math.min(Math.round(tOut.frames), localFrames) : 0;
      // Measured from the clip's OWN end, never the extended one: a fade-out
      // says "this clip is gone by here", and the dissolve tail behind it is
      // pixels the fade has already taken to zero.
      const fadeOutAt = Math.max(0, localFrames - rampOut);

      collected.push({
        clip,
        source,
        inputPath: isTitle ? (titlePng as string) : (source as ExportSource).path,
        isTitle,
        input: -1,
        contributesVideo,
        contributesAudio,
        ssSec: sourceInFrames / F,
        tSec: extendedLenFrames / F,
        audioTrimSec: sourceLenFrames / F,
        gain: props.volume * trackVolume(track),
        fadeInSec: rampIn >= 1 ? rampIn / F : 0,
        // §4.3a — a dissolve ramps the picture and NOT the sound.
        audioFadeInSec: rampIn >= 1 && !isDissolveIn ? rampIn / F : 0,
        fadeOutAtSec: fadeOutAt / F,
        fadeOutSec: rampOut >= 1 ? rampOut / F : 0,
        startSec: nStart / OF,
        startMs: Math.round((nStart / OF) * 1000),
        enableFrom: (nStart - 0.5) / OF, // frame CENTRES, not edges — §1.6
        enableTo: (nEnd - 0.5) / OF,
        // tw/th need no ratio: they are already computed from req.width/req.height,
        // so they are already in output space, and the containment fit is
        // scale-invariant. Only the additive offset was wrong.
        tw: Math.max(2, Math.round(req.width * props.scale)),
        th: Math.max(2, Math.round(req.height * props.scale)),
        px: props.positionX * rx,
        py: props.positionY * ry,
      });
    }
  }

  // For an audio-only export an empty contributor set is a SILENT FILE, not an
  // error. The `durationFrames >= 1` check above already caught the genuinely
  // empty request; what is left here is a range that contains picture and no
  // sound — every track muted, every volume 0 — which is an ordinary edit.
  if (collected.length === 0 && !audioOnly) return { ok: false, error: ERR['empty-timeline'] };

  /* -- §1.4 input assignment: two passes, and the order is normative --------- */

  const inputs: Contributor[] = [];
  for (const c of collected) {
    if (!c.contributesVideo) continue;
    c.input = inputs.length;
    inputs.push(c);
  }
  for (const c of collected) {
    if (c.contributesVideo) continue;
    c.input = inputs.length;
    inputs.push(c);
  }

  /* ---------------------------------------------------------- §1.2 the graph */

  // No cast. `isAudioOnlyCodec` is a type predicate, so its false arm gives
  // `req.codec` the type `VideoCodec` and the index is total. It is called
  // directly rather than through the `audioOnly` alias because aliased
  // narrowing of a dotted name does not reach here — and the fix for that is to
  // restore the narrowing, never to add `as VideoCodec`, which would put back
  // exactly the runtime hole the narrowed CODEC_SHAPE is closing.
  const shape: CodecShape | null = isAudioOnlyCodec(req.codec) ? null : CODEC_SHAPE[req.codec];
  const lines: string[] = [];

  // The whole video half. `[vbase]` and the terminal `[vout]` sit OUTSIDE the
  // two loops, so an empty contributor list does not suppress them — left alone,
  // the terminal line dereferences a null shape and the throw reaches the user
  // as "the encoder could not be started" for a perfectly valid WAV request.
  if (shape !== null) {
    lines.push(
      `color=c=black:s=${req.width}x${req.height}:r=${rate(OF)}:d=${sec(durationSeconds)},` +
        `format=${shape.basePixFmt}[vbase]`,
    );
  }
  lines.push(
    `anullsrc=channel_layout=stereo:sample_rate=48000,` +
      `atrim=duration=${sec(durationSeconds)},asetpts=N/SR/TB[abase]`,
  );

  if (shape !== null) {
    // §1.5 — per-clip video chains, in input order.
    const videoContributors = inputs.filter((c) => c.contributesVideo);
    for (const c of videoContributors) {
      const p = c.clip.properties;

      // CREATIVE §2, §3 — nothing at all when the clip is ungraded and has no
      // effect, which is what keeps EXPORT §1.8's three transcripts exact.
      const gp = withGradeDefaults(p);
      const fx = effectFilters(gp, rx);
      const tone = toneFilter(gp);
      const mixer = mixerFilter(gp, p.opacity);
      // §2.4, §3.1 — a clip with ANY look works in planar RGB with alpha and
      // converts back once, at the end of the block. A clip with none never
      // leaves the format EXPORT §1.5 specifies, which is what keeps §1.8
      // byte-exact.
      //
      // EFFECTS ARE IN THIS CONDITION, not just the grade, and that was measured
      // rather than assumed. `gblur` is an IIR run six times (§3.1) and it
      // quantises on every pass, so at 8-bit `yuva420p` an authored sigma landed
      // 4.1% narrow where the same sigma in the deeper format lands 2.6% narrow.
      // Gating the depth on the grade alone would have meant the SAME blur
      // measuring two different widths depending on whether the clip happened to
      // be graded as well — a coupling nobody would think to look for.
      const graded = !gradeMath(gp).neutral || !effectsNeutral(gp);
      const workFmt = graded ? shape.gradePixFmt : shape.clipPixFmt;
      const look = [
        ...fx.geometry,
        ...(tone === null ? [] : [tone]),
        ...fx.spatial,
      ];

      /* §4.2 — an ALPHA ramp, never a luminance one. `fade` without `alpha=1`
         fades towards BLACK, and this clip is one layer of an overlay stack: a
         luminance fade would punch a black hole through whatever is beneath it
         instead of revealing it. `st=` is in the LOCAL base described in the
         collect loop — post-`setpts=…/speed`, pre-placement.

         ONE HALF-FRAME of divergence from the preview is known and accepted.
         `transitionGain` samples the frame CENTRE — `(elapsed + 0.5)/frames` —
         so a 12-frame ramp opens at 1/24 on its first frame. `fade` evaluates at
         the frame's own PTS, which is its leading edge, so the export's first
         frame is 0. There is no way to say "start half open" to `fade`: `st` may
         not be negative, and shortening `d` moves the whole ramp rather than
         offsetting it. Half a frame at each end of a ramp is under one frame in
         a transition whose shortest legal length is one, and paying for it with
         a hand-rolled `geq` alpha expression would cost far more than it buys. */
      const ramps: string[] = [];
      if (c.fadeInSec > 0) {
        ramps.push(`fade=t=in:st=${sec(0)}:d=${sec(c.fadeInSec)}:alpha=1`);
      }
      if (c.fadeOutSec > 0) {
        ramps.push(`fade=t=out:st=${sec(c.fadeOutAtSec)}:d=${sec(c.fadeOutSec)}:alpha=1`);
      }

      lines.push(
        `[${c.input}:v]setpts=(PTS-STARTPTS)/${fac(p.speed)},` +
          `fps=fps=${rate(OF)},` +
          `scale=${c.tw}:${c.th}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,` +
          `setsar=1,` +
          `format=${workFmt},` +
          (look.length > 0 ? `${look.join(',')},` : '') +
          `${mixer},` +
          (graded ? `format=${shape.clipPixFmt},` : '') +
          (ramps.length > 0 ? `${ramps.join(',')},` : '') +
          `setpts=PTS+${sec(c.startSec)}/TB[v${c.input}]`,
      );
    }

    // §1.6 — track order is overlay order; each clip consumes the previous composite.
    let composite = 'vbase';
    videoContributors.forEach((c, i) => {
      const next = `vc${i}`;
      lines.push(
        `[${composite}][v${c.input}]overlay=` +
          `x=(W-w)/2${offset(c.px)}:y=(H-h)/2${offset(c.py)}:` +
          `eof_action=pass:shortest=0:repeatlast=0:format=${shape.overlayFmt}:` +
          `enable='gte(t,${sec(c.enableFrom)})*lt(t,${sec(c.enableTo)})'[${next}]`,
      );
      composite = next;
    });
    /* CREATIVE §6.3 — burn-in goes on the TERMINAL chain, after the last overlay
       and before the final `format`. Above every clip, so it sits over the whole
       composite; after every clip's grade, so no clip's grade touches it. The
       filename is bare and relative because main runs ffmpeg with `cwd` set to
       the directory it wrote both this and the filter script into (BuildPaths). */
    // Present exactly when the CALLER wrote a SubRip file for this job. This
    // module is pure — it opens nothing and writes nothing — so "is there a
    // burn-in" is the same question as "did main put a file there", and asking
    // it once, of the thing that knows, is what stops the graph naming a file
    // that does not exist.
    const subs =
      paths.subtitlesFile !== undefined && paths.subtitlesFile !== ''
        ? `subtitles=filename=${paths.subtitlesFile}:force_style='${subtitleForceStyle(doc.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE)}',`
        : '';
    lines.push(`[${composite}]${subs}format=${shape.basePixFmt}[vout]`);
  }

  // §1.7 — per-clip audio chains, keyed to the INPUT index, ascending.
  const audioLabels: string[] = [];
  for (const c of inputs) {
    if (!c.contributesAudio) continue;
    const p = c.clip.properties;
    // §4.3a — a dissolve extended this clip's input `-t` to buy PICTURE to
    // dissolve out of. Sound is not part of that bargain: a cross dissolve is a
    // picture event, and the sound at one is a hard cut, the same cut every
    // ordinary edit point makes. Without this trim the outgoing clip would play
    // N frames of audio the edit does not contain, over the top of the incoming
    // clip's. `atrim` runs on the zero-based, pre-`atempo` segment, so its bound
    // is the ORIGINAL `-t` in source seconds.
    const trim = c.tSec > c.audioTrimSec ? `atrim=end=${sec(c.audioTrimSec)},asetpts=N/SR/TB,` : '';
    // §4.2 — the ramps a `fade` gets, in the same local base as the picture's
    // (post-`atempo`, so `atempo`'s compression has already cancelled the speed
    // multiplication in `-t`). `curve=tri` is linear, which is what an alpha
    // ramp is. `audioFadeInSec` — not `fadeInSec` — is what makes a dissolve
    // ramp the picture alone.
    const ramps: string[] = [];
    if (c.audioFadeInSec > 0) {
      ramps.push(`afade=t=in:st=${sec(0)}:d=${sec(c.audioFadeInSec)}:curve=tri`);
    }
    if (c.fadeOutSec > 0) {
      ramps.push(`afade=t=out:st=${sec(c.fadeOutAtSec)}:d=${sec(c.fadeOutSec)}:curve=tri`);
    }
    lines.push(
      `[${c.input}:a]asetpts=PTS-STARTPTS,` +
        trim +
        `${atempoChain(p.speed).join(',')},` +
        (ramps.length > 0 ? `${ramps.join(',')},` : '') +
        `volume=${fac(c.gain)},` +
        `aresample=48000:async=1:first_pts=0,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `adelay=delays=${c.startMs}:all=1[a${c.input}]`,
    );
    audioLabels.push(`[a${c.input}]`);
  }

  lines.push(
    `[abase]${audioLabels.join('')}amix=inputs=${1 + audioLabels.length}:` +
      `duration=first:dropout_transition=0:normalize=0[aout]`,
  );

  const filterScript = lines.join(';\n');

  /* ----------------------------------------------------------------- §1.4 argv */

  const args: string[] = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  const sourcePaths: string[] = [];
  for (const c of inputs) {
    if (c.isTitle) {
      // CREATIVE §5.2 — a still, looped for exactly as long as the clip needs.
      // `-framerate` is the rate the loop PRODUCES at, so it is the output rate
      // like everything else on the emitting side; `-t` is the same
      // speed-multiplied length a media clip gets, because the chain's
      // `setpts=…/speed` divides it back out either way and a title must not
      // change length when its clip's speed does.
      args.push('-loop', '1', '-framerate', rate(OF), '-t', sec(c.tSec), '-i', c.inputPath);
    } else {
      args.push('-ss', sec(c.ssSec), '-t', sec(c.tSec), '-i', c.inputPath);
    }
    sourcePaths.push(c.inputPath);
  }

  args.push('-filter_complex_script', paths.scriptPath);
  // `-vn` is redundant beside a lone `-map [aout]` and is passed anyway, for the
  // same reason the trailing output `-t` is passed even though the base's `d=`
  // already fixes the length (EXPORT §1.8): it is a hard statement of intent
  // that bounds the output even if a future `-map` edit is wrong, and a
  // wrong-shaped file is the failure that would not announce itself.
  if (audioOnly) args.push('-vn', '-map', '[aout]');
  else args.push('-map', '[vout]', '-map', '[aout]');

  /* ------------------------------------------------------------ §1.10 encoder */

  if (audioOnly) {
    // An explicit arm, because the chain below used to end in ProRes's `else`
    // and a widened union would otherwise send wav straight into `-c:v
    // prores_ks` and a null `shape`.
    if (req.codec === 'wav') {
      args.push('-c:a', WAV_PCM[req.quality], '-ar', '48000', '-ac', '2');
      args.push('-t', sec(durationSeconds), '-f', 'wav');
    } else if (req.codec === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', AUDIO_BITRATE.mp3[req.quality]);
      args.push('-ar', '48000', '-ac', '2');
      args.push('-t', sec(durationSeconds), '-f', 'mp3');
    } else {
      // .m4a IS the mp4 container, so a front-loaded moov is free and kept.
      args.push('-c:a', 'aac', '-b:a', AUDIO_BITRATE.aac[req.quality]);
      args.push('-ar', '48000', '-ac', '2');
      args.push('-t', sec(durationSeconds), '-movflags', '+faststart', '-f', 'mp4');
    }
  } else if (shape !== null) {
    if (req.codec === 'h264') {
      const q = X264[req.quality];
      args.push('-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf);
      args.push('-pix_fmt', shape.basePixFmt, '-r', rate(OF));
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
      args.push('-t', sec(durationSeconds), '-movflags', '+faststart', '-f', 'mp4');
    } else if (req.codec === 'h265') {
      const q = X265[req.quality];
      args.push('-c:v', 'libx265', '-preset', q.preset, '-crf', q.crf, '-tag:v', 'hvc1');
      args.push('-pix_fmt', shape.basePixFmt, '-r', rate(OF));
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
      args.push('-t', sec(durationSeconds), '-movflags', '+faststart', '-f', 'mp4');
    } else {
      args.push('-c:v', 'prores_ks', '-profile:v', PRORES_PROFILE[req.quality], '-vendor', 'apl0');
      args.push('-pix_fmt', shape.basePixFmt, '-r', rate(OF));
      args.push('-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2');
      args.push('-t', sec(durationSeconds), '-f', 'mov');
    }
  }

  // §2.1 — stdout carries progress blocks and nothing else, so the parser owns
  // the stream; -nostats keeps stderr for errors only, which §4 depends on.
  args.push('-progress', 'pipe:1', '-stats_period', '0.25', '-nostats');
  args.push(paths.outputPath);

  return {
    ok: true,
    graph: { args, filterScript, framesTotal, durationSeconds, sourcePaths, notices },
  };
}
