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
  // see the bundle-preservation note below
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
  // A real trackId, not a missing argument: planMove fails closed on an
  // unresolved primary track (docs/LINKING.md §5.2b), and this file is untyped
  // .mjs, so leaving the argument off would turn three NaN-refusal assertions
  // into three `no-track` refusals that pass while testing nothing.
  ['moveClips delta NaN', () => state.moveClips([clipId], NaN, 0, trackId)],
  ['moveClips trackIndex NaN', () => state.moveClips([clipId], 10, NaN, trackId)],
  ['trimClip out NaN', () => state.trimClip(clipId, 'out', NaN)],
  ['trimClip in NaN', () => state.trimClip(clipId, 'in', NaN)],
  ['planMove dry run NaN', () => mod.planMove(state, [clipId], NaN, 0, trackId)],
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

/* 3b. …AND `undefined`, WHICH IS NOT THE SAME THING.

   The gate above was true and incomplete, and the gap it left was a live
   document-corrupting hole rather than a theoretical one.

   `undefined` is not non-finite. It is ABSENT. The slice's frame guard was
   called `isFiniteFrames` and deliberately passed `undefined`, because it guards
   OPTIONAL fields where absent means "take the default" — `input.duration`,
   `input.mediaIn`, `addMarker`'s frame. Under that name three REQUIRED arguments
   were guarded with it, so `undefined` sailed through, `Math.round(undefined)`
   produced NaN, and NaN passes every range test: measured,
   `insertClips(ids, undefined, 0, v)` returned `{ok:true}` and wrote a NaN start
   into the document.

   THE HOLE IS REACHABLE PRECISELY FROM HERE. TypeScript refuses `undefined` at a
   typed call site, so the only callers that can reach it are untyped `.mjs` —
   which is to say the gate scripts. The guard exists for this file's benefit and
   this file was the one place not testing it.

   So the two cases are asserted SEPARATELY, because they have opposite correct
   answers, and asserting them together is what produced the hole:

     REQUIRED argument + undefined  ->  REFUSE
     OPTIONAL field    + undefined  ->  ACCEPT, and take the default

   A gate that only fed `undefined` everywhere and expected refusal would fail a
   correct implementation on the optional half — the same shape of trap §12.7's
   first draft carried. */

const undefinedRefusals = [
  ['addClip start', () => state.addClip({ mediaId: MEDIA, trackId, start: undefined })],
  ['insertMediaAt start', () => state.insertMediaAt(MEDIA, undefined)],
  ['moveClip start', () => state.moveClip(clipId, { trackId, start: undefined })],
  ['moveClips delta', () => state.moveClips([clipId], undefined, 0, trackId)],
  ['moveClips trackIndex', () => state.moveClips([clipId], 10, undefined, trackId)],
  ['trimClip out', () => state.trimClip(clipId, 'out', undefined)],
  ['trimClip in', () => state.trimClip(clipId, 'in', undefined)],
  ['planMove dry run', () => mod.planMove(state, [clipId], undefined, 0, trackId)],
  ['planTrim dry run', () => mod.planTrim(state, clipId, 'out', undefined)],
  // The one that was measured writing a NaN start into the document.
  ['insertClips delta', () => state.insertClips([clipId], undefined, 0, trackId)],
  ['insertClips trackIndex', () => state.insertClips([clipId], 10, undefined, trackId)],
  ['planInsert dry run', () => mod.planInsert(state, [clipId], undefined, 0, trackId)],
];

const beforeUndefined = clips().length;

for (const [name, run] of undefinedRefusals) {
  let result;
  try {
    result = run();
  } catch (error) {
    check(`${name} undefined is refused, not thrown`, false, String(error?.message ?? error));
    continue;
  }
  check(
    `${name} undefined is refused`,
    result !== null && result !== undefined && result.ok === false,
    `returned ${JSON.stringify(result)} — \`undefined\` is ABSENT, not non-finite, so a guard ` +
      'written for optional fields passes it straight through to `Math.round`, which yields NaN, ' +
      'which passes every range test below it.',
  );
  check(
    `${name} undefined names a reason`,
    result !== null && result !== undefined && result.ok === false && typeof result.reason === 'string',
    JSON.stringify(result),
  );
}

check(
  'no clip was created by a refused undefined mutation',
  clips().length === beforeUndefined,
  `${clips().length} vs ${beforeUndefined}`,
);
check(
  'every clip in the store still has finite geometry after the undefined pass',
  clips().every(finiteClip),
  JSON.stringify(clips().filter((c) => !finiteClip(c))),
);

/* The other half, and it is not decoration: an OPTIONAL field given `undefined`
   must be ACCEPTED and defaulted. This is what the guard was written for, and it
   is what makes the refusals above a distinction rather than a blanket rule. */

{
  const defaulted = state.addClip({
    mediaId: MEDIA,
    trackId,
    start: 20000,
    duration: undefined,
    mediaIn: undefined,
  });
  check('addClip with an absent duration and mediaIn is ACCEPTED', defaulted.ok, JSON.stringify(defaulted));
  if (defaulted.ok) {
    const c = state.clips[defaulted.id];
    check(
      'and both took a finite default rather than NaN',
      Number.isFinite(c.duration) && c.duration > 0 && Number.isFinite(c.mediaIn),
      `duration=${c.duration} mediaIn=${c.mediaIn}`,
    );
  }
}

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
  keepBundle = true;
  console.error(`timeline guards: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error('\nsrc/state/timelineSlice.ts must refuse non-finite frames and durations.');
  console.error(
    `\n  the bundled source this ran against is preserved at:\n    ${dir}\n` +
      '  Deleted on a pass, kept on a failure, so what was actually compiled can be read ' +
      'rather than guessed at — CREATIVE §7.4 entry 8.\n',
  );
  process.exit(1);
}

console.log(
  `timeline guards: ok (${refusals.length} entry points refuse non-finite input, ` +
    `${undefinedRefusals.length} refuse an ABSENT required argument, and an absent OPTIONAL ` +
    'field still takes its default)',
);
