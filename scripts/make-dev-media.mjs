#!/usr/bin/env node
/**
 * Generates the small real media files src/dev/fixtures.ts points at, into ./dev-media.
 *
 * They exist so `npm run dev:web` renders a fully populated editor whose preview plays
 * ACTUAL video in a browser — the design target ("40 clips across 6 tracks at 2 a.m.")
 * cannot be judged against a placeholder rectangle.
 *
 * Solid colours, short durations, deliberately varied frame rates and resolutions so the
 * fixture's fps-mismatch and resolution-mismatch warnings are true statements about real
 * files. `drone_pass_02.mp4` is 24 fps ON PURPOSE, against a 30 fps project: it is the
 * only fixture that exercises frame-rate conversion. Do not "fix" it.
 *
 * ---------------------------------------------------------------------------------------
 * WHY ONE FIXTURE IS NOT FLAT — `test_chart_edges.mp4`, and do not "simplify" it away.
 * ---------------------------------------------------------------------------------------
 * The six naturalistic clips are SOLID COLOUR, and that was never wrong: each is a
 * single flat field, which is what keeps them a few hundred KB while carrying a
 * distinct audible signature (see below). Flat is right for what they are for.
 *
 * Flat-ONLY was the gap. `signalstats` on every one of them reports YMIN === YMAX —
 * `interview_wide_a.mp4` is 76 from corner to corner — so this repo contained no frame
 * with an edge in it, and CREATIVE §3's three SPATIAL effects had no fixture that shows
 * what they do:
 *
 *   blur      needs an EDGE to spread. On a flat field it is a no-op, exactly.
 *   sharpen   needs DETAIL to enhance. On a flat field it is a no-op, exactly.
 *   vignette  needs a BRIGHT FIELD REACHING THE CORNERS to darken.
 *
 * A spatial effect with no fixture that exercises it is a spatial effect nobody has
 * looked at, and the cost of that was real: verification reached its THIRD pass before
 * a 29%-narrow blur surfaced, because with nothing else in the app carrying an edge it
 * had to measure against a title glyph — a narrow stroke rather than a step edge, which
 * is the wrong shape for an edge-width fit and contaminated the number it produced.
 *
 * So this chart is a MEASUREMENT SURFACE, not a picture. Its geometry is fixed and
 * documented, in CHART below, so a measurement can name a region instead of hunting for
 * one:
 *
 *   STEP EDGE   a dark block at x 480..1440, y 60..480 on the bright field. The vertical
 *               boundary at x = 480 is a single-pixel step — measured 231 -> 16 with no
 *               transition pixel — with 480 px of flat field on the left and 960 px of
 *               flat block on the right. That much flat run either side is what lets a
 *               10-90% edge-width fit converge, and it is what a glyph cannot give.
 *               Axis-aligned and far from the frame border, so no crop clips the tails.
 *   FINE DETAIL two grids in the lower band: 4 px lines on a 24 px pitch, and 2 px lines
 *               on an 8 px pitch. `unsharp` runs a 5x5 kernel, so features of a few
 *               pixels are precisely what it acts on.
 *   BRIGHT      the base field is untouched in all four corners, so corner-vs-centre
 *   CORNERS     falloff — the whole observable for `vignette` — has something to fall off
 *               from.
 *
 * NEUTRAL GREYS ON PURPOSE. Every level in the chart is R=G=B, so chroma is 128/128
 * everywhere and 4:2:0 subsampling cannot move any measurement taken on it. A chart with
 * colour in it would measure the codec as much as the effect.
 *
 * 16 AND 232, NOT 0 AND 255. Both levels sit inside the range with headroom, so
 * `unsharp`'s overshoot and undershoot are visible instead of clipping — a step between
 * the endpoints would silently discard exactly the part of a sharpen that is being
 * measured.
 *
 * IT VERIFIES ITSELF at the bottom of this file, for the same reason the audio does: a
 * generator that does not measure its own output is not evidence of anything. If the step
 * edge, the detail or the bright corners stop being present, this script fails.
 *
 * Confirmed usable before it was committed: blurred through the pinned binary at
 * sigma 4/8/16, the 10-90% edge width comes back at 2.51x sigma against the Gaussian's
 * theoretical 2.563x — and it separates `gblur=steps=1` (89.3% of the ideal width) from
 * `steps=6` (97.7%), which is the defect it exists to make visible.
 *
 * It is the one fixture with expensive I-frames, so it takes `-g 60` and `-crf 16` rather
 * than the shared defaults: at `-g 30` it is 945 KB and at `-g 60` it is 497 KB, which is
 * the same order as the others. Detail is the point of the file, so the CRF buys it back.
 *
 * dev-media/ is gitignored. `npm run fixtures:media` rebuilds ALL of it from scratch on a
 * clean checkout — every run deletes the files listed below and re-encodes them, so a
 * stale fixture cannot survive a regeneration. Files you dropped into dev-media/ yourself
 * are left alone.
 *
 * Requires ffmpeg/ffprobe on PATH (the same assumption the real media IPC makes).
 *
 * ---------------------------------------------------------------------------------------
 * AUDIO SIGNATURES — every fixture carries audible, mutually distinguishable sound.
 * ---------------------------------------------------------------------------------------
 * This used to be `anullsrc`: nine files whose audio streams existed but were digital
 * silence at -91 dB. Every claim that the audio path had been "verified" against them was
 * vacuous, because silence mixed with silence is silence and the mixer could not be caught
 * getting it wrong. Each fixture now carries a signal you can assert on.
 *
 * The seven video clips are steady full-length sine tones at 100 Hz × a distinct prime, so
 * no clip's tone is a harmonic of any other and a mix can be decomposed by frequency:
 *
 *   file                        tone       mean dB   max dB
 *   interview_wide_a.mp4         300 Hz      -15.1     -8.9
 *   interview_close_b.mp4        500 Hz      -15.0     -9.5
 *   broll_market_street.mp4      700 Hz      -15.0     -8.4
 *   drone_pass_02.mp4           1100 Hz      -15.0     -8.0
 *   ocean_sunrise_4k.mp4        1300 Hz      -15.2     -7.8
 *   macro_coffee_pour.mp4       1700 Hz      -15.1     -7.8
 *   test_chart_edges.mp4        1900 Hz      -15.1     -8.0
 *
 * All seven sit at the SAME level — amplitude exactly 0.25, so RMS is 0.25/√2 = -15.05 dBFS
 * and the measured means agree to a tenth of a dB. "Did every source reach the mix at equal
 * weight?" is therefore a question about seven numbers that should match. (The peaks read a
 * few dB above the source's -12.04 dBFS: that is AAC reconstruction overshoot at 32 kbit/s,
 * not a level error. Assert on the mean, which is stable; treat max as headroom info.)
 *
 * The three audio-only files each have a deliberately different shape:
 *
 *   room_tone_hall.m4a   broadband — brown noise, seeded, low-passed at 300 Hz, quiet
 *                        (-38.2 dB mean / -25.8 dB max). The only fixture with NO spectral
 *                        line: the "is this ambience or is this nothing?" case.
 *   music_bed_low.m4a    a chord — A minor, 110.00 + 130.81 + 164.81 Hz, under a 1.5 Hz
 *                        tremolo. Three lines, all below 200 Hz, so it never collides with
 *                        a clip tone. -21.4 dB mean; about -24.8 dB in each line's band,
 *                        the power being split three ways.
 *   vo_take_04.m4a       850 Hz in bursts — a sin^4 envelope on a 0.6 s period, so 50
 *                        syllable-shaped swells in 30 s. Identified by its ENVELOPE as well
 *                        as its pitch; the edges are smooth, so it adds no broadband click
 *                        energy to anyone else's band. -20.5 dB mean.
 *
 * How to assert one of these from a test — isolate the band and read the level back:
 *
 *   ffmpeg -i dev-media/interview_wide_a.mp4 -af \
 *     "bandpass=f=300:width_type=h:w=25,bandpass=f=300:width_type=h:w=25,\
 *      bandpass=f=300:width_type=h:w=25,volumedetect" -f null -
 *
 * gives -15.1 dB on the clip that owns 300 Hz and -76.5 dB on the one that owns 500 Hz:
 * 61 dB of separation, which survives AAC at 32 kbit/s and survives amix. It tells you
 * WHICH source you are hearing, not merely that something is there.
 *
 * The bandpass is cascaded three times ON PURPOSE. A single biquad at Q=12 has skirts wide
 * enough to pass a neighbouring tone at only -22 dB, so a one-stage measurement bottoms out
 * around -37 dB and you would be reading the FILTER, not the file. Three stages put the
 * floor below the codec noise, where it belongs.
 *
 * This script re-measures every file it writes and FAILS if any of them comes back
 * quieter than -60 dB. The fixtures cannot silently go silent again.
 * ---------------------------------------------------------------------------------------
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'dev-media');
const THUMBS = join(OUT, 'thumbs');

/** Sample rate and encoder settings are uniform: one less variable when a mix looks wrong. */
const RATE = 48000;
const ABITRATE = '32k'; // A pure tone needs almost nothing; keeps every fixture a few hundred KB.

/**
 * Two identical channel expressions -> a stereo aevalsrc. aevalsrc is used rather than the
 * `sine` filter because it takes an EXPLICIT amplitude: `sine` has no amplitude option, and
 * its output level and the mono->stereo conversion that follows it are both things that have
 * changed between ffmpeg releases. A number in the expression cannot drift.
 *
 * Commas separate filters in a filtergraph, so any comma inside an expression must be
 * escaped. Every expression below is written comma-free instead — no escaping, nothing to
 * get wrong when someone edits one.
 */
const stereoExpr = (expr, seconds) =>
  `aevalsrc=exprs=${expr}|${expr}:s=${RATE}:d=${seconds}:c=stereo`;

/** A steady sine at `hz`, amplitude exactly 0.25 → -12.04 dBFS peak, -15.05 dBFS RMS. */
const toneExpr = (hz) => `0.25*sin(2*PI*${hz}*t)`;

const VIDEO = [
  { name: 'interview_wide_a.mp4',   color: 'darkslategray', w: 1920, h: 1080, fps: 30, dur: 45, hz: 300 },
  { name: 'interview_close_b.mp4',  color: 'dimgray',       w: 1920, h: 1080, fps: 30, dur: 40, hz: 500 },
  { name: 'broll_market_street.mp4',color: 'sienna',        w: 1920, h: 1080, fps: 30, dur: 25, hz: 700 },
  // 24 fps in a 30 fps project. Deliberate — it is the fps-conversion fixture.
  { name: 'drone_pass_02.mp4',      color: 'steelblue',     w: 1920, h: 1080, fps: 24, dur: 20, hz: 1100 },
  { name: 'ocean_sunrise_4k.mp4',   color: 'darkorange',    w: 3840, h: 2160, fps: 30, dur: 18, hz: 1300 },
  { name: 'macro_coffee_pour.mp4',  color: 'saddlebrown',   w: 1920, h: 1080, fps: 30, dur: 12, hz: 1700 },
];

/* -------------------------------------------------- the spatial-effect chart

   THE ONE NUMBER THAT MATTERS IS IN HERE, so it is written once. Every region a
   measurement will crop is derived from this object, and so is the drawing —
   there is no second copy of the geometry for a comment to go stale against.

   `bright` and `dark` are neutral greys with headroom at both ends; see the
   header for why neither is 0 or 255 and why neither carries chroma. */
const CHART = {
  name: 'test_chart_edges.mp4',
  w: 1920,
  h: 1080,
  fps: 30,
  dur: 12,
  hz: 1900,
  bright: '0xE8E8E8', // 232 — encodes to Y 214, leaving room for sharpen overshoot
  dark: '0x101010', //   16 — encodes to Y 30,  leaving room for undershoot
  /** The step-edge block. Its LEFT boundary is the edge to measure. */
  step: { x: 480, y: 60, w: 960, h: 420 },
  /** 4 px lines on a 24 px pitch — comfortably inside unsharp's 5x5 kernel. */
  coarse: { x: 240, y: 610, w: 720, h: 400, pitch: 24, line: 4 },
  /** 2 px lines on an 8 px pitch — the finest detail that survives 4:2:0 cleanly. */
  fine: { x: 1000, y: 610, w: 680, h: 400, pitch: 8, line: 2 },
  /** Detail costs I-frames. See the header: -g 30 doubles the file for nothing. */
  crf: '16',
  gop: '60',
};

/** A grid tile: bright ground, dark rules. */
const gridTile = (t, label) =>
  `color=c=${CHART.bright}:s=${t.w}x${t.h},drawgrid=w=${t.pitch}:h=${t.pitch}:t=${t.line}:c=${CHART.dark}[${label}]`;

/**
 * The whole chart as one filtergraph producing `[v]`. No input file: it is drawn
 * from lavfi sources, so it is byte-identical on every machine with no asset to
 * check in and nothing to go missing on a clean clone.
 *
 * ORDER MATTERS ONCE: the step block is drawn LAST, over the grids, so a future
 * edit that moves a grid can never quietly eat into the step edge's flat run —
 * it would visibly cover the grid instead, which is the failure you can see.
 */
const chartGraph = () =>
  [
    `color=c=${CHART.bright}:s=${CHART.w}x${CHART.h}:r=${CHART.fps}:d=${CHART.dur}[bg]`,
    gridTile(CHART.coarse, 'coarse'),
    gridTile(CHART.fine, 'fine'),
    `[bg][coarse]overlay=x=${CHART.coarse.x}:y=${CHART.coarse.y}[c1]`,
    `[c1][fine]overlay=x=${CHART.fine.x}:y=${CHART.fine.y}[c2]`,
    `[c2]drawbox=x=${CHART.step.x}:y=${CHART.step.y}:w=${CHART.step.w}:h=${CHART.step.h}:` +
      `c=${CHART.dark}:t=fill[v]`,
  ].join(';');

/* A sin^4 envelope: a smooth swell every 0.6 s with no hard edge, so the burst adds no
   broadband click energy to the bands the video clips are identified by. */
const voSwell = '(0.5+0.5*sin(2*PI*t/0.6))';
const VO_EXPR = `0.30*sin(2*PI*850*t)*${voSwell}*${voSwell}*${voSwell}*${voSwell}`;

/* A minor triad under a tremolo. Three sines at 0.10 → 0.30 peak when they align. */
const MUSIC_EXPR =
  '0.10*(sin(2*PI*110*t)+sin(2*PI*130.81*t)+sin(2*PI*164.81*t))*(0.65+0.35*sin(2*PI*1.5*t))';

/* Seeded, so the "noise" is the same noise on every machine and every run. The 0.084 is not
   arbitrary: brown noise through a 300 Hz low-pass lands near 0 dBFS, and room tone that peaks
   at 0 dBFS is not room tone. It puts the file at -38.0 dB mean / -25.7 dB max. */
const roomToneInput = (seconds) =>
  `anoisesrc=color=brown:seed=1963:r=${RATE}:d=${seconds}:a=0.9,` +
  'lowpass=f=300,volume=0.084,pan=stereo|c0=c0|c1=c0';

const AUDIO = [
  { name: 'room_tone_hall.m4a', dur: 60, input: roomToneInput(60) },
  { name: 'music_bed_low.m4a',  dur: 90, input: stereoExpr(MUSIC_EXPR, 90) },
  { name: 'vo_take_04.m4a',     dur: 30, input: stereoExpr(VO_EXPR, 30) },
];

/* Bit-exact flags strip the encoder tag and creation_time, so two runs of this script
   produce byte-identical files. "Deterministic" is then something you can check with a
   hash rather than something the header comment merely claims. */
const BITEXACT = ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1'];

const ffmpeg = (args, label) => {
  const res = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (res.error) {
    console.error(`ffmpeg not runnable: ${res.error.message}`);
    process.exit(2);
  }
  if (res.status !== 0) {
    console.error(`FAILED ${label}\n${res.stderr?.toString().slice(-800) ?? ''}`);
    process.exit(1);
  }
  return res.stderr?.toString() ?? '';
};

/** mean/max dBFS of a file's audio, read back off volumedetect. */
const measure = (file) => {
  const err = ffmpeg(
    ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    `measure ${file}`,
  );
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(err);
  return { mean: mean ? Number(mean[1]) : NaN, max: max ? Number(max[1]) : NaN };
};

/**
 * Level of one narrow band, used to prove a tone is where the table says it is. Three
 * cascaded biquads, for the skirt reason spelled out in the header — one stage would read
 * the filter rather than the file.
 */
const BAND = (hz) => Array(3).fill(`bandpass=f=${hz}:width_type=h:w=25`).join(',');

/**
 * Luma min/max over one frame, optionally within a crop — the video counterpart
 * of `volumedetect`, and the measurement that says whether a frame has anything
 * in it at all. YMIN === YMAX is a flat field.
 *
 * `metadata=print:file=-` writes to STDOUT, not stderr, so this reaches for the
 * other pipe rather than reusing `ffmpeg()` above.
 */
const luma = (file, crop = null) => {
  const vf = `${crop === null ? '' : `crop=${crop},`}signalstats,metadata=print:file=-`;
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-v', 'error', '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'null', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const out = res.stdout?.toString() ?? '';
  const min = /YMIN=(\d+)/.exec(out);
  const max = /YMAX=(\d+)/.exec(out);
  return { min: min ? Number(min[1]) : NaN, max: max ? Number(max[1]) : NaN };
};

/**
 * HIGH-PASS ENERGY in a region: the mean absolute difference between the frame
 * and a blurred copy of it. This is the measure of DETAIL, and it exists because
 * the obvious measure is not.
 *
 * The first version of the chart's self-check used the luma RANGE of the detail
 * tile — and passed on a fixture whose grating had been destroyed outright. A
 * tile with one stray line in it still spans the full range, and so does a tile
 * whose grating has been smeared into ringing: the extremes survive while the
 * structure between them does not. Range answers "are both levels present",
 * which is the right question for a STEP EDGE and the wrong one for a GRATING.
 *
 * That was not a hypothetical. x264's adaptive quantisation redistributes bits
 * toward flat regions, so on a mostly-flat frame it starves exactly the detailed
 * tile this chart exists for — and the range check reported `Y 26..217 ok` on a
 * file whose 8 px grating had been flattened to a single line at the tile's own
 * border. Measured here, that file reads 1.2 against the intended 85.
 */
const highPass = (file, crop) => {
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-v', 'error', '-i', file,
     '-filter_complex',
     `[0:v]crop=${crop},format=gray,split[a][b];[b]gblur=sigma=2:steps=6[lo];` +
       '[a][lo]blend=all_mode=difference,signalstats,metadata=print:file=-',
     '-frames:v', '1', '-f', 'null', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const m = /YAVG=([\d.]+)/.exec(res.stdout?.toString() ?? '');
  return m ? Number(m[1]) : NaN;
};

const measureBand = (file, hz) => {
  const err = ffmpeg(
    ['-hide_banner', '-nostats', '-i', file,
     '-af', `${BAND(hz)},volumedetect`, '-f', 'null', '-'],
    `band ${hz} ${file}`,
  );
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
  return mean ? Number(mean[1]) : NaN;
};

/* ------------------------------------------------------------------ regenerate */

console.log(`dev media -> ${OUT}`);

mkdirSync(THUMBS, { recursive: true });

/* From scratch, but surgically: only the files this script owns are removed. Anything else
   in dev-media/ — including media a tester generated by hand, or a file the app's rename
   feature moved aside — is left where it is.

   A running editor holds its media open, and Windows will not let an open file be replaced.
   Say so plainly instead of dying on an EBUSY stack trace, because "close the app" is the
   whole fix and nothing in the error text would otherwise suggest it. */
const remove = (path) => {
  try {
    rmSync(path, { force: true });
  } catch (err) {
    console.error(
      `cannot replace ${path}\n  ${err.message}\n` +
        '  A running editor keeps its media files open on Windows. Close the app and re-run.',
    );
    process.exit(1);
  }
};

for (const v of [...VIDEO, CHART]) {
  remove(join(OUT, v.name));
  remove(join(THUMBS, `${v.name.replace(/\.[^.]+$/, '')}.jpg`));
}
for (const a of AUDIO) remove(join(OUT, a.name));

/** The thumbnail every video fixture gets, chart included. */
const writeThumb = (name, dur) =>
  ffmpeg(
    ['-v', 'error', '-y', '-ss', String(Math.min(1, dur / 2)), '-i', join(OUT, name),
     ...BITEXACT, '-frames:v', '1', '-vf', 'scale=320:-2',
     join(THUMBS, `${name.replace(/\.[^.]+$/, '')}.jpg`)],
    `thumb ${name}`,
  );

for (const v of VIDEO) {
  const out = join(OUT, v.name);
  ffmpeg(
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${v.color}:s=${v.w}x${v.h}:r=${v.fps}:d=${v.dur}`,
      '-f', 'lavfi', '-i', stereoExpr(toneExpr(v.hz), v.dur),
      '-shortest',
      ...BITEXACT,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a', 'aac', '-b:a', ABITRATE,
      '-movflags', '+faststart',
      out,
    ],
    v.name,
  );
  console.log(`  ok  ${v.name}  (${v.hz} Hz)`);
  writeThumb(v.name, v.dur);
}

/* The chart. Its picture comes from a filtergraph rather than an input file, so
   the only `-i` is the tone. */
ffmpeg(
  [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', stereoExpr(toneExpr(CHART.hz), CHART.dur),
    '-filter_complex', chartGraph(),
    '-map', '[v]', '-map', '0:a',
    '-t', String(CHART.dur),
    ...BITEXACT,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', CHART.crf,
    '-pix_fmt', 'yuv420p', '-g', CHART.gop,
    '-c:a', 'aac', '-b:a', ABITRATE,
    '-movflags', '+faststart',
    join(OUT, CHART.name),
  ],
  CHART.name,
);
console.log(`  ok  ${CHART.name}  (${CHART.hz} Hz, step edge + fine detail + bright corners)`);
writeThumb(CHART.name, CHART.dur);

for (const a of AUDIO) {
  const out = join(OUT, a.name);
  ffmpeg(
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', a.input, '-t', String(a.dur),
     ...BITEXACT, '-c:a', 'aac', '-b:a', ABITRATE, out],
    a.name,
  );
  console.log(`  ok  ${a.name}`);
}

/* ---------------------------------------------------------------------- verify */

/* The reason this section exists: the previous generator wrote nine files of digital
   silence and reported success, and it stayed that way until a human happened to listen.
   A generator that does not measure its own output is not evidence of anything. */

console.log('\nmeasured levels');
console.log('  file                       mean dB   max dB   band                 luma');

const SILENT_DB = -60;
let failed = 0;

const report = (name, hz, video = false) => {
  const path = join(OUT, name);
  if (!existsSync(path)) {
    console.error(`  MISSING ${name}`);
    failed += 1;
    return;
  }
  const { mean, max } = measure(path);
  const band = hz ? `${measureBand(path, hz).toFixed(1)} dB @ ${hz} Hz` : 'broadband';
  const kb = `${Math.round(statSync(path).size / 1024)} KB`;
  const bad = !(mean > SILENT_DB);
  if (bad) failed += 1;
  // The luma column exists to make the flatness of the six naturalistic clips
  // VISIBLE rather than a fact you have to go and discover — see the header. A
  // flat clip reading `Y 76` next to the chart reading `Y 30..214` is the whole
  // reason the chart is in this list.
  const y = video ? (({ min, max: hi }) => (min === hi ? `Y ${min} flat` : `Y ${min}..${hi}`))(luma(path)) : '';
  console.log(
    `  ${bad ? 'SILENT ' : '  ok   '}${name.padEnd(24)} ${mean.toFixed(1).padStart(7)}  ${max
      .toFixed(1)
      .padStart(7)}   ${band.padEnd(20)} ${y.padEnd(12)} ${kb}`,
  );
};

for (const v of VIDEO) report(v.name, v.hz, true);
report(CHART.name, CHART.hz, true);
report('room_tone_hall.m4a', null);
report('music_bed_low.m4a', 130.81);
report('vo_take_04.m4a', 850);

/* ------------------------------------------------ the chart carries a picture

   Same principle as the audio check above, applied to the thing this fixture is
   FOR. `blur`, `sharpen` and `vignette` cannot be measured against a flat frame,
   so a chart that had quietly gone flat — a filter renamed, an overlay landing
   off-frame, a CRF crushing the grating — would put the suite straight back in
   the state that let a 29%-narrow blur reach a third verification pass.

   Each region is asserted for the property the effect it serves depends on, and
   nothing more: presence, not appearance. */

const chartPath = join(OUT, CHART.name);
const region = (label, crop, ok, why) => {
  const { min, max } = luma(chartPath, crop);
  if (Number.isNaN(min) || Number.isNaN(max)) {
    console.error(`  FLAT?  ${label}: could not read luma (crop ${crop})`);
    failed += 1;
    return;
  }
  const good = ok(min, max);
  if (!good) failed += 1;
  console.log(`  ${good ? '  ok   ' : 'BROKEN '}${label.padEnd(24)} Y ${min}..${max}   ${good ? why : `EXPECTED ${why}`}`);
};

if (existsSync(chartPath)) {
  console.log('\nchart regions (CREATIVE §3 — blur, sharpen, vignette)');

  // The frame is not flat. This is the single assertion that closes the gap.
  region('whole frame', null, (min, max) => max - min >= 150, 'a wide luma range, not a flat field');

  // A step edge: a band across the block's midline holds BOTH levels, so a
  // scanline through it crosses a boundary. The 10-90% fit needs nothing else.
  region(
    'step edge scanline',
    `${CHART.w}:8:0:${CHART.step.y + CHART.step.h / 2 - 4}`,
    (min, max) => min <= 40 && max >= 200,
    'both levels present across the midline of the step block',
  );

  // Flat field on the approach to the edge, or the fit has no baseline. The
  // 400 px sampled here stop short of the edge at x = CHART.step.x.
  region(
    'flat run before the edge',
    `400:8:40:${CHART.step.y + CHART.step.h / 2 - 4}`,
    (min, max) => min === max,
    'a perfectly flat approach, so an edge-width fit has a baseline',
  );

  /* DETAIL IS MEASURED AS HIGH-PASS ENERGY, not as range — see `highPass`. The
     bar is set against the SPECIFIED grating rather than against "some detail
     exists", because the weaker claim is what let a destroyed tile through:

       this grating (2 px on 8 px)   85     the coarse tile (4 px on 24 px)  41
       3 px on 12 px                 68     one stray line                    1
       4 px on 16 px                 55     flat                              0

     70 therefore says "the pattern this file declares is actually in it", with
     the coarse tile asserted separately so both detail scales are covered. A
     fixture that has been quietly coarsened fails here rather than passing on
     the strength of its own borders. */
  const detail = (label, tile, floor) => {
    const e = highPass(chartPath, `${tile.w}:${tile.h}:${tile.x}:${tile.y}`);
    const good = e >= floor;
    if (!good) failed += 1;
    console.log(
      `  ${good ? '  ok   ' : 'BROKEN '}${label.padEnd(24)} high-pass ${e.toFixed(1).padStart(5)}   ` +
        `${good ? `>= ${floor}, the specified grating is in the file` : `EXPECTED >= ${floor} — the grating specified in CHART is not in the file`}`,
    );
  };
  detail('fine detail grid', CHART.fine, 70);
  detail('coarse detail grid', CHART.coarse, 30);

  // The instrument is not reporting detail everywhere: a flat region must read
  // zero, or the two numbers above mean nothing.
  {
    const e = highPass(chartPath, '200:280:20:700');
    const good = e < 1;
    if (!good) failed += 1;
    console.log(
      `  ${good ? '  ok   ' : 'BROKEN '}${'flat field control'.padEnd(24)} high-pass ${e
        .toFixed(1)
        .padStart(5)}   ${good ? 'zero on flat ground, so the detail figures above mean something' : 'EXPECTED ~0 on a flat region'}`,
    );
  }

  // A bright field reaching the corner, and flat there — `vignette`'s entire
  // observable is corner-against-centre falloff.
  region(
    'bright corner',
    '120:120:0:0',
    (min, max) => min === max && min >= 200,
    'a flat, bright corner for `vignette` to darken',
  );
}

if (failed > 0) {
  console.error(
    `\n${failed} fixture check(s) failed. These files are the only evidence the audio and ` +
      'spatial-effect paths work; a silent fixture makes every audio claim vacuous, and a flat ' +
      'one makes every blur, sharpen and vignette claim vacuous in exactly the same way.',
  );
  process.exit(1);
}

console.log(
  '\ndone — every fixture carries audible, identifiable audio, and one carries a step edge, ' +
    'fine detail and bright corners for CREATIVE §3',
);
