#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-transitions.mjs — the gate on transitions in the export graph.
   CREATIVE.md §4, §7.

   Run:  node scripts/check-transitions.mjs

   Why this exists: the cross-dissolve in §4.3 is built out of two edits that
   look unrelated in the source — the OUTGOING clip takes more source through
   its input `-t`, and the INCOMING clip gets an alpha ramp. Either one alone
   produces a file that encodes without complaint:

     - ramp without tail  → the incoming clip dissolves up out of BLACK, because
                            nothing is underneath it any more. Looks like a fade.
     - tail without ramp  → the outgoing clip simply runs long and is covered by
                            a hard cut. Looks like no transition at all.

   Neither fails. Neither warns. Both are wrong, and both are the kind of wrong
   a person notices weeks later on a finished edit. So this gate asserts the
   TWO halves independently, and asserts the handle arithmetic that decides how
   much tail is legal.

   It asserts SEMANTICS — the `-t` seconds for a given input, the presence of an
   alpha ramp in that input's chain — rather than filter-string spelling, so the
   graph builder stays free to order its filters however it needs to.

   Bundled from source, for the reason check-export-graph.mjs states at length:
   reading build output lets a STALE build make the gate pass.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(new URL('../electron/export/graph.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 've-transitions-'));
const outfile = join(dir, 'graph.mjs');

/* CREATIVE §7.4 entry 8 — the bundle survives a FAILURE. Deleted on a pass; on a
   failure it is kept and its path PRINTED, so what was actually compiled can be
   read rather than guessed at. An unreproducible `check-linking` failure was
   once diagnosed as a torn mid-save read and relayed onward as such; there was
   no torn file — another agent had bound `V` to two rows and the gate caught the
   mutation in flight. Naming a mechanism is not evidence.

   DECLARED HERE, AT TOP LEVEL, AND THAT IS THE WHOLE POINT OF THIS COMMENT. The
   retrofit first put this `let` inside the `finally` below, where it is
   block-scoped — so the reference in the failure branch resolved to nothing and
   the gate died with `ReferenceError: keepBundle is not defined` at the exact
   moment it had a real defect to report. It passed every green run, because the
   only path that touches it is the path that runs when something is wrong. A
   gate that throws a stack trace about its own explaining mechanism, instead of
   the explanation, is worse than one without the mechanism at all. */
let keepBundle = false;
process.on('exit', () => {
  if (keepBundle) return;
  rmSync(dir, { recursive: true, force: true });
});

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
} catch (error) {
  // The bundle is worth keeping when the BUILD is what failed, too.
  keepBundle = true;
  throw error;
}

const { buildExportGraph } = mod;
if (typeof buildExportGraph !== 'function') {
  console.error('transitions: buildExportGraph is not exported from electron/export/graph.ts');
  process.exit(2);
}

const failures = [];
const fail = (msg) => failures.push(msg);
const near = (label, actual, expected, tol = 1e-6) => {
  if (!(Math.abs(actual - expected) <= tol)) fail(`${label}: expected ${expected}, got ${actual}`);
};

/* --------------------------------------------------------------- a document

   FPS 30 throughout, project === output, so every frame count converts to
   seconds by /30 and an arithmetic error cannot hide behind a rate conversion.

   Two clips butt-joined at frame 60 on ONE video track. `a` uses source frames
   0..60 of a 300-frame source, so it has 240 frames of handle — far more than
   any transition here asks for. `b`'s handle is irrelevant: a dissolve consumes
   the OUTGOING clip's tail, never the incoming clip's head.                  */

const FPS = 30;
const PROPS = {
  scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1, speed: 1, volume: 1,
  brightness: 0, contrast: 1, saturation: 1, temperature: 0,
  blur: 0, sharpen: 0, vignette: 0, flipH: false, flipV: false,
};

const track = { id: 't1', kind: 'video', index: 1, label: 'V1', height: 64, muted: false, locked: false, visible: true };

const clip = (id, start, duration, mediaIn, extra = {}) => ({
  id, mediaId: 'm1', trackId: 't1', start, duration, mediaIn,
  name: id, properties: { ...PROPS }, ...extra,
});

const source = (durationFrames) => ({
  mediaId: 'm1', path: '/media/a.mp4', kind: 'video', hasAudio: true,
  durationFrames, width: 1920, height: 1080,
});

const doc = (clips, sourceFrames = 300) => ({
  fps: FPS, width: 1920, height: 1080,
  tracks: [track], clips, sources: [source(sourceFrames)],
  titles: [], subtitles: [], subtitleStyle: { sizePct: 0.055, color: '#ffffff', outline: 2, marginPct: 0.08 },
});

const req = (document) => ({
  filename: 'out', folder: '/out', width: 1920, height: 1080, fps: FPS,
  codec: 'h264', quality: 'good', range: 'entire', burnSubtitles: false,
  startFrame: 0, durationFrames: 180, document,
});

function graphOf(label, document, extraPaths = {}) {
  const r = buildExportGraph(req(document), {
    scriptPath: '/tmp/s.txt',
    outputPath: '/tmp/o.mp4',
    ...extraPaths,
  });
  if (!r.ok) {
    fail(`${label}: build refused the document — ${r.error.code}: ${r.error.message}`);
    return null;
  }
  return r.graph;
}

/** The `-t` seconds passed for input N, read back out of argv. */
function inputSeconds(graph, n) {
  let seen = -1;
  for (let i = 0; i < graph.args.length; i += 1) {
    if (graph.args[i] === '-i') {
      seen += 1;
      if (seen === n) {
        for (let j = i - 1; j >= 0 && j > i - 6; j -= 1) {
          if (graph.args[j] === '-t') return Number(graph.args[j + 1]);
        }
        return NaN;
      }
    }
  }
  return NaN;
}

/** The filter-script line that consumes `[N:v]`. */
const videoChain = (graph, n) =>
  graph.filterScript.split(';\n').find((l) => l.startsWith(`[${n}:v]`)) ?? '';
/** The filter-script line that consumes `[N:a]`. */
const audioChain = (graph, n) =>
  graph.filterScript.split(';\n').find((l) => l.startsWith(`[${n}:a]`)) ?? '';

/** An ALPHA ramp, not a luminance one — §4.2. A luminance fade would punch a
 *  black hole through whatever is beneath instead of revealing it. */
const hasAlphaFade = (chain, dir) =>
  new RegExp(`fade=[^,]*t=${dir}`).test(chain) && /fade=[^,]*alpha=1/.test(chain);

/* --------------------------------------------------- 1. nothing means nothing */

const plain = graphOf('no transitions', doc([clip('a', 0, 60, 0), clip('b', 60, 60, 0)]));
if (plain) {
  if (/fade=/.test(plain.filterScript)) fail('no transitions: the script must contain no fade at all');
  if (/afade=/.test(plain.filterScript)) fail('no transitions: the script must contain no afade at all');
  near('no transitions: clip a takes exactly its own length', inputSeconds(plain, 0), 60 / FPS);
}

/* --------------------------------------------------------------- 2. plain fade */

const faded = graphOf(
  'fade in and out',
  doc([
    clip('a', 0, 60, 0, { transitionIn: { kind: 'fade', frames: 10 }, transitionOut: { kind: 'fade', frames: 10 } }),
    clip('b', 60, 60, 0),
  ]),
);
if (faded) {
  const v = videoChain(faded, 0);
  if (!hasAlphaFade(v, 'in')) fail(`fade in: input 0 has no alpha fade-in.\n    chain: ${v}`);
  if (!hasAlphaFade(v, 'out')) fail(`fade out: input 0 has no alpha fade-out.\n    chain: ${v}`);
  const a = audioChain(faded, 0);
  if (!/afade=[^,]*t=in/.test(a)) fail(`fade in: input 0 has no afade-in.\n    chain: ${a}`);
  if (!/afade=[^,]*t=out/.test(a)) fail(`fade out: input 0 has no afade-out.\n    chain: ${a}`);
  // A plain fade takes NO extra source: it ramps the clip's own frames.
  near('fade takes no extra source', inputSeconds(faded, 0), 60 / FPS);
}

/* ------------------------------------------- 3. dissolve, handle to spare */

const N = 12;
const dissolved = graphOf(
  'dissolve with ample handle',
  doc([clip('a', 0, 60, 0), clip('b', 60, 60, 0, { transitionIn: { kind: 'dissolve', frames: N } })]),
);
if (dissolved) {
  // HALF ONE: the outgoing clip runs N frames longer, so there is something
  // underneath to dissolve FROM. Without this the incoming clip rises out of
  // black and the result is a fade wearing a dissolve's name.
  near('dissolve: outgoing input is extended by exactly the transition', inputSeconds(dissolved, 0), (60 + N) / FPS);
  // HALF TWO: the incoming clip ramps up in alpha. Without this the outgoing
  // clip merely runs long under a hard cut and there is no transition at all.
  const v = videoChain(dissolved, 1);
  if (!hasAlphaFade(v, 'in')) fail(`dissolve: incoming input 1 has no alpha fade-in.\n    chain: ${v}`);
  // The incoming clip's own length is untouched — a dissolve consumes the
  // OUTGOING clip's handle, never the incoming clip's head.
  near('dissolve: incoming input is not extended', inputSeconds(dissolved, 1), 60 / FPS);

  /* AND THE SOUND — CREATIVE §4.3a, and this assertion is the OPPOSITE of the
     one it replaces.

     A cross dissolve is a PICTURE event. It applies NO audio ramp, on either
     side: the sound at a dissolve is a hard cut, the same cut every ordinary
     edit point in this programme already makes. Both other answers lost, and
     for reasons this gate has to keep enforcing rather than re-litigate.

       · Ramp the incoming side only — the original defect. The ramp was derived
         from `transitionIn.frames` without consulting `.kind`, so the incoming
         clip climbed out of silence while the outgoing one stopped dead at its
         `atrim`. For the length of the transition the only thing playing was a
         clip fading up from zero: an audible hole, invisible in a filter script
         and obvious in the file.
       · Cross-fade both sides — coherent, measured, and UNPREVIEWABLE.
         `useAudioMonitor` picks one voice per track and a dissolve is two clips
         on the SAME track, so the file would blend where the preview hard cuts.
         That is the "preview quietly disagrees with the file" failure CREATIVE
         opens by refusing.

     So: NEITHER chain may carry an `afade` at a dissolve. `transitionOut`'s kind
     is always `fade` and is asserted separately above — this is only about the
     dissolve edge. */
  const ain = audioChain(dissolved, 1);
  const aout = audioChain(dissolved, 0);
  if (/afade=/.test(ain)) {
    fail(
      'dissolve: the INCOMING clip carries an audio ramp. A cross dissolve is a picture ' +
        'event and applies no audio ramp on either side (CREATIVE §4.3a) — a ramp here is ' +
        'the one-sided fade that leaves an audible hole across the transition.\n' +
        `    incoming audio chain: ${ain}`,
    );
  }
  if (/afade=/.test(aout)) {
    fail(
      'dissolve: the OUTGOING clip carries an audio ramp. The audio at a cross dissolve is ' +
        'a hard cut (CREATIVE §4.3a); a ramp here means the export is cross-fading sound the ' +
        'preview cannot follow, because one track sounds one voice.\n' +
        `    outgoing audio chain: ${aout}`,
    );
  }
  // And the sound is not merely un-ramped, it is un-EXTENDED. The tail bought
  // `N` more frames of picture to dissolve out of; carrying `N` more frames of
  // the outgoing clip's audio would play sound the edit does not contain, over
  // the top of the incoming clip's.
  if (!/atrim=end=/.test(aout)) {
    fail(
      'dissolve: the outgoing audio chain has no `atrim` back to its own length. The tail ' +
        'extension is a PICTURE bargain — without the trim the export plays N frames of audio ' +
        'that are not in the edit.\n' +
        `    outgoing audio chain: ${aout}`,
    );
  }
}

/* ------------------------------- 3b. a fade at the SAME edge still ramps sound

   The rule above is about `kind`, not about the edge, and the cheapest way to
   get it wrong is to stop consulting `kind` in the other direction: silence the
   audio ramp for every `transitionIn`. That would take `fade` — which ramps from
   BLACK AND SILENCE, §4.2 — down with it, and the two cases are one line apart
   in the builder. */

const fadeIncoming = graphOf(
  'a fade on the same edge a dissolve would use',
  doc([clip('a', 0, 60, 0), clip('b', 60, 60, 0, { transitionIn: { kind: 'fade', frames: 12 } })]),
);
if (fadeIncoming) {
  const a = audioChain(fadeIncoming, 1);
  if (!/afade=[^,]*t=in/.test(a)) {
    fail(
      'fade in on clip b: a `fade` still ramps the audio — only a `dissolve` does not. ' +
        'Suppressing both is the same bug as ramping both, mirrored.\n' +
        `    chain: ${a}`,
    );
  }
  // And it must NOT take the dissolve's tail: a fade ramps the clip's own frames.
  near('fade in: the earlier clip is not extended', inputSeconds(fadeIncoming, 0), 60 / FPS);
}

/* ------------------------------------------ 4. dissolve, handle runs short */

// Source is 68 frames; clip `a` uses 0..60, so only 8 frames of handle exist
// against a 20-frame request. The build clamps to 8 and does NOT write it back.
const clamped = graphOf(
  'dissolve clamped to the available handle',
  doc([clip('a', 0, 60, 0), clip('b', 60, 60, 0, { transitionIn: { kind: 'dissolve', frames: 20 } })], 68),
);
if (clamped) {
  near('dissolve: extension clamps to the handle that exists', inputSeconds(clamped, 0), (60 + 8) / FPS);
}

/* ------------------------------------------------ 5. dissolve with no handle */

// Source is exactly as long as the clip: zero handle. §4.3 says degrade to a
// plain fade and keep going — a transition that cannot be honoured is not a
// reason to refuse an export.
const noHandle = graphOf(
  'dissolve with no handle at all',
  doc([clip('a', 0, 60, 0), clip('b', 60, 60, 0, { transitionIn: { kind: 'dissolve', frames: 12 } })], 60),
);
if (noHandle) {
  near('no handle: outgoing input is not extended', inputSeconds(noHandle, 0), 60 / FPS);
  const v = videoChain(noHandle, 1);
  if (!hasAlphaFade(v, 'in')) {
    fail(`no handle: the dissolve must degrade to a fade, not vanish.\n    chain: ${v}`);
  }
}

/* ------------------------------- 6. a dissolve needs an adjacent neighbour */

// A gap before the incoming clip means there is nothing to dissolve from, so
// there is nothing to extend. It must still not throw and must still fade.
const gapped = graphOf(
  'dissolve with a gap before it',
  doc([clip('a', 0, 40, 0), clip('b', 60, 60, 0, { transitionIn: { kind: 'dissolve', frames: 12 } })]),
);
if (gapped) {
  near('gap: the earlier clip is not extended across a gap', inputSeconds(gapped, 0), 40 / FPS);
}

/* ---------------------------------------- 7. burn-in, AT THE RIGHT SEAM ----

   Not a transition, but the same class of bug — a value that travels through
   four layers and, if any one drops it, produces an export that succeeds, plays,
   and simply has no subtitles in it. Nothing fails, nothing warns.

   WHICH LAYER THIS TESTS, because the first version of this section tested the
   wrong one. It asserted that `burnSubtitles: true` made the BUILDER emit a
   `subtitles=` filter. That demanded a pure function produce a filter whose
   enabling input it was never given: the decision does not live in the builder
   at all. It lives in `writeSubtitles` in electron/ipc/export.ts, which is the
   only code that can answer it — the builder joins no paths and writes no files,
   so "is there a burn-in" is the same question as "did main put a SubRip file on
   disk". The answer reaches the builder as `paths.subtitlesFile`, and a builder
   handed none correctly emits nothing.

   So the seam this exercises is `BuildPaths.subtitlesFile`, in both states, and
   `burnSubtitles` on the request is deliberately NOT what is varied. */

const withCues = doc([clip('a', 0, 60, 0), clip('b', 60, 60, 0)]);
withCues.subtitles = [{ id: 'q1', start: 10, end: 40, text: 'hello' }];

// The bare RELATIVE name main writes, and the only shape that may appear: ffmpeg
// is spawned with `cwd` set to that directory precisely so nothing has to be
// escaped. An absolute Windows path inside a filter script needs `C\:/Users/…`,
// and this machine's userData path carries spaces and a drive letter — the exact
// shape that breaks (CREATIVE §6.3).
const SUBS = 'subs.srt';

const noSubs = graphOf('no subtitlesFile', withCues);
if (noSubs && /subtitles=/.test(noSubs.filterScript)) {
  fail(
    'burn-in: the builder emitted a `subtitles=` filter with NO subtitlesFile handed to it. ' +
      'That names a file main did not write, and ffmpeg refuses the whole graph.',
  );
}

const burned = graphOf('with subtitlesFile', withCues, { subtitlesFile: SUBS });
if (burned) {
  const script = burned.filterScript;
  const videoTerminal = script.split(';\n').find((l) => /\[vout\]$/.test(l)) ?? '';

  if (!/subtitles=/.test(script)) {
    fail(
      'burn-in: given a subtitlesFile the builder emits no `subtitles=` filter at all. Main ' +
        'wrote the SubRip file and set the path; the graph dropped it, so the export succeeds ' +
        'with no captions in it and nothing fails.',
    );
  } else {
    // The TERMINAL video chain — after the last overlay, before the final
    // `format`. Above every clip, so captions sit over the whole composite; after
    // every clip's grade, so no clip's grade tints them (§6.3).
    if (!/subtitles=/.test(videoTerminal)) {
      fail(
        "burn-in: the subtitles filter is not in the TERMINAL video chain. Inside a clip's " +
          "chain it would sit under later clips and take that clip's grade.\n" +
          `    terminal: ${videoTerminal}`,
      );
    }
    // Exactly the name it was given, bare.
    if (!new RegExp(`subtitles=filename=${SUBS}[:,]`).test(script)) {
      fail(
        `burn-in: the filter does not name the file it was handed as a bare relative name. ` +
          `Expected \`subtitles=filename=${SUBS}\`.\n    terminal: ${videoTerminal}`,
      );
    }
    if (/subtitles=[^,;]*[A-Za-z]:[\\/]/.test(script)) {
      fail(
        'burn-in: the subtitles filter carries an ABSOLUTE path. It must be the bare relative ' +
          'name main wrote, with ffmpeg spawned in that directory — CREATIVE §6.3.',
      );
    }
  }
}

/* An audio-only export has no picture to burn into. `writeSubtitles` already
   returns undefined for one, but the builder must not depend on that: it emits
   no `[vout]` chain at all here, so a `subtitles=` appearing would mean the
   filter had been attached somewhere that produces an unconnected output and a
   refused graph. Handed the file ANYWAY, which is the point — this asserts the
   builder's own arm, not main's. */
const audioGraph = buildExportGraph(
  { ...req(withCues), codec: 'wav', burnSubtitles: true },
  { scriptPath: '/tmp/s.txt', outputPath: '/tmp/o.wav', subtitlesFile: SUBS },
);
if (!audioGraph.ok) {
  fail(`burn-in (audio-only): build refused — ${audioGraph.error.code}`);
} else if (/subtitles=/.test(audioGraph.graph.filterScript)) {
  fail(
    'burn-in: an audio-only export emitted a subtitles filter. There is no video chain to ' +
      'attach it to, so this is a filtergraph output nothing maps and ffmpeg refuses the run.',
  );
}

/* ============================================================================
   8. §4.3d — A DISSOLVE OUT OF A TITLE DEGRADES TO A FADE.

   A capability the export HAD and that was deliberately removed. Verified
   through the real builder before the ruling: two title cards with a 12-frame
   dissolve emitted `-t 2.500000` for a 2.0s outgoing title — a genuine tail
   extension, exactly 12 frames, with the incoming card alpha-ramping over it. A
   correct cross dissolve, and `notices` empty.

   The preview cannot follow it, structurally: `DissolveUnderlay` is ONE element
   at the bottom of the stage, in the picture plane, so a title's underlay drawn
   there would sit BENEATH the footage rather than above it. The preview shows
   the incoming card fading up over black while the file cross-fades two cards.
   Credits and lower-third sequences are made of exactly that, so it is not a
   corner. §4.3a's precedent decides it — that section deleted a working,
   MEASURED audio crossfade for the same reason — and this project does not ship
   an export behaviour the preview cannot show.

   WHY THIS GATE EXISTS EVEN THOUGH `check-transitions` WAS ALREADY GREEN: it was
   green because nothing it asserted changed. Every existing row here is a
   footage dissolve, and the new branch is invisible to all of them. A gate that
   is green before and after a behaviour change has not tested the change.

   FOUR ROWS, and case 4 carries the most weight. It is the regression nobody
   would think to look for: a `clipIsTitle` test placed anywhere near the clip
   list rather than on the OUTGOING clip of the dissolve specifically would break
   an ordinary footage dissolve merely because a title happened to sit on a track
   above it. Case 3 is its mirror — dissolving INTO a title is untouched, because
   the rule is about what is underneath, not what is on top.
============================================================================ */

const TITLE_SPEC = {
  text: 'CARD',
  sizePct: 0.09,
  fontFamily: 'Inter, sans-serif',
  bold: true,
  italic: false,
  color: '#ffffff',
  background: '#000000',
  backgroundOpacity: 0,
  align: 'center',
  anchorX: 0.5,
  anchorY: 0.5,
};

const V1 = { id: 'tv1', kind: 'video', index: 1, label: 'V1', height: 64, muted: false, locked: false, visible: true };
const V2 = { id: 'tv2', kind: 'video', index: 2, label: 'V2', height: 64, muted: false, locked: false, visible: true };

const mediaClip = (id, trackId, start, duration, mediaId, extra = {}) => ({
  id, mediaId, trackId, start, duration, mediaIn: 0,
  name: id, properties: { ...PROPS }, ...extra,
});

const titleClip = (id, trackId, start, duration, extra = {}) => ({
  id, mediaId: '', trackId, start, duration, mediaIn: 0,
  name: id, kind: 'title', title: { ...TITLE_SPEC },
  properties: { ...PROPS }, ...extra,
});

const mediaSource = (mediaId, durationFrames = 300) => ({
  mediaId, path: `/media/${mediaId}.mp4`, kind: 'video', hasAudio: true,
  durationFrames, width: 1920, height: 1080,
});

/** A document with explicit tracks and sources — the one above is single-track. */
const doc43d = (tracks, clips, sources) => ({
  fps: FPS, width: 1920, height: 1080,
  tracks, clips, sources,
  titles: [], subtitles: [],
  subtitleStyle: { sizePct: 0.055, color: '#ffffff', outline: 2, marginPct: 0.08 },
});

/**
 * The `-t` seconds for the input opened on `path`, and that input's index.
 *
 * BY PATH, not by position. Input order is an implementation detail of the
 * collect pass, and a gate that hard-codes an index is asserting against its own
 * model of that pass rather than against the graph — it would go quietly wrong,
 * not loudly, the day a clip stops contributing or the order changes.
 */
function inputFor(graph, path) {
  let n = -1;
  for (let i = 0; i < graph.args.length; i += 1) {
    if (graph.args[i] !== '-i') continue;
    n += 1;
    if (graph.args[i + 1] !== path) continue;
    for (let j = i - 1; j >= 0 && j > i - 8; j -= 1) {
      if (graph.args[j] === '-t') return { index: n, seconds: Number(graph.args[j + 1]) };
    }
    return { index: n, seconds: NaN };
  }
  return { index: -1, seconds: NaN };
}

const DISSOLVE = { transitionIn: { kind: 'dissolve', frames: N } };
const PNGS = { titlePngs: { card_out: '/tmp/t_out.png', card_in: '/tmp/t_in.png', over: '/tmp/t_over.png' } };

/* ---------------------------------------------- 8.1 title -> title: DEGRADED */

{
  const g = graphOf(
    'title dissolving out of a title',
    doc43d(
      [V1],
      [titleClip('card_out', V1.id, 0, 60), titleClip('card_in', V1.id, 60, 60, DISSOLVE)],
      [],
    ),
    PNGS,
  );
  if (g) {
    const outgoing = inputFor(g, '/tmp/t_out.png');
    const incoming = inputFor(g, '/tmp/t_in.png');

    // THE RULING: no tail extension. The outgoing card takes exactly its own
    // length, so there is nothing underneath for the incoming one to reveal —
    // which is what the preview shows.
    near(
      '8.1 title -> title: the outgoing title is NOT extended',
      outgoing.seconds,
      60 / FPS,
    );

    /* AND THE TRANSITION DOES NOT VANISH. This is the whole ruling and the half a
       gate is most likely to miss: §4.3d degrades the dissolve to a FADE, it does
       not delete it. A build that dropped the transition entirely would satisfy
       the assertion above perfectly and show nothing at the cut. */
    const v = videoChain(g, incoming.index);
    if (!hasAlphaFade(v, 'in')) {
      fail(
        '8.1 title -> title: the degraded dissolve carries no alpha fade-in, so the transition ' +
          'has VANISHED rather than degraded. §4.3d removes the cross-fade, not the ramp — the ' +
          'incoming card must still come up from transparent, exactly as the preview shows it.\n' +
          `    chain: ${v}`,
      );
    }
    // The incoming card is not extended either: a dissolve consumes the
    // OUTGOING clip's handle, and there is now no dissolve at all.
    near('8.1 title -> title: the incoming title is not extended', incoming.seconds, 60 / FPS);

    /* THE NOTICE. Asserted as ARRIVING and NAMING THE CAUSE, never by its
       wording — §7.3. The sentence is graph.ts's to write, and a gate holding a
       copy of it is a gate that fails on a rephrasing and passes on a lie. What
       carries information is that the user is told, and told WHICH cause. */
    if (g.notices.length === 0) {
      fail(
        '8.1 title -> title: the export silently degraded the dissolve. §4.3d says this ' +
          'degradation is ANNOUNCED — it is the one respect in which it is better off than ' +
          "§4.3a's, which is silent. A capability removed without a word is indistinguishable " +
          'from a bug, to the one person this app answers to.',
      );
    } else {
      const said = g.notices.join(' ');
      if (!/title/i.test(said)) {
        fail(
          '8.1 title -> title: a notice arrived but does not name the cause. It must say that a ' +
            'dissolve OUT OF A TITLE CARD is what was degraded; a sentence about handles or ' +
            'source frames sends whoever reads it hunting through trim points for a problem that ' +
            `is not there — a title has no source to run out of.\n    said: ${said}`,
        );
      }
      if (!said.includes('card_in')) {
        fail(
          '8.1 title -> title: the notice does not name the clip it is about. With forty clips ' +
            `on the timeline, "a dissolve was degraded" is not actionable.\n    said: ${said}`,
        );
      }
    }
  }
}

/* -------------------------- 8.1b the two degradations are told APART -------

   §4.3d and the zero-handle path both end in a fade, and graph.ts routes the
   first through the second deliberately — one branch, falling through rather
   than duplicating. That is the right implementation and it is exactly why the
   two sentences must not have merged: "no source left to dissolve from" is FALSE
   of a title, which has no source at all.

   Asserted by comparing the two notices the builder produces, so neither
   sentence is written down here.

   THE CLIP NAME IS STRIPPED BEFORE COMPARING, and it has to be. The first
   version compared the sentences whole and a mutation walked straight through
   it: giving the title branch the zero-handle wording still produced two
   DIFFERENT strings, because each names its own clip. Comparing whole sentences
   was comparing the clip names, not the explanations. What is under test is the
   sentence SHAPE, so the variable part comes out first. */

const withoutName = (notice, name) => notice.split(name).join('<clip>');

{
  const titleCase = graphOf(
    'title degradation',
    doc43d([V1], [titleClip('card_out', V1.id, 0, 60), titleClip('card_in', V1.id, 60, 60, DISSOLVE)], []),
    PNGS,
  );
  // Source is exactly as long as the clip: zero handle, the other degradation.
  const handleCase = graphOf(
    'zero-handle degradation',
    doc43d(
      [V1],
      [mediaClip('a', V1.id, 0, 60, 'm_out'), mediaClip('b', V1.id, 60, 60, 'm_in', DISSOLVE)],
      [mediaSource('m_out', 60), mediaSource('m_in')],
    ),
  );

  if (titleCase && handleCase) {
    if (handleCase.notices.length === 0) {
      fail('8.1b: the zero-handle degradation raised no notice, so there is nothing to compare');
    } else if (titleCase.notices.length === 0) {
      fail('8.1b: the title degradation raised no notice, so there is nothing to compare');
    } else {
      const said = withoutName(titleCase.notices[0], 'card_in');
      const other = withoutName(handleCase.notices[0], 'b');
      if (said === other) {
        fail(
          '8.1b: a dissolve degraded for a TITLE and one degraded for a spent HANDLE are reported ' +
            'with the same sentence. They are different causes with different remedies — one is ' +
            'lifted by trimming the outgoing clip shorter, the other cannot be lifted at all — and ' +
            `one sentence for both is worse than none.\n    both said: ${said}`,
        );
      }
    }
  }
}

/* ------------------------------------ 8.2 footage -> footage: UNTOUCHED */

{
  const g = graphOf(
    'an ordinary footage dissolve',
    doc43d(
      [V1],
      [mediaClip('a', V1.id, 0, 60, 'm_out'), mediaClip('b', V1.id, 60, 60, 'm_in', DISSOLVE)],
      [mediaSource('m_out'), mediaSource('m_in')],
    ),
  );
  if (g) {
    near(
      '8.2 footage -> footage: still extended by exactly the transition',
      inputFor(g, '/media/m_out.mp4').seconds,
      (60 + N) / FPS,
    );
    if (g.notices.length !== 0) {
      fail(`8.2 footage -> footage: an ordinary dissolve raised a notice — ${g.notices.join(' | ')}`);
    }
  }
}

/* ---------------- 8.3 footage -> TITLE: dissolving INTO a title is untouched

   The mirror of 8.1, and the case that pins the rule to the OUTGOING clip. The
   incoming clip being a title says nothing about whether there is something
   underneath to reveal — there is, it is footage, and the preview's underlay
   draws it perfectly well. A rule written against "either clip is a title"
   would break this and nothing else would notice. */

{
  const g = graphOf(
    'a title dissolving in over footage',
    doc43d(
      [V1],
      [mediaClip('a', V1.id, 0, 60, 'm_out'), titleClip('card_in', V1.id, 60, 60, DISSOLVE)],
      [mediaSource('m_out')],
    ),
    PNGS,
  );
  if (g) {
    near(
      '8.3 footage -> title: the OUTGOING FOOTAGE is still extended',
      inputFor(g, '/media/m_out.mp4').seconds,
      (60 + N) / FPS,
    );
    if (g.notices.length !== 0) {
      fail(
        '8.3 footage -> title: dissolving INTO a title was degraded. §4.3d is about what is ' +
          'UNDERNEATH the transition, not what is on top — the outgoing clip here is ordinary ' +
          `footage and the preview's underlay draws it.\n    said: ${g.notices.join(' | ')}`,
      );
    }
  }
}

/* -------- 8.4 a footage dissolve on V1, with a title sitting on V2 above it

   THE ONE TO WEIGHT. Nothing about this arrangement involves a title in the
   transition at all — the dissolve is between two footage clips on V1, and a
   title merely happens to be on a track above. A `clipIsTitle` test placed
   anywhere near the clip list rather than on the outgoing clip of THIS dissolve
   breaks an entirely ordinary edit, and the symptom is a transition quietly
   becoming a fade because of something on a different track. */

{
  const g = graphOf(
    'a footage dissolve running under a title',
    doc43d(
      [V1, V2], // bottom-first, EXPORT §1.6
      [
        mediaClip('a', V1.id, 0, 60, 'm_out'),
        mediaClip('b', V1.id, 60, 60, 'm_in', DISSOLVE),
        titleClip('over', V2.id, 0, 120),
      ],
      [mediaSource('m_out'), mediaSource('m_in')],
    ),
    PNGS,
  );
  if (g) {
    near(
      '8.4 a title on the track above does not degrade the dissolve beneath it',
      inputFor(g, '/media/m_out.mp4').seconds,
      (60 + N) / FPS,
    );
    if (g.notices.length !== 0) {
      fail(
        '8.4 a footage dissolve was degraded because a title was on another track. The rule is ' +
          'about the OUTGOING CLIP OF THE DISSOLVE and nothing else; this edit contains an ' +
          'ordinary cross dissolve between two footage clips.\n' +
          `    said: ${g.notices.join(' | ')}`,
      );
    }
    // And the title is still in the export — the fixture has to contain the
    // thing it claims to, or 8.4 passes by not having built a title at all.
    if (inputFor(g, '/tmp/t_over.png').index < 0) {
      fail(
        '8.4: the title on V2 is not an input, so this row never tested what it claims to. ' +
          'The arrangement it exists to protect was not built.',
      );
    }
  }
}

/* ------------------------------------------------------------------ verdict */

if (failures.length > 0) {
  keepBundle = true;
  console.error(`\ntransitions: ${failures.length} failure${failures.length > 1 ? 's' : ''}.\n`);
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
  'transitions: ok — fade both edges, dissolve tail + picture ramp with NO audio ramp either side ' +
    '(§4.3a), handle clamp, zero-handle degrade, gap, burn-in through BuildPaths.subtitlesFile, ' +
    'and §4.3d: a dissolve out of a title degrades to a fade and says so, while footage->footage, ' +
    'footage->title and a dissolve running under a title are untouched',
);
