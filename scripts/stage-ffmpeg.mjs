#!/usr/bin/env node
/**
 * Stages ffmpeg + ffprobe into build/ffmpeg/, which electron-builder copies to
 * <resources>/ffmpeg/ in the packaged app (electron-builder.yml `extraResources`)
 * and which electron/ffmpeg.ts looks in first at runtime.
 *
 * The app shells out to ffmpeg; it does not link it and does not depend on an
 * npm wrapper. So the binaries have to come from somewhere concrete, and this
 * script states where: FFMPEG_DIR if set, otherwise wherever they already are on
 * PATH. There is no download step — a packaging script that reaches the network
 * fails on the machine that most needs it to work.
 *
 * Copies are skipped when the destination already matches by size, so re-running
 * `npm run dist` does not re-copy 200 MB every time.
 *
 * Usage:
 *   node scripts/stage-ffmpeg.mjs           # required: exit 1 if not found
 *   node scripts/stage-ffmpeg.mjs --check   # report only, never copies
 *   node scripts/stage-ffmpeg.mjs --skip    # EMPTY the folder: build without ffmpeg
 *   FFMPEG_DIR=/path/to/bin node scripts/stage-ffmpeg.mjs
 *
 * `--skip` deletes rather than merely skipping, because build/ffmpeg persists
 * between runs: a "no bundle" build that quietly shipped last run's binaries
 * would be the exact silent failure this whole file exists to prevent.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEST = path.join(ROOT, 'build', 'ffmpeg');
const TOOLS = ['ffmpeg', 'ffprobe'];
const SUFFIX = process.platform === 'win32' ? '.exe' : '';
const checkOnly = process.argv.includes('--check');
const skip = process.argv.includes('--skip');

const sizeOf = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
};

/** The absolute path of a tool, from FFMPEG_DIR or from PATH. null when absent. */
function locate(tool) {
  const explicit = process.env.FFMPEG_DIR?.trim();
  if (explicit) {
    const candidate = path.join(explicit, `${tool}${SUFFIX}`);
    return sizeOf(candidate) > 0 ? candidate : null;
  }

  // `where` on win32, `which` elsewhere. Both print one path per line.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [tool], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '');
    return first && sizeOf(first) > 0 ? first : null;
  } catch {
    return null;
  }
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

if (skip) {
  mkdirSync(DEST, { recursive: true });
  for (const tool of TOOLS) rmSync(path.join(DEST, `${tool}${SUFFIX}`), { force: true });
  console.log('stage-ffmpeg: --skip — build/ffmpeg emptied, no ffmpeg will ship');
  console.log('stage-ffmpeg: the resulting build needs ffmpeg and ffprobe on the PATH of');
  console.log('stage-ffmpeg: whatever machine runs it, or every import and export fails');
  process.exit(0);
}

const found = [];
const missing = [];
for (const tool of TOOLS) {
  const from = locate(tool);
  if (from) found.push({ tool, from });
  else missing.push(tool);
}

if (missing.length > 0) {
  const where = process.env.FFMPEG_DIR ? `FFMPEG_DIR (${process.env.FFMPEG_DIR})` : 'PATH';
  console.error(`stage-ffmpeg: ${missing.join(' and ')} not found on ${where}.`);
  console.error('');
  console.error('The packaged app ships its own copy of both binaries, so packaging needs');
  console.error('them present here first. Either:');
  console.error('  · install ffmpeg so both are on PATH  (winget install Gyan.FFmpeg.Essentials)');
  console.error('  · or point at an existing build:      FFMPEG_DIR=<folder-with-the-exes>');
  console.error('');
  console.error('To build an installer that does NOT bundle ffmpeg, run `npm run dist:nobundle`.');
  console.error('It works only on machines that already have ffmpeg on PATH.');
  process.exit(1);
}

if (checkOnly) {
  for (const { tool, from } of found) console.log(`stage-ffmpeg: ${tool} -> ${from} (${mb(sizeOf(from))})`);
  process.exit(0);
}

mkdirSync(DEST, { recursive: true });

let copied = 0;
let total = 0;
for (const { tool, from } of found) {
  const to = path.join(DEST, `${tool}${SUFFIX}`);
  const bytes = sizeOf(from);
  total += bytes;
  if (sizeOf(to) === bytes) {
    console.log(`stage-ffmpeg: ${tool} already staged (${mb(bytes)})`);
    continue;
  }
  copyFileSync(from, to);
  copied += 1;
  console.log(`stage-ffmpeg: ${tool} <- ${from} (${mb(bytes)})`);
}

console.log(
  `stage-ffmpeg: ${copied === 0 ? 'up to date' : `${copied} copied`} in ${path.relative(ROOT, DEST)} — ${mb(total)} will ship with the app`,
);

/* ------------------------------------------------------- prove the copy runs
   Resolving a tool and copying it is NOT evidence that the copy works, and the
   difference shipped a broken 0.1.1.

   `choco install ffmpeg` puts a 383 KB SHIM on PATH — a launcher that finds the
   real binary by a path relative to its own install root. `ffmpeg -version`
   passes, because the shim works where it lives. Copied into build/ffmpeg/ it
   is a corpse: it looks for `..\lib\ffmpeg\tools\ffmpeg\bin\ffprobe.exe` beside
   the app and reports "Cannot find file". Every import failed with an ffprobe
   error on a build whose CI was green.

   So: execute what was actually staged, from where it was staged. A tool that
   cannot answer -version is not shippable, and finding that out here costs
   seconds instead of a release. */

const looksLikeFfmpeg = (out) => /\bff(mpeg|probe) version\b/i.test(out);

for (const { tool } of found) {
  const staged = path.join(DEST, `${tool}${SUFFIX}`);
  let out = '';
  let ok = false;
  try {
    out = execFileSync(staged, ['-version'], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ok = looksLikeFfmpeg(out);
  } catch (error) {
    out = String(error?.stdout || '') + String(error?.stderr || error?.message || '');
  }

  if (!ok) {
    console.error(`\nstage-ffmpeg: the staged ${tool} does not run.\n`);
    console.error(`  staged: ${staged} (${mb(sizeOf(staged))})`);
    console.error(`  said:   ${out.trim().split('\n')[0] || '(no output)'}\n`);
    console.error('A shim or wrapper was staged instead of a real binary. Chocolatey installs one');
    console.error('by default; it works on PATH and dies the moment it is copied elsewhere.');
    console.error('Point at a real static build instead:');
    console.error('  FFMPEG_DIR=<folder-with-the-real-exes> npm run stage:ffmpeg\n');
    rmSync(DEST, { recursive: true, force: true });
    process.exit(1);
  }

  console.log(`stage-ffmpeg: ${tool} runs — ${out.trim().split('\n')[0]}`);
}

/* ------------------------------------------- the options the graph depends on
   Running is not enough: the encoder can start and still refuse the arguments.

   electron/export/graph.ts passes the filter graph with -filter_complex_script,
   because the graph routinely exceeds the Windows command-line limit. That
   option was REMOVED in ffmpeg master. v0.1.4 shipped a master build: ffmpeg
   launched, rejected the argument list before encoding a frame, exited non-zero,
   and every export failed with "the encoder stopped before it finished" — while
   every codec the app names was present and the binary answered -version
   perfectly.

   So assert the options, not just the binary. An ffmpeg that cannot take the
   arguments this app builds is the wrong ffmpeg, whatever else it can do. */

const REQUIRED_FFMPEG_OPTIONS = ['filter_complex_script'];

const ffmpegPath = path.join(DEST, `ffmpeg${SUFFIX}`);
let help = '';
try {
  help = execFileSync(ffmpegPath, ['-hide_banner', '-h', 'full'], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  help = String(error?.stdout || '');
}

const missingOptions = REQUIRED_FFMPEG_OPTIONS.filter((opt) => !help.includes(opt));
if (missingOptions.length > 0) {
  console.error(`\nstage-ffmpeg: the staged ffmpeg is missing ${missingOptions.length > 1 ? 'options' : 'an option'} this app requires.\n`);
  for (const opt of missingOptions) console.error(`  -${opt}`);
  console.error(`\n  staged: ${ffmpegPath}`);
  console.error(`  version: ${(help.split('\n')[0] || '').trim() || 'unknown'}\n`);
  console.error('-filter_complex_script was removed in ffmpeg master. Use a RELEASE build (n8.x),');
  console.error('not a master snapshot: the graph is passed as a file because it routinely exceeds');
  console.error('the Windows command-line limit, and without it every export fails.\n');
  rmSync(DEST, { recursive: true, force: true });
  process.exit(1);
}

console.log(`stage-ffmpeg: required options present — ${REQUIRED_FFMPEG_OPTIONS.map((o) => '-' + o).join(', ')}`);

/* ---------------------------------------------------------------- filters
   The same argument as the options above, one level down. An option is missing
   when the BUILD is wrong; a filter is missing when the build was CONFIGURED
   wrong — and a misconfigured build is harder to spot, because it answers
   `-version` perfectly and encodes an ordinary export perfectly. It fails only
   on the feature that needed the library nobody enabled.

   `subtitles` is the one that earns this whole block. It is the only entry here
   that requires an external library (libass), so it is the canary: a build
   without libass produces a working editor whose burn-in silently has no
   subtitles in it, discovered by a user, after a release. Everything else here
   is built in to any reasonable ffmpeg and costs nothing to assert alongside it.

   CREATIVE.md §7. */

const REQUIRED_FFMPEG_FILTERS = [
  // Grade — CREATIVE §2, §2.4. The export does the tone curve in planar RGB with
  // `lutrgb`, NOT with `eq`: `eq` works on limited-range Y, so its brightness
  // moved a pixel by ~58/255 where the shared `gradeMath` says 51, and its
  // saturation=0 produced 86,88,85 rather than a neutral grey. `eq` is kept in
  // this list anyway — it is not a dead entry, because a build without it is a
  // build whose filter set has been cut down, and that is worth knowing before
  // the first export rather than after.
  'eq',
  'lutrgb', // grade: contrast + brightness, the feComponentTransfer twin
  'colorchannelmixer', // grade: saturation × temperature as one 3×3, and opacity's alpha
  'gblur', // effects — §3
  'unsharp',
  'vignette',
  'hflip',
  'vflip',
  'fade', // transitions — §4, alpha ramps
  'afade',
  'subtitles', // burn-in — §6.3. THE LIBASS CANARY.
];

let filterList = '';
try {
  filterList = execFileSync(ffmpegPath, ['-hide_banner', '-filters'], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  filterList = String(error?.stdout || '');
}

// `-filters` prints one filter per line as `TFF name  in->out  description`.
// Matched on the NAME COLUMN, not with `includes`: `fade` appears inside
// `afade`, and every filter name appears inside somebody's description.
const filterNames = new Set(
  filterList
    .split('\n')
    .map((line) => /^\s*[TSC.]{1,3}\s+(\S+)\s/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]),
);

const missingFilters = REQUIRED_FFMPEG_FILTERS.filter((f) => !filterNames.has(f));
if (missingFilters.length > 0) {
  console.error(`\nstage-ffmpeg: the staged ffmpeg is missing ${missingFilters.length > 1 ? 'filters' : 'a filter'} this app requires.\n`);
  for (const f of missingFilters) console.error(`  ${f}`);
  console.error(`\n  staged: ${ffmpegPath}`);
  console.error(`  version: ${(filterList.split('\n')[0] || '').trim() || 'unknown'}`);
  console.error(`  filters found: ${filterNames.size}\n`);
  if (missingFilters.includes('subtitles')) {
    console.error('`subtitles` needs libass. A build without it encodes every ordinary export');
    console.error('perfectly and burns in NO subtitles at all — a failure that reaches a user');
    console.error('rather than this script. Use a build configured with --enable-libass.\n');
  }
  rmSync(DEST, { recursive: true, force: true });
  process.exit(1);
}

console.log(
  `stage-ffmpeg: required filters present — ${REQUIRED_FFMPEG_FILTERS.length} of ${filterNames.size}, including subtitles (libass)`,
);
