/* ---------------------------------------------------------------------------
   fixtures.ts — the dev-only EditorAPI and the fixture project. PLAN §4.4.

   Loaded by src/main.tsx through a DYNAMIC import, and only when
   `window.editorAPI` is absent, so it is a separate chunk that the Electron
   build never fetches. Nothing in src/lib/** imports this module — the bridge is
   REGISTERED INTO editorApi.ts rather than imported by it (PLAN §1.1).

   The media it points at is real: ./dev-media is served over /dev-media/* with
   Range support by the `ve-dev-media` Vite plugin, so `npm run dev:web` renders
   a populated editor whose preview plays actual video. PLAN §4.4's `url: ''`
   still-frame path stays exercised by the two synthetic items below (the
   offline one and the one stuck probing), which have no file behind them.

   The fixture satisfies every guarantee in §4.4:
     · 12 media items, 6 tracks (V3 V2 V1 A1 A2 A3), 41 clips, 4 markers,
       fps 30, 1920×1080.
     · clip widths span 12 → 1500 frames (3 px → 375 px at ZOOM_DEFAULT), with
       ten clips under CLIP_MIN_LABEL_WIDTH so the degrade path is visible on
       first load.
     · four exact abutments (c01/c02, c09/c10, c23/c24, c30/c31).
     · one item probes `not-found` and two clips reference it.
     · one item stays `probing` at progress 0.4.
     · one ready item carries fps-mismatch, another resolution-mismatch.
     · two clips have properties.speed !== 1.
     · V3 is locked and A2 is muted.
--------------------------------------------------------------------------- */

import type {
  Clip,
  ClipProperties,
  Marker,
  PersistedMediaItem,
  ProjectFile,
  Track,
} from '../types/model';
import { DEFAULT_CLIP_PROPERTIES } from '../types/model';
import type { EditorAPI, ProbeData, ProbeResult, RenameResult } from '../types/api';
import { checkBaseName, renamedPath, splitMediaPath } from '../lib/filename';
import { applyProject } from '../lib/project';

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

/** A plausible absolute path. It carries a separator, so Retry is offered on failures. */
const FOOTAGE = 'C:\\Users\\editor\\Footage';

const secondsToFrames = (seconds: number): number => Math.round(seconds * FPS);

/* ------------------------------------------------------------------- media */

interface FixtureMedia {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  seconds: number;
  width: number;
  height: number;
  /** Native rate. 24 on the drone shot is what produces the fps-mismatch warning. */
  fps: number;
  codec: string;
  hasAudio: boolean;
  /** The file under ./dev-media that actually backs it, or null when nothing does. */
  file: string | null;
  /** How the fixture bridge answers a probe for this path. */
  probe: 'ok' | 'not-found' | 'pending';
}

const MEDIA: readonly FixtureMedia[] = [
  {
    id: 'm_fx_interview_wide_a',
    name: 'interview_wide_a.mp4',
    kind: 'video',
    seconds: 45,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    hasAudio: true,
    file: 'interview_wide_a.mp4',
    probe: 'ok',
  },
  {
    id: 'm_fx_interview_close_b',
    name: 'interview_close_b.mp4',
    kind: 'video',
    seconds: 40,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    hasAudio: true,
    file: 'interview_close_b.mp4',
    probe: 'ok',
  },
  {
    id: 'm_fx_broll_market',
    name: 'broll_market_street.mp4',
    kind: 'video',
    seconds: 25,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    hasAudio: true,
    file: 'broll_market_street.mp4',
    probe: 'ok',
  },
  {
    id: 'm_fx_broll_market_2',
    name: 'broll_market_street_take2.mp4',
    kind: 'video',
    seconds: 25,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    hasAudio: true,
    file: 'broll_market_street.mp4',
    probe: 'ok',
  },
  {
    // 24 fps against a 30 fps project: the fps-mismatch warning (PLAN §7.6).
    id: 'm_fx_drone_pass',
    name: 'drone_pass_02.mp4',
    kind: 'video',
    seconds: 20,
    width: 1920,
    height: 1080,
    fps: 24,
    codec: 'h264',
    hasAudio: true,
    file: 'drone_pass_02.mp4',
    probe: 'ok',
  },
  {
    // 3840×2160 against a 1920×1080 project: the resolution-mismatch warning.
    id: 'm_fx_ocean_sunrise',
    name: 'ocean_sunrise_4k.mp4',
    kind: 'video',
    seconds: 18,
    width: 3840,
    height: 2160,
    fps: 30,
    codec: 'h264',
    hasAudio: true,
    file: 'ocean_sunrise_4k.mp4',
    probe: 'ok',
  },
  {
    id: 'm_fx_macro_coffee',
    name: 'macro_coffee_pour.mp4',
    kind: 'video',
    seconds: 12,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    hasAudio: true,
    file: 'macro_coffee_pour.mp4',
    probe: 'ok',
  },
  {
    id: 'm_fx_room_tone',
    name: 'room_tone_hall.m4a',
    kind: 'audio',
    seconds: 60,
    width: 0,
    height: 0,
    fps: 0,
    codec: 'aac',
    hasAudio: true,
    file: 'room_tone_hall.m4a',
    probe: 'ok',
  },
  {
    id: 'm_fx_music_bed',
    name: 'music_bed_low.m4a',
    kind: 'audio',
    seconds: 90,
    width: 0,
    height: 0,
    fps: 0,
    codec: 'aac',
    hasAudio: true,
    file: 'music_bed_low.m4a',
    probe: 'ok',
  },
  {
    id: 'm_fx_vo_take_04',
    name: 'vo_take_04.m4a',
    kind: 'audio',
    seconds: 30,
    width: 0,
    height: 0,
    fps: 0,
    codec: 'aac',
    hasAudio: true,
    file: 'vo_take_04.m4a',
    probe: 'ok',
  },
  {
    // Nothing behind it: probes 'not-found', two clips go offline.
    id: 'm_fx_archive_missing',
    name: 'archive_b_roll.mp4',
    kind: 'video',
    seconds: 30,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    hasAudio: false,
    file: null,
    probe: 'not-found',
  },
  {
    // Never resolves: the row holds at progress 0.4 so the determinate bar is visible.
    id: 'm_fx_rushes_day2',
    name: 'rushes_day2_08.mp4',
    kind: 'video',
    seconds: 35,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    hasAudio: true,
    file: null,
    probe: 'pending',
  },
];

const pathOf = (m: FixtureMedia): string => `${FOOTAGE}\\${m.name}`;

const urlOf = (m: FixtureMedia): string => (m.file === null ? '' : `/dev-media/${m.file}`);

const thumbOf = (m: FixtureMedia): string | null =>
  m.file === null || m.kind !== 'video'
    ? null
    : `/dev-media/thumbs/${m.file.replace(/\.[^.]+$/, '')}.jpg`;

const persistedMedia = (m: FixtureMedia, index: number): PersistedMediaItem => ({
  id: m.id,
  path: pathOf(m),
  name: m.name,
  kind: m.kind,
  durationFrames: secondsToFrames(m.seconds),
  durationSeconds: m.seconds,
  width: m.width,
  height: m.height,
  fps: m.fps,
  codec: m.codec,
  hasAudio: m.hasAudio,
  // Stable and ordered, so the rail's row order does not shuffle between reloads.
  addedAt: Date.UTC(2026, 1, 14, 9, 0, 0) + index * 60_000,
});

/* ------------------------------------------------------------------ tracks */

const track = (
  id: string,
  kind: 'video' | 'audio',
  index: number,
  label: string,
  height: number,
  state: Partial<Pick<Track, 'muted' | 'locked' | 'visible'>> = {},
): Track => ({
  id,
  kind,
  index,
  label,
  height,
  muted: state.muted ?? false,
  locked: state.locked ?? false,
  visible: state.visible ?? true,
});

const TRACKS: readonly Track[] = [
  track('t_fx_v3', 'video', 3, 'V3', 56, { locked: true }),
  track('t_fx_v2', 'video', 2, 'V2', 56),
  track('t_fx_v1', 'video', 1, 'V1', 56),
  track('t_fx_a1', 'audio', 1, 'A1', 40),
  track('t_fx_a2', 'audio', 2, 'A2', 40, { muted: true }),
  track('t_fx_a3', 'audio', 3, 'A3', 40),
];

/* ------------------------------------------------------------------- clips */

interface ClipSpec {
  n: number;
  media: string;
  track: string;
  start: number;
  duration: number;
  mediaIn: number;
  name: string;
  properties?: Partial<ClipProperties>;
}

/**
 * Every row satisfies the source-mapping invariant (PLAN §2.4 invariant 3):
 * `mediaIn + round(duration * speed) <= media.durationFrames`.
 */
const CLIP_SPECS: readonly ClipSpec[] = [
  // --- V1: the interview spine. Ten cuts, all abutting. --------------------
  { n: 1, media: 'm_fx_interview_wide_a', track: 't_fx_v1', start: 0, duration: 210, mediaIn: 30, name: 'Wide, opening' },
  { n: 2, media: 'm_fx_interview_close_b', track: 't_fx_v1', start: 210, duration: 150, mediaIn: 60, name: 'Close, answer 1' },
  { n: 3, media: 'm_fx_interview_wide_a', track: 't_fx_v1', start: 360, duration: 240, mediaIn: 300, name: 'Wide, answer 2' },
  { n: 4, media: 'm_fx_interview_close_b', track: 't_fx_v1', start: 600, duration: 180, mediaIn: 240, name: 'Close, answer 2' },
  { n: 5, media: 'm_fx_interview_wide_a', track: 't_fx_v1', start: 780, duration: 330, mediaIn: 600, name: 'Wide, story' },
  { n: 6, media: 'm_fx_interview_close_b', track: 't_fx_v1', start: 1110, duration: 90, mediaIn: 450, name: 'Close, reaction' },
  { n: 7, media: 'm_fx_interview_wide_a', track: 't_fx_v1', start: 1200, duration: 420, mediaIn: 900, name: 'Wide, long take' },
  { n: 8, media: 'm_fx_interview_close_b', track: 't_fx_v1', start: 1620, duration: 260, mediaIn: 640, name: 'Close, answer 3' },
  { n: 9, media: 'm_fx_interview_wide_a', track: 't_fx_v1', start: 1880, duration: 40, mediaIn: 1300, name: 'Wide, flash' },
  { n: 10, media: 'm_fx_interview_close_b', track: 't_fx_v1', start: 1920, duration: 300, mediaIn: 900, name: 'Close, sign off' },

  // --- V2: b-roll over the spine ------------------------------------------
  { n: 11, media: 'm_fx_broll_market', track: 't_fx_v2', start: 120, duration: 180, mediaIn: 0, name: 'Market, wide' },
  { n: 12, media: 'm_fx_macro_coffee', track: 't_fx_v2', start: 420, duration: 120, mediaIn: 30, name: 'Coffee pour' },
  { n: 13, media: 'm_fx_drone_pass', track: 't_fx_v2', start: 640, duration: 200, mediaIn: 40, name: 'Drone pass' },
  { n: 14, media: 'm_fx_ocean_sunrise', track: 't_fx_v2', start: 900, duration: 240, mediaIn: 60, name: 'Sunrise' },
  { n: 15, media: 'm_fx_broll_market_2', track: 't_fx_v2', start: 1180, duration: 150, mediaIn: 200, name: 'Market, take 2' },
  { n: 16, media: 'm_fx_macro_coffee', track: 't_fx_v2', start: 1400, duration: 12, mediaIn: 100, name: 'Coffee, flash' },
  { n: 17, media: 'm_fx_drone_pass', track: 't_fx_v2', start: 1450, duration: 60, mediaIn: 300, name: 'Drone, tag' },
  // Half speed: 1000 timeline frames from 500 source frames.
  { n: 18, media: 'm_fx_ocean_sunrise', track: 't_fx_v2', start: 1560, duration: 1000, mediaIn: 0, name: 'Sunrise, slow', properties: { speed: 0.5 } },
  { n: 19, media: 'm_fx_broll_market', track: 't_fx_v2', start: 2600, duration: 140, mediaIn: 400, name: 'Market, tail' },

  // --- V3: archive layer, locked, and offline ------------------------------
  { n: 20, media: 'm_fx_archive_missing', track: 't_fx_v3', start: 300, duration: 200, mediaIn: 0, name: 'Archive, plate' },
  { n: 21, media: 'm_fx_archive_missing', track: 't_fx_v3', start: 1500, duration: 90, mediaIn: 300, name: 'Archive, insert' },
  { n: 22, media: 'm_fx_macro_coffee', track: 't_fx_v3', start: 2000, duration: 160, mediaIn: 150, name: 'Overlay, texture' },

  // --- A1: dialogue --------------------------------------------------------
  { n: 23, media: 'm_fx_vo_take_04', track: 't_fx_a1', start: 0, duration: 240, mediaIn: 0, name: 'VO, intro' },
  { n: 24, media: 'm_fx_vo_take_04', track: 't_fx_a1', start: 240, duration: 200, mediaIn: 240, name: 'VO, line 2' },
  { n: 25, media: 'm_fx_vo_take_04', track: 't_fx_a1', start: 480, duration: 300, mediaIn: 500, name: 'VO, line 3' },
  { n: 26, media: 'm_fx_vo_take_04', track: 't_fx_a1', start: 820, duration: 80, mediaIn: 820, name: 'VO, breath' },
  { n: 27, media: 'm_fx_room_tone', track: 't_fx_a1', start: 950, duration: 600, mediaIn: 0, name: 'Room tone' },
  { n: 28, media: 'm_fx_room_tone', track: 't_fx_a1', start: 1600, duration: 420, mediaIn: 700, name: 'Room tone, 2' },
  { n: 29, media: 'm_fx_vo_take_04', track: 't_fx_a1', start: 2100, duration: 120, mediaIn: 100, name: 'VO, outro' },

  // --- A2: music bed, muted ------------------------------------------------
  { n: 30, media: 'm_fx_music_bed', track: 't_fx_a2', start: 0, duration: 1200, mediaIn: 0, name: 'Music, part 1' },
  { n: 31, media: 'm_fx_music_bed', track: 't_fx_a2', start: 1200, duration: 1500, mediaIn: 1200, name: 'Music, part 2' },

  // --- A3: spot effects, mostly sub-24px ----------------------------------
  { n: 32, media: 'm_fx_room_tone', track: 't_fx_a3', start: 180, duration: 45, mediaIn: 100, name: 'Door' },
  { n: 33, media: 'm_fx_room_tone', track: 't_fx_a3', start: 400, duration: 30, mediaIn: 200, name: 'Cup' },
  { n: 34, media: 'm_fx_vo_take_04', track: 't_fx_a3', start: 700, duration: 24, mediaIn: 300, name: 'Breath' },
  { n: 35, media: 'm_fx_room_tone', track: 't_fx_a3', start: 1000, duration: 60, mediaIn: 400, name: 'Steps' },
  { n: 36, media: 'm_fx_vo_take_04', track: 't_fx_a3', start: 1300, duration: 90, mediaIn: 400, name: 'Aside' },
  { n: 37, media: 'm_fx_room_tone', track: 't_fx_a3', start: 1700, duration: 150, mediaIn: 900, name: 'Street' },
  // Double speed: 200 timeline frames from 400 source frames.
  { n: 38, media: 'm_fx_vo_take_04', track: 't_fx_a3', start: 1950, duration: 200, mediaIn: 400, name: 'Aside, fast', properties: { speed: 2 } },
  { n: 39, media: 'm_fx_room_tone', track: 't_fx_a3', start: 2250, duration: 120, mediaIn: 1200, name: 'Chair' },
  { n: 40, media: 'm_fx_room_tone', track: 't_fx_a3', start: 2400, duration: 320, mediaIn: 1300, name: 'Ambience' },
  { n: 41, media: 'm_fx_vo_take_04', track: 't_fx_a3', start: 2760, duration: 100, mediaIn: 700, name: 'Sting' },
];

const CLIPS: readonly Clip[] = CLIP_SPECS.map((spec) => ({
  id: `c_fx${String(spec.n).padStart(2, '0')}`,
  mediaId: spec.media,
  trackId: spec.track,
  start: spec.start,
  duration: spec.duration,
  mediaIn: spec.mediaIn,
  name: spec.name,
  properties: { ...DEFAULT_CLIP_PROPERTIES, ...spec.properties },
}));

const MARKERS: readonly Marker[] = [
  { id: 'k_fx1', frame: 210, label: 'First cut' },
  { id: 'k_fx2', frame: 900, label: 'Music swells' },
  { id: 'k_fx3', frame: 1620, label: 'B-roll block' },
  { id: 'k_fx4', frame: 2220, label: 'Tail' },
];

export const FIXTURE_PROJECT: ProjectFile = {
  version: 1,
  name: 'Harbour interview',
  fps: FPS,
  width: WIDTH,
  height: HEIGHT,
  media: MEDIA.map(persistedMedia),
  tracks: [...TRACKS],
  trackOrder: TRACKS.map((t) => t.id),
  clips: [...CLIPS],
  markers: [...MARKERS],
  savedAt: '2026-02-14T09:00:00.000Z',
};

/* ------------------------------------------------------------ the bridge */

const BY_PATH = new Map<string, FixtureMedia>(MEDIA.map((m) => [pathOf(m), m]));

/** What `pickFiles` hands back, so the import path is exercisable in a browser. */
const PICKER_PATHS = [
  `${FOOTAGE}\\pickup_shot_a.mp4`,
  `${FOOTAGE}\\pickup_shot_b.mp4`,
] as const;

const PICKED: Record<string, FixtureMedia> = {
  [PICKER_PATHS[0]]: {
    id: 'm_fx_pickup_a',
    name: 'pickup_shot_a.mp4',
    kind: 'video',
    seconds: 12,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    hasAudio: true,
    file: 'macro_coffee_pour.mp4',
    probe: 'ok',
  },
  [PICKER_PATHS[1]]: {
    id: 'm_fx_pickup_b',
    name: 'pickup_shot_b.mp4',
    kind: 'video',
    seconds: 18,
    width: 3840,
    height: 2160,
    fps: 30,
    codec: 'h264',
    hasAudio: true,
    file: 'ocean_sunrise_4k.mp4',
    probe: 'ok',
  },
};

type ProgressListener = (e: { path: string; progress: number }) => void;

const progressListeners = new Set<ProgressListener>();

const emitProgress = (path: string, progress: number): void => {
  for (const listener of progressListeners) listener({ path, progress });
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const probeDataFor = (m: FixtureMedia): ProbeData => ({
  kind: m.kind,
  durationSeconds: m.seconds,
  width: m.width,
  height: m.height,
  fps: m.fps,
  codec: m.codec,
  hasAudio: m.hasAudio,
  url: urlOf(m),
  thumbnailUrl: thumbOf(m),
});

/** Staged progress over ~600 ms, exactly as PLAN §4.4 asks for. */
async function stagedProbe(path: string, m: FixtureMedia): Promise<ProbeResult> {
  for (const step of [0.15, 0.45, 0.8]) {
    await wait(200);
    emitProgress(path, step);
  }
  return { ok: true, data: probeDataFor(m) };
}

async function fixtureProbe(path: string): Promise<ProbeResult> {
  const known = BY_PATH.get(path) ?? PICKED[path];

  if (!known) {
    await wait(200);
    return {
      ok: false,
      error: { code: 'not-found', message: 'That file could not be found on disk' },
    };
  }

  if (known.probe === 'not-found') {
    await wait(400);
    return {
      ok: false,
      error: { code: 'not-found', message: 'That file could not be found on disk' },
    };
  }

  if (known.probe === 'pending') {
    // Holds the row at a determinate 0.4 for the session. The row is the point;
    // it never resolves, so the 'probing' treatment stays on screen to be judged.
    await wait(150);
    emitProgress(path, 0.4);
    return new Promise<ProbeResult>(() => undefined);
  }

  return stagedProbe(path, known);
}

/**
 * Rename, browser edition. There is no filesystem here, so nothing moves — but
 * the RULE is the real one (src/lib/filename.ts, the same predicate main uses),
 * and 'name-taken' is reachable against the other fixture paths. That is what
 * makes the rename UI developable under dev:web without pretending a disk exists.
 *
 * `url` is returned UNCHANGED, because the file Vite serves out of /dev-media is
 * unchanged: only the pseudo-path the fixture reports has moved.
 */
async function fixtureRename(path: string, baseName: string): Promise<RenameResult> {
  const { base, ext } = splitMediaPath(path);

  const check = checkBaseName(baseName, path);
  if (!check.ok) return { ok: false, error: { code: 'invalid-name', message: check.message } };

  const known = MEDIA.find((m) => pathOf(m) === path);
  const url = known ? urlOf(known) : '';

  if (baseName === base) return { ok: true, path, url, name: `${base}${ext}` };

  const target = renamedPath(path, baseName);
  const taken = MEDIA.some(
    (m) => pathOf(m) !== path && pathOf(m).toLowerCase() === target.toLowerCase(),
  );
  if (taken) {
    return {
      ok: false,
      error: {
        code: 'name-taken',
        message: 'A file with that name already exists in this folder',
      },
    };
  }

  // Long enough for the row's busy state to be visible, which is the point of
  // having this at all.
  await wait(250);
  return { ok: true, path: target, url, name: `${baseName}${ext}` };
}

const noBridge = (what: string): { code: 'io-failed'; message: string } => ({
  code: 'io-failed',
  message: `${what} is not available in the browser preview`,
});

export const fixtureAPI: EditorAPI = {
  platform: 'win32',

  window: {
    // There is no window to command in a browser tab, and WindowControls does not
    // render outside Electron, so these exist only to keep the contract total.
    minimize: () => undefined,
    maximizeToggle: () => undefined,
    close: () => undefined,
    isMaximized: () => Promise.resolve(false),
    onMaximizeChange: () => () => undefined,
  },

  media: {
    pickFiles: () => Promise.resolve([...PICKER_PATHS]),
    probe: fixtureProbe,
    rename: fixtureRename,
    onProbeProgress: (cb) => {
      progressListeners.add(cb);
      return () => {
        progressListeners.delete(cb);
      };
    },
    // PLAN §4.4: always null. A browser File has no filesystem path, and the media
    // slice's browser branch reads the File itself instead.
    pathForFile: () => null,
  },

  project: {
    save: () => Promise.resolve({ ok: false, error: noBridge('Saving') }),
    open: () => Promise.resolve({ ok: false, error: noBridge('Opening a project') }),
    // A real folder string, so the export dialog's whole flow is reachable in a browser.
    pickDirectory: () => Promise.resolve(`C:\\Users\\editor\\Exports`),
  },

  // `export` is deliberately absent: ExportDialog falls back to its local stub (PLAN §8.9).
};

export function bootstrapFixtures(): void {
  applyProject(FIXTURE_PROJECT);
}
