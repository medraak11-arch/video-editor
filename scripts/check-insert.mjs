#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-insert.mjs — the gate on insert-and-push. CREATIVE.md §12, §12.7, §12.8.

   Run:  node scripts/check-insert.mjs

   The user's words: *"make them behave like soap bubbles … point it at the seam
   between two clips. it should be placed there and scootch the right clip to the
   right."* A drop whose start edge snaps to a boundary, and which would
   otherwise refuse for `overlap`, inserts — pushing what is in the way, and only
   as far as it must.

   WHY THIS GATE IS HARD TO WRITE WELL, and the trap it already sprang.

   §12.7's first draft asserted that the downstream run keeps its
   `(duration, gap)` sequence — identical, only offset. That reads like the
   defining property of an insert and it is FALSE across a partially consumed
   gap, because §12.3's cascade eats gaps as it travels. Occupants at 60/140/200
   taking a 60-frame insert at seam 60 land at 120/180/240, and the 20-frame gap
   between the first two is simply gone. A gate written to that draft would have
   failed a CORRECT implementation. State caught it before any gate code existed.

   The observable this file actually uses is the corrected one:

     > EVERY CLIP THAT MOVED IS BUTTED AGAINST ITS PREDECESSOR — the inserted
     > clip, or the previously moved clip — AND NO CLIP'S DURATION CHANGED.

   It is exact, because a clip with slack in front of it would not have needed to
   move at all. It covers the tight run and the gapped run in one sentence, it
   restates none of the arithmetic, and it survives a rewrite of the cascade.
   The two cases still get SEPARATE FIXTURES, because one sentence covering both
   is not the same as one fixture exercising both.

   THREE STANDING RULES SHAPE THE REST:

   §7.2 — it drives the STORE ACTION, never `planInsert` alone. The assertion is
   on the resulting document, because that is the behaviour. A pure planner that
   returns a correct plan nobody commits is not a feature.

   §11.2 — every fixture is built through the store actions a user's gesture
   calls: `addTrack`, `addClip`, `linkClips`, `toggleLock`. A hand-assembled
   document is a restatement of the app's own state.

   §12.8 — the whole assertion set runs through BOTH entry points, the drag-shaped
   `insertClips` call and the `Insert at playhead` command, and requires
   byte-identical documents out. That is what keeps them one implementation
   rather than two, and it is cheap precisely because the command is a third
   caller of one planner.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* CREATIVE §7.4 entry 8 — THE BUNDLE SURVIVES A FAILURE.

   esbuild's output is deleted on the way out, which is right when the gate
   passes and wrong the moment it does not: the one artefact that says what was
   actually compiled is destroyed exactly when somebody needs to look at it.

   The cost of not having it is on record. An unreproducible `check-linking`
   failure was diagnosed as a torn mid-save read and relayed onward as such;
   there was no torn file — another agent had temporarily bound `V` to two rows
   and the gate caught the mutation in flight, on a file that was exactly as
   written. A guess phrased in the grammar of a diagnosis is harder to challenge
   than an admitted guess, which is how it travelled unchallenged. The preserved
   bundle turns that from an argument into a look: it would have shown the source
   complete, well-formed, and with `V` bound twice.

   So: keep it on failure, print the path, and delete it only when green. */
const dir = mkdtempSync(join(tmpdir(), 've-insert-'));
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

const timeline = await bundle('../src/state/timelineSlice.ts', 'timelineSlice');

/* The keyboard path, and the REAL store beside it.

   `insertCommand.ts` reaches the store through `readStore()` rather than taking
   one, so a bundle of it alone cannot be driven. A generated shim re-exports
   both from ONE bundle, which is what makes them the same store instance — two
   separate bundles would each construct their own and the command would edit a
   document this file could not see. */
const shim = join(dir, 'shim.ts');
const abs = (rel) => fileURLToPath(new URL(rel, import.meta.url)).split('\\').join('/');
writeFileSync(
  shim,
  [
    `export { insertSelectionAtPlayhead, selectionInsert } from ${JSON.stringify(abs('../src/components/timeline/insertCommand.ts'))};`,
    `export { readStore } from ${JSON.stringify(abs('../src/state/store.ts'))};`,
  ].join('\n'),
);
const outfile = join(dir, 'insertCommand.mjs');
await build({ entryPoints: [shim], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const command = await import(pathToFileURL(outfile).href);

for (const name of ['createTimelineSlice', 'planInsert']) {
  if (typeof timeline[name] !== 'function') {
    console.error(`insert: src/state/timelineSlice.ts must export ${name}`);
    process.exit(2);
  }
}

const failures = [];
/* Muted while a scenario is REPLAYED for a comparison rather than judged on its
   own — the snap sweep below. Without it one cause reports ten times, once per
   scenario, and the run that actually says why is buried under nine that do not. */
let muted = false;
const check = (name, ok, detail = '') => {
  if (!ok && !muted) failures.push(detail === '' ? name : `${name} — ${detail}`);
};
const quietly = (fn) => {
  muted = true;
  try {
    return fn();
  } finally {
    muted = false;
  }
};

/* --------------------------------------------------------------- fake store */

const MEDIA = 'm_insert';

function fresh() {
  const state = {};
  const get = () => state;
  const set = (p) => Object.assign(state, typeof p === 'function' ? p(state) : p);
  Object.assign(
    state,
    {
      items: {},
      playhead: 0,
      fps: 30,
      inPoint: null,
      outPoint: null,
      notice: null,
      markDirty: () => {},
      markSaved: () => {},
      setNotice: (n) => {
        state.notice = n;
      },
    },
    timeline.createTimelineSlice(set, get, {}),
  );
  state.items[MEDIA] = {
    id: MEDIA,
    kind: 'video',
    name: 'insert.mp4',
    status: 'ready',
    durationFrames: 100000,
    durationSeconds: 3333,
    hasAudio: true,
  };
  return state;
}

const add = (s, trackId, start, duration, extra = {}) => {
  const r = s.addClip({ mediaId: MEDIA, trackId, start, duration, ...extra });
  if (!r.ok) throw new Error(`addClip refused: ${JSON.stringify(r)}`);
  return r.id;
};

const startsOn = (s, trackId) =>
  (s.clipsByTrack[trackId] ?? []).map((id) => s.clips[id].start).slice().sort((a, b) => a - b);

/**
 * The whole document, in a form the two entry points can be compared on.
 *
 * ID-FREE, and that is not a convenience. Clip ids are nanoid-based, so two runs
 * of the same fixture never share one; a comparison that carried ids could only
 * ever report "different". What the two entry points must agree about is the
 * ARRANGEMENT — which lane, which frame, how long — and that is exactly what is
 * left when the ids come out.
 */
const documentOf = (s) =>
  JSON.stringify(
    s.trackOrder.map((t) =>
      (s.clipsByTrack[t] ?? [])
        .map((id) => [s.clips[id].start, s.clips[id].duration, s.clips[id].mediaIn])
        .sort((a, b) => a[0] - b[0]),
    ),
  );

/* ------------------------------------------------------------- THE OBSERVABLE

   §12.7 assertion 1, as corrected. Given the positions before and after, every
   clip whose start CHANGED must now sit exactly against whatever precedes it on
   its track, and no duration may have changed.

   It takes `before` as data rather than recomputing anything, and it discovers
   the moved set from the two snapshots — so it never needs to be told what the
   cascade decided, which is the property that stops it restating the algorithm. */

const snapshot = (s) =>
  Object.fromEntries(
    Object.values(s.clips).map((c) => [c.id, { trackId: c.trackId, start: c.start, duration: c.duration }]),
  );

function assertButtedAgainstPredecessor(label, s, before, insertedIds) {
  const after = snapshot(s);

  /* The INSERTED clips are excluded, and the exclusion is the assertion's
     meaning rather than a convenience. §12.7 says every clip that moved is
     butted "against its predecessor — the inserted clip, or the previously moved
     clip"; the inserted clip itself lands where the user AIMED, which may be a
     seam with nothing in front of it at all (scenario 4 puts it at frame 0). It
     is the DISPLACED set that must be tight.

     Taken as the link CLOSURE, not the argument: a linked pair moves as a unit,
     so the unselected half is inserted too and would otherwise be scored as a
     clip that was pushed. */
  const inserted = new Set(timeline.selectLinkedClosure(s, insertedIds));

  const movedIds = Object.keys(after).filter(
    (id) => !inserted.has(id) && before[id] !== undefined && before[id].start !== after[id].start,
  );

  for (const id of Object.keys(after)) {
    if (before[id] === undefined) continue;
    if (before[id].duration !== after[id].duration) {
      check(
        `${label}: no clip's duration changed`,
        false,
        `clip ${id} went ${before[id].duration} -> ${after[id].duration}. An insert moves clips; ` +
          'it never trims one to make room, which is the difference between an insert and an ' +
          'overwrite.',
      );
    }
  }

  for (const id of movedIds) {
    const c = after[id];
    // Its predecessor on its own track, after the move.
    const lane = Object.entries(after)
      .filter(([, v]) => v.trackId === c.trackId)
      .map(([k, v]) => ({ id: k, ...v }))
      .sort((a, b) => a.start - b.start);
    const i = lane.findIndex((x) => x.id === id);
    if (i <= 0) {
      check(
        `${label}: a clip that moved has something in front of it`,
        false,
        `clip ${id} moved to ${c.start} with nothing before it on its track — nothing pushed it`,
      );
      continue;
    }
    const prev = lane[i - 1];
    check(
      `${label}: every clip that moved is butted against its predecessor`,
      c.start === prev.start + prev.duration,
      `clip ${id} moved to ${c.start} but its predecessor ends at ${prev.start + prev.duration}. ` +
        'A clip with slack in front of it did not need to move, so a gap here means the cascade ' +
        'pushed something further than it had to (CREATIVE §12.7 assertion 1, as corrected — the ' +
        'earlier "(duration, gap) sequence is preserved" is FALSE across a consumed gap).',
    );
  }

  return movedIds;
}

/* ============================================================ THE SCENARIOS

   Each is a function of `commit` — the thing that performs the insert — so the
   entire set can be replayed through the drag-shaped action and through the
   command with no second copy. `commit(s, ids, seam, primaryTrackId)` places
   `ids` so their start lands on `seam`.
============================================================================ */

const SCENARIOS = [];
const scenario = (name, fn) => SCENARIOS.push([name, fn]);

/* -- 1a. THE TIGHT RUN: the whole pattern is preserved and offset by D ------ */

scenario('1a tight run', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  const a = add(s, v, 0, 60);
  const b = add(s, v, 60, 60);
  const c = add(s, v, 120, 60);
  const moving = add(s, v, 600, 60);

  const before = snapshot(s);
  const r = commit(s, [moving], 60, v);
  check(`${label} 1a: the insert succeeds`, r.ok, JSON.stringify(r));
  check(`${label} 1a: the dragged clip landed on the seam`, s.clips[moving].start === 60, `${s.clips[moving].start}`);
  assertButtedAgainstPredecessor(`${label} 1a`, s, before, [moving]);

  // On a TIGHT run the stronger property also holds, so it is asserted too —
  // the corrected observable covers both cases, and this is the case where the
  // original draft happened to be right.
  check(
    `${label} 1a: a tight run keeps its whole pattern, offset by D`,
    s.clips[b].start === 120 && s.clips[c].start === 180,
    `b=${s.clips[b].start} c=${s.clips[c].start}`,
  );
  check(`${label} 1a: the clip before the seam did not move`, s.clips[a].start === 0, `${s.clips[a].start}`);
  return s;
});

/* -- 1b. THE GAPPED RUN: gaps are consumed in order ------------------------ */

scenario('1b gapped run', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  //           [0,60) [60,120)  gap 20  [140,200) [200,260)
  const a = add(s, v, 0, 60);
  const b = add(s, v, 60, 60);
  const c = add(s, v, 140, 60);
  const d = add(s, v, 200, 60);
  const moving = add(s, v, 900, 60);

  const before = snapshot(s);
  const r = commit(s, [moving], 60, v);
  check(`${label} 1b: the insert succeeds`, r.ok, JSON.stringify(r));
  const moved = assertButtedAgainstPredecessor(`${label} 1b`, s, before, [moving]);

  // The exact figures §12.7 traced, so the fixture is the one the correction was
  // derived from rather than a paraphrase of it.
  check(`${label} 1b: b took the full requirement`, s.clips[b].start === 120, `${s.clips[b].start}`);
  check(`${label} 1b: c yielded only what was left after the gap`, s.clips[c].start === 180, `${s.clips[c].start}`);
  check(`${label} 1b: d propagated by the remainder`, s.clips[d].start === 240, `${s.clips[d].start}`);
  check(`${label} 1b: a is untouched`, s.clips[a].start === 0, `${s.clips[a].start}`);
  check(
    `${label} 1b: three clips moved and no more`,
    moved.length === 3,
    `moved ${JSON.stringify(moved)}`,
  );
  return s;
});

/* -- 2. A GAP WIDE ENOUGH ABSORBS THE PUSH; nothing beyond it moves -------- */

scenario('2 absorbing gap', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  const a = add(s, v, 0, 60);
  const b = add(s, v, 60, 60);
  // 90 frames of gap, then a clip that must NOT move for a 60-frame insert.
  const c = add(s, v, 210, 60);
  const moving = add(s, v, 600, 60);

  const before = snapshot(s);
  const r = commit(s, [moving], 60, v);
  check(`${label} 2: the insert succeeds`, r.ok, JSON.stringify(r));
  assertButtedAgainstPredecessor(`${label} 2`, s, before, [moving]);
  check(`${label} 2: the occupant at the seam moved only as far as it must`, s.clips[b].start === 120, `${s.clips[b].start}`);
  check(
    `${label} 2: the clip beyond the absorbing gap did NOT move at all`,
    s.clips[c].start === 210,
    `c=${s.clips[c].start} — the push must stop at the first gap wide enough to take it (§12.3). ` +
      'A cascade that keeps going turns a local edit into a whole-track rearrangement.',
  );
  check(`${label} 2: the clip before the seam did not move`, s.clips[a].start === 0, `${s.clips[a].start}`);
  return s;
});

/* -- 3. A PARTIAL GAP absorbs part; the consumed gap is GONE --------------- */

scenario('3 partial gap consumed', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  add(s, v, 0, 60);
  const b = add(s, v, 60, 60);
  const c = add(s, v, 140, 60); // 20-frame gap in front of it
  const moving = add(s, v, 900, 60);

  const before = snapshot(s);
  commit(s, [moving], 60, v);
  assertButtedAgainstPredecessor(`${label} 3`, s, before, [moving]);

  // Positively: the gap is CONSUMED, not carried along. This is the assertion
  // the withdrawn "(duration, gap) is preserved" draft would have contradicted.
  const gapAfter = s.clips[c].start - (s.clips[b].start + s.clips[b].duration);
  check(
    `${label} 3: the partially-absorbing gap is GONE, not preserved`,
    gapAfter === 0,
    `gap is ${gapAfter}. §12.3's cascade CONSUMES gaps as the push travels; a run that carried ` +
      'its gaps along would mean the push had propagated further than required.',
  );
  check(
    `${label} 3: and only the remainder propagated past it`,
    s.clips[c].start - 140 === 40,
    `c moved by ${s.clips[c].start - 140}, expected 40 of the 60 required`,
  );
  return s;
});

/* -- 4. INSERT AT FRAME 0 pushes the whole track (the user's second example) */

scenario('4 insert at frame 0', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  const a = add(s, v, 0, 60);
  const b = add(s, v, 60, 60);
  const c = add(s, v, 120, 60);
  const moving = add(s, v, 400, 90);

  const before = snapshot(s);
  const r = commit(s, [moving], 0, v);
  check(`${label} 4: the insert succeeds`, r.ok, JSON.stringify(r));
  check(`${label} 4: the dragged clip is at frame 0`, s.clips[moving].start === 0, `${s.clips[moving].start}`);
  assertButtedAgainstPredecessor(`${label} 4`, s, before, [moving]);
  check(
    `${label} 4: the whole track pushed right by the clip's own duration`,
    s.clips[a].start === 90 && s.clips[b].start === 150 && s.clips[c].start === 210,
    `${s.clips[a].start},${s.clips[b].start},${s.clips[c].start}`,
  );
  return s;
});

/* -- 5. THE SOURCE GAP IS NOT CLOSED — §12.1, asserted POSITIVELY ---------- */

scenario('5 source gap stays open', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  add(s, v, 0, 60);
  add(s, v, 60, 60);
  const neighbour = add(s, v, 480, 60); // sits immediately before the hole
  const moving = add(s, v, 600, 60);
  // AND a clip AFTER the hole. Without it this scenario cannot see the failure
  // it exists for: closing the source gap pulls DOWNSTREAM clips left, and a
  // fixture whose hole is at the end of the track has nothing downstream to
  // pull. A mutation that closed the gap passed the earlier version of this
  // scenario for exactly that reason.
  const trailing = add(s, v, 800, 60);

  const before = snapshot(s);
  commit(s, [moving], 60, v);
  assertButtedAgainstPredecessor(`${label} 5`, s, before, [moving]);
  check(
    `${label} 5: the clip AFTER the vacated range did NOT slide left into it`,
    s.clips[trailing].start === 800,
    `${s.clips[trailing].start} — the source gap must stay open (§12.1). Closing it re-times ` +
      'everything downstream against markers, subtitles and every other lane, and it makes the ' +
      'gesture irreversible by eye: drag back out and the hole does not reopen.',
  );
  check(
    `${label} 5: the clip before the vacated range did NOT move`,
    s.clips[neighbour].start === 480,
    `${s.clips[neighbour].start} — §12.1 rules that an insert changes only the TARGET side. ` +
      'Closing the source gap re-times everything downstream against markers, subtitles and ' +
      'every other lane, and it makes the gesture irreversible by eye. This is a deliberate ' +
      'absence, which is exactly the kind of thing a later "improvement" removes silently.',
  );
  check(
    `${label} 5: nothing was pulled leftward into the vacated range`,
    Object.values(s.clips).every((c) => c.start !== 540 && c.start !== 600),
    JSON.stringify(Object.values(s.clips).map((c) => c.start).sort((x, y) => x - y)),
  );
  return s;
});

/* -- 6. ONE history entry, and undo restores the document exactly ---------- */

scenario('6 one history entry', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  add(s, v, 0, 60);
  add(s, v, 60, 60);
  add(s, v, 120, 60);
  const moving = add(s, v, 600, 60);

  const wasDocument = documentOf(s);
  const depth = s.history.past.length;
  commit(s, [moving], 60, v);
  check(
    `${label} 6: exactly ONE history entry for the clip and everything it displaced`,
    s.history.past.length === depth + 1,
    `pushed ${s.history.past.length - depth} entries. A rearrangement that undoes in pieces is ` +
      'worse than one that does not undo at all (§12.7).',
  );
  s.undo();
  check(
    `${label} 6: one undo restores the document exactly`,
    documentOf(s) === wasDocument,
    'the document after undo is not the document before the insert',
  );
  return s;
});

/* -- 7. A LOCKED lane in the push set refuses the whole drop --------------- */

scenario('7 locked lane refuses', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  const v2 = s.addTrack('video');
  add(s, v, 0, 60);
  add(s, v, 60, 60);
  add(s, v2, 0, 60);
  const moving = add(s, v, 600, 60);
  s.toggleLock(v);

  const wasDocument = documentOf(s);
  const depth = s.history.past.length;
  const r = commit(s, [moving], 60, v);
  check(
    `${label} 7: a locked lane in the push set refuses`,
    r.ok === false && r.reason === 'locked',
    `${JSON.stringify(r)} — pushing a clip on a locked track IS a write to a locked track (§12.3).`,
  );
  check(
    `${label} 7: and NOTHING moved, on any track`,
    documentOf(s) === wasDocument,
    'a refused insert left the document changed',
  );
  check(
    `${label} 7: and it pushed no history entry`,
    s.history.past.length === depth,
    `pushed ${s.history.past.length - depth}`,
  );
  return s;
});

/* -- 8. A LINKED PAIR inserts on both lanes, with independent push amounts - */

scenario('8 linked pair, independent cascades', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  const at = s.addTrack('audio');
  const addAudio = (start, duration) => add(s, at, start, duration, { streams: 'audio' });

  add(s, v, 0, 60);
  const vb = add(s, v, 60, 60); // V lane is tight after the seam -> must push
  const ab = addAudio(0, 60);
  const aFar = addAudio(600, 60); // A lane has room -> absorbs, pushes nothing
  const mv = add(s, v, 900, 60);
  const ma = addAudio(900, 60);
  s.linkClips([mv, ma]);

  const before = snapshot(s);
  const r = commit(s, [mv], 60, v);
  check(`${label} 8: a linked pair inserts`, r.ok, JSON.stringify(r));
  assertButtedAgainstPredecessor(`${label} 8`, s, before, [mv]);
  check(
    `${label} 8: both members landed at the same start`,
    s.clips[mv].start === 60 && s.clips[ma].start === 60,
    `${s.clips[mv].start},${s.clips[ma].start}`,
  );
  check(`${label} 8: the V lane pushed its occupant`, s.clips[vb].start === 120, `${s.clips[vb].start}`);
  check(
    `${label} 8: the A lane absorbed the insert and pushed NOTHING`,
    s.clips[aFar].start === 600,
    `${s.clips[aFar].start} — each landing track runs its OWN cascade (§12.5); the lanes are ` +
      'allowed to push by different amounts because the PAIR stays together regardless.',
  );
  check(`${label} 8: the A lane occupant before the seam is untouched`, s.clips[ab].start === 0, `${s.clips[ab].start}`);
  return s;
});

/* -- 9. THE PUSH DOES NOT CROSS TRACKS — §12.4 ---------------------------- */

scenario('9 no cross-track push', (commit, label) => {
  const s = fresh();
  const v = s.addTrack('video');
  const v2 = s.addTrack('video');
  add(s, v, 0, 60);
  add(s, v, 60, 60);
  // An identical arrangement on a lane the gesture never touches.
  const o1 = add(s, v2, 60, 60);
  const o2 = add(s, v2, 120, 60);
  const moving = add(s, v, 600, 60);

  const before = snapshot(s);
  commit(s, [moving], 60, v);
  assertButtedAgainstPredecessor(`${label} 9`, s, before, [moving]);
  check(
    `${label} 9: the untouched lane did not move`,
    s.clips[o1].start === 60 && s.clips[o2].start === 120,
    `${s.clips[o1].start},${s.clips[o2].start} — the push applies to the tracks the moving clips ` +
      'actually land on and to no others (§12.4). Markers, subtitles and project timing do not ' +
      'move with it, so shifting every lane moves the sync problem rather than solving it.',
  );
  return s;
});

/* -- 10. clipsByTrack invariants hold afterwards — REUSED, not restated ---- */

/** docs/LINKING.md §12's census, and check-linking's, applied to a post-insert store. */
function assertLaneInvariants(label, s) {
  for (const trackId of s.trackOrder) {
    const ids = s.clipsByTrack[trackId] ?? [];
    for (let i = 1; i < ids.length; i += 1) {
      const p = s.clips[ids[i - 1]];
      const q = s.clips[ids[i]];
      check(`${label}: clipsByTrack is sorted ascending`, q.start >= p.start, JSON.stringify(startsOn(s, trackId)));
      check(
        `${label}: no two clips overlap on a lane`,
        q.start >= p.start + p.duration,
        `${p.start}+${p.duration} then ${q.start} on ${trackId}`,
      );
    }
  }
  const census = new Map();
  for (const c of Object.values(s.clips)) {
    if (c.linkId === undefined) continue;
    census.set(c.linkId, (census.get(c.linkId) ?? 0) + 1);
  }
  for (const [group, n] of census) {
    check(`${label}: no LinkId is carried by fewer than two clips`, n >= 2, `${group} carried by ${n}`);
  }
}

/* ======================================================= THE TWO ENTRY POINTS

   §12.8: the same assertion set, through the drag-shaped action and through the
   command, requiring identical documents out. Both are given the same job in the
   same words — "place these clips so their start lands on `seam`" — and how each
   expresses that is its own business, which is the only difference between them.
============================================================================ */

/** The drag: a delta from where the clip is now, exactly as a drop computes it. */
const commitByDrag = (s, ids, seam, primaryTrackId) =>
  s.insertClips(ids, seam - s.clips[ids[0]].start, 0, primaryTrackId);

/**
 * The keyboard: park the playhead on the seam, select, and let the command work
 * out WHERE — which is the one thing it contributes that the drag gets from the
 * pointer. `selectionInsert` is the command's own delta derivation, including
 * the link-closure anchor rule, and it is exported precisely so the menu item and
 * the command cannot answer differently. If it computed a delta the drag would
 * not have, the document comparison below stops matching.
 *
 * `primaryTrackId` is deliberately ignored here rather than passed through: the
 * command resolves its own, and taking the caller's would hide a disagreement.
 */
const commitByCommand = (s, ids, seam) => {
  s.playhead = seam;
  s.selectMany(ids, 'replace');
  const plan = command.selectionInsert(s);
  if (plan === null) return { ok: false, reason: 'no-selection' };
  return s.insertClips(plan.ids, plan.delta, 0, plan.primaryTrackId);
};

const ENTRY_POINTS = [
  ['drag', commitByDrag],
  ['command', commitByCommand],
];

if (typeof command.selectionInsert !== 'function' || typeof command.insertSelectionAtPlayhead !== 'function') {
  check(
    'CREATIVE §12.8: the keyboard path exists',
    false,
    'src/components/timeline/insertCommand.ts does not export the command. §12.8 is explicit ' +
      'that it ships WITH §12 and not after: a feature reachable only by pointer fails ' +
      "CLAUDE.md's standing instruction that the keyboard is the primary instrument.",
  );
}

const documents = new Map();

for (const [entry, commit] of ENTRY_POINTS) {
  for (const [name, run] of SCENARIOS) {
    const s = run(commit, entry);
    assertLaneInvariants(`${entry} ${name}`, s);
    const doc = documentOf(s);
    if (documents.has(name)) {
      check(
        `both entry points produce an IDENTICAL document — ${name}`,
        documents.get(name) === doc,
        'the drag and the `Insert at playhead` command disagree about what the same insert does. ' +
          'They are meant to be two callers of ONE planner (§12.8); a difference here means there ' +
          `are two cascades, and the second one will drift.\n      drag:    ${documents.get(name)}\n` +
          `      command: ${doc}`,
      );
    } else {
      documents.set(name, doc);
    }
  }
}

/* -- 10b. THE COMMAND IS WIRED TO THE REAL STORE --------------------------

   Everything above drives `selectionInsert` + `insertClips` against the harness
   store, which exercises the command's arithmetic but not the two lines that
   fetch the store and hand the plan over. Those lines are where a keyboard path
   dies silently: `insertSelectionAtPlayhead` could compute a perfect plan and
   never commit it, and every assertion above would still pass.

   So one scenario runs through the REAL exported command, on the REAL store, and
   asserts the document changed. It is deliberately one — the behaviour is
   covered above; what is being proven here is only that the wrapper reaches it. */

{
  const S = command.readStore;
  S().hydrateTimeline({
    tracks: [],
    trackOrder: [],
    clips: [],
    markers: [],
    subtitles: [],
    subtitleStyle: S().subtitleStyle,
  });
  S().hydrateMedia([
    { id: MEDIA, kind: 'video', name: 'insert.mp4', path: '/insert.mp4', durationSeconds: 3333, hasAudio: true, width: 1920, height: 1080 },
  ]);
  const v = S().addTrack('video');
  const mk = (start, duration) => {
    const r = S().addClip({ mediaId: MEDIA, trackId: v, start, duration });
    if (!r.ok) throw new Error(`real-store addClip refused: ${JSON.stringify(r)}`);
    return r.id;
  };
  mk(0, 60);
  const b = mk(60, 60);
  const moving = mk(600, 60);

  S().playhead = 60;
  S().selectMany([moving], 'replace');
  S().setNotice(null);
  command.insertSelectionAtPlayhead();

  check(
    '10b the exported command actually commits through the real store',
    S().clips[moving].start === 60 && S().clips[b].start === 120,
    `moving=${S().clips[moving].start} occupant=${S().clips[b].start}, notice=${JSON.stringify(S().notice)} — ` +
      '`insertSelectionAtPlayhead` computed a plan and did not commit it, or never ran. A ' +
      'keyboard path that plans and does not act passes every arithmetic assertion there is.',
  );
  check(
    '10b and it raised no refusal notice on a legal insert',
    S().notice === null,
    JSON.stringify(S().notice),
  );

  // And it refuses HONESTLY with nothing selected, rather than throwing or
  // silently doing nothing — §12.8's "refuses whole, same notice channel".
  S().clearSelection();
  S().setNotice(null);
  command.insertSelectionAtPlayhead();
  check(
    '10b with nothing selected it refuses through the notice channel',
    S().notice !== null && /select/i.test(S().notice.message ?? ''),
    JSON.stringify(S().notice),
  );
}

/* -- 9. `snapEnabled` DOES NOT REACH `insertClips` — INVERTED, deliberately ---

   This assertion used to say the opposite: snap off means no insert, the
   overlapping drop refuses. That wording asserted a coupling which has now been
   removed on purpose, and the reasoning is worth carrying because the assertion
   is the enforcement of it.

   The `!s.snapEnabled` branch inside `planInsert` was ALREADY DEAD for the drag
   path — `applyMove` reaches `planInsert` only when `snapped.edge === 'start'`
   with a guide, and `snapTranslation` returns `edge: null` when snapping is
   suppressed — so its only live effect was to cripple the KEYBOARD command,
   which has no aim for snapping to assist. `snapEnabled` is a positioning
   preference, not a safety, and letting it also disable a named command gives
   one control two behaviours. The planner withdrew its own sentence on the other
   side too: §12.2 had called snap-off "the only way to get the old
   refuse-on-overlap behaviour back, which is worth having", and struck it as a
   rationalisation of a side effect rather than a designed promise.

   So the assertion is now the stronger one, and it fails loudly the day anyone
   reintroduces the check:

     > `insertClips` produces a BYTE-IDENTICAL document with `snapEnabled` true
     > and false.

   Swept over every scenario rather than asserted once, because a coupling
   reintroduced in one branch of the cascade would hide from a single fixture.

   THE DRAG HALF IS NOT HERE, and must not be faked: with snapping off an
   overlapping DRAG must still refuse and no caret may appear. That is a property
   of the gesture — of `snapTranslation` returning `edge: null` and `applyMove`
   never calling `planInsert` — and it belongs to `verify`, who can perform it.
   A gate that asserted it from the store would be asserting something it cannot
   see. */

{
  const differing = [];
  for (const [name, run] of SCENARIOS) {
    const withSnap = quietly(() => documentOf(run(commitByDrag, `snap-on ${name}`)));
    const withoutSnap = quietly(() =>
      documentOf(
        run((s, ids, seam, primaryTrackId) => {
          s.setSnapEnabled(false);
          return commitByDrag(s, ids, seam, primaryTrackId);
        }, `snap-off ${name}`),
      ),
    );
    if (withSnap !== withoutSnap) differing.push({ name, withSnap, withoutSnap });
  }
  check(
    `9 snapEnabled does not change what insertClips does (${SCENARIOS.length} scenarios)`,
    differing.length === 0,
    'the document differs with the snap toggle off, in ' +
      `${differing.length} of ${SCENARIOS.length} scenarios. \`snapEnabled\` is a POSITIONING ` +
      'PREFERENCE and must not reach `insertClips`: the drag path already gates itself on ' +
      "`snapped.edge === 'start'`, so a check inside `planInsert` is DEAD for the drag and live " +
      'only against the keyboard command — which has no aim for snapping to assist. Deleting the ' +
      '`!s.snapEnabled` branch from `planInsert` is the fix.' +
      (differing.length === 0
        ? ''
        : `\n      first: ${differing[0].name}\n      on:  ${differing[0].withSnap}\n      off: ${differing[0].withoutSnap}`),
  );
}

/* -- 11. ONE IMPLEMENTATION, TWO CALLERS — SWEPT, not asserted once ---------

   "One implementation, two callers" appears as a COMMENT in `planMove`'s header,
   in `planTrim`'s, and in §12.7's own prose. A comment is not an assertion. The
   ghost renders `planInsert`'s output on every pointermove and the drop commits
   `insertClips`; if those two ever disagree the preview shows one edit and the
   drop performs another, which is the failure this whole document is about.

   Swept across every landing frame in a range, so it fails AT THE FRAME where a
   divergence starts rather than at whichever single frame a fixture happened to
   pick. Adopted from state's own probe. It pairs with the both-entry-points
   comparison above: that one stops a third caller becoming a second cascade,
   this one stops the planner and the commit drifting apart. */

{
  const FROM = 0;
  const TO = 260;
  let mismatches = 0;
  let firstBad = null;

  for (let at = FROM; at <= TO; at += 1) {
    const s = fresh();
    const v = s.addTrack('video');
    add(s, v, 0, 60);
    add(s, v, 60, 60);
    add(s, v, 140, 60); // the gapped run, so the sweep crosses a consumed gap
    add(s, v, 200, 60);
    const moving = add(s, v, 900, 60);
    const delta = at - 900;

    const plan = timeline.planInsert(s, [moving], delta, 0, v);
    const result = s.insertClips([moving], delta, 0, v);

    if (plan.ok !== result.ok) {
      mismatches += 1;
      firstBad ??= `frame ${at}: planInsert says ${plan.ok ? 'ok' : plan.reason}, insertClips says ${result.ok ? 'ok' : result.reason}`;
      continue;
    }
    if (!plan.ok) continue;

    // Everything the ghost said would move, at the position it said it would be.
    for (const c of [...plan.clips, ...plan.pushed]) {
      const actual = s.clips[c.id];
      if (actual === undefined || actual.start !== c.start || actual.duration !== c.duration) {
        mismatches += 1;
        firstBad ??=
          `frame ${at}: the plan put clip ${c.id} at ${c.start}+${c.duration}, the store holds ` +
          `${actual === undefined ? 'nothing' : `${actual.start}+${actual.duration}`}`;
      }
    }
    // …and nothing moved that the plan did not name. A commit that displaced a
    // clip the ghost never drew is the same defect mirrored: the preview would
    // understate the edit rather than overstate it.
    const named = new Set([...plan.clips, ...plan.pushed].map((c) => c.id));
    for (const id of s.clipsByTrack[v] ?? []) {
      if (named.has(id)) continue;
      const was = [0, 60, 140, 200, 900];
      if (!was.includes(s.clips[id].start)) {
        mismatches += 1;
        firstBad ??= `frame ${at}: clip ${id} moved to ${s.clips[id].start}, and no plan entry named it`;
      }
    }
  }

  check(
    `11 planInsert and insertClips agree at every landing frame ${FROM}..${TO}`,
    mismatches === 0,
    `${mismatches} divergence(s). The ghost renders the PLAN and the drop commits the ACTION; ` +
      'where they differ, the preview shows one edit and the drop performs another — which is ' +
      `the failure CREATIVE opens by refusing.\n      first: ${firstBad}`,
  );
}

/* -- 12. AN END-EDGE SNAP IS AN ORDINARY ABUT, NOT AN INSERT — §12.2 -------

   The amendment §12.2 records: read by itself, "the start lands on a boundary"
   makes EVERY abutting drop an insert, and butting one clip's end against the
   next clip's start is the most common snap in the application. Every ordinary
   assembly edit would have rearranged the timeline.

   A clip dropped so its END meets an occupant's START does not overlap, so it
   must simply land — pushing nothing. */

{
  const s = fresh();
  const v = s.addTrack('video');
  const occupant = add(s, v, 200, 60);
  const later = add(s, v, 260, 60);
  const moving = add(s, v, 600, 60);

  const before = snapshot(s);
  const r = commitByDrag(s, [moving], 140, v); // ends exactly at 200
  check('12 end-edge abut: the drop succeeds', r.ok, JSON.stringify(r));
  check('12 end-edge abut: the clip landed where asked', s.clips[moving].start === 140, `${s.clips[moving].start}`);
  const moved = Object.keys(snapshot(s)).filter(
    (id) => before[id] !== undefined && before[id].start !== snapshot(s)[id].start && id !== moving,
  );
  check(
    '12 end-edge abut: NOTHING was pushed',
    moved.length === 0,
    `${JSON.stringify(moved)} moved. A clip whose END snaps to the next clip's start is an ` +
      'ordinary butt, not an insert (§12.2) — treating it as one would rearrange the timeline on ' +
      'every assembly edit.',
  );
  check(
    '12 end-edge abut: the occupants are exactly where they were',
    s.clips[occupant].start === 200 && s.clips[later].start === 260,
    `${s.clips[occupant].start},${s.clips[later].start}`,
  );
}

/* ------------------------------------------------------------------- report */

if (failures.length > 0) {
  keepBundle = true;
  console.error(`\ninsert: ${failures.length} failure${failures.length > 1 ? 's' : ''}.\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(
    `\n  the bundled source this ran against is preserved at:\n    ${dir}\n` +
      '  It is deleted on a pass and kept on a failure, so what was actually compiled can be ' +
      'read rather than guessed at — CREATIVE §7.4 entry 8.\n',
  );
  process.exit(1);
}

console.log(
  `insert: ok — ${SCENARIOS.length} scenarios x 2 entry points (drag and command) producing identical ` +
    'documents; every clip that ' +
    'moved is butted against its predecessor and no duration changed; gaps absorb and are ' +
    'consumed; the source gap stays open; one history entry; locked lane refuses whole; no ' +
    'cross-track push; snapEnabled changes nothing; end-edge abuts are ordinary drops',
);

/* EXPLICIT, and not a formality. This gate imports the REAL store to drive the
   keyboard command (10b), and constructing it leaves the event loop with
   something to wait on — so the script finishes its work and then simply never
   exits. Under a runner that kills it on a timeout, the buffered stdout is lost
   with it: the gate reports NOTHING, having passed. That is worse than a
   failure, because it looks like a hang in the code under test. */
process.exit(0);
