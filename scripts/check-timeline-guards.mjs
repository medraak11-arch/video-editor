#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-timeline-guards.mjs — regression check for the frame/duration guard in
   src/state/timelineSlice.ts.

   Run:  node scripts/check-timeline-guards.mjs

   Why this exists: NaN survives every sanitizer the slice applies. Math.max(0, NaN)
   is NaN, Math.round(NaN) is NaN, and every comparison against NaN is false, so the
   overlap and source-bound checks silently succeed and a clip with NaN geometry
   lands in the store, poisoning all duration arithmetic downstream. The slice
   refuses non-finite frames at its own boundary; this asserts it still does, and
   that ordinary bad input is still sanitized rather than refused.

   No test framework: esbuild (already present as a vite dependency) bundles the
   slice, and the slice creator is driven with a minimal fake store — the same
   (set, get) contract zustand gives it.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(new URL('../src/state/timelineSlice.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 've-timeline-guards-'));
const outfile = join(dir, 'timelineSlice.mjs');

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

/* --------------------------------------------------------------- fake store */

let state = {};
const get = () => state;
const set = (partial) => {
  Object.assign(state, typeof partial === 'function' ? partial(state) : partial);
};

Object.assign(
  state,
  {
    // The cross-slice reads timelineSlice makes, stubbed.
    items: {},
    playhead: 0,
    fps: 30,
    inPoint: null,
    outPoint: null,
    markDirty: () => {},
    markSaved: () => {},
    setNotice: () => {},
  },
  mod.createTimelineSlice(set, get, {}),
);

const MEDIA = 'm_check';
state.items[MEDIA] = {
  id: MEDIA,
  kind: 'video',
  name: 'check.mp4',
  status: 'ready',
  durationFrames: 600,
  durationSeconds: 20,
};
const trackId = state.addTrack('video');

/* ------------------------------------------------------------------ asserts */

const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(detail ? `${name} — ${detail}` : name);
};

const clips = () => Object.values(state.clips);
const finiteClip = (c) =>
  Number.isFinite(c.start) && Number.isFinite(c.duration) && Number.isFinite(c.mediaIn);

/* 1. The guard must not swallow legal input. */

const seeded = state.addClip({ mediaId: MEDIA, trackId, start: 2000, duration: 100 });
check('valid addClip is accepted', seeded.ok, JSON.stringify(seeded));
const clipId = seeded.ok ? seeded.id : null;

/* 2. Ordinary bad input is still SANITIZED, not refused (PLAN §3.4). */

const sanitized = state.addClip({ mediaId: MEDIA, trackId, start: -500, duration: 0 });
check('addClip sanitizes start:-500 / duration:0', sanitized.ok, JSON.stringify(sanitized));
if (sanitized.ok) {
  const c = state.clips[sanitized.id];
  check('start:-500 clamps to 0', c.start === 0, `start=${c.start}`);
  check('duration:0 clamps to 1', c.duration === 1, `duration=${c.duration}`);
  const rounded = state.addClip({ mediaId: MEDIA, trackId, start: 15000.7, duration: 10 });
  check(
    'start:15000.7 rounds to 15001',
    rounded.ok && state.clips[rounded.id].start === 15001,
    JSON.stringify(rounded),
  );
}

/* 3. Non-finite frames and durations are REFUSED at every store entry point. */

const before = clips().length;
const refusals = [
  ['addClip start NaN', () => state.addClip({ mediaId: MEDIA, trackId, start: NaN })],
  ['addClip start Infinity', () => state.addClip({ mediaId: MEDIA, trackId, start: Infinity })],
  [
    'addClip duration NaN',
    () => state.addClip({ mediaId: MEDIA, trackId, start: 900, duration: NaN }),
  ],
  [
    'addClip mediaIn NaN',
    () => state.addClip({ mediaId: MEDIA, trackId, start: 900, mediaIn: NaN }),
  ],
  ['insertMediaAt NaN', () => state.insertMediaAt(MEDIA, NaN)],
  ['moveClip start NaN', () => state.moveClip(clipId, { trackId, start: NaN })],
  ['moveClips delta NaN', () => state.moveClips([clipId], NaN, 0)],
  ['moveClips trackIndex NaN', () => state.moveClips([clipId], 10, NaN)],
  ['trimClip out NaN', () => state.trimClip(clipId, 'out', NaN)],
  ['trimClip in NaN', () => state.trimClip(clipId, 'in', NaN)],
  ['planMove dry run NaN', () => mod.planMove(state, [clipId], NaN, 0)],
  ['planTrim dry run NaN', () => mod.planTrim(state, clipId, 'out', NaN)],
];

for (const [name, run] of refusals) {
  const result = run();
  check(`${name} is refused`, result.ok === false, `returned ${JSON.stringify(result)}`);
  check(
    `${name} names a reason`,
    result.ok === false && typeof result.reason === 'string',
    JSON.stringify(result),
  );
}

check('no clip was created by a refused mutation', clips().length === before, `${clips().length}`);
check(
  'every clip in the store has finite geometry',
  clips().every(finiteClip),
  JSON.stringify(clips().filter((c) => !finiteClip(c))),
);

/* 4. Markers carry a frame too. */

const marker = state.addMarker(NaN);
check('addMarker NaN is refused', marker === null, `returned ${JSON.stringify(marker)}`);
check(
  'every marker has a finite frame',
  Object.values(state.markers).every((m) => Number.isFinite(m.frame)),
  JSON.stringify(Object.values(state.markers)),
);
check('addMarker with no argument still works', typeof state.addMarker() === 'string');

/* ------------------------------------------------------------------- report */

if (failures.length > 0) {
  console.error(`timeline guards: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error('\nsrc/state/timelineSlice.ts must refuse non-finite frames and durations.');
  process.exit(1);
}

console.log(`timeline guards: ok (${refusals.length} entry points refuse non-finite input)`);
