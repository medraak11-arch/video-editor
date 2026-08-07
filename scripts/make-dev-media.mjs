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
 * files. dev-media/ is gitignored; re-run `npm run fixtures:media` to recreate it.
 *
 * Requires ffmpeg/ffprobe on PATH (the same assumption the real media IPC makes).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'dev-media');
const THUMBS = join(OUT, 'thumbs');
mkdirSync(THUMBS, { recursive: true });

const VIDEO = [
  { name: 'interview_wide_a.mp4', color: 'darkslategray', w: 1920, h: 1080, fps: 30, dur: 45 },
  { name: 'interview_close_b.mp4', color: 'dimgray', w: 1920, h: 1080, fps: 30, dur: 40 },
  { name: 'broll_market_street.mp4', color: 'sienna', w: 1920, h: 1080, fps: 30, dur: 25 },
  { name: 'drone_pass_02.mp4', color: 'steelblue', w: 1920, h: 1080, fps: 24, dur: 20 },
  { name: 'ocean_sunrise_4k.mp4', color: 'darkorange', w: 3840, h: 2160, fps: 30, dur: 18 },
  { name: 'macro_coffee_pour.mp4', color: 'saddlebrown', w: 1920, h: 1080, fps: 30, dur: 12 },
];

const AUDIO = [
  { name: 'room_tone_hall.m4a', dur: 60 },
  { name: 'music_bed_low.m4a', dur: 90 },
  { name: 'vo_take_04.m4a', dur: 30 },
];

const run = (args, label) => {
  const res = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (res.error) {
    console.error(`ffmpeg not runnable: ${res.error.message}`);
    process.exit(2);
  }
  if (res.status !== 0) {
    console.error(`FAILED ${label}\n${res.stderr?.toString().slice(-800) ?? ''}`);
    process.exit(1);
  }
  console.log(`  ok  ${label}`);
};

console.log(`dev media -> ${OUT}`);

for (const v of VIDEO) {
  const out = join(OUT, v.name);
  if (!existsSync(out)) {
    run(
      [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${v.color}:s=${v.w}x${v.h}:r=${v.fps}:d=${v.dur}`,
        '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`,
        '-shortest',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        out,
      ],
      v.name,
    );
  } else {
    console.log(`  --  ${v.name} (exists)`);
  }

  const thumb = join(THUMBS, `${v.name.replace(/\.[^.]+$/, '')}.jpg`);
  if (!existsSync(thumb)) {
    run(
      ['-v', 'error', '-y', '-ss', String(Math.min(1, v.dur / 2)), '-i', out,
       '-frames:v', '1', '-vf', 'scale=320:-2', thumb],
      `thumb ${v.name}`,
    );
  }
}

for (const a of AUDIO) {
  const out = join(OUT, a.name);
  if (existsSync(out)) {
    console.log(`  --  ${a.name} (exists)`);
    continue;
  }
  run(
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${a.dur}`,
     '-c:a', 'aac', '-b:a', '128k', out],
    a.name,
  );
}

console.log('done');
