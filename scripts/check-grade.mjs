#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-grade.mjs — the gate on src/lib/color.ts. CREATIVE.md §2, §4, §7.

   Run:  node scripts/check-grade.mjs

   Why this exists: `gradeMath` exists ONLY to stop the preview and the export
   disagreeing, and a disagreement between them is the one bug this project
   cannot catch by looking. Both sides type-check. Both sides render something
   plausible. The difference shows up as "the exported file looks a bit
   different from the preview", which a user reports as a vague complaint
   months later, if at all.

   THE ASSERTION IS THE MEASUREMENT — CREATIVE §7.1, and this gate is the reason
   that section exists.

   This file used to assert `slope`/`intercept` against a longhand
   reimplementation of ffmpeg's `eq`, written out by the same hand that wrote
   `gradeMath`. Both sides shared a false premise — `eq` works on limited-range
   YUV — so the gate was green for a whole build while the preview and the file
   disagreed by 7-9/255. §2.4 records the diagnosis and takes `eq` out of the
   project entirely; §7's row for this gate was not amended with it, so the stale
   instruction sat here and the stale summary line announced "63 eq identity
   samples" on every pass.

   The obvious repair — assert against the emitted `lutrgb` expression instead —
   is better and still not enough, and §7.1 says why: comparing `gradeMath`'s
   numbers against an expression this project ALSO generates is two of our own
   outputs agreeing. It cannot see a `lutrgb` semantics change, a `gbrap` depth
   regression, or a pixel-format conversion quietly reintroducing the range
   expansion — which is the entire class §2.4 exists to close, and precisely what
   §10.1 says only a real binary finds.

   So: this gate BUILDS A REAL GRAPH through the real builder, lifts the grade
   block the builder ACTUALLY EMITTED out of that graph verbatim, runs the PINNED
   BUNDLED BINARY on synthetic known pixels through it, and asserts the bytes
   that come back match what `gradeMath` and `gradeMatrix` predict the PREVIEW
   will show — within ±1/255, the tolerance §2.4 states and the 8-bit
   quantisation floor no arrangement of filters beats. Brightness, contrast,
   saturation, temperature, and all four together, which is the row that first
   exceeded the bar and forced the `gbrap10le`/`gbrap12le` depth choice.

   Reading the emitted expression is still done — printed as the DIAGNOSTIC that
   explains why a row failed. It is not what passes.

   WHERE IT MEASURES, because getting this wrong sends you chasing a ghost. The
   readback is taken at the END OF THE GRADE BLOCK, before the chain converts
   back to `clipPixFmt`. That is the surface §2.4 makes its claim about. Read
   back through the trailing `format=yuva420p` instead and every row is out by up
   to 2.8/255 — limited-range YUV quantisation that every clip pays graded or
   not, which the identity control below demonstrates by measuring zero.

   NO SKIP PATH. An absent binary is a FAILURE naming `stage-ffmpeg`, not a skip.
   A gate that cannot run is not a gate that passed, and "skipped because
   unavailable" is how a suite rots into decoration.

   It also gates `transitionGain`, which is the single function picture AND
   sound both multiply by. A fade that ramps the video over 12 frames and the
   audio over 13 is inaudible in a screenshot and obvious in the file.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 've-grade-'));
/* CREATIVE §7.4 entry 8 — the bundle survives a FAILURE. Deleted on a pass; on a
   failure it is kept and its path printed, so what was actually compiled can be
   read rather than guessed at. An unreproducible `check-linking` failure was
   once diagnosed as a torn mid-save read and relayed onward as such; there was
   no torn file — another agent had bound `V` to two rows and the gate caught the
   mutation in flight. Naming a mechanism is not evidence. This is what makes it
   checkable in one look. */
let keepBundle = false;
process.on('exit', () => {
  if (keepBundle) return;
  rmSync(dir, { recursive: true, force: true });
});

async function bundle(relative, name) {
  const outfile = join(dir, `${name}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL(relative, import.meta.url))],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

const mod = await bundle('../src/lib/color.ts', 'color');
const graphMod = await bundle('../electron/export/graph.ts', 'graph');

const { gradeMath, gradeMatrix, effectsNeutral, transitionGain } = mod;
const { buildExportGraph } = graphMod;
for (const [name, fn] of Object.entries({ gradeMath, gradeMatrix, effectsNeutral, transitionGain })) {
  if (typeof fn !== 'function') {
    console.error(`grade: src/lib/color.ts must export ${name}`);
    process.exit(2);
  }
}
if (typeof buildExportGraph !== 'function') {
  console.error('grade: buildExportGraph is not exported from electron/export/graph.ts');
  process.exit(2);
}

const failures = [];
const fail = (msg) => failures.push(msg);
const check = (name, ok, detail = '') => {
  if (!ok) fail(detail === '' ? name : `${name}\n    ${detail}`);
};
const near = (label, actual, expected, tol = 1e-9) => {
  if (!(Math.abs(actual - expected) <= tol)) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
};

/** DEFAULT_CLIP_PROPERTIES, restated so this gate does not import the model and
 *  therefore cannot be made to pass by editing the defaults. */
const NEUTRAL = {
  scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1, speed: 1, volume: 1,
  brightness: 0, contrast: 1, saturation: 1, temperature: 0,
  blur: 0, sharpen: 0, vignette: 0, flipH: false, flipV: false,
};
const P = (patch) => ({ ...NEUTRAL, ...patch });

/* ============================================================================
   1. THE MEASUREMENT — CREATIVE §7.1.

   The pinned binary, the emitted chain, known pixels, ±1/255.
============================================================================ */

/* ------------------------------------------------------- 1.0 the binary

   `build/ffmpeg/` is what `stage-ffmpeg.mjs` populates and what electron-builder
   ships. Nothing else is acceptable: PATH's ffmpeg is whatever this machine
   happens to have, and a gate that measures a DIFFERENT binary from the one the
   user gets is measuring the wrong thing quietly — which is the failure mode
   this whole section is a response to. */

const FFMPEG = fileURLToPath(
  new URL(`../build/ffmpeg/ffmpeg${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url),
);

if (!existsSync(FFMPEG)) {
  console.error('\ngrade: the pinned ffmpeg is not staged, so this gate cannot run.\n');
  console.error(`  expected: ${FFMPEG}\n`);
  console.error('CREATIVE §7.1: the assertion IS the measurement. This gate compares `gradeMath`');
  console.error("against bytes the real encoder produced; with no encoder there is nothing to");
  console.error('compare against, and a gate that cannot run is NOT a gate that passed —');
  console.error('"skipped because unavailable" is how a suite rots into decoration.\n');
  console.error('  npm run stage:ffmpeg\n');
  process.exit(1);
}

/* ------------------------------------------- 1.1 lifting the chain the builder emitted

   Not a chain this file spells. The builder is run for real and the grade block
   is cut out of its output between the two `format=` conversions that bracket
   it — §2.4's "one `format` in, one `format` back out". Neither pixel format is
   named here: they are read off the emitted line, so a depth regression changes
   what gets measured rather than being invisible to it. */

const GRADE_CLIP_PROPS = {
  scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1, speed: 1, volume: 1,
  brightness: 0, contrast: 1, saturation: 1, temperature: 0,
  blur: 0, sharpen: 0, vignette: 0, flipH: false, flipV: false,
};

/** Splits a filter chain on commas that are NOT inside `'…'` — `lutrgb`'s
 *  `clip(val*…,minval,maxval)` carries commas of its own. */
function splitFilters(chain) {
  const out = [];
  let term = '';
  let quoted = false;
  for (const ch of chain) {
    if (ch === "'") quoted = !quoted;
    if (ch === ',' && !quoted) {
      out.push(term);
      term = '';
    } else term += ch;
  }
  if (term !== '') out.push(term);
  return out;
}

/**
 * Builds a real one-clip export for `patch` and returns the grade block exactly
 * as the builder wrote it, plus the two formats bracketing it.
 */
function emittedGradeBlock(patch, codec = 'h264') {
  const document = {
    fps: 30,
    width: 64,
    height: 64,
    tracks: [
      { id: 't1', kind: 'video', index: 1, label: 'V1', height: 56, muted: false, locked: false, visible: true },
    ],
    clips: [
      {
        id: 'c1', mediaId: 'm1', trackId: 't1', start: 0, duration: 30, mediaIn: 0, name: 'c1',
        properties: { ...GRADE_CLIP_PROPS, ...patch },
      },
    ],
    sources: [
      { mediaId: 'm1', path: '/media/a.mp4', kind: 'video', hasAudio: false, durationFrames: 300, width: 64, height: 64 },
    ],
    titles: [],
    subtitles: [],
    subtitleStyle: { sizePct: 0.055, color: '#ffffff', outline: 2, marginPct: 0.08 },
  };

  const r = buildExportGraph(
    {
      filename: 'out', folder: '/out', width: 64, height: 64, fps: 30,
      codec, quality: 'good', range: 'entire', burnSubtitles: false,
      startFrame: 0, durationFrames: 30, document,
    },
    { scriptPath: '/tmp/s.txt', outputPath: '/tmp/o.mp4' },
  );
  if (!r.ok) return { error: `${r.error.code}: ${r.error.message}` };

  const line = r.graph.filterScript.split(';\n').find((l) => l.startsWith('[0:v]'));
  if (line === undefined) return { error: 'the built graph carries no chain for input 0' };

  const inner = line.replace(/^\[0:v\]/, '').replace(/\[v0\]$/, '');
  const terms = splitFilters(inner);

  // The block opens at the first `format=` after the geometry and closes at the
  // `colorchannelmixer` that carries saturation, temperature and opacity.
  const start = terms.findIndex((t) => t.startsWith('format='));
  const end = terms.findIndex((t) => t.startsWith('colorchannelmixer='));
  if (start < 0 || end < 0 || end < start) {
    return { error: `no grade block in the emitted chain\n    chain: ${inner}` };
  }
  const workFmt = terms[start].slice('format='.length);
  const backFmt = terms[end + 1]?.startsWith('format=') ? terms[end + 1].slice('format='.length) : null;

  return {
    chain: terms.slice(start, end + 1).join(','),
    workFmt,
    backFmt,
    full: inner,
  };
}

/* ------------------------------------------------------------ 1.2 the probe

   Four known pixels in one frame, fed as RAWVIDEO rather than generated by
   `color=`: rawvideo is exact bytes in, so the input is not itself a
   measurement. The first is 46,95,158 — the pixel §2.4 and the graph owner both
   measured by hand, kept so this gate and those notes are comparable. The last
   two sit ON the clipping bounds, where §2.4 says a domain error shows first. */

const PROBE = [
  [46, 95, 158],
  [46, 46, 46],
  [210, 40, 20],
  [128, 128, 128],
  [200, 200, 200],
  [30, 200, 90],
  [255, 255, 255],
  [0, 0, 0],
];

/* WHY EIGHT AND WHY THESE. The first four-pixel set passed a deliberate 8-bit
   depth regression — `gradePixFmt` dropped from `gbrap10le` to `gbrap` measured
   1.00/255, exactly ON the bar rather than past it, so the gate stayed green on
   the very regression the depth choice exists to prevent. The probe was the
   weakness, not the bar: the grade is two filters and quantises twice, and where
   the second rounding compounds depends entirely on which pixel you hand it.
   Rescanned across a wide set, the near-neutral mid tones are the sensitive
   ones — 46,46,46 reads 1.33/255 at `gbrap` against 0.57 at `gbrap10le`. They
   are in the set for that reason and must not be trimmed for speed: all eight
   ride in ONE frame, so the whole set costs one ffmpeg run per row. */

const PW = PROBE.length;
const PH = 2;
const probeFile = join(dir, 'probe.rgb');
const outFile = join(dir, 'measured.rgb');

{
  const bytes = Buffer.alloc(PW * PH * 3);
  for (let y = 0; y < PH; y += 1) {
    for (let x = 0; x < PW; x += 1) {
      const at = (y * PW + x) * 3;
      bytes[at] = PROBE[x][0];
      bytes[at + 1] = PROBE[x][1];
      bytes[at + 2] = PROBE[x][2];
    }
  }
  writeFileSync(probeFile, bytes);
}

/** Runs `chain` on the probe frame and returns the four pixels that come back. */
function measure(chain) {
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${PW}x${PH}`, '-framerate', '1', '-i', probeFile,
    // `format=rgb24` is the READBACK, not part of the grade: it converts planar
    // RGB to packed RGB and nothing else. There is no YUV anywhere in this
    // pipeline, which is what makes the identity control below measure zero.
    '-filter_complex', `[0:v]${chain},format=rgb24[g]`,
    '-map', '[g]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', outFile,
  ];
  try {
    execFileSync(FFMPEG, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const said = String(error?.stderr || error?.stdout || error?.message || '').trim().split('\n')[0];
    return { error: said === '' ? 'ffmpeg produced no output and said nothing' : said };
  }
  const bytes = readFileSync(outFile);
  if (bytes.length < PW * PH * 3) {
    return { error: `ffmpeg wrote ${bytes.length} bytes, expected ${PW * PH * 3}` };
  }
  return { pixels: PROBE.map((_, x) => [bytes[x * 3], bytes[x * 3 + 1], bytes[x * 3 + 2]]) };
}

/**
 * What the PREVIEW will show, from the two shared functions and nothing else.
 * `feComponentTransfer type="linear"` is `slope`/`intercept` per channel;
 * `feColorMatrix` is `gradeMatrix`. This is the prediction the file has to meet.
 */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function predict(props, [r8, g8, b8]) {
  const g = gradeMath(props);
  const m = gradeMatrix(g.saturation, g.rGain, g.bGain);
  const tone = (v) => clamp01(g.slope * (v / 255) + g.intercept);
  const r = tone(r8);
  const gr = tone(g8);
  const b = tone(b8);
  return [
    clamp01(m.rr * r + m.rg * gr + m.rb * b) * 255,
    clamp01(m.gr * r + m.gg * gr + m.gb * b) * 255,
    clamp01(m.br * r + m.bg * gr + m.bb * b) * 255,
  ];
}

/* --------------------------------------------- 1.3 the identity control

   FIRST, because every row after it is only meaningful if this one measures
   ZERO. It proves the harness itself introduces no error: the same conversion
   in and out, no grade filters, must return the probe bytes untouched. It is
   also the demonstration §2.4's note rests on — the up-to-2.8/255 that appears
   when you read back through the trailing YUV conversion is quantisation this
   pipeline never pays, not a grade error. */

{
  const neutralBlock = emittedGradeBlock({});
  // A neutral clip emits NO grade block at all — §2.2's `neutral`, which is what
  // keeps EXPORT §1.8's transcripts byte-exact — so the control names the
  // working format itself. This is the ONE place a format is spelled here, and
  // it is spelled from the GRADED build's own emitted value.
  const graded = emittedGradeBlock({ brightness: 0.2 });
  if (graded.error) {
    fail(`1.3 control: could not build a graded chain — ${graded.error}`);
  } else {
    const r = measure(`format=${graded.workFmt}`);
    if (r.error) fail(`1.3 control: ffmpeg refused the identity chain — ${r.error}`);
    else {
      for (let i = 0; i < PROBE.length; i += 1) {
        const got = r.pixels[i].join(',');
        const want = PROBE[i].join(',');
        if (got !== want) {
          fail(
            `1.3 control: a round trip through ${graded.workFmt} with NO grade filters is not ` +
              'lossless, and exactly one of two things is true.\n' +
              `    Either the grade's working format is no longer a planar RGB one — ` +
              `${graded.workFmt} is what the builder emitted, and a YUV format there silently ` +
              'reintroduces the limited-range expansion §2.4 removed, which is a real defect and ' +
              'the one this control exists to catch.\n' +
              '    Or the harness itself moves pixels, in which case every row below is measured ' +
              'through a conversion that lies and the whole section is meaningless.\n' +
              `    probe ${want} came back ${got}`,
          );
        }
      }
    }
  }
  // And a neutral clip really does emit nothing to grade with: §2.2's fast path.
  if (!neutralBlock.error && /lutrgb|rr=/.test(neutralBlock.chain ?? '')) {
    fail(
      '1.3: an UNGRADED clip emitted grade filters. §2.2 makes `neutral` the fast path, and ' +
        `EXPORT §1.8's byte-exact transcripts depend on it.\n    ${neutralBlock.chain}`,
    );
  }
}

/* ------------------------------------------------- 1.4 the rows, measured

   ±1/255 is §2.4's stated tolerance and the 8-bit quantisation floor. It is a
   claim that can be checked, unlike the "exact" it replaces. */

const TOLERANCE = 1;

/* BOTH DEPTHS. `gradePixFmt` is two bits deeper than `clipPixFmt` on every codec
   — `gbrap10le` for h264/h265, `gbrap12le` for ProRes — and the h264 row alone
   would leave the ProRes path measured by nobody, on the codec a user reaches
   for precisely when they care about the grade surviving. */
const ROWS = [
  ['all four together, ProRes depth', { brightness: 0.12, contrast: 1.35, saturation: 1.4, temperature: 45 }, 'prores'],
  ['saturation to zero, ProRes depth', { saturation: 0 }, 'prores'],
  ['brightness up', { brightness: 0.2 }],
  ['brightness down', { brightness: -0.35 }],
  ['contrast up', { contrast: 1.6 }],
  ['contrast down', { contrast: 0.5 }],
  ['saturation to zero', { saturation: 0 }],
  ['saturation up', { saturation: 1.5 }],
  ['temperature warm', { temperature: 60 }],
  ['temperature cool', { temperature: -60 }],
  // The row that first exceeded ±1/255 and forced the gbrap10le/gbrap12le
  // choice: the grade is TWO filters, so it quantises TWICE, and at 8-bit the
  // two roundings compound past the bar.
  ['all four together', { brightness: 0.12, contrast: 1.35, saturation: 1.4, temperature: 45 }],
];

let worst = { delta: 0, where: 'nothing measured' };

for (const [label, patch, codec = 'h264'] of ROWS) {
  const block = emittedGradeBlock(patch, codec);
  if (block.error) {
    fail(`1.4 ${label}: could not lift the emitted grade block — ${block.error}`);
    continue;
  }

  const r = measure(block.chain);
  if (r.error) {
    fail(
      `1.4 ${label}: the pinned binary REFUSED the chain this project emits. The export would ` +
        `fail on the user's machine in exactly the same way.\n    ffmpeg: ${r.error}\n    ` +
        `emitted: ${block.chain}`,
    );
    continue;
  }

  for (let i = 0; i < PROBE.length; i += 1) {
    const want = predict(P(patch), PROBE[i]);
    const got = r.pixels[i];
    const deltas = got.map((v, c) => Math.abs(v - want[c]));
    const max = Math.max(...deltas);
    if (max > worst.delta) worst = { delta: max, where: `${label} @ ${PROBE[i].join(',')}` };
    if (max > TOLERANCE) {
      fail(
        `1.4 ${label}: the FILE and the PREVIEW disagree at probe ${PROBE[i].join(',')} by ` +
          `${max.toFixed(2)}/255, past the ±${TOLERANCE}/255 CREATIVE §2.4 states.\n` +
          `    gradeMath predicts  ${want.map((v) => v.toFixed(2)).join(', ')}\n` +
          `    the binary produced ${got.join(', ')}\n` +
          // The DIAGNOSTIC, which is why the emitted expression is still read: it
          // says WHY, and it is not what passed.
          `    emitted grade block: ${block.chain}\n` +
          `    working format: ${block.workFmt}, converts back to: ${block.backFmt}`,
      );
    }
  }
}

/* ============================================================================
   1.5 EVERY GRADE THE MODEL DECLARES LEGAL MUST BE ENCODABLE.

   The rows above measure ACCURACY, and accuracy is only interesting on a chain
   the binary will run. This asserts the other half: for every corner of the
   range `ClipProperties` declares and `normalizeClipProperties` clamps to —
   `saturation` 0..1.8 since §2.5, `temperature` -100..100 — the pinned binary
   must ACCEPT the chain this project emits.

   This is exactly the class §7.1 says only a real binary finds, and it is the
   section that found §2.5. A filter option whose value is out of ffmpeg's own
   range is not a rounding error and not a near miss: ffmpeg refuses the entire
   filtergraph, so the export fails outright on a setting the inspector's own
   slider reaches. Nothing upstream can see it — `gradeMatrix` returns a
   perfectly ordinary number, `coef()` formats it, the graph builds, the script
   is written, and the failure lands in the user's lap as a refused export with a
   message about a parameter they have never heard of.

   `saturation: 3` used to be a row here and was the input that found it. It is
   gone from this list because it is no longer a grade the model declares legal —
   and it has not been dropped, it has MOVED to §1.6, which now requires it to be
   unreachable rather than encodable. A narrowed range is only a fix if the
   narrowing is enforced.
============================================================================ */

{
  const CORNERS = [
    ['saturation at the top of its range', { saturation: 1.8 }],
    ['saturation just under the top', { saturation: 1.75 }],
    ['saturation at the bottom', { saturation: 0 }],
    ['temperature at both extremes, warm', { temperature: 100 }],
    ['temperature at both extremes, cool', { temperature: -100 }],
    // The two corners §2.5's derivation turns on: the temperature gain scales
    // the saturation diagonal, so the ceiling is lowest at the coolest setting.
    ['saturation and a cool temperature together', { saturation: 1.8, temperature: -100 }],
    ['saturation and a warm temperature together', { saturation: 1.8, temperature: 100 }],
    ['contrast and brightness at their corners', { contrast: 3, brightness: 1 }],
    ['contrast and brightness at their other corners', { contrast: 0, brightness: -1 }],
  ];

  for (const [label, patch] of CORNERS) {
    const block = emittedGradeBlock(patch);
    if (block.error) {
      fail(`1.5 ${label}: could not lift the emitted grade block — ${block.error}`);
      continue;
    }
    const r = measure(block.chain);
    if (r.error) {
      fail(
        `1.5 ${label}: the pinned binary REFUSES the chain this project emits for a grade the ` +
          'model declares LEGAL. `normalizeClipProperties` clamps to this range and the ' +
          'inspector slider reaches it, so this is an export that fails outright on a setting ' +
          `the user is invited to choose.\n    setting: ${JSON.stringify(patch)}\n` +
          `    ffmpeg: ${r.error}\n    emitted grade block: ${block.chain}`,
      );
    }
  }
}

/* ============================================================================
   1.6 THE ILLEGAL RANGE IS UNREACHABLE — the other half of §2.5.

   §1.5 proves the declared range is encodable. On its own that is only half a
   fix, and the weaker half: it would stay green the day somebody widens the
   declared range without widening what the binary can encode, which is EXACTLY
   how §2.5's defect arrived. `saturation` was declared 0..3, clamped to 0..3 and
   offered as 0..3 by the slider, and the top third of it refused the export.

   So this closes the loop from the other side: whatever the sanitiser lets
   through must be something the binary will run.

   NO BOUND IS WRITTEN DOWN HERE. Writing `1.8` into this gate would be a
   restatement of the clamp — gate and clamp would then agree with each other no
   matter how wrong both were, which is the §2.4 failure in miniature. The gate
   never learns what the limit IS. It pushes values far past any plausible range
   through the real `normalizeClipProperties`, takes whatever comes back, and
   requires the pinned binary to run the chain the builder emits for it. The
   sanitiser names the value; ffmpeg gives the verdict; this file supplies
   neither.

   A NOTE ON WHAT WAS TRIED FIRST, because the failure is instructive. The first
   version binary-searched the encoder's own ceiling and asserted
   `reachable <= encodable`. It found 1.8467 against §2.5's derived 1.846 — and
   it was still wrong, because every probe it sent was built through `gradeMath`,
   whose clamp bounds the search. The moment that clamp is narrowed to the legal
   range the search can no longer reach an illegal coefficient and reports "no
   ceiling found" — a gate that goes blind exactly when the code is correct. The
   ceiling was never the property. Round-tripping the sanitiser's own output
   through the binary is.
============================================================================ */

const clipProps = await bundle('../src/lib/clipProperties.ts', 'clipProperties');
const { normalizeClipProperties } = clipProps;
if (typeof normalizeClipProperties !== 'function') {
  console.error('grade: src/lib/clipProperties.ts must export normalizeClipProperties');
  process.exit(2);
}

{
  /* Unmistakably out of range, plus the shapes a hand-edited or pre-§2.5
     `.veproj` actually carries. A string and an `undefined` are in here because
     JSON from disk is not typed and `migrateProject` feeds this function raw. */
  const PUSHED = [1.85, 1.9, 2, 2.5, 3, 10, 1e6, Infinity, -Infinity, '3', NaN, undefined];
  /* At both temperature extremes: the gain scales the saturation diagonal, so a
     value that encodes at neutral can still refuse at the coolest setting —
     which is the corner §2.5's derivation turns on. */
  const EXTREMES = [-100, 0, 100];

  let clamped = false;

  for (const value of PUSHED) {
    const normalised = normalizeClipProperties({ ...NEUTRAL, saturation: value });

    if (!Number.isFinite(normalised.saturation)) {
      fail(
        `1.6: normalizeClipProperties returned a non-finite saturation (${normalised.saturation}) ` +
          `for input ${String(value)}. A NaN reaching \`coef()\` writes the literal "NaN" into a ` +
          'filter argument and ffmpeg refuses the whole graph.',
      );
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value) && normalised.saturation !== value) {
      clamped = true;
    }

    for (const temperature of EXTREMES) {
      // Built from what the SANITISER produced, not from what was pushed in.
      // That is the whole point: this is the document the app can actually
      // reach, and the binary has to run it.
      const block = emittedGradeBlock({ ...normalised, temperature });
      if (block.error) {
        fail(`1.6 saturation ${String(value)} @ temp ${temperature}: ${block.error}`);
        continue;
      }
      const r = measure(block.chain);
      if (r.error) {
        fail(
          "1.6 the sanitiser admits a saturation the encoder cannot run. This is §2.5's defect " +
            'exactly: a bound wider than the encodable one, invisible everywhere upstream and ' +
            'fatal at export.\n' +
            `    pushed in:  ${String(value)}\n` +
            `    normalizeClipProperties returned: ${normalised.saturation}\n` +
            `    at temperature ${temperature}, ffmpeg: ${r.error}\n` +
            `    emitted grade block: ${block.chain}\n` +
            '    Narrow the clamp, or make the emitted chain able to encode the wider range — ' +
            'CREATIVE §2.5 records why splitting the matrix across two passes is not that route.',
        );
      }
    }
  }

  check(
    '1.6 the sanitiser actually clamps saturation',
    clamped,
    'every pushed value came back unchanged, so `normalizeClipProperties` is not bounding this ' +
      'field at all and every round trip above passed for the wrong reason',
  );

  /* AND THE TWO CLAMPS AGREE.

     `gradeMath` clamps too, and it is the LAST bound before a coefficient is
     formatted — the main process receives an `ExportDocument` over structured
     clone and `withGradeDefaults` fills non-finite fields without bounding them,
     so a document that never met `normalizeClipProperties` reaches the filter
     through `gradeMath` alone. It is also the bound the PREVIEW obeys, since
     `ClipFilter` builds `feColorMatrix` from the same call. Two bounds on one
     field, in two files, is two bounds that drift; a value between them renders
     in the preview and refuses in the file.

     Asserted as AGREEMENT between two independently-written clamps rather than
     against a number this gate supplies. */
  const viaGradeMath = gradeMath(P({ saturation: 1e6 })).saturation;
  const viaSanitiser = normalizeClipProperties({ ...NEUTRAL, saturation: 1e6 }).saturation;
  if (viaGradeMath !== viaSanitiser) {
    fail(
      "1.6 the two clamps on `saturation` disagree. `gradeMath` is the last bound before a " +
        'coefficient is formatted and the only one on a document that reached main without ' +
        'passing through `normalizeClipProperties` — and it is the bound the PREVIEW obeys, so a ' +
        'value between the two renders in the preview and refuses in the file.\n' +
        `    gradeMath clamps saturation to:            ${viaGradeMath}\n` +
        `    normalizeClipProperties clamps it to:      ${viaSanitiser}`,
    );
  }
}

/* The named reference point, asserted exactly rather than within a tolerance.
   §2.4: `saturation=0` on 46,95,158 must land on a NEUTRAL GREY at that pixel's
   Rec.709 luma — 89.099. Under `eq` it returned 86,88,85, which is not grey at
   all, and that single number is what proved the disagreement was a DOMAIN error
   rather than a coefficient to correct. It is worth one hard assertion. */

{
  const block = emittedGradeBlock({ saturation: 0 });
  if (!block.error) {
    const r = measure(block.chain);
    if (!r.error) {
      const [rr, gg, bb] = r.pixels[0];
      if (!(rr === gg && gg === bb)) {
        fail(
          `1.4 saturation=0 on 46,95,158 must be a NEUTRAL GREY and came back ${rr},${gg},${bb}. ` +
            'A non-grey here is the `eq` signature: chroma scaled in YUV rather than a ' +
            'luma-preserving matrix in RGB (CREATIVE §2.4).',
        );
      }
      const luma = 0.2126 * 46 + 0.7152 * 95 + 0.0722 * 158;
      if (Math.abs(rr - luma) > TOLERANCE) {
        fail(
          `1.4 saturation=0 landed on ${rr}, but the Rec.709 luma of 46,95,158 is ` +
            `${luma.toFixed(3)}. feColorMatrix type="saturate" is DEFINED with these weights, so ` +
            'the two match by construction or one of them is not using them.',
        );
      }
    }
  }
}

/* --------------------------------------------------------- 2. neutrality */

const neutral = gradeMath(P({}));
if (!neutral.neutral) fail('a default clip must report neutral: true — the fast path depends on it');
near('neutral slope', neutral.slope, 1);
near('neutral intercept', neutral.intercept, 0);
near('neutral saturation', neutral.saturation, 1);
near('neutral rGain', neutral.rGain, 1);
near('neutral bGain', neutral.bGain, 1);

// Each of the four corrections ALONE must break neutrality. A `neutral` that
// only notices some of them emits no filter for the others, and the grade
// silently does nothing.
for (const patch of [
  { brightness: 0.01 },
  { contrast: 1.01 },
  { saturation: 0.99 },
  { temperature: 1 },
]) {
  const key = Object.keys(patch)[0];
  if (gradeMath(P(patch)).neutral) fail(`neutral must be false when ${key} is off unity`);
}

if (!effectsNeutral(P({}))) fail('a default clip must report effectsNeutral: true');
for (const patch of [{ blur: 0.5 }, { sharpen: 0.1 }, { vignette: 0.1 }, { flipH: true }, { flipV: true }]) {
  const key = Object.keys(patch)[0];
  if (effectsNeutral(P(patch))) fail(`effectsNeutral must be false when ${key} is set`);
}

/* --------------------------------------------------- 3. temperature is a gain */

const warm = gradeMath(P({ temperature: 100 }));
const cool = gradeMath(P({ temperature: -100 }));
if (!(warm.rGain > 1 && warm.bGain < 1)) fail('positive temperature must warm: more red, less blue');
if (!(cool.rGain < 1 && cool.bGain > 1)) fail('negative temperature must cool: less red, more blue');
near('temperature leaves green alone', warm.gGain, 1);
near('temperature is symmetric about zero', warm.rGain - 1, 1 - cool.rGain);

/* --------------------------------- 4. an ABSENT field is NEUTRAL, not minimum

   This assertion used to say only "the result is finite", and that weakness hid
   a real bug for the length of a build.

   `clamp` folds two different inputs. An out-of-range NUMBER is a value the user
   chose and overshot, and the nearest legal value is the right answer for it. An
   ABSENT or NaN field is not a value at all — it is a `.veproj` written before
   CREATIVE, or one hand-edited past the sanitiser — and the honest reading of
   "this project does not mention contrast" is "this project is not graded".

   Landing the second case on `lo` read it as `contrast: 0`, and `contrast: 0`
   multiplies every channel by zero about mid-grey. Every clip in every
   pre-CREATIVE project would have exported FLAT BLACK: total, silent loss of
   picture on a file the user did nothing to but open. A finiteness check passes
   on that happily — 0 is a perfectly finite number.

   So the property asserted is the one that matters: absent or NaN resolves to
   the NEUTRAL value of the term, and `neutral` therefore comes out TRUE, which
   is what keeps a legacy project off the filter path entirely. */

const LEGACY = { scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1, speed: 1, volume: 1 };

for (const [label, props] of [
  ['absent (a pre-CREATIVE .veproj)', { ...LEGACY }],
  [
    'NaN (hand-edited past the sanitiser)',
    { ...LEGACY, brightness: NaN, contrast: NaN, saturation: NaN, temperature: NaN },
  ],
  [
    'undefined, written explicitly',
    { ...LEGACY, brightness: undefined, contrast: undefined, saturation: undefined, temperature: undefined },
  ],
]) {
  const m = gradeMath(props);
  // slope IS contrast, and 0 is the flat-black value. This is the assertion.
  near(`${label}: contrast resolves to unity, not to the bottom of its range`, m.slope, 1);
  near(`${label}: brightness resolves to zero`, m.intercept, 0);
  near(`${label}: saturation resolves to unity, not to zero`, m.saturation, 1);
  near(`${label}: temperature leaves red alone`, m.rGain, 1);
  near(`${label}: temperature leaves blue alone`, m.bGain, 1);
  if (!m.neutral) {
    fail(
      `${label}: an ungraded legacy clip must report neutral: true, so it never reaches an ` +
        '`eq` filter or an SVG filter at all',
    );
  }
  for (const [k, v] of Object.entries(m)) {
    if (k === 'neutral') continue;
    // Still asserted: a NaN reaching `toFixed` writes the literal "NaN" into a
    // filter argument and ffmpeg refuses the whole graph.
    if (!Number.isFinite(v)) fail(`${label}: gradeMath must never emit a non-finite ${k} (got ${v})`);
  }
}

// The other arm, which the rule above must not have swallowed: a real number
// the user overshot still clamps to the nearest LEGAL value, not to neutral.
near('an overshot contrast still clamps to the bound, not to unity', gradeMath(P({ contrast: -5 })).slope, 0);
near('an overshot saturation still clamps to the bound', gradeMath(P({ saturation: -5 })).saturation, 0);

/* ------------------------------------------------- 5. clamping to the model */

const over = gradeMath(P({ contrast: 99, brightness: 99, saturation: 99, temperature: 9999 }));
near('contrast clamps to 3', over.slope, 3);
if (!(over.rGain <= 1.12 + 1e-9)) fail(`temperature must clamp, rGain ${over.rGain} exceeds the maximum`);
/* SATURATION IS DELIBERATELY NOT ASSERTED AGAINST A LITERAL HERE. This line used
   to read `saturation must clamp to 3`, and §2.5 narrowed the range to 1.8 —
   which would have left a gate cheerfully asserting the OLD bound and passing
   while the model said something else, the same stale-constant failure §7.1 was
   written about. The bound is measured against the binary in §1.6 instead, so
   there is no second copy of it to go stale. */
if (!(over.saturation > 0)) fail(`saturation must clamp to a usable value, got ${over.saturation}`);

/* ------------------------------------------------------- 6. transitionGain */

const clip = (patch) => ({ start: 100, duration: 50, ...patch });
/** `stream` is REQUIRED on the real signature; the gate never omits it either. */
const gain = (c, f, stream = 'video') => transitionGain(c, f, stream);

near('no transitions is always unity', gain(clip({}), 120), 1);

/* THE SAMPLING CONVENTION IS THE LEADING EDGE, and these numbers are the whole
   assertion. ffmpeg's `fade` evaluates at the frame's PTS, so the first frame of
   an export ramp is exactly 0 and the last frame of a fade-out is 1/N. A
   frame-CENTRE sample would give 1/2N and N-1/2N here, and the preview would sit
   permanently half a frame ahead of the file at the start of every ramp — small,
   permanent, and in the direction this project always resolves against (the
   preview moves to meet the export; `fade` rejects a negative `st`, so the
   export cannot move). These constants are what stop it drifting back. */

const fin = clip({ transitionIn: { kind: 'fade', frames: 10 } });
near('fade in: the first frame is fully transparent, as the file is', gain(fin, 100), 0);
near('fade in: midpoint', gain(fin, 105), 0.5);
near('fade in: fully up at the end of the ramp', gain(fin, 110), 1);
near('fade in: unity well past the ramp', gain(fin, 140), 1);

const fout = clip({ transitionOut: { kind: 'fade', frames: 10 } });
near('fade out: unity before the ramp', gain(fout, 130), 1);
near('fade out: the last frame is 1/N, matching `fade=t=out`', gain(fout, 149), 0.1);
near('fade out: fully down at the exclusive end', gain(fout, 150), 0);

// The ramp is never allowed outside 0..1 — an opacity above 1 is silently
// clamped by CSS and NOT by an audio gain node, where it is distortion.
for (let f = 90; f <= 160; f += 1) {
  const g = gain(clip({ transitionIn: { kind: 'fade', frames: 10 }, transitionOut: { kind: 'fade', frames: 10 } }), f);
  if (!(g >= 0 && g <= 1)) fail(`transitionGain out of range at frame ${f}: ${g}`);
}

// A ramp longer than the clip must not invert or go negative.
for (let f = 100; f < 150; f += 1) {
  const g = gain(clip({ transitionIn: { kind: 'fade', frames: 500 }, transitionOut: { kind: 'fade', frames: 500 } }), f);
  if (!(g >= 0 && g <= 1)) fail(`over-long ramp out of range at frame ${f}: ${g}`);
}

// A zero-frame transition is no transition — never a division by zero. The OUT
// edge is the one that proves the guard: at the clip's exclusive end `remaining`
// is 0, which satisfies `remaining <= frames` for frames 0 and divides by it.
// The IN edge alone cannot reach the division and would let the guard be
// deleted unnoticed.
near('zero-frame fade in is unity', gain(clip({ transitionIn: { kind: 'fade', frames: 0 } }), 100), 1);
near('zero-frame fade out is unity', gain(clip({ transitionOut: { kind: 'fade', frames: 0 } }), 150), 1);
near('zero-frame fade out is unity mid-clip', gain(clip({ transitionOut: { kind: 'fade', frames: 0 } }), 125), 1);

/* --------------------------- 6b. §4.3a lives in transitionGain and nowhere else

   The rule is written in exactly one place so no consumer can restate it
   differently, which means exactly one place can be asserted. A cross dissolve
   is a PICTURE event: it ramps the rendered opacity and leaves the audio edit the
   hard cut it already was. `stream` is required rather than defaulted precisely
   so `tsc` enumerates every call site rather than leaving one silently on the
   picture rule — a `.mjs` gate is untyped and would not have been enumerated, so
   the behaviour is asserted here instead. */

const dis = clip({ transitionIn: { kind: 'dissolve', frames: 10 } });
near('dissolve: PICTURE ramps, exactly as a fade does', gain(dis, 105, 'video'), 0.5);
near('dissolve: SOUND does not ramp at the start of the transition', gain(dis, 100, 'audio'), 1);
near('dissolve: SOUND does not ramp mid-transition', gain(dis, 105, 'audio'), 1);

// And the mirror: a `fade` on the same edge still ramps the sound. Suppressing
// both is the same defect as ramping both, and the two are one comparison apart.
near('fade in: SOUND ramps', gain(fin, 105, 'audio'), 0.5);
// `transitionOut` is always a fade, so it ramps sound whatever the in-edge is.
near(
  'a dissolve in-edge does not silence the OUT ramp',
  gain(clip({ transitionIn: { kind: 'dissolve', frames: 10 }, transitionOut: { kind: 'fade', frames: 10 } }), 145, 'audio'),
  0.5,
);

/* --------------------------- 7. the preview's filter runs in the FILE's space

   CREATIVE §2.2 / §3 make this load-bearing, and it is the one term in the whole
   feature that no amount of numeric agreement between `gradeMath` and `eq` can
   protect.

   SVG's default for filter primitives is `linearRGB`. ffmpeg's `eq` operates on
   the gamma-encoded values it is handed. Leave the default in place and every
   term — slope, intercept, saturation, the temperature matrix — is applied to a
   differently-transferred signal from the one the file gets. The maths agrees
   perfectly and the pictures do not: a mid-grey lift reads as roughly twice its
   size in the preview, silently, and worst at large corrections. That is exactly
   the quiet disagreement this whole feature exists to prevent, arriving through
   the machinery built to prevent it.

   A STRUCTURAL check, deliberately. There is no headless way to measure an SVG
   filter's working colour space, and there does not need to be: the attribute's
   ABSENCE is the entire failure mode, so its presence is the entire property.
   Both spellings are accepted because the file is JSX today and could be a
   template tomorrow, and neither spelling is more correct than the other. */

{
  const file = fileURLToPath(new URL('../src/components/preview/ClipFilter.tsx', import.meta.url));
  let src = '';
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    fail('src/components/preview/ClipFilter.tsx is missing — the preview has no grade filter at all');
  }
  if (src !== '') {
    // JSX `colorInterpolationFilters="sRGB"` or the DOM attribute spelling.
    const jsx = /colorInterpolationFilters\s*=\s*["'{]?\s*["']?sRGB["']?/.test(src);
    const attr = /color-interpolation-filters\s*=\s*["']sRGB["']/.test(src);
    if (!jsx && !attr) {
      fail(
        'ClipFilter carries no `color-interpolation-filters="sRGB"`. Without it the SVG filter ' +
          'runs in linearRGB while the export runs on gamma-encoded values, so every grade term ' +
          'lands on a differently-transferred signal and the preview silently stops matching the ' +
          'file — CREATIVE §2.2.',
      );
    }
    // It must be on the <filter> element itself, not parked on the wrapping
    // <svg>: the property inherits, but a primitive that sets its own would
    // override it and the attribute would be there while doing nothing.
    const filterTag = /<filter\b[^>]*>/.exec(src)?.[0] ?? '';
    if (filterTag !== '' && !/colorInterpolationFilters|color-interpolation-filters/.test(filterTag)) {
      fail(
        'ClipFilter declares sRGB somewhere other than on the <filter> element itself. It must ' +
          'be on the filter, where every primitive inherits it.\n' +
          `    <filter …>: ${filterTag}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ verdict */

if (failures.length > 0) {
  keepBundle = true;
  console.error(`\ngrade: ${failures.length} failure${failures.length > 1 ? 's' : ''}.\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('');
  console.error(
    `\n  the bundled source this ran against is preserved at:\n    ${dir}\n` +
      '  Deleted on a pass, kept on a failure, so what was actually compiled can be read ' +
      'rather than guessed at — CREATIVE §7.4 entry 8.\n',
  );
  process.exit(1);
}

console.log(
  `grade: ok — ${ROWS.length} grades x ${PROBE.length} pixels MEASURED through the pinned binary on ` +
    `the emitted chain, worst ${worst.delta.toFixed(2)}/255 (${worst.where}) against a ±${TOLERANCE}/255 ` +
    'bar; identity control lossless; every corner of the declared grade range encodable; ' +
    'neutrality, temperature, absent/NaN resolves NEUTRAL (not flat black), clamping, ' +
    'transitionGain incl. §4.3a, ClipFilter sRGB',
);
