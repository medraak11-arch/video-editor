#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-linking.mjs — docs/LINKING.md §12.

   Run:  node scripts/check-linking.mjs

   The one invariant this whole feature rests on is that a LinkId is never
   carried by fewer than two clips. It is enforced at a single choke point
   (`withClips`), which means every mutation in §5 depends on that pass firing
   and on nobody writing a group behind its back. A census after every scenario
   is the assertion that catches a mistake anywhere in §5, so it runs after each
   one and — for a detach — on every intermediate `set`.

   No test framework: esbuild (already a vite dependency) bundles the modules,
   and the slice creator is driven with a minimal fake store, exactly as
   check-timeline-guards.mjs does.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 've-linking-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

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
const project = await bundle('../src/lib/project.ts', 'project');
const shortcuts = await bundle('../src/keyboard/shortcuts.ts', 'shortcuts');

/* ------------------------------------------------------------------ asserts */

const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(detail ? `${name} — ${detail}` : name);
};

/* --------------------------------------------------------------- fake store */

const MEDIA = 'm_check';

/**
 * A fresh store per scenario, so one scenario's document can never explain
 * another's result. `set` is wrapped: every intermediate write is censused, so a
 * group of one that exists for the length of one loop iteration is still a
 * failure.
 */
function fresh(label) {
  const state = {};
  const get = () => state;
  const set = (partial) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial);
    const bad = censusViolations(state);
    if (bad.length > 0) {
      check(`${label}: no group of one at any intermediate set`, false, bad.join(', '));
    }
  };

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
    name: 'check.mp4',
    status: 'ready',
    durationFrames: 6000,
    durationSeconds: 200,
    hasAudio: true,
  };
  return state;
}

/** Every LinkId in the store carried by fewer than two clips. Empty = the invariant holds. */
function censusViolations(state) {
  const census = new Map();
  for (const clip of Object.values(state.clips ?? {})) {
    if (clip.linkId === undefined) continue;
    census.set(clip.linkId, (census.get(clip.linkId) ?? 0) + 1);
  }
  const bad = [];
  for (const [group, n] of census) if (n < 2) bad.push(`${group} carried by ${n}`);
  return bad;
}

const invariant = (label, state) =>
  check(`${label}: no LinkId is carried by fewer than two clips`, censusViolations(state).length === 0,
    censusViolations(state).join(', '));

const groupsOf = (state) => {
  const map = new Map();
  for (const clip of Object.values(state.clips)) {
    if (clip.linkId === undefined) continue;
    const list = map.get(clip.linkId);
    if (list) list.push(clip.id);
    else map.set(clip.linkId, list ?? [clip.id]);
  }
  return map;
};

/** V-then-A lanes, in a known order, plus the ids of the ones the scenario asked for. */
function lanes(state, videoCount = 1, audioCount = 1) {
  const video = [];
  const audio = [];
  for (let i = 0; i < videoCount; i += 1) video.push(state.addTrack('video'));
  for (let i = 0; i < audioCount; i += 1) audio.push(state.addTrack('audio'));
  return { video, audio };
}

const add = (state, trackId, start, duration, streams) => {
  const r = state.addClip({ mediaId: MEDIA, trackId, start, duration, streams });
  if (!r.ok) throw new Error(`addClip refused: ${JSON.stringify(r)}`);
  return r.id;
};

/* ------------------------------------------------- 2, 3: detachAudio links */

{
  const s = fresh('detach');
  const { video } = lanes(s, 1, 1);
  const clipId = add(s, video[0], 0, 100);
  s.selectMany([clipId], 'replace');
  s.detachAudio();

  const groups = groupsOf(s);
  check('2. detachAudio produces exactly one group', groups.size === 1, `${groups.size}`);
  const members = [...groups.values()][0] ?? [];
  check('2. that group holds exactly two clips', members.length === 2, `${members.length}`);
  check(
    '2. the two members are the picture and its twin',
    members.length === 2 &&
      members.map((id) => s.clips[id].streams).sort().join(',') === 'audio,video',
    JSON.stringify(members.map((id) => s.clips[id].streams)),
  );
  // The selection is closed AFTER the detach, not just after a selectMany. The
  // group is minted under a selection that was made before it existed, so
  // nothing re-runs unless detachAudio re-closes it — and the inspector counts
  // within the selection, so a miss here reads `Linked, 1 clips` to the user.
  check('2. the selection is a closure after the detach', s.selection.size === 2, `${s.selection.size}`);
  check('2. and it holds both members', members.every((id) => s.selection.has(id)), JSON.stringify([...s.selection]));
  invariant('2. detach', s);

  // 3 — a detach on a clip that is already grouped grows the group rather than
  // starting a second one.
  const other = add(s, video[0], 400, 100);
  const picture = members.find((id) => s.clips[id].streams === 'video');
  s.selectMany([picture, other], 'replace');
  s.linkClips();
  check('3. link joined the picture and the third clip', groupsOf(s).size === 1, `${groupsOf(s).size}`);
  s.selectMany([other], 'replace');
  s.detachAudio();
  const after = groupsOf(s);
  check('3. still one group after the second detach', after.size === 1, `${after.size}`);
  check(
    '3. the group grew to four (pair + third + its twin)',
    ([...after.values()][0] ?? []).length === 4,
    `${([...after.values()][0] ?? []).length}`,
  );
  invariant('3. detach into an existing group', s);
}

/* ------------------------------------------- 4: the dissolve fires on removeTrack */

{
  const s = fresh('dissolve');
  const { video, audio } = lanes(s, 1, 1);
  const v = add(s, video[0], 0, 100);
  const a = add(s, audio[0], 0, 100, 'audio');
  s.selectMany([v, a], 'replace');
  s.linkClips();
  check('4. the pair is linked', s.clips[v].linkId !== undefined && s.clips[v].linkId === s.clips[a].linkId);
  s.removeTrack(audio[0]);
  check('4. the survivor carries no linkId', s.clips[v].linkId === undefined, JSON.stringify(s.clips[v].linkId));
  invariant('4. removeTrack', s);
}

/* -------------------------------------------- 4b: the closure survives history */

{
  const s = fresh('history');
  const { video, audio } = lanes(s, 1, 1);
  const v = add(s, video[0], 0, 100);
  const a = add(s, audio[0], 0, 100, 'audio');
  s.selectMany([v, a], 'replace');
  s.linkClips();
  s.unlinkClips();
  s.selectMany([v], 'replace');
  check('4b. after unlink, one clip selects alone', s.selection.size === 1, `${s.selection.size}`);
  s.undo();
  check('4b. undo re-selects the whole group', s.selection.size === 2, `${s.selection.size}`);
  check('4b. both members are selected', s.selection.has(v) && s.selection.has(a));
  s.deleteSelection();
  check('4b. deleteSelection removed both', Object.keys(s.clips).length === 0, JSON.stringify(Object.keys(s.clips)));
  invariant('4b. history', s);
}

/* ------------------------------------------------------------ 5, 5b: split */

{
  const s = fresh('split');
  const { video, audio } = lanes(s, 1, 1);
  const v = add(s, video[0], 0, 100);
  const a = add(s, audio[0], 0, 100, 'audio');
  s.selectMany([v, a], 'replace');
  s.linkClips();
  const original = s.clips[v].linkId;
  s.playhead = 50;
  s.clearSelection();
  s.splitAtPlayhead();

  check('5. four clips after the split', Object.keys(s.clips).length === 4, `${Object.keys(s.clips).length}`);
  const groups = groupsOf(s);
  check('5. two groups', groups.size === 2, `${groups.size}`);
  check('5. both groups hold two clips', [...groups.values()].every((m) => m.length === 2), JSON.stringify([...groups.values()]));
  check('5. the left group keeps the original id', groups.has(original), `${original}`);
  check(
    '5. the left group is the two left halves',
    (groups.get(original) ?? []).every((id) => s.clips[id].start === 0),
    JSON.stringify((groups.get(original) ?? []).map((id) => s.clips[id].start)),
  );
  invariant('5. split', s);
}

{
  // The playhead crosses only one member; the other ends before it, so it stays
  // in the original group and the right side is a group of one that dissolves.
  const s = fresh('split-one');
  const { video, audio } = lanes(s, 1, 1);
  const v = add(s, video[0], 0, 100);
  const a = add(s, audio[0], 0, 40, 'audio');
  s.selectMany([v, a], 'replace');
  s.linkClips();
  const original = s.clips[v].linkId;
  s.playhead = 50;
  s.clearSelection();
  s.splitAtPlayhead();
  const groups = groupsOf(s);
  check('5. one crossed member yields exactly one group', groups.size === 1, `${groups.size}`);
  check('5. that group is the original, with two members', (groups.get(original) ?? []).length === 2, JSON.stringify([...groups]));
  invariant('5. split with one crossed member', s);
}

{
  // 5b — whole-group under a lock.
  const s = fresh('split-lock');
  const { video, audio } = lanes(s, 2, 1);
  const v = add(s, video[0], 0, 100);
  const a = add(s, audio[0], 0, 100, 'audio');
  const loose = add(s, video[1], 0, 100);
  s.selectMany([v, a], 'replace');
  s.linkClips();
  s.toggleLock(audio[0]);
  s.playhead = 50;
  s.clearSelection();
  s.notice = null;
  s.splitAtPlayhead();

  check('5b. the locked pair did not split', s.clips[v].duration === 100, `${s.clips[v].duration}`);
  check('5b. the unlinked clip elsewhere still split', s.clips[loose].duration === 50, `${s.clips[loose].duration}`);
  check(
    '5b. the notice names the linked lock',
    s.notice?.title === 'Could not split' && s.notice?.message === 'A linked clip is on a locked track',
    JSON.stringify(s.notice),
  );
  invariant('5b. split under a lock', s);
}

{
  // 5b — a locked member that ends before the playhead is never written, so it
  // is not a lock on us.
  const s = fresh('split-lock-left');
  const { video, audio } = lanes(s, 1, 1);
  const v = add(s, video[0], 0, 100);
  const a = add(s, audio[0], 0, 40, 'audio');
  s.selectMany([v, a], 'replace');
  s.linkClips();
  s.toggleLock(audio[0]);
  s.playhead = 50;
  s.clearSelection();
  s.notice = null;
  s.splitAtPlayhead();
  check('5b. a locked member left of the cut does not block', s.clips[v].duration === 50, `${s.clips[v].duration}`);
  check('5b. and raises no notice', s.notice === null, JSON.stringify(s.notice));
  invariant('5b. split with a locked left member', s);
}

/* -------------------------------------------------------------- 6: planMove */

{
  const s = fresh('planMove');
  const { video, audio } = lanes(s, 2, 1);
  const v = add(s, video[0], 0, 100);
  const a = add(s, audio[0], 0, 100, 'audio');
  s.selectMany([v, a], 'replace');
  s.linkClips();

  const lane = s.trackOrder.filter((id) => s.tracks[id].kind === 'video');
  const from = lane.indexOf(s.clips[v].trackId);
  const to = lane.indexOf(video[1]);

  const plan = timeline.planMove(s, [v], 10, 0, s.clips[v].trackId);
  check('6. planMove closes its own moving set', plan.ok && plan.clips.length === 2, JSON.stringify(plan));

  const off = timeline.planMove(s, [v], 0, 5, s.clips[v].trackId);
  check('6. a vertical delta past the end of the lane is no-track', off.ok === false && off.reason === 'no-track', JSON.stringify(off));

  const missing = timeline.planMove(s, [v], 0, 1, undefined);
  check('6. an unresolved primary track fails closed', missing.ok === false && missing.reason === 'no-track', JSON.stringify(missing));

  const vertical = timeline.planMove(s, [v], 0, to - from, s.clips[v].trackId);
  const audioPlanned = vertical.ok ? vertical.clips.find((c) => c.id === a) : null;
  const videoPlanned = vertical.ok ? vertical.clips.find((c) => c.id === v) : null;
  check('6. the video member changes lane', videoPlanned?.trackId === video[1], JSON.stringify(videoPlanned?.trackId));
  check(
    '6. the audio member keeps its trackId under a video-primary vertical delta',
    audioPlanned?.trackId === audio[0],
    JSON.stringify(audioPlanned?.trackId),
  );
  check('6. planMove mutated nothing', s.clips[v].start === 0 && s.clips[v].trackId === video[0]);
  invariant('6. planMove', s);
}

/* -------------------------------------------------------------- 7: planTrim */

{
  const s = fresh('planTrim');
  const { video, audio } = lanes(s, 1, 1);
  const v = add(s, video[0], 100, 100);
  const a = add(s, audio[0], 100, 100, 'audio');
  s.selectMany([v, a], 'replace');
  s.linkClips();

  const plan = timeline.planTrim(s, v, 'in', 140);
  check('7. planTrim returns both members', plan.ok && plan.clips.length === 2, JSON.stringify(plan));
  if (plan.ok) {
    const deltas = plan.clips.map((c) => c.start - s.clips[c.id].start);
    const durations = plan.clips.map((c) => c.duration - s.clips[c.id].duration);
    check('7. identical start delta', new Set(deltas).size === 1 && deltas[0] === 40, JSON.stringify(deltas));
    check('7. identical duration delta', new Set(durations).size === 1 && durations[0] === -40, JSON.stringify(durations));
  }
  invariant('7. planTrim', s);
}

/* ------------------------------------------------ 8, 8b, 8c: ripple delete */

{
  // (i) removals on both members' lanes, of different lengths: the group takes
  // the larger, and both members move by it.
  const s = fresh('ripple-both');
  const { video, audio } = lanes(s, 1, 1);
  const l1 = add(s, video[0], 0, 100);
  const l2 = add(s, audio[0], 0, 40, 'audio');
  const g1 = add(s, video[0], 500, 100);
  const g2 = add(s, audio[0], 500, 100, 'audio');
  s.selectMany([g1, g2], 'replace');
  s.linkClips();
  s.selectMany([l1, l2], 'replace');
  s.rippleDelete();
  check('8i. both members took the larger shift', s.clips[g1].start === 400 && s.clips[g2].start === 400,
    `${s.clips[g1].start} / ${s.clips[g2].start}`);
  check('8i. the offset between members is unchanged', s.clips[g1].start === s.clips[g2].start);
  invariant('8i. ripple with removals on both lanes', s);
}

{
  // (ii) a removal on only one member's lane: the group takes 0, so neither moves.
  const s = fresh('ripple-one');
  const { video, audio } = lanes(s, 1, 1);
  const l1 = add(s, video[0], 0, 100);
  const g1 = add(s, video[0], 500, 100);
  const g2 = add(s, audio[0], 500, 100, 'audio');
  s.selectMany([g1, g2], 'replace');
  s.linkClips();
  s.selectMany([l1], 'replace');
  s.rippleDelete();
  check('8ii. the group held still', s.clips[g1].start === 500 && s.clips[g2].start === 500,
    `${s.clips[g1].start} / ${s.clips[g2].start}`);
  invariant('8ii. ripple with a removal on one lane', s);
}

{
  // 8b — the §2 sting case: one member before the gap, one after.
  const s = fresh('ripple-sting');
  const { video } = lanes(s, 1, 0);
  const s1 = add(s, video[0], 0, 100);
  const middle = add(s, video[0], 200, 100);
  const s2 = add(s, video[0], 1200, 100);
  s.selectMany([s1, s2], 'replace');
  s.linkClips();
  s.selectMany([middle], 'replace');
  s.notice = null;
  s.rippleDelete();
  check('8b. the sting pair did not move', s.clips[s1].start === 0 && s.clips[s2].start === 1200,
    `${s.clips[s1].start} / ${s.clips[s2].start}`);
  check('8b. the middle clip was removed', s.clips[middle] === undefined);
  check('8b. and it raised no notice', s.notice === null, JSON.stringify(s.notice));
  invariant('8b. the sting case', s);
}

{
  // 8c — every member downstream, on lanes that freed different amounts, where
  // the larger shift does not fit.
  const s = fresh('ripple-refuse');
  const { video, audio } = lanes(s, 1, 1);
  const l1 = add(s, video[0], 0, 100);
  const l2 = add(s, audio[0], 0, 20, 'audio');
  const blocker = add(s, audio[0], 100, 340, 'audio');
  const g1 = add(s, video[0], 500, 100);
  const g2 = add(s, audio[0], 500, 100, 'audio');
  s.selectMany([g1, g2], 'replace');
  s.linkClips();
  s.selectMany([l1, l2], 'replace');
  s.notice = null;
  const beforeStarts = Object.fromEntries(Object.values(s.clips).map((c) => [c.id, c.start]));
  s.rippleDelete();

  check('8c. state is unchanged', Object.values(s.clips).every((c) => c.start === beforeStarts[c.id]),
    JSON.stringify(Object.values(s.clips).map((c) => [c.name, c.start])));
  check('8c. nothing was removed', s.clips[l1] !== undefined && s.clips[l2] !== undefined);
  check('8c. the notice names a clip and the remedy',
    s.notice?.title === 'Could not ripple delete' &&
      s.notice.message.includes(s.clips[g2].name) &&
      s.notice.message.includes('unlink'),
    JSON.stringify(s.notice));
  check('8c. the blocker is still where it was', s.clips[blocker].start === 100, `${s.clips[blocker].start}`);
  invariant('8c. a ripple that cannot close', s);
}

/* --------------------------------------------- 8d: delete is group-atomic */

for (const action of ['deleteSelection', 'rippleDelete']) {
  const s = fresh(`delete-lock-${action}`);
  const { video, audio } = lanes(s, 1, 1);
  const v = add(s, video[0], 0, 100);
  const a = add(s, audio[0], 0, 100, 'audio');
  s.selectMany([v, a], 'replace');
  s.linkClips();
  const group = s.clips[v].linkId;
  s.toggleLock(audio[0]);
  s.selectMany([v], 'replace');
  s.notice = null;
  s[action]();
  check(`8d. ${action} left both clips present`, s.clips[v] !== undefined && s.clips[a] !== undefined);
  check(`8d. ${action} left both carrying the same linkId`,
    s.clips[v]?.linkId === group && s.clips[a]?.linkId === group,
    JSON.stringify([s.clips[v]?.linkId, s.clips[a]?.linkId]));
  check(`8d. ${action} says which`,
    s.notice?.title === 'Could not delete' && s.notice?.message === 'A linked clip is on a locked track',
    JSON.stringify(s.notice));
  invariant(`8d. ${action} under a lock`, s);
}

/* ------------------------------------------------------ 8e: group speed */

{
  const s = fresh('speed');
  const { video, audio } = lanes(s, 1, 1);
  const v = add(s, video[0], 0, 100);
  const a = add(s, audio[0], 0, 100, 'audio');
  s.selectMany([v, a], 'replace');
  s.linkClips();
  const ok = s.updateClipProperties([v], { speed: 2 });
  check('8e. a group speed change is accepted', ok.ok === true, JSON.stringify(ok));
  check('8e. both members kept equal duration', s.clips[v].duration === s.clips[a].duration && s.clips[v].duration === 50,
    `${s.clips[v].duration} / ${s.clips[a].duration}`);
  check('8e. both members kept equal start', s.clips[v].start === s.clips[a].start && s.clips[v].start === 0);
  invariant('8e. group speed', s);

  s.toggleLock(audio[0]);
  const durationBefore = s.clips[v].duration;
  const refused = s.updateClipProperties([v], { speed: 4 });
  check('8e. a locked member refuses the whole call', refused.ok === false && refused.reason === 'locked', JSON.stringify(refused));
  check('8e. and changes nothing', s.clips[v].duration === durationBefore, `${s.clips[v].duration}`);
  invariant('8e. group speed under a lock', s);
}

/* ------------------------------------------------------- 9: migrateProject */

{
  const track = { id: 't_a', kind: 'video', index: 1, label: 'V1', height: 64, muted: false, locked: false, visible: true };
  const gone = { id: 't_gone', kind: 'video', index: 2, label: 'V2', height: 64, muted: false, locked: false, visible: true };
  const properties = { scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1, speed: 1, volume: 1 };
  const clip = (id, trackId, linkId) => ({
    id, mediaId: MEDIA, trackId, start: 0, duration: 10, mediaIn: 0, name: id, properties,
    ...(linkId !== undefined ? { linkId } : {}),
  });

  const kept1 = clip('c_1', 't_a', 'g_keep');
  const kept2 = clip('c_2', 't_a', 'g_keep');
  const orphan = clip('c_3', 't_a', 'g_orphan');
  const partner = clip('c_4', 't_gone', 'g_orphan'); // its track is dropped below
  const plain = clip('c_5', 't_a');

  const raw = {
    version: 1, name: 'p', fps: 30, width: 1920, height: 1080,
    media: [], tracks: [track], trackOrder: ['t_a'],
    clips: [kept1, kept2, orphan, partner, plain], markers: [], savedAt: '2026-01-01T00:00:00.000Z',
  };
  void gone;

  const out = project.migrateProject(raw);
  const byId = Object.fromEntries((out?.clips ?? []).map((c) => [c.id, c]));
  check('9. a clip on a dropped track is gone', byId.c_4 === undefined);
  check('9. a linkId held by two survivors is kept', byId.c_1?.linkId === 'g_keep' && byId.c_2?.linkId === 'g_keep',
    JSON.stringify([byId.c_1?.linkId, byId.c_2?.linkId]));
  check('9. a linkId held by one survivor is dropped', byId.c_3 !== undefined && !('linkId' in byId.c_3),
    JSON.stringify(byId.c_3));
  check('9. an untouched clip keeps its object identity', byId.c_1 === kept1 && byId.c_5 === plain);
}

/* ---------------------------------------------------- 10: one row per combo */

{
  const clashes = [];
  for (const [combo, rows] of shortcuts.SHORTCUTS_BY_COMBO) {
    if (rows.length !== 1) clashes.push(`${combo} -> ${rows.map((r) => r.id).join(', ')}`);
  }
  check('10. every combo maps to exactly one row', clashes.length === 0, clashes.join(' | '));
  check('10. Ctrl+L is bound to edit.link',
    shortcuts.SHORTCUTS_BY_COMBO.get('Ctrl+L')?.[0]?.id === 'edit.link');
  check('10. Ctrl+Shift+L is bound to edit.unlink',
    shortcuts.SHORTCUTS_BY_COMBO.get('Ctrl+Shift+L')?.[0]?.id === 'edit.unlink');
}

/* ------------------------------------------- 11: Alt still means one thing */

{
  const source = readFileSync(
    fileURLToPath(new URL('../src/components/timeline/useTimelineInteraction.ts', import.meta.url)),
    'utf8',
  );
  const assigned = [...source.matchAll(/altHeld\.current\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  check('11. altHeld is written exactly five times', assigned.length === 5, JSON.stringify(assigned));
  const want = ['event.altKey', 'event.altKey', 'event.altKey', 'false', 'true'];
  check('11. and the assigned forms are exactly {event.altKey x3, true, false}',
    JSON.stringify([...assigned].sort()) === JSON.stringify(want),
    JSON.stringify([...assigned].sort()));

  // No new modifier read in the three gesture bodies: a drag modifier has no
  // control to live on and no registry row to be listed as, so slipping a member
  // out of a group is a named command instead (docs/LINKING.md §6).
  for (const fn of ['applyMove', 'applyTrim', 'endGesture']) {
    const at = source.indexOf(`const ${fn} = useCallback(`);
    const end = source.indexOf('\n  );', at);
    const body = at >= 0 && end > at ? source.slice(at, end) : '';
    check(`11. ${fn} was found in the source`, body !== '');
    check(`11. ${fn} reads no event modifier`, !/event\.(altKey|ctrlKey|shiftKey)/.test(body), body.match(/event\.\w+Key/g)?.join(', ') ?? '');
  }
}

/* ------------------------------------------------------------------- report */

if (failures.length > 0) {
  console.error(`linking: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error('\ndocs/LINKING.md §12 — a LinkId must never be carried by fewer than two clips.');
  process.exit(1);
}

console.log('linking: ok (group invariant holds across detach, split, delete, ripple, trim, move and history)');
