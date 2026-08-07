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
 * The six video clips are steady full-length sine tones at 100 Hz × a distinct prime, so
 * no clip's tone is a harmonic of any other and a mix can be decomposed by frequency:
 *
 *   file                        tone       mean dB   max dB
 *   interview_wide_a.mp4         300 Hz      -15.1     -8.9
 *   interview_close_b.mp4        500 Hz      -15.0     -9.5
 *   broll_market_street.mp4      700 Hz      -15.0     -8.4
 *   drone_pass_02.mp4           1100 Hz      -15.0     -8.0
 *   ocean_sunrise_4k.mp4        1300 Hz      -15.2     -7.8
 *   macro_coffee_pour.mp4       1700 Hz      -15.1     -7.8
 *
 * All six sit at the SAME level — amplitude exactly 0.25, so RMS is 0.25/√2 = -15.05 dBFS
 * and the measured means agree to a tenth of a dB. "Did every source reach the mix at equal
 * weight?" is therefore a question about six numbers that should match. (The peaks read a
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

for (const v of VIDEO) {
  remove(join(OUT, v.name));
  remove(join(THUMBS, `${v.name.replace(/\.[^.]+$/, '')}.jpg`));
}
for (const a of AUDIO) remove(join(OUT, a.name));

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

  ffmpeg(
    ['-v', 'error', '-y', '-ss', String(Math.min(1, v.dur / 2)), '-i', out,
     ...BITEXACT, '-frames:v', '1', '-vf', 'scale=320:-2',
     join(THUMBS, `${v.name.replace(/\.[^.]+$/, '')}.jpg`)],
    `thumb ${v.name}`,
  );
}

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
console.log('  file                       mean dB   max dB   band');

const SILENT_DB = -60;
let failed = 0;

const report = (name, hz) => {
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
  console.log(
    `  ${bad ? 'SILENT ' : '  ok   '}${name.padEnd(24)} ${mean.toFixed(1).padStart(7)}  ${max
      .toFixed(1)
      .padStart(7)}   ${band.padEnd(20)} ${kb}`,
  );
};

for (const v of VIDEO) report(v.name, v.hz);
report('room_tone_hall.m4a', null);
report('music_bed_low.m4a', 130.81);
report('vo_take_04.m4a', 850);

if (failed > 0) {
  console.error(
    `\n${failed} fixture(s) came back at or below ${SILENT_DB} dB. These files are the only ` +
      'evidence the audio path works; shipping silent ones makes every audio claim vacuous.',
  );
  process.exit(1);
}

console.log('\ndone — every fixture carries audible, identifiable audio');
