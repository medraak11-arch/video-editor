/* ---------------------------------------------------------------------------
   electron/export/graph.ts — the ffmpeg graph builder. EXPORT §1, §6.

   PURE MODULE. No `electron`, no `node:child_process`, no `node:fs`, no
   `node:path`. It takes an ExportRequest plus two already-joined paths and
   returns argv + the filter script as strings. That is the point: the part most
   likely to be wrong is the part that can be exercised with `node -e` against
   dist-electron/electron/export/graph.js, with no window, no app and no encode.

   Every construct here is EXPORT §1. The three worked examples in EXPORT §1.8
   are the acceptance test for this file and must be diffed byte-for-byte before
   anything is wired.
--------------------------------------------------------------------------- */

import type {
  ExportDocument,
  ExportError,
  ExportErrorCode,
  ExportRequest,
  ExportSource,
} from '../../src/types/api';
import type { Clip } from '../../src/types/model';

/* --------------------------------------------------------------- §4 errors
   One frozen table so a message is written once. graph.ts owns it because it is
   the first module that needs to name an error; electron/ipc/export.ts imports
   it rather than restating a sentence. */

export const ERR: Readonly<Record<ExportErrorCode, ExportError>> = Object.freeze({
  'ffmpeg-missing': {
    code: 'ffmpeg-missing',
    message: 'ffmpeg was not found on PATH, so nothing can be encoded',
    retryable: false,
  },
  'invalid-filename': {
    code: 'invalid-filename',
    message: 'That file name cannot be used on this system',
    retryable: false,
  },
  'empty-timeline': {
    code: 'empty-timeline',
    message: 'There is nothing on the timeline to export',
    retryable: false,
  },
  'source-missing': {
    code: 'source-missing',
    message: 'A source file is no longer where the project expects it',
    retryable: false,
  },
  'unsupported-codec': {
    code: 'unsupported-codec',
    message: 'A source uses a codec this build cannot decode',
    retryable: false,
  },
  'output-not-writable': {
    code: 'output-not-writable',
    message: 'The output folder is missing, so nothing can be written',
    retryable: false,
  },
  'permission-denied': {
    code: 'permission-denied',
    message: 'The output folder does not allow this app to write',
    retryable: false,
  },
  'disk-full': {
    code: 'disk-full',
    message: 'The drive ran out of space before the export finished',
    retryable: false,
  },
  'output-in-use': {
    code: 'output-in-use',
    message: 'The output file is open in another program',
    retryable: true,
  },
  busy: {
    code: 'busy',
    message: 'Another export is already running',
    retryable: true,
  },
  'encoder-failed': {
    code: 'encoder-failed',
    message: 'The encoder stopped before it finished',
    retryable: true,
  },
});

/* --------------------------------------------------------------- §1.10 codec */

/** PLAN §7.3, restated so this pure module needs no renderer import. */
export const CONTAINER: Record<ExportRequest['codec'], string> = {
  h264: 'mp4',
  h265: 'mp4',
  prores: 'mov',
};

interface CodecShape {
  /** base + terminal `format`, and the encoder's -pix_fmt. */
  basePixFmt: string;
  /** per-clip `format` — carries alpha, which opacity and the letterbox need. */
  clipPixFmt: string;
  /** `overlay`'s `format=` option. A CODEC decision, not a constant. */
  overlayFmt: string;
}

const CODEC_SHAPE: Record<ExportRequest['codec'], CodecShape> = {
  h264: { basePixFmt: 'yuv420p', clipPixFmt: 'yuva420p', overlayFmt: 'yuv420' },
  h265: { basePixFmt: 'yuv420p', clipPixFmt: 'yuva420p', overlayFmt: 'yuv420' },
  prores: { basePixFmt: 'yuv422p10le', clipPixFmt: 'yuva422p10le', overlayFmt: 'yuv422p10' },
};

const X264: Record<ExportRequest['quality'], { preset: string; crf: string }> = {
  draft: { preset: 'veryfast', crf: '28' },
  good: { preset: 'medium', crf: '20' },
  best: { preset: 'slow', crf: '16' },
};

const X265: Record<ExportRequest['quality'], { preset: string; crf: string }> = {
  draft: { preset: 'veryfast', crf: '32' },
  good: { preset: 'medium', crf: '24' },
  best: { preset: 'slow', crf: '20' },
};

/** prores_ks -profile:v. 0 proxy, 2 422, 3 422 HQ. */
const PRORES_PROFILE: Record<ExportRequest['quality'], string> = {
  draft: '0',
  good: '2',
  best: '3',
};

/* ------------------------------------------------------------- §1.3 formats
   Fixed so the graph is byte-reproducible: the same document and settings must
   always produce the same script. That is what makes a bug reportable. */

/** Seconds. */
const sec = (n: number): string => n.toFixed(6);
/** Factors: speed, opacity, volume. */
const fac = (n: number): string => n.toFixed(3);
/** A frame rate as ffmpeg spells it: 30, 24, 29.97, 23.976. */
const rate = (n: number): string => String(n);
/** An overlay position offset, as a signed expression tail: '+0', '-40', '+12.500'. */
function offset(n: number): string {
  const magnitude = Math.abs(n);
  const text = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(3);
  return (n < 0 ? '-' : '+') + text;
}

/* ------------------------------------------------------------- §1.7 atempo */

/**
 * atempo's real range on this build is [0.5, 100], so only the LOW end needs
 * decomposing. Chaining atempo=2 three times for speed 8 would be three lossy
 * resamples where one is legal.
 *
 * The `out.length === 0` guard is load-bearing: without it a speed-1 clip emits
 * an empty slot and the chain gets a double comma.
 */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let f = speed;
  while (f < 0.5) {
    out.push('atempo=0.500');
    f /= 0.5;
  }
  if (Math.abs(f - 1) > 1e-6 || out.length === 0) out.push(`atempo=${fac(f)}`);
  return out;
}

/* ------------------------------------------------------------------ result */

export interface BuiltGraph {
  /** argv after the binary name, in order: inputs, -filter_complex_script, maps, encoder, output. */
  args: string[];
  /** The filter script contents. The caller writes it to `scriptPath` UTF-8, no BOM (§1.1). */
  filterScript: string;
  framesTotal: number;
  durationSeconds: number;
  /**
   * Absolute paths every input in `args` references, in input order. The caller
   * access()-checks exactly these, pre-flight (§2.3). NOT `document.sources`: a source
   * used only by a clip outside the range, or on a track that is both hidden and muted,
   * never reaches the graph and must not fail the export.
   */
  sourcePaths: string[];
}

export type BuildResult = { ok: true; graph: BuiltGraph } | { ok: false; error: ExportError };

/* ---------------------------------------------------------------- the build */

/** One clip that survived range intersection and the §1.9 track flags. */
interface Contributor {
  clip: Clip;
  source: ExportSource;
  /** Assigned by the two-pass walk in §1.4. */
  input: number;
  contributesVideo: boolean;
  contributesAudio: boolean;
  /** Input-level -ss / -t, on the PROJECT rate: a source offset is a TIME, not a grid position. */
  ssSec: number;
  tSec: number;
  /** Placement, always on the OUTPUT grid. */
  startSec: number;
  startMs: number;
  enableFrom: number;
  enableTo: number;
  /** Target box: where ClipProperties.scale is honoured. */
  tw: number;
  th: number;
}

export function buildExportGraph(
  req: ExportRequest,
  paths: { scriptPath: string; outputPath: string },
): BuildResult {
  const doc: ExportDocument | undefined = req.document;
  if (!doc) return { ok: false, error: ERR['empty-timeline'] };

  const F = doc.fps; // PROJECT rate. The unit every frame field in the DOCUMENT is in.
  const OF = req.fps; // OUTPUT rate. What the base, every clip chain and the encoder RUN at.
  if (!(F > 0) || !(OF > 0)) return { ok: false, error: ERR['empty-timeline'] };

  const startFrame = req.startFrame;
  const durationFrames = req.durationFrames;
  if (!(durationFrames >= 1)) return { ok: false, error: ERR['empty-timeline'] };

  const rangeEnd = startFrame + durationFrames;
  const durationSeconds = durationFrames / F; // base d=, output -t, §2 denominator
  const framesTotal = Math.max(1, Math.round(durationSeconds * OF));

  const toOut = (projectFrame: number): number => Math.round((projectFrame / F) * OF);

  const sourceById = new Map<string, ExportSource>();
  for (const s of doc.sources) sourceById.set(s.mediaId, s);

  const clipsByTrack = new Map<string, Clip[]>();
  for (const c of doc.clips) {
    const list = clipsByTrack.get(c.trackId);
    if (list) list.push(c);
    else clipsByTrack.set(c.trackId, [c]);
  }
  for (const list of clipsByTrack.values()) list.sort((a, b) => a.start - b.start);

  /* -- collect, in §1.6 order: tracks as given (bottom-first), start ascending -- */

  const collected: Contributor[] = [];

  for (const track of doc.tracks) {
    for (const clip of clipsByTrack.get(track.id) ?? []) {
      // Intersection with the range. Clips outside it are not emitted at all.
      if (clip.start + clip.duration <= startFrame || clip.start >= rangeEnd) continue;

      const props = clip.properties;
      const speed = props.speed;

      const headFrames = Math.max(0, startFrame - clip.start); // trimmed off the clip's head
      const S = Math.max(0, clip.start - startFrame); // PROJECT frame within the range
      const E = Math.min(durationFrames, clip.start + clip.duration - startFrame);

      const timelineFrames = E - S; // >= 1 by the intersection test

      const nStart = toOut(S); // output frame index of the clip's first frame
      const nEnd = toOut(E); // output frame index one past its last

      const wantsVideo =
        track.kind === 'video' && track.visible && props.opacity > 0 && nEnd > nStart;
      const wantsAudio = !track.muted && props.volume > 0;
      if (!wantsVideo && !wantsAudio) continue; // no input, no chain, no overlay

      const source = sourceById.get(clip.mediaId);
      if (!source) return { ok: false, error: ERR['source-missing'] };

      const contributesVideo = wantsVideo;
      const contributesAudio = source.hasAudio && wantsAudio;
      if (!contributesVideo && !contributesAudio) continue;

      const sourceInFrames = clip.mediaIn + Math.round(headFrames * speed);
      // max(1, …) guards the degenerate `-t 0.000000` a 1-frame clip at speed 0.1
      // would otherwise produce; on every case EXPORT §1.3 actually names, the
      // round() is already >= 1 and this clamp is invisible.
      const sourceLenFrames = Math.max(1, Math.round(timelineFrames * speed));

      collected.push({
        clip,
        source,
        input: -1,
        contributesVideo,
        contributesAudio,
        ssSec: sourceInFrames / F,
        tSec: sourceLenFrames / F,
        startSec: nStart / OF,
        startMs: Math.round((nStart / OF) * 1000),
        enableFrom: (nStart - 0.5) / OF, // frame CENTRES, not edges — §1.6
        enableTo: (nEnd - 0.5) / OF,
        tw: Math.max(2, Math.round(req.width * props.scale)),
        th: Math.max(2, Math.round(req.height * props.scale)),
      });
    }
  }

  if (collected.length === 0) return { ok: false, error: ERR['empty-timeline'] };

  /* -- §1.4 input assignment: two passes, and the order is normative --------- */

  const inputs: Contributor[] = [];
  for (const c of collected) {
    if (!c.contributesVideo) continue;
    c.input = inputs.length;
    inputs.push(c);
  }
  for (const c of collected) {
    if (c.contributesVideo) continue;
    c.input = inputs.length;
    inputs.push(c);
  }

  /* ---------------------------------------------------------- §1.2 the graph */

  const shape = CODEC_SHAPE[req.codec];
  const lines: string[] = [];

  lines.push(
    `color=c=black:s=${req.width}x${req.height}:r=${rate(OF)}:d=${sec(durationSeconds)},` +
      `format=${shape.basePixFmt}[vbase]`,
  );
  lines.push(
    `anullsrc=channel_layout=stereo:sample_rate=48000,` +
      `atrim=duration=${sec(durationSeconds)},asetpts=N/SR/TB[abase]`,
  );

  // §1.5 — per-clip video chains, in input order.
  const videoContributors = inputs.filter((c) => c.contributesVideo);
  for (const c of videoContributors) {
    const p = c.clip.properties;
    lines.push(
      `[${c.input}:v]setpts=(PTS-STARTPTS)/${fac(p.speed)},` +
        `fps=fps=${rate(OF)},` +
        `scale=${c.tw}:${c.th}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,` +
        `setsar=1,` +
        `format=${shape.clipPixFmt},` +
        `colorchannelmixer=aa=${fac(p.opacity)},` +
        `setpts=PTS+${sec(c.startSec)}/TB[v${c.input}]`,
    );
  }

  // §1.6 — track order is overlay order; each clip consumes the previous composite.
  let composite = 'vbase';
  videoContributors.forEach((c, i) => {
    const p = c.clip.properties;
    const next = `vc${i}`;
    lines.push(
      `[${composite}][v${c.input}]overlay=` +
        `x=(W-w)/2${offset(p.positionX)}:y=(H-h)/2${offset(p.positionY)}:` +
        `eof_action=pass:shortest=0:repeatlast=0:format=${shape.overlayFmt}:` +
        `enable='gte(t,${sec(c.enableFrom)})*lt(t,${sec(c.enableTo)})'[${next}]`,
    );
    composite = next;
  });
  lines.push(`[${composite}]format=${shape.basePixFmt}[vout]`);

  // §1.7 — per-clip audio chains, keyed to the INPUT index, ascending.
  const audioLabels: string[] = [];
  for (const c of inputs) {
    if (!c.contributesAudio) continue;
    const p = c.clip.properties;
    lines.push(
      `[${c.input}:a]asetpts=PTS-STARTPTS,` +
        `${atempoChain(p.speed).join(',')},` +
        `volume=${fac(p.volume)},` +
        `aresample=48000:async=1:first_pts=0,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `adelay=delays=${c.startMs}:all=1[a${c.input}]`,
    );
    audioLabels.push(`[a${c.input}]`);
  }

  lines.push(
    `[abase]${audioLabels.join('')}amix=inputs=${1 + audioLabels.length}:` +
      `duration=first:dropout_transition=0:normalize=0[aout]`,
  );

  const filterScript = lines.join(';\n');

  /* ----------------------------------------------------------------- §1.4 argv */

  const args: string[] = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  const sourcePaths: string[] = [];
  for (const c of inputs) {
    args.push('-ss', sec(c.ssSec), '-t', sec(c.tSec), '-i', c.source.path);
    sourcePaths.push(c.source.path);
  }

  args.push('-filter_complex_script', paths.scriptPath);
  args.push('-map', '[vout]', '-map', '[aout]');

  /* ------------------------------------------------------------ §1.10 encoder */

  if (req.codec === 'h264') {
    const q = X264[req.quality];
    args.push('-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf);
    args.push('-pix_fmt', shape.basePixFmt, '-r', rate(OF));
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
    args.push('-t', sec(durationSeconds), '-movflags', '+faststart', '-f', 'mp4');
  } else if (req.codec === 'h265') {
    const q = X265[req.quality];
    args.push('-c:v', 'libx265', '-preset', q.preset, '-crf', q.crf, '-tag:v', 'hvc1');
    args.push('-pix_fmt', shape.basePixFmt, '-r', rate(OF));
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
    args.push('-t', sec(durationSeconds), '-movflags', '+faststart', '-f', 'mp4');
  } else {
    args.push('-c:v', 'prores_ks', '-profile:v', PRORES_PROFILE[req.quality], '-vendor', 'apl0');
    args.push('-pix_fmt', shape.basePixFmt, '-r', rate(OF));
    args.push('-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2');
    args.push('-t', sec(durationSeconds), '-f', 'mov');
  }

  // §2.1 — stdout carries progress blocks and nothing else, so the parser owns
  // the stream; -nostats keeps stderr for errors only, which §4 depends on.
  args.push('-progress', 'pipe:1', '-stats_period', '0.25', '-nostats');
  args.push(paths.outputPath);

  return {
    ok: true,
    graph: { args, filterScript, framesTotal, durationSeconds, sourcePaths },
  };
}
