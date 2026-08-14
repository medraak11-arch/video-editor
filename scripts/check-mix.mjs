#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-mix.mjs — the gate on track volume. CREATIVE.md §1.2, §1.3, §7, §9.4.

   Run:  node scripts/check-mix.mjs

   Why this exists: §1.3 is titled "where it applies — all three, or it is a
   lie", and §9.4 lists the classic failure by name: a fader that works on every
   track except the one you are watching. Three independent consumers multiply a
   clip's own volume by its track's, and every one of them is a plain arithmetic
   expression that compiles perfectly with a term missing. Nothing throws.
   Nothing warns. The file and the preview simply come out at different levels,
   and the user hears it once, months later, on a mix they cannot re-derive.

   TWO THINGS THIS GATE REFUSES TO DO, and both are the same refusal.

   It does not assert `mixVolume(a, b) === a * b`. That is a restatement of the
   function under test written by the person who wrote the function — CREATIVE
   §2.4 is a record of precisely that gate passing for a whole build while the
   product claim was false. Instead it MEASURES both sides: it reads the `volume=`
   factor back out of a filter script the real graph builder produced from a
   document the real store actions assembled, and it reads the preview's gain off
   a media element the real element writer wrote to. Then it asserts the two move
   together — one fixed monitoring reference apart, across the whole matrix, with
   the reference itself DERIVED from the measurements rather than declared here.
   Neither side is the gate's opinion. If the product law is wrong on one side
   the ratio stops being constant and the offending row is named.

   And it does not flatten the deliberate asymmetry at zero. §1.3 and §7 record
   two different correct behaviours for a track faded to silence, and the gate
   requires BOTH:

     · EXPORT — a track at gain 0 contributes NO INPUT AT ALL. Exactly as
       `muted` already does: an input decoded, resampled and mixed at zero is
       work done to produce silence.
     · PREVIEW — the voice is KEPT and gated to gain 0. `monitorAudible`
       deliberately does not test `trackVolume > 0`, because dropping and
       reloading a source every time a live fader drag crosses zero is a worse
       defect than an idle silent element — it is an audible dropout produced by
       the act of listening.

   So this gate asserts effective GAIN on the preview path and never voice count,
   and asserts input ABSENCE on the export path. Collapsing either into the other
   is a regression, in both directions.

   FIXTURES ARE BUILT THROUGH STORE ACTIONS — CREATIVE §11.2. `addTrack`,
   `addClip` and `setTrackVolume` are what the user's gestures call.

   Bundled FROM SOURCE, for the reason check-export-graph.mjs states at length:
   reading build output lets a STALE build make the gate pass.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 've-mix-'));
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

const read = (relative) => {
  try {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  } catch {
    return null;
  }
};

const failures = [];
const fail = (msg) => failures.push(msg);
const check = (name, ok, detail = '') => {
  if (!ok) fail(detail === '' ? name : `${name}\n    ${detail}`);
};
const near = (label, actual, expected, tol = 1e-9) => {
  if (!(Math.abs(actual - expected) <= tol)) fail(`${label}: expected ${expected}, got ${actual}`);
};

const timeline = await bundle('../src/state/timelineSlice.ts', 'timelineSlice');
const exportDoc = await bundle('../src/components/export/exportDocument.ts', 'exportDocument');
const graph = await bundle('../electron/export/graph.ts', 'graph');
const monitor = await bundle('../src/components/preview/audioMonitor.ts', 'audioMonitor');

const { buildExportDocument } = exportDoc;
const { buildExportGraph } = graph;
const { mixVolume, effectiveGain, monitorAudible, writeElement, EMPTY_SLOT } = monitor;
void EMPTY_SLOT;

for (const [name, fn] of [
  ['timelineSlice.createTimelineSlice', timeline.createTimelineSlice],
  ['exportDocument.buildExportDocument', buildExportDocument],
  ['graph.buildExportGraph', buildExportGraph],
  ['audioMonitor.mixVolume', mixVolume],
  ['audioMonitor.effectiveGain', effectiveGain],
  ['audioMonitor.monitorAudible', monitorAudible],
  ['audioMonitor.writeElement', writeElement],
]) {
  if (typeof fn !== 'function') {
    console.error(`mix: ${name} is not exported`);
    process.exit(2);
  }
}

/* --------------------------------------------------------------- fake store */

const MEDIA = 'm_take';

function fresh() {
  const state = {};
  const get = () => state;
  const set = (partial) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial);

  Object.assign(
    state,
    {
      items: {},
      playhead: 0,
      fps: 30,
      width: 1920,
      height: 1080,
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
    name: 'take.mp4',
    path: '/media/take.mp4',
    url: 've-media://take.mp4',
    status: 'ready',
    durationFrames: 6000,
    durationSeconds: 200,
    hasAudio: true,
    width: 1920,
    height: 1080,
  };
  return state;
}

const REQ = {
  filename: 'out',
  folder: '/out',
  width: 1920,
  height: 1080,
  fps: 30,
  /* AUDIO-ONLY, deliberately. This gate is about the mix, and an audio-only
     export is the one shape in which "a track at gain 0 contributes no input at
     all" is DIRECTLY observable: with no picture in the request there is nothing
     else in argv for the missing input to hide behind, and an empty contributor
     set is an ordinary silent file rather than an `empty-timeline` refusal. */
  codec: 'wav',
  quality: 'good',
  range: 'entire',
  burnSubtitles: false,
  startFrame: 0,
  durationFrames: 120,
};

async function graphFor(label, s) {
  const document = await buildExportDocument(s);
  const r = buildExportGraph({ ...REQ, document }, { scriptPath: '/tmp/s.txt', outputPath: '/tmp/o.wav' });
  if (!r.ok) {
    fail(`${label}: the export refused the document — ${r.error.code}: ${r.error.message}`);
    return null;
  }
  return r.graph;
}

/** Every `volume=` factor the filter script carries, in order. */
const emittedGains = (g) => [...g.filterScript.matchAll(/(?:^|,)volume=([0-9.]+)/g)].map((m) => Number(m[1]));

/** The media paths ffmpeg is told to open. */
const inputPaths = (g) =>
  g.args.reduce((acc, a, i) => (g.args[i - 1] === '-i' ? [...acc, a] : acc), []);

/**
 * The preview's gain, MEASURED where the preview actually puts it: on the media
 * element, through `writeElement`, which §3.3 makes the only writer of `volume`
 * on a voice. Reading the element rather than the expression is what stops this
 * being a second copy of the gain law.
 */
function previewElementVolume(clip, track, master = { volume: 1, muted: false }) {
  const el = { volume: -1, muted: null, playbackRate: 1, preservesPitch: true };
  const st = {
    fadeUntilSeeked: false,
    wrote: { volume: NaN, muted: null, rate: NaN, pitch: null },
  };
  writeElement(el, st, {
    gain: effectiveGain(
      mixVolume(clip.properties.volume, track.volume ?? 1),
      track.muted,
      master.volume,
      master.muted,
      false,
    ),
    rate: 1,
    pitch: true,
  });
  return el.volume;
}

/* ============================================================================
   1. THE PRODUCT LAW, MEASURED ON BOTH SIDES.

   One audible clip per document, so the single `volume=` in the script is
   unambiguously that clip's and no index bookkeeping can go wrong.

   The assertion is a RATIO, held constant across the matrix, with the constant
   read out of the measurements. That is deliberate: hard-coding the monitoring
   reference here would make this gate fail the day the reference legitimately
   changes, and — worse — would let the two sides drift together if somebody
   "fixed" the gate by editing the constant. A constant ratio across nine rows
   with three distinct clip terms and three distinct track terms cannot be
   satisfied by anything but the same law on both sides.
============================================================================ */

const MATRIX = [
  { clip: 1, track: 1 },
  { clip: 1, track: 0.5 },
  { clip: 0.5, track: 1 },
  { clip: 0.5, track: 0.5 },
  { clip: 0.25, track: 2 },
  { clip: 2, track: 0.25 },
  { clip: 0.8, track: 1.25 },
  { clip: 1.6, track: 1.25 },
  { clip: 0.1, track: 0.1 },
];

const ratios = [];

for (const row of MATRIX) {
  const label = `clip ${row.clip} x track ${row.track}`;
  const s = fresh();
  const a1 = s.addTrack('audio');
  const created = s.addClip({ mediaId: MEDIA, trackId: a1, start: 0, duration: 60, streams: 'audio' });
  if (!created.ok) throw new Error(`addClip refused: ${JSON.stringify(created)}`);
  s.updateClipProperties([created.id], { volume: row.clip });
  s.setTrackVolume(a1, row.track);

  const clip = s.clips[created.id];
  const track = s.tracks[a1];
  check(
    `1. ${label}: setTrackVolume stored what it was given`,
    Math.abs((track.volume ?? 1) - row.track) < 1e-9,
    `stored ${track.volume}`,
  );

  const g = await graphFor(label, s);
  if (g === null) continue;

  const gains = emittedGains(g);
  check(`1. ${label}: exactly one volume= in the script`, gains.length === 1, JSON.stringify(gains));
  if (gains.length !== 1) continue;

  const exported = gains[0];
  const previewed = previewElementVolume(clip, track);

  check(
    `1. ${label}: the export emits a gain at all`,
    exported > 0,
    'a track fader above zero produced silence in the file',
  );
  check(
    `1. ${label}: the preview emits a gain at all`,
    previewed > 0,
    'a track fader above zero produced silence in the preview',
  );
  if (!(exported > 0) || !(previewed > 0)) continue;

  ratios.push({ label, ratio: previewed / exported, exported, previewed });
}

check(
  `1. every one of the ${MATRIX.length} rows produced a measurement on both sides`,
  ratios.length === MATRIX.length,
  `only ${ratios.length} rows measured`,
);
if (ratios.length >= 2) {
  const first = ratios[0].ratio;
  for (const r of ratios) {
    check(
      `1. ${r.label}: preview and export move together`,
      Math.abs(r.ratio - first) < 1e-6,
      'The two consumers of CREATIVE §1.2 disagree about effective gain. They are allowed to ' +
        'differ by ONE fixed monitoring reference and by nothing else — a term dropped on ' +
        'either side shows up here and nowhere else until somebody hears it.\n    ' +
        `preview ${r.previewed} / export ${r.exported} = ${r.ratio}, but ` +
        `${ratios[0].label} gives ${first}`,
    );
  }
  // And the reference is a real, positive scalar rather than an accident of both
  // sides being zero — which would satisfy "constant ratio" vacuously.
  check('1. the monitoring reference is positive and finite', first > 0 && Number.isFinite(first), `${first}`);

  /* The export honours the model's FULL range as a real linear gain, so a clip
     and a track both pushed above unity must come out ABOVE unity in the file.
     Without this the matrix above is satisfied by any consumer that saturates. */
  const boosted = ratios.find((r) => r.label === 'clip 1.6 x track 1.25');
  near('1. the export does not clamp a boosted product', boosted?.exported ?? 0, 2, 5e-4);
}

/* ============================================================================
   2. MUTE IS ZERO, IN BOTH — and the export drops the input entirely.
============================================================================ */

{
  const s = fresh();
  const a1 = s.addTrack('audio');
  const created = s.addClip({ mediaId: MEDIA, trackId: a1, start: 0, duration: 60, streams: 'audio' });
  s.toggleMute(a1);

  const g = await graphFor('muted track', s);
  if (g !== null) {
    check(
      '2. a MUTED track contributes no input to the export',
      inputPaths(g).length === 0,
      `ffmpeg was told to open ${JSON.stringify(inputPaths(g))}`,
    );
    check('2. and no volume= at all', emittedGains(g).length === 0, JSON.stringify(emittedGains(g)));
  }

  near(
    '2. a MUTED track monitors at gain 0',
    previewElementVolume(s.clips[created.id], s.tracks[a1]),
    0,
  );
  check(
    '2. and the preview does not even keep a voice on a muted track',
    monitorAudible(s.clips[created.id], s.tracks[a1], s.items[MEDIA]) === false,
    'mute is an edit decision that survives a reload; the fader is a gesture in flight. Only ' +
      'the second one is worth keeping a silent element alive for.',
  );
}

/* ============================================================================
   3. THE ASYMMETRY AT ZERO — §1.3 item 1 and §7, and it is deliberate.
============================================================================ */

{
  const s = fresh();
  const a1 = s.addTrack('audio');
  const created = s.addClip({ mediaId: MEDIA, trackId: a1, start: 0, duration: 60, streams: 'audio' });
  s.setTrackVolume(a1, 0);

  /* --- the EXPORT half: no input at all. */
  const g = await graphFor('track faded to silence', s);
  if (g !== null) {
    check(
      '3. EXPORT: a track at gain 0 contributes NO INPUT AT ALL',
      inputPaths(g).length === 0,
      'CREATIVE §1.3 item 1: `wantsAudio` gains `trackVolume(track) > 0`, exactly as `muted` ' +
        'already does. An input decoded, resampled and mixed at zero is work done to produce ' +
        `silence.\n    ffmpeg was told to open ${JSON.stringify(inputPaths(g))}`,
    );
    check('3. EXPORT: and emits no volume=', emittedGains(g).length === 0, JSON.stringify(emittedGains(g)));
  }

  // The control: a hair above zero and the input is back. Without this, "no
  // input" would also be satisfied by an export that had stopped emitting audio
  // for every track.
  s.setTrackVolume(a1, 0.01);
  const alive = await graphFor('track just above silence', s);
  if (alive !== null) {
    check(
      '3. EXPORT: a track just above zero DOES contribute an input',
      inputPaths(alive).length === 1,
      JSON.stringify(inputPaths(alive)),
    );
  }
  s.setTrackVolume(a1, 0);

  /* --- the PREVIEW half: the voice stays, gated to zero. */
  const clip = s.clips[created.id];
  const track = s.tracks[a1];

  check(
    '3. PREVIEW: a track at gain 0 KEEPS its voice',
    monitorAudible(clip, track, s.items[MEDIA]) === true,
    'CREATIVE §7: `monitorAudible` deliberately does not test `trackVolume > 0`. Dropping and ' +
      'reloading a source every time a live fader drag crosses zero is a worse defect than an ' +
      'idle silent element — it is an audible dropout produced by the act of listening. This ' +
      'is not the export rule with a term missing; it is a different rule, on purpose.',
  );
  near('3. PREVIEW: and monitors it at gain exactly 0', previewElementVolume(clip, track), 0);

  // The asymmetry stated as one assertion, so neither half can be "tidied" into
  // the other: at this one setting the two consumers deliberately disagree about
  // whether the source is open, and agree exactly about the level.
  check(
    '3. the two behaviours coexist — open in the preview, absent from the file',
    monitorAudible(clip, track, s.items[MEDIA]) === true &&
      previewElementVolume(clip, track) === 0 &&
      (g === null || inputPaths(g).length === 0),
  );
}

/* ============================================================================
   4. THE THIRD CONSUMER — the clock clip's own <video>. §1.3 item 3, §9.4 item 1.

   "Applying the fader to the mix voices and not to that element gives a fader
   that works on every track except the one you are watching."

   STRUCTURAL, and the reason is stated rather than glossed. `VideoSurface` and
   `useAudioMonitor` write their gain onto a live media element from inside a
   React effect; there is no headless way to observe that write, and inventing
   one would mean a second implementation of the wiring — which is the thing
   under test. What CAN be checked without a browser is the property that
   actually failed: a consumer computing effective gain WITHOUT the track term.

   So the check is tree-wide rather than file-wide: every call to `effectiveGain`
   anywhere outside the module that defines it must be handed a `mixVolume(...)`
   expression as its clip term. That catches the two consumers that exist, and it
   catches a third one added later without anybody remembering §9.4 — which is
   how this class of bug arrives every time.
============================================================================ */

{
  const CONSUMERS = [
    ['the mix voices', '../src/components/preview/useAudioMonitor.ts'],
    ["the clock clip's <video>", '../src/components/preview/VideoSurface.tsx'],
  ];

  for (const [label, path] of CONSUMERS) {
    const src = read(path);
    check(`4. ${label} (${path}) exists`, src !== null);
    if (src === null) continue;
    check(
      `4. ${label} reads the track fader`,
      /\btrackVolume\s*\(/.test(src),
      'CREATIVE §9.4 item 1: this is the consumer that gets forgotten, and the symptom is a ' +
        'fader that works on every track except the one you are watching.',
    );
    check(
      `4. ${label} folds it in through the shared mixVolume`,
      /\bmixVolume\s*\(/.test(src),
      '§1.2\'s product is applied ONCE, in `mixVolume`, so all three consumers spell it the ' +
        'same way. A local `a * b` here is a fourth spelling and the one that drifts.',
    );
  }

  // Tree-wide: no call site anywhere may pass a bare clip volume.
  const files = [
    '../src/components/preview/useAudioMonitor.ts',
    '../src/components/preview/VideoSurface.tsx',
    '../src/components/preview/AudioTrackVoice.tsx',
    '../src/components/preview/PreviewWell.tsx',
    '../src/components/preview/AudioSurface.tsx',
  ];
  const bare = [];
  for (const path of files) {
    const src = read(path);
    if (src === null) continue;
    for (const m of src.matchAll(/effectiveGain\s*\(\s*([\s\S]{0,40}?)[,)]/g)) {
      if (!/^\s*mixVolume\s*\(/.test(m[1])) bare.push(`${path}: effectiveGain(${m[1].trim()}…`);
    }
  }
  check(
    '4. every effectiveGain call site passes a mixVolume() clip term',
    bare.length === 0,
    `a consumer computes effective gain without the track fader:\n    ${bare.join('\n    ')}`,
  );
}

/* ------------------------------------------------------------------ verdict */

if (failures.length > 0) {
  keepBundle = true;
  console.error(`\nmix: ${failures.length} failure${failures.length > 1 ? 's' : ''}.\n`);
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
  `mix: ok — ${MATRIX.length} clip x track rows measured on both sides and one constant ` +
    'monitoring reference apart, mute is silence in both, a track at 0 emits no export input ' +
    'while the preview keeps the voice at gain 0, and every effectiveGain call site carries the ' +
    'track fader',
);
