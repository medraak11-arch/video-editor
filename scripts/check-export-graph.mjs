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

   Four cases, not three:
     A  30 fps project, 30 fps export — compositing, a gap, speed, scale,
        opacity-0-with-audio, a 24 fps source.
     B  30 fps project, 24 fps export — the two frame rates.
     C  29.97 fps project and export — the non-integer rate.
     D  A's document exported at DOUBLE its resolution, with one clip at
        positionX 100. A, B and C are all req === doc, where the placement
        rescale is a provable no-op, so without D the whole point of FORMAT §6.2
        is unmeasured: the three real transcripts cannot see it by construction.

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

const entry = fileURLToPath(new URL('../electron/export/graph.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 've-export-graph-'));
const outfile = join(dir, 'graph.mjs');

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

/* -------------------------------------------------------------------- verdict */

if (failures.length) {
  console.error(`export-graph: ${failures.length} FAILURES`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(
  'export-graph: PASS — EXPORT §1.8 A/B/C diff byte-for-byte, and placement rescales 100 -> 200 at 2x',
);
