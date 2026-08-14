/* ---------------------------------------------------------------------------
   srt.ts — SubRip, both directions. CREATIVE §6.2.

   PURE MODULE, compiled into BOTH bundles: the renderer parses on import and the
   main process formats the temp file it burns in from. One implementation, so
   what is burned into the video is what the cue list showed.

   TOLERANT ON READ, STRICT ON WRITE. Files in the wild carry BOMs, CRLF, a
   decimal point where the spec says a comma, indices that restart at 1 halfway
   through, and no trailing newline. Every one of those is somebody's subtitles
   and refusing them helps nobody. What we WRITE is the intersection every player
   agrees on, because that file leaves the app and we do not control what opens it.
--------------------------------------------------------------------------- */

import type { Frames, SubtitleCue } from '../types/model';
import { newId } from './id';

/* --------------------------------------------------------------------- read */

/**
 * `HH:MM:SS,mmm` — and also `H:MM:SS.mmm`, and also with stray spaces, because
 * all three exist. Hours are optional in some writers' output; when they are
 * missing the first group is minutes, which is why the leading group is matched
 * lazily and counted rather than positionally.
 */
const TIME = /(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
const ARROW = /-->/;

function timeToFrames(h: string, m: string, s: string, ms: string, fps: number): Frames {
  const seconds =
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
  // Rounded to the nearest whole frame, deliberately and lossily: everything in
  // this store is whole frames (model.ts §2.1), and a cue 3 ms off a cut it was
  // authored against is a cue that flickers on that cut.
  return Math.max(0, Math.round(seconds * fps));
}

/**
 * Never throws and never returns a cue that violates `end > start`. A line that
 * cannot be understood is skipped; the cues around it still load. Losing one
 * malformed cue is recoverable, refusing the whole file is not.
 */
export function parseSrt(text: string, fps: number): SubtitleCue[] {
  if (!(fps > 0)) return [];

  // No BOM strip. There was one, and a mutation test proved it could be deleted
  // with no observable effect: a BOM can only ever sit at byte 0, which is the
  // index line, and this parser locates the timing line by searching for the
  // arrow rather than by counting lines — so the BOM leaves with the index. On
  // the one file shape where it reaches the timing line (no index line at all)
  // the unanchored time pattern steps over it. Left in, it would read as load-
  // bearing to the next person; this note is here so it is not re-added.
  const normalised = text.replace(/\r\n?/g, '\n');

  const out: SubtitleCue[] = [];
  // Split on blank lines, tolerating trailing spaces on the "blank" one.
  for (const block of normalised.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').filter((l, i, all) => !(l.trim() === '' && i === all.length - 1));
    if (lines.length === 0) continue;

    // The index line is optional in practice. Find the timing line rather than
    // assuming it is line 2, which is what breaks on files whose index is missing.
    const timingAt = lines.findIndex((l) => ARROW.test(l));
    if (timingAt === -1) continue;

    const [left, right] = lines[timingAt].split(ARROW);
    const a = TIME.exec(left ?? '');
    const b = TIME.exec(right ?? '');
    if (!a || !b) continue;

    const start = timeToFrames(a[1], a[2], a[3], a[4], fps);
    const end = timeToFrames(b[1], b[2], b[3], b[4], fps);
    // A zero-length or reversed cue is not a cue. It is also not a reason to
    // stop: some writers emit one at the end of every file.
    if (!(end > start)) continue;

    const body = lines
      .slice(timingAt + 1)
      .join('\n')
      .trim();
    if (body === '') continue; // an empty cue would render as a blank plate

    out.push({ id: newId('q'), start, end, text: body });
  }

  out.sort((x, y) => x.start - y.start || x.end - y.end);
  return out;
}

/* -------------------------------------------------------------------- write */

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function framesToTime(frames: Frames, fps: number): string {
  // Clamped HERE and nowhere else. `formatSrt` offsets cues by the export range
  // start, which drives a cue that straddles the range boundary negative — and
  // that cue must survive, clamped, because it is on screen at the first
  // exported frame and dropping it would blank a line the preview shows at
  // exactly that frame. Doing it here rather than in the caller keeps it one
  // clamp; a second one upstream was unreachable, which a mutation test proved
  // by deleting it with no observable effect.
  const total = Math.max(0, frames) / fps;
  const ms = Math.round(total * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

/**
 * CRLF, a comma, 1-based sequential indices, one blank line between cues and a
 * trailing newline. Not because the spec insists — it barely exists — but
 * because that is the shape every player has been tested against.
 *
 * `offsetFrames` shifts every cue earlier by that many frames and drops
 * everything that lands before zero. It is what the burn-in path uses to align
 * a subtitle file with an export that starts partway into the timeline; the
 * sidecar export passes nothing and gets the timeline's own times.
 */
export function formatSrt(cues: SubtitleCue[], fps: number, offsetFrames = 0): string {
  if (!(fps > 0)) return '';

  const shifted = cues
    .map((c) => ({ ...c, start: c.start - offsetFrames, end: c.end - offsetFrames }))
    // A cue that ends before the range never appears. A cue that STRADDLES the
    // start does, clamped to zero by `framesToTime` — see the note there.
    .filter((c) => c.end > 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const blocks = shifted.map(
    (c, i) =>
      `${i + 1}\r\n${framesToTime(c.start, fps)} --> ${framesToTime(c.end, fps)}\r\n` +
      `${c.text.replace(/\r\n?|\n/g, '\r\n')}\r\n`,
  );

  return blocks.join('\r\n') + (blocks.length > 0 ? '\r\n' : '');
}
