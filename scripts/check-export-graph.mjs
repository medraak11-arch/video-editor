#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-export-graph.mjs — the acceptance test for electron/export/graph.ts,
   turned into a gate.

   Run:  node scripts/check-export-graph.mjs

   Why this exists: EXPORT.md §1.8 holds three transcripts of verified ffmpeg
   runs and calls them "the acceptance test for this file … diffed byte-for-byte
   before anything is wired". Until now that diff was performed by eye, which is
   exactly how a one-character change to `offset()`'s output slips through — and
   FORMAT.md §6.2 is a change to what `offset()` is fed.

   Five cases, not three:
     A  30 fps project, 30 fps export — compositing, a gap, speed, scale,
        opacity-0-with-audio, a 24 fps source.
     B  30 fps project, 24 fps export — the two frame rates.
     C  29.97 fps project and export — the non-integer rate.
     D  A's document exported at DOUBLE its resolution, with one clip at
        positionX 100. A, B and C are all req === doc, where the placement
        rescale is a provable no-op, so without D the whole point of FORMAT §6.2
        is unmeasured: the three real transcripts cannot see it by construction.
     E  TRACK ORDER, CREATIVE §11.1 — two overlapping video clips on different
        tracks, built through `addTrack`/`addClip`, asserting that the export and
        the preview name the SAME clip as the top of the stack, plus the same
        invariant across a serialise/migrate round trip. A/B/C/D are hand-written
        transcripts by design; E measures the app against itself and is therefore
        built through store actions, per §11.2.

   It bundles electron/export/graph.ts FROM SOURCE with esbuild, exactly as
   check-fps-snap.mjs and check-timeline-guards.mjs already bundle src/state/*.ts.
   Reading the build output would be wrong twice, and the second way is the
   dangerous one: the build output is gitignored, so a clean clone running
   `npm run check` alone would exit 2 rather than passing — and far worse, a
   STALE build makes the gate assert against the previous compile and PASS.
   graph.ts is on this area's ownership list and FORMAT §6.2 changes it, so the
   most likely sequence in the whole change — edit graph.ts, run npm run check —
   would green-light un-rebuilt code. The one gate FORMAT calls "not optional"
   must not be the one that can silently validate something other than the source.

   It resolves cleanly because graph.ts imports only src/types/api.ts and
   src/types/model.ts, both plain TypeScript with no DOM, no React and no node
   built-in. esbuild is already a vite dependency, so no package is added.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 've-export-graph-'));
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

const mod = await bundle('../electron/export/graph.ts', 'graph');
/* Case E only. The four transcript cases below are hand-written documents on
   purpose — they are EXPORT §1.8's verified ffmpeg runs, diffed byte for byte,
   and their whole value is that they are the transcript rather than something
   the app produced today. §11.2's rule bites on the NEW case, which measures the
   app against itself and must therefore be built through the actions a user's
   gestures call. */
const timeline = await bundle('../src/state/timelineSlice.ts', 'timelineSlice');
const projectLib = await bundle('../src/lib/project.ts', 'project');
const exportDoc = await bundle('../src/components/export/exportDocument.ts', 'exportDocument');

const { buildExportGraph } = mod;
if (typeof buildExportGraph !== 'function') {
  console.error('export-graph: buildExportGraph is not exported from electron/export/graph.ts');
  process.exit(2);
}

/* ------------------------------------------------------------------ helpers */

const failures = [];
const fail = (msg) => failures.push(msg);

/** The literal argv and script paths EXPORT §1.8 prints, used verbatim as input. */
const SCRIPT_PATH = '<temp>/ve-export-<jobId>.txt';
const OUTPUT_PATH = '<partPath>';
const M = (name) => `<dev-media>/${name}`;

const track = (id, kind, index, label, over = {}) => ({
  id,
  kind,
  index,
  label,
  height: kind === 'video' ? 56 : 40,
  muted: false,
  locked: false,
  visible: true,
  ...over,
});

const clip = (id, mediaId, trackId, start, duration, mediaIn, props = {}) => ({
  id,
  mediaId,
  trackId,
  start,
  duration,
  mediaIn,
  name: id,
  properties: {
    scale: 1,
    positionX: 0,
    positionY: 0,
    rotation: 0,
    opacity: 1,
    speed: 1,
    volume: 1,
    ...props,
  },
});

const source = (mediaId, file, kind, durationFrames, width, height) => ({
  mediaId,
  path: M(file),
  kind,
  hasAudio: true,
  durationFrames,
  width,
  height,
});

const run = (label, req) => {
  const result = buildExportGraph(req, { scriptPath: SCRIPT_PATH, outputPath: OUTPUT_PATH });
  if (!result.ok) {
    fail(`${label}: build failed with ${result.error.code}`);
    return null;
  }
  return result.graph;
};

/** Byte-for-byte, line by line, so a diff names the line rather than the file. */
const diffScript = (label, actual, expected) => {
  if (actual === expected) return;
  const a = actual.split('\n');
  const e = expected.split('\n');
  if (a.length !== e.length) fail(`${label}: filterScript has ${a.length} lines, expected ${e.length}`);
  for (let i = 0; i < Math.max(a.length, e.length); i += 1) {
    if (a[i] !== e[i]) {
      fail(`${label}: filterScript line ${i + 1}\n    got      ${a[i]}\n    expected ${e[i]}`);
      break;
    }
  }
};

const diffArgs = (label, actual, expected) => {
  if (actual.length !== expected.length) {
    fail(`${label}: args has ${actual.length} elements, expected ${expected.length}`);
  }
  for (let i = 0; i < Math.max(actual.length, expected.length); i += 1) {
    if (actual[i] !== expected[i]) {
      fail(`${label}: args[${i}]\n    got      ${actual[i]}\n    expected ${expected[i]}`);
      break;
    }
  }
};

const eq = (label, got, expected) => {
  if (got !== expected) fail(`${label}: got ${got}, expected ${expected}`);
};

const H264_TAIL = [
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
];

/* ================================================================= case A ==
   EXPORT §1.8 A. 1920×1080 @ 30, exported entire at 1920×1080 @ 30, h264/good. */

const V1 = track('t_v1', 'video', 1, 'V1');
const V2 = track('t_v2', 'video', 2, 'V2');
const V3 = track('t_v3', 'video', 3, 'V3');
const A1 = track('t_a1', 'audio', 1, 'A1');

/** Video tracks BOTTOM-first, then audio (EXPORT §1.6, api.ts ExportDocument). */
const docA = {
  fps: 30,
  width: 1920,
  height: 1080,
  tracks: [V1, V2, V3, A1],
  clips: [
    clip('A', 'm_wide', V1.id, 0, 90, 0),
    clip('B', 'm_street', V1.id, 150, 60, 300),
    clip('C', 'm_macro', V2.id, 60, 120, 0, { speed: 2, scale: 0.5, opacity: 0.5, volume: 0 }),
    clip('D', 'm_drone', V2.id, 180, 30, 0, { volume: 0.5 }),
    clip('G', 'm_close', V3.id, 0, 90, 0, { opacity: 0 }),
    clip('H', 'm_vo', A1.id, 30, 120, 0, { volume: 0.8 }),
  ],
  sources: [
    source('m_wide', 'interview_wide_a.mp4', 'video', 900, 1920, 1080),
    source('m_street', 'broll_market_street.mp4', 'video', 900, 1920, 1080),
    source('m_macro', 'macro_coffee_pour.mp4', 'video', 900, 1920, 1080),
    source('m_drone', 'drone_pass_02.mp4', 'video', 900, 1920, 1080),
    source('m_close', 'interview_close_b.mp4', 'video', 900, 1920, 1080),
    source('m_vo', 'vo_take_04.m4a', 'audio', 900, 0, 0),
  ],
};

const reqA = {
  filename: 'out',
  folder: '<folder>',
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'h264',
  quality: 'good',
  range: 'entire',
  startFrame: 0,
  durationFrames: 210,
  document: docA,
};

const SCRIPT_A = [
  `color=c=black:s=1920x1080:r=30:d=7.000000,format=yuv420p[vbase]`,
  `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=7.000000,asetpts=N/SR/TB[abase]`,
  `[0:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=30,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+0.000000/TB[v0]`,
  `[1:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=30,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+5.000000/TB[v1]`,
  `[2:v]setpts=(PTS-STARTPTS)/2.000,fps=fps=30,scale=960:540:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=0.500,setpts=PTS+2.000000/TB[v2]`,
  `[3:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=30,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+6.000000/TB[v3]`,
  `[vbase][v0]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,-0.016667)*lt(t,2.983333)'[vc0]`,
  `[vc0][v1]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,4.983333)*lt(t,6.983333)'[vc1]`,
  `[vc1][v2]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,1.983333)*lt(t,5.983333)'[vc2]`,
  `[vc2][v3]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,5.983333)*lt(t,6.983333)'[vc3]`,
  `[vc3]format=yuv420p[vout]`,
  `[0:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a0]`,
  `[1:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=5000:all=1[a1]`,
  `[3:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=0.500,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=6000:all=1[a3]`,
  `[4:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a4]`,
  `[5:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=0.800,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=1000:all=1[a5]`,
  `[abase][a0][a1][a3][a4][a5]amix=inputs=6:duration=first:dropout_transition=0:normalize=0[aout]`,
].join(';\n');

const ARGS_A = [
  '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
  '-ss', '0.000000', '-t', '3.000000', '-i', M('interview_wide_a.mp4'),
  '-ss', '10.000000', '-t', '2.000000', '-i', M('broll_market_street.mp4'),
  '-ss', '0.000000', '-t', '8.000000', '-i', M('macro_coffee_pour.mp4'),
  '-ss', '0.000000', '-t', '1.000000', '-i', M('drone_pass_02.mp4'),
  '-ss', '0.000000', '-t', '3.000000', '-i', M('interview_close_b.mp4'),
  '-ss', '0.000000', '-t', '4.000000', '-i', M('vo_take_04.m4a'),
  '-filter_complex_script', SCRIPT_PATH,
  '-map', '[vout]', '-map', '[aout]',
  ...H264_TAIL,
  '-pix_fmt', 'yuv420p', '-r', '30',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  '-t', '7.000000', '-movflags', '+faststart', '-f', 'mp4',
  '-progress', 'pipe:1', '-stats_period', '0.25', '-nostats',
  OUTPUT_PATH,
];

const gA = run('A', reqA);
if (gA) {
  diffScript('A', gA.filterScript, SCRIPT_A);
  diffArgs('A', gA.args, ARGS_A);
  eq('A framesTotal', gA.framesTotal, 210);
  eq('A durationSeconds', gA.durationSeconds, 7);
}

/* ================================================================= case B ==
   EXPORT §1.8 B. 30 fps project, 24 fps export. */

const docB = {
  fps: 30,
  width: 1920,
  height: 1080,
  tracks: [V1],
  clips: [
    clip('A', 'm_wide', V1.id, 0, 30, 0),
    clip('B', 'm_street', V1.id, 30, 30, 300),
  ],
  sources: [
    source('m_wide', 'interview_wide_a.mp4', 'video', 900, 1920, 1080),
    source('m_street', 'broll_market_street.mp4', 'video', 900, 1920, 1080),
  ],
};

const SCRIPT_B = [
  `color=c=black:s=1920x1080:r=24:d=2.000000,format=yuv420p[vbase]`,
  `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2.000000,asetpts=N/SR/TB[abase]`,
  `[0:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=24,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+0.000000/TB[v0]`,
  `[1:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=24,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+1.000000/TB[v1]`,
  `[vbase][v0]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,-0.020833)*lt(t,0.979167)'[vc0]`,
  `[vc0][v1]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,0.979167)*lt(t,1.979167)'[vc1]`,
  `[vc1]format=yuv420p[vout]`,
  `[0:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a0]`,
  `[1:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=1000:all=1[a1]`,
  `[abase][a0][a1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[aout]`,
].join(';\n');

const ARGS_B = [
  '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
  '-ss', '0.000000', '-t', '1.000000', '-i', M('interview_wide_a.mp4'),
  '-ss', '10.000000', '-t', '1.000000', '-i', M('broll_market_street.mp4'),
  '-filter_complex_script', SCRIPT_PATH,
  '-map', '[vout]', '-map', '[aout]',
  ...H264_TAIL,
  '-pix_fmt', 'yuv420p', '-r', '24',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  '-t', '2.000000', '-movflags', '+faststart', '-f', 'mp4',
  '-progress', 'pipe:1', '-stats_period', '0.25', '-nostats',
  OUTPUT_PATH,
];

const gB = run('B', { ...reqA, fps: 24, durationFrames: 60, document: docB });
if (gB) {
  diffScript('B', gB.filterScript, SCRIPT_B);
  diffArgs('B', gB.args, ARGS_B);
  eq('B framesTotal', gB.framesTotal, 48);
}

/* ================================================================= case C ==
   EXPORT §1.8 C. 29.97 fps project and export. */

const docC = {
  fps: 29.97,
  width: 1920,
  height: 1080,
  tracks: [V1],
  clips: [
    clip('A', 'm_wide', V1.id, 0, 25, 0),
    clip('B', 'm_drone', V1.id, 25, 35, 0),
  ],
  sources: [
    source('m_wide', 'interview_wide_a.mp4', 'video', 900, 1920, 1080),
    source('m_drone', 'drone_pass_02.mp4', 'video', 900, 1920, 1080),
  ],
};

const SCRIPT_C = [
  `color=c=black:s=1920x1080:r=29.97:d=2.002002,format=yuv420p[vbase]`,
  `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2.002002,asetpts=N/SR/TB[abase]`,
  `[0:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=29.97,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+0.000000/TB[v0]`,
  `[1:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=29.97,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+0.834168/TB[v1]`,
  `[vbase][v0]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,-0.016683)*lt(t,0.817484)'[vc0]`,
  `[vc0][v1]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,0.817484)*lt(t,1.985319)'[vc1]`,
  `[vc1]format=yuv420p[vout]`,
  `[0:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a0]`,
  `[1:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=834:all=1[a1]`,
  `[abase][a0][a1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[aout]`,
].join(';\n');

const ARGS_C = [
  '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
  '-ss', '0.000000', '-t', '0.834168', '-i', M('interview_wide_a.mp4'),
  // 35 / 29.97 = 1.1678345011678346, and sec() is toFixed(6), which rounds UP.
  // EXPORT §1.8 C's prose had truncated this to 1.167834; corrected there.
  '-ss', '0.000000', '-t', '1.167835', '-i', M('drone_pass_02.mp4'),
  '-filter_complex_script', SCRIPT_PATH,
  '-map', '[vout]', '-map', '[aout]',
  ...H264_TAIL,
  '-pix_fmt', 'yuv420p', '-r', '29.97',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  '-t', '2.002002', '-movflags', '+faststart', '-f', 'mp4',
  '-progress', 'pipe:1', '-stats_period', '0.25', '-nostats',
  OUTPUT_PATH,
];

const gC = run('C', { ...reqA, fps: 29.97, durationFrames: 60, document: docC });
if (gC) {
  diffScript('C', gC.filterScript, SCRIPT_C);
  diffArgs('C', gC.args, ARGS_C);
  eq('C framesTotal', gC.framesTotal, 60);
}

/* ================================================================= case D ==
   FORMAT §6.2 / §11.23. positionX is in PROJECT-resolution px; the overlay runs
   on the OUTPUT grid. At double the document resolution a clip at positionX 100
   must land at +200, or a clip reframed in the preview moves in the file.

   Both halves are asserted: the rescaled one, and the req === doc one that must
   stay +100. A constant, a wrong ratio and a dropped ratio each fail one of them. */

const docD = {
  ...docA,
  clips: docA.clips.map((c) =>
    c.id === 'A' ? { ...c, properties: { ...c.properties, positionX: 100 } } : c,
  ),
};

const OVERLAY_D_DOUBLE =
  `[vbase][v0]overlay=x=(W-w)/2+200:y=(H-h)/2+0:eof_action=pass:shortest=0:` +
  `repeatlast=0:format=yuv420:enable='gte(t,-0.016667)*lt(t,2.983333)'[vc0]`;
const OVERLAY_D_SAME =
  `[vbase][v0]overlay=x=(W-w)/2+100:y=(H-h)/2+0:eof_action=pass:shortest=0:` +
  `repeatlast=0:format=yuv420:enable='gte(t,-0.016667)*lt(t,2.983333)'[vc0]`;

const overlayLine = (graph) =>
  graph.filterScript.split(';\n').find((l) => l.startsWith('[vbase][v0]overlay=')) ?? '<missing>';

const gDdouble = run('D', { ...reqA, width: 3840, height: 2160, document: docD });
if (gDdouble) eq('D overlay at 2x resolution', overlayLine(gDdouble), OVERLAY_D_DOUBLE);

const gDsame = run('D (req === doc)', { ...reqA, document: docD });
if (gDsame) eq('D overlay at 1x resolution', overlayLine(gDsame), OVERLAY_D_SAME);

/* ================================================================= case E ==
   CREATIVE §11.1 — TRACK ORDER, and specifically NOT the obvious assertion.

   The preview's D1 fix derives stacking from the convention that `trackOrder`
   runs top-to-bottom, rather than copying `compositeTracks` out of
   exportDocument.ts. That was the right call — a second ordering table is this
   defect class reproducing itself — but it makes an ungated convention
   load-bearing in a second place.

   "trackOrder is top-first" IS NOT DIRECTLY CHECKABLE. Looking at `[t1, t2]`
   tells you nothing about which the user believes is on top; it is a statement
   about what the array MEANS, and no assertion can read intent out of data. A
   gate claiming to check it would be a restatement — §2.4's lesson, again, and
   the planner rejected its own first draft of this section for exactly that.

   What IS checkable is that the two consumers AGREE. Two overlapping video clips
   on different tracks: the export must overlay the `trackOrder`-earlier one LAST
   (so it lands on top of the composite) and the preview must pick that same clip
   as the one on top. Neither side's direction is asserted — only that they name
   the SAME clip. It therefore holds whichever way the stack runs, and it fails
   loudly the day either side flips.

   Nothing below states which `addTrack` call produced the higher track. The
   fixture reads that back out of `trackOrder` itself, which is what keeps this
   an agreement test rather than a third opinion.
--------------------------------------------------------------------------- */

const MEDIA_LOWER = 'm_lower';
const MEDIA_UPPER = 'm_upper';

function freshStore() {
  const state = {};
  const get = () => state;
  const set = (partial) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial);

  Object.assign(
    state,
    {
      items: {},
      order: [],
      projectName: 'order',
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

  for (const id of [MEDIA_LOWER, MEDIA_UPPER]) {
    state.order.push(id);
    state.items[id] = {
      id,
      kind: 'video',
      name: `${id}.mp4`,
      path: `/media/${id}.mp4`,
      url: `ve-media://${id}.mp4`,
      status: 'ready',
      durationFrames: 6000,
      durationSeconds: 200,
      hasAudio: false,
      width: 1920,
      height: 1080,
    };
  }
  return state;
}

{
  const s = freshStore();
  const trackA = s.addTrack('video');
  const trackB = s.addTrack('video');

  // WHICH of the two is higher is read back, never assumed.
  const rankA = s.trackOrder.indexOf(trackA);
  const rankB = s.trackOrder.indexOf(trackB);
  eq('E: the two tracks are distinct positions in trackOrder', rankA === rankB, false);
  const earlierTrack = rankA < rankB ? trackA : trackB;
  const laterTrack = rankA < rankB ? trackB : trackA;

  const mk = (mediaId, trackId) => {
    const r = s.addClip({ mediaId, trackId, start: 0, duration: 60 });
    if (!r.ok) throw new Error(`addClip refused: ${JSON.stringify(r)}`);
    return r.id;
  };
  const earlierClip = mk(MEDIA_UPPER, earlierTrack);
  const laterClip = mk(MEDIA_LOWER, laterTrack);

  // The clips genuinely overlap in time, or there is no stack to order.
  eq(
    'E: the two clips overlap at frame 30',
    s.clips[earlierClip].start <= 30 && s.clips[laterClip].start <= 30,
    true,
  );

  const doc = await exportDoc.buildExportDocument(s);
  const gE = run('E', {
    ...reqA,
    durationFrames: 60,
    document: doc,
  });

  if (gE) {
    /* The EXPORT side, measured out of the filter script. Input N's path is read
       from argv, so a clip is identified by the file ffmpeg opens for it rather
       than by an index this gate computed. */
    const paths = gE.args.reduce((acc, a, i) => (gE.args[i - 1] === '-i' ? [...acc, a] : acc), []);
    const overlays = gE.filterScript
      .split(';\n')
      .map((line) => /^\[[^\]]+\]\[v(\d+)\]overlay=/.exec(line))
      .filter(Boolean)
      .map((m) => Number(m[1]));

    eq('E: both clips reached the overlay stack', overlays.length, 2);
    const lastOverlaid = overlays.length > 0 ? paths[overlays[overlays.length - 1]] : '<none>';
    const expectedTop = `/media/${MEDIA_UPPER}.mp4`;

    if (lastOverlaid !== expectedTop) {
      fail(
        'E: the export overlays the trackOrder-EARLIER clip last (so it lands on top of the ' +
          'composite) and the preview treats that same clip as the top of the stack. They now ' +
          'disagree, which means a clip visible in the preview is buried in the file, or the ' +
          `reverse — CREATIVE §11.1.\n    export overlaid last: ${lastOverlaid}\n    ` +
          `expected the trackOrder-earlier clip: ${expectedTop}`,
      );
    }

    /* The PREVIEW side, measured through the selector that decides what is on
       screen. It walks `trackOrder` forward and returns the first hit, so the
       trackOrder-earlier clip is the one it sorts FIRST — the top of the paint
       order. Same clip, other consumer. */
    const previewTop = timeline.selectVideoClipIdAtFrame(s, 30);
    eq('E: the preview sorts the trackOrder-earlier clip first', previewTop, earlierClip);

    // And the agreement itself, stated once so a reader cannot miss which fact
    // is load-bearing: the clip the export puts on top IS the clip the preview
    // puts on top. Whichever direction `trackOrder` runs.
    const previewTopPath = previewTop === null ? '<none>' : `/media/${s.clips[previewTop].mediaId}.mp4`;
    eq('E: the two consumers name the SAME clip as the top of the stack', lastOverlaid, previewTopPath);
  }
}

/* ------------------------------- §11.1 item 2: the invariant on a ROUND TRIP

   `addTrack` assigns `index`, video unshifts and audio appends, so within a kind
   VIDEO DESCENDS by `index` through `trackOrder` and AUDIO ASCENDS. That is
   mechanical today and it is what the stacking convention rests on.

   The gate builds through `addTrack`, serialises, migrates back and asserts it
   still holds — which catches a scaffold or state regression, the thing actually
   worth catching. What it deliberately does NOT assert is that `migrateProject`
   REPAIRS a bad order. §11.1 records the planner reversing itself on that: there
   is no track-reordering gesture yet, and the day one is added `trackOrder` and
   `Track.index` legitimately diverge. A sanitiser that sorted by `index` would
   silently undo every reorder the user made, on load, with no way to see why —
   and a hand-edited order and a future-reordered one are the same bytes. So
   `migrateProject` honours whatever order it is given, and the assertion here is
   that it CHANGES NOTHING. */

{
  const s = freshStore();
  const v = [s.addTrack('video'), s.addTrack('video'), s.addTrack('video')];
  const a = [s.addTrack('audio'), s.addTrack('audio')];
  void v;
  void a;

  const file = projectLib.serializeProject(s);
  // Through JSON, because that is what a `.veproj` is: a round trip that never
  // left memory would not exercise the reader at all.
  const migrated = projectLib.migrateProject(JSON.parse(JSON.stringify(file)));

  if (migrated === null) {
    fail('E round trip: migrateProject rejected a project this app just serialised');
  } else {
    eq(
      'E round trip: migration honours the order it was given, unchanged',
      migrated.trackOrder.join(','),
      s.trackOrder.join(','),
    );

    const byId = Object.fromEntries(migrated.tracks.map((t) => [t.id, t]));
    const indices = (kind) =>
      migrated.trackOrder.map((id) => byId[id]).filter((t) => t?.kind === kind).map((t) => t.index);

    const video = indices('video');
    const audio = indices('audio');
    eq('E round trip: all three video tracks survived', video.length, 3);
    eq('E round trip: both audio tracks survived', audio.length, 2);

    const descends = video.every((n, i) => i === 0 || video[i - 1] > n);
    const ascends = audio.every((n, i) => i === 0 || audio[i - 1] < n);
    if (!descends) {
      fail(
        'E round trip: video tracks no longer DESCEND by `index` through `trackOrder`. ' +
          '`addTrack` unshifts a new video track, so the newest carries the highest index and ' +
          'sits earliest — the fact the stacking convention rests on, in both consumers ' +
          `(CREATIVE §11.1).\n    indices in trackOrder: ${JSON.stringify(video)}`,
      );
    }
    if (!ascends) {
      fail(
        'E round trip: audio tracks no longer ASCEND by `index` through `trackOrder`. ' +
          `\n    indices in trackOrder: ${JSON.stringify(audio)}`,
      );
    }
  }
}

/* -------------------------------------------------------------------- verdict */

if (failures.length) {
  keepBundle = true;
  console.error(`export-graph: ${failures.length} FAILURES`);
  for (const f of failures) console.error('  ' + f);
  console.error(
    `\n  the bundled source this ran against is preserved at:\n    ${dir}\n` +
      '  Deleted on a pass, kept on a failure, so what was actually compiled can be read ' +
      'rather than guessed at — CREATIVE §7.4 entry 8.\n',
  );
  process.exit(1);
}
console.log(
  'export-graph: PASS — EXPORT §1.8 A/B/C diff byte-for-byte, placement rescales 100 -> 200 at 2x, ' +
    'and §11.1 track order agrees across both consumers and survives a round trip',
);
