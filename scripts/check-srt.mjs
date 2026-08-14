#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-srt.mjs — the gate on src/lib/srt.ts. CREATIVE.md §6.2, §7.

   Run:  node scripts/check-srt.mjs

   Why this exists: `parseSrt` promises to be TOLERANT and `formatSrt` promises
   to be STRICT, and both promises are invisible. A parser that quietly drops
   every cue in a CRLF file still returns an array, still type-checks, and still
   renders an empty subtitle panel that looks exactly like "this file had no
   subtitles in it" — which is the sentence the user will believe.

   So each tolerated malformation gets a named case here, and each is a file
   somebody actually has: a BOM from Notepad, CRLF from Windows, a decimal point
   from a writer that read the spec differently, indices that restart halfway
   through, and no trailing newline.

   It bundles src/lib/srt.ts FROM SOURCE with esbuild, for the reason
   check-export-graph.mjs states at length: reading build output means a stale
   build makes the gate assert against the previous compile and PASS.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(new URL('../src/lib/srt.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 've-srt-'));
const outfile = join(dir, 'srt.mjs');

/* CREATIVE §7.4 entry 8 — the bundle survives a FAILURE, and its path is
   PRINTED. Preserving a directory whose `mkdtemp` name is random and never
   emitted is most of the way back to not preserving it: entry 8's value is
   reading what was actually compiled instead of guessing, and that needs the
   path in the output. Declared at TOP LEVEL — inside the `finally` below it is
   block-scoped, and the failure branch then throws `ReferenceError` at the exact
   moment it has a real defect to report. */
let keepBundle = false;
process.on('exit', () => {
  if (keepBundle) return;
  rmSync(dir, { recursive: true, force: true });
});

let mod;
try {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  mod = await import(pathToFileURL(outfile).href);
} catch (error) {
  // The bundle is worth keeping when the BUILD is what failed, too.
  keepBundle = true;
  throw error;
}

const { parseSrt, formatSrt } = mod;
if (typeof parseSrt !== 'function' || typeof formatSrt !== 'function') {
  console.error('srt: src/lib/srt.ts must export parseSrt and formatSrt');
  process.exit(2);
}

const failures = [];
const fail = (msg) => failures.push(msg);
const eq = (label, actual, expected) => {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const FPS = 25; // whole ms per frame, so no rounding noise hides a real error

/* ------------------------------------------------------- 1. the tolerant read */

const CANONICAL = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  'first',
  '',
  '2',
  '00:00:03,500 --> 00:00:05,000',
  'second line one',
  'second line two',
  '',
].join('\n');

const cases = {
  canonical: CANONICAL,
  bom: '﻿' + CANONICAL,
  crlf: CANONICAL.replace(/\n/g, '\r\n'),
  'decimal point': CANONICAL.replace(/,(\d{3})/g, '.$1'),
  'restarting indices': CANONICAL.replace(/^2$/m, '1'),
  'no trailing newline': CANONICAL.replace(/\n+$/, ''),
  'no index lines': CANONICAL.split('\n').filter((l) => !/^\d+$/.test(l)).join('\n'),
  'trailing spaces on blank lines': CANONICAL.replace(/^$/gm, '   '),
};

for (const [name, text] of Object.entries(cases)) {
  const cues = parseSrt(text, FPS);
  if (cues.length !== 2) {
    fail(`tolerant read "${name}": expected 2 cues, got ${cues.length}`);
    continue;
  }
  eq(`tolerant read "${name}" cue 1 start`, cues[0].start, 25);
  eq(`tolerant read "${name}" cue 1 end`, cues[0].end, 50);
  eq(`tolerant read "${name}" cue 1 text`, cues[0].text, 'first');
  eq(`tolerant read "${name}" cue 2 start`, cues[1].start, Math.round(3.5 * FPS));
  eq(`tolerant read "${name}" cue 2 text`, cues[1].text, 'second line one\nsecond line two');
}

/* ------------------------------------------------- 2. what must NOT parse */

const rejected = {
  'reversed times': '1\n00:00:05,000 --> 00:00:02,000\nbackwards\n',
  'zero length': '1\n00:00:02,000 --> 00:00:02,000\nnothing\n',
  'empty body': '1\n00:00:01,000 --> 00:00:02,000\n\n',
  'no arrow': '1\n00:00:01,000 00:00:02,000\nbroken\n',
  'not srt at all': 'this is a plain text file\nwith two lines\n',
};

for (const [name, text] of Object.entries(rejected)) {
  const cues = parseSrt(text, FPS);
  if (cues.length !== 0) fail(`"${name}" should yield no cues, got ${cues.length}`);
}

// Cues come back in timeline order whatever order the file was in. A player
// tolerates an out-of-order file; the cue LIST does not — it would show the
// user's subtitles shuffled, and a file that was merely unusual would look like
// a file that was wrong.
const outOfOrder = [
  '1\n00:00:09,000 --> 00:00:10,000\nlast\n',
  '2\n00:00:01,000 --> 00:00:02,000\nfirst\n',
  '3\n00:00:05,000 --> 00:00:06,000\nmiddle\n',
].join('\n');
const sorted = parseSrt(outOfOrder, FPS);
eq('out-of-order file: cue count', sorted.length, 3);
eq(
  'out-of-order file is sorted on read',
  sorted.map((c) => c.text).join(','),
  'first,middle,last',
);

// A malformed cue must lose only ITSELF. This is the difference between a file
// that mostly loads and a file the user is told is broken.
const mixed = CANONICAL + '\n3\n00:00:09,000 --> 00:00:08,000\nbackwards\n\n';
eq('a bad cue does not take the good ones with it', parseSrt(mixed, FPS).length, 2);

/* --------------------------------------------------------- 3. round trip */

const parsed = parseSrt(CANONICAL, FPS);
const written = formatSrt(parsed, FPS);
const reparsed = parseSrt(written, FPS);

eq('round trip cue count', reparsed.length, parsed.length);
// Guarded rather than assumed: when the round trip loses cues, an unguarded loop
// dereferences undefined and the gate dies with a TypeError instead of naming
// the promise that was broken. A gate whose failure output is a stack trace
// costs the reader the twenty minutes the gate existed to save.
for (let i = 0; i < Math.min(parsed.length, reparsed.length); i += 1) {
  eq(`round trip cue ${i} start`, reparsed[i].start, parsed[i].start);
  eq(`round trip cue ${i} end`, reparsed[i].end, parsed[i].end);
  eq(`round trip cue ${i} text`, reparsed[i].text, parsed[i].text);
}

// Idempotent: formatting what we just formatted changes nothing. Without this a
// drifting index or a doubled newline would survive every single-pass check.
eq('format is idempotent', formatSrt(reparsed, FPS), written);

/* ------------------------------------------------------- 4. the strict write */

if (!written.includes('\r\n')) fail('write: must use CRLF');
if (/[^\r]\n/.test(written)) fail('write: found a bare LF — every newline must be CRLF');
if (!/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/.test(written)) {
  fail('write: timing line is not `HH:MM:SS,mmm --> HH:MM:SS,mmm`');
}
if (!/^1\r\n/.test(written)) fail('write: indices must be 1-based and sequential');
if (!written.endsWith('\r\n')) fail('write: must end with a newline');
eq('write: no cues is the empty string, not a stray newline', formatSrt([], FPS), '');

/* ------------------------------------------- 5. the offset the burn-in uses */

const offset = formatSrt(parsed, FPS, 25); // one second in
const shifted = parseSrt(offset, FPS);
eq('offset: cue 1 moves to zero', shifted[0].start, 0);
eq('offset: cue 2 moves back by the offset', shifted[1].start, parsed[1].start - 25);

// A cue entirely before the range is gone; a cue STRADDLING the start is kept
// and clamped, because it is on screen at the first exported frame and dropping
// it would blank a line the preview shows at exactly that frame.
const straddle = parseSrt('1\n00:00:00,000 --> 00:00:04,000\nover the edge\n', FPS);
const clamped = parseSrt(formatSrt(straddle, FPS, 25), FPS);
eq('offset: a straddling cue survives', clamped.length, 1);
eq('offset: a straddling cue is clamped to zero', clamped[0].start, 0);
eq('offset: a cue before the range is dropped', formatSrt(straddle, FPS, 200), '');

/* ------------------------------------------------------------------ verdict */

if (failures.length > 0) {
  keepBundle = true;
  console.error(`\nsrt: ${failures.length} failure${failures.length > 1 ? 's' : ''}.\n`);
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
  `srt: ok — ${Object.keys(cases).length} tolerated malformations, ${Object.keys(rejected).length} rejections, round trip, strict write, range offset`,
);
