#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-fps-snap.mjs — regression check for snapKnownFps in
   src/state/playbackSlice.ts.

   Run:  node scripts/check-fps-snap.mjs

   Why this exists: KNOWN_FPS is ascending and FPS_SNAP_TOLERANCE (0.05) is wider
   than the gap inside each NTSC pair — 23.976/24 differ by 0.024, 29.97/30 by
   0.03. A first-match loop therefore snapped a true 30.000 source to 29.97 and a
   true 24.000 to 23.976. Nothing throws: the project simply adopts a rate ~0.1%
   off, and since every clip duration and every timecode is re-derived from it, a
   25.000 s source displayed as 0:24. Silent corruption of the whole document,
   from one comparison.

   Same no-framework approach as check-timeline-guards.mjs: esbuild (already a
   vite dependency) bundles the slice and we assert on the exported pure function.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(new URL('../src/state/playbackSlice.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 've-fps-snap-'));
const outfile = join(dir, 'playbackSlice.mjs');

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
} finally {
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}

const { snapKnownFps, KNOWN_FPS } = mod;

const failures = [];
const check = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: got ${actual}, expected ${expected}`);
};

// The two pairs that first-match got wrong. These are the whole point of the file.
check('exact 30.000 stays 30', snapKnownFps(30), 30);
check('exact 24.000 stays 24', snapKnownFps(24), 24);
check('exact 29.97 stays 29.97', snapKnownFps(29.97), 29.97);
check('exact 23.976 stays 23.976', snapKnownFps(23.976), 23.976);
check('exact 60.000 stays 60', snapKnownFps(60), 60);
check('exact 59.94 stays 59.94', snapKnownFps(59.94), 59.94);

// Every known rate must be a fixed point, or adopting a project's own rate drifts it.
for (const known of KNOWN_FPS) {
  check(`fixed point ${known}`, snapKnownFps(known), known);
}

// Near misses snap to the NEAREST neighbour.
check('30.001 -> 30', snapKnownFps(30.001), 30);
check('29.971 -> 29.97', snapKnownFps(29.971), 29.97);
check('23.98 -> 23.976', snapKnownFps(23.98), 23.976);
check('24.01 -> 24', snapKnownFps(24.01), 24);

// Outside tolerance passes through untouched rather than being forced onto a rate.
check('48 is not snapped', snapKnownFps(48), 48);
check('15 is not snapped', snapKnownFps(15), 15);

if (failures.length) {
  console.error(`fps-snap: ${failures.length} FAILURES`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`fps-snap: PASS — ${KNOWN_FPS.length} known rates are fixed points, nearest-match holds`);
