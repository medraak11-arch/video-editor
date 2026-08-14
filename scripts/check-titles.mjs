#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-titles.mjs — the gate on titles. CREATIVE.md §5, §7, §9.4 item 2.

   Run:  node scripts/check-titles.mjs

   Why this exists, and it is the sharpest "why" in the set: titles are the one
   feature in CREATIVE whose whole claim is an IDENTITY between two pictures —
   §5.2, "the exported title is, byte for byte, the pixels the user was looking
   at". An identity claim fails silently by construction. Both sides render
   something plausible, both typecheck, and the disagreement is only visible to
   somebody holding the file and the preview up against each other.

   Three separate ways to break it, and this gate holds all three:

     1. TWO RASTERISERS. The instant a second `drawTitle` exists — a preview that
        measures its own line height, an export that pads its own plate — §5.2's
        thesis is dead and nothing fails. One function used twice is the entire
        design.

     2. A TITLE READ AS MEDIA. A title clip carries `mediaId: ''` (§5.1). Every
        media lookup must SKIP it rather than resolve an empty id, and
        `offlineClipIds` is the one CREATIVE §9.4 names first: miss it and the
        lane paints the user's own titles as missing footage, in red, on a
        project with nothing wrong with it.

     3. THE CLOCK-CLIP DEFECT — the build's highest-severity bug, and the reason
        this file exists at all. The preview drew a title only when that title
        was the CLOCK CLIP: the single clip `selectVideoClipIdAtFrame` returns
        for the <video> element. The clock clip is a fact about which element
        carries the playback clock and the sound. It was never a fact about what
        is on screen. Gated on it, a title with anything at all above it drew
        NOTHING, and two titles at once could never both draw — while the export
        composited both correctly. The user sees a title vanish from the preview
        and goes looking for the bug in their own edit.

   HOW §3 IS ASSERTED, because the choice matters more than the assertion.

   The cheap version is a grep: prove `selectVideoClipIdAtFrame` is not mentioned
   near the title layer. That gate is worthless in both directions. It passes the
   day somebody re-derives the same gate under a different name — `topClipId`,
   `s.clips[clockId]`, an equality against the <video> element's clip — and it
   fails the day the module legitimately calls that selector for something else,
   which this one does: it reads the clock clip's RANK, deliberately, to decide
   which titles composite below the one media clip the preview can draw. A gate
   that forbids a string cannot tell those two apart, because the string is not
   the defect. The defect is a BEHAVIOUR: a title in range on a visible video
   track that the preview does not draw.

   So the gate drives the real selector over documents built through the real
   store actions and asserts what comes back. Every one of the three arrangements
   the old code could not do — a title UNDER footage, TWO titles at once, and a
   title that stays put when the track above it is hidden — is a case here, and
   each fails loudly with the id it expected and did not get. It holds whichever
   way the stack runs and it survives any renaming inside the module.

   FIXTURES ARE BUILT THROUGH STORE ACTIONS — CREATIVE §11.2, and it is not
   advisory. `addTrack`, `addClip` and `addTitleClip` are what the user's
   gestures call, and a document hand-assembled instead is a restatement of the
   app's own state: §11.2 records a D1 measurement taken against exactly that,
   with `trackOrder` inverted relative to its labels, which made the measurement
   worse than none because it was believed.

   Bundled FROM SOURCE with esbuild for the reason check-export-graph.mjs states
   at length: reading build output lets a STALE build make the gate pass.
--------------------------------------------------------------------------- */

import { build } from 'esbuild';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 've-titles-'));
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

/* ---------------------------------------------------------------- the modules

   `TitleClipLayer.tsx` is a .tsx that imports React, so it bundles heavier than
   the other gates' entry points. It is still the right entry point: the selector
   under test is exported from it, and asserting a COPY of that selector would be
   the restatement CREATIVE §2.4 rules out. Nothing here renders a component. */

const timeline = await bundle('../src/state/timelineSlice.ts', 'timelineSlice');
const titleLayer = await bundle('../src/components/preview/TitleClipLayer.tsx', 'titleClipLayer');
const exportDoc = await bundle('../src/components/export/exportDocument.ts', 'exportDocument');
const graph = await bundle('../electron/export/graph.ts', 'graph');

for (const [name, fn] of [
  ['timelineSlice.createTimelineSlice', timeline.createTimelineSlice],
  ['TitleClipLayer.selectTitleClipIds', titleLayer.selectTitleClipIds],
  ['TitleClipLayer.splitTitleClipIds', titleLayer.splitTitleClipIds],
  ['exportDocument.buildExportDocument', exportDoc.buildExportDocument],
  ['graph.buildExportGraph', graph.buildExportGraph],
]) {
  if (typeof fn !== 'function') {
    console.error(`titles: ${name} is not exported`);
    process.exit(2);
  }
}

const { selectTitleClipIds, splitTitleClipIds } = titleLayer;
const { buildExportDocument } = exportDoc;
const { buildExportGraph } = graph;

/* --------------------------------------------------------------- fake store

   The same minimal harness check-linking.mjs drives the slice with. It is not a
   mock of the store: it IS the slice creator, given somewhere to put its state,
   so every action below is the one the user's gesture calls. */

const MEDIA = 'm_footage';

function fresh() {
  const state = {};
  const get = () => state;
  const set = (partial) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial);

  Object.assign(
    state,
    {
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

  /* EVERY MEDIA LOOKUP, RECORDED. §7's wording is "a title clip never reaches a
     media lookup", and that is a stronger claim than "no title ends up marked
     offline" — a lookup on `''` that happens to MISS produces the right answer
     today by luck, and stays right only until an item exists under that key
     (`removeItem('')` is one call away, and `items['']` is what a hand-edited
     project would hand it). A mutation proved the difference: dropping
     `clipUsesMedia` from `referencedSources` left every downstream assertion
     green, because the lookup missed. So the gate observes the LOOKUP, not its
     consequence, and `''` reaching this proxy is the failure. */
  const lookups = [];
  const rawItems = {};
  state.items = new Proxy(rawItems, {
    get(target, key) {
      if (typeof key === 'string') lookups.push(key);
      return target[key];
    },
  });
  state.mediaLookups = lookups;

  rawItems[MEDIA] = {
    id: MEDIA,
    kind: 'video',
    name: 'footage.mp4',
    path: '/media/footage.mp4',
    url: 've-media://footage.mp4',
    status: 'ready',
    durationFrames: 6000,
    durationSeconds: 200,
    hasAudio: true,
    width: 1920,
    height: 1080,
  };
  return state;
}

const addMedia = (s, trackId, start, duration) => {
  const r = s.addClip({ mediaId: MEDIA, trackId, start, duration });
  if (!r.ok) throw new Error(`addClip refused: ${JSON.stringify(r)}`);
  return r.id;
};

const addTitle = (s, trackId, start) => {
  const id = s.addTitleClip(trackId, start);
  if (id === null) throw new Error('addTitleClip refused');
  return id;
};

/** Every title id the preview would draw at `frame`, both sides of the stack. */
const drawnTitles = (s, frame) => [
  ...splitTitleClipIds(selectTitleClipIds(s, frame, 'below')),
  ...splitTitleClipIds(selectTitleClipIds(s, frame, 'above')),
];

/* ============================================================================
   1. ONE RASTERISER, USED TWICE — CREATIVE §5.2.

   Two halves, and neither is sufficient. The structural half is what makes a
   SECOND rasteriser impossible: glyph drawing exists in exactly one module, so
   there is no second place for a line height or a plate padding to disagree. The
   behavioural half is what makes the first one LIVE: an import that is never
   called compiles perfectly and rasterises nothing, and `rasteriseTitles`
   swallows its own exceptions by design (a title that cannot be drawn costs one
   title, not the export), so a broken export raster is silent at every layer.
============================================================================ */

const RASTERISER = '../src/lib/titleRaster.ts';
const PREVIEW_TITLE_LAYER = '../src/components/preview/TitleLayer.tsx';
const EXPORT_DOCUMENT = '../src/components/export/exportDocument.ts';

{
  const raster = read(RASTERISER);
  check('1. src/lib/titleRaster.ts exists', raster !== null);
  check(
    '1. and it is the module that defines drawTitle',
    raster !== null && /export function drawTitle\s*\(/.test(raster),
  );

  for (const [label, path] of [
    ['the preview title layer', PREVIEW_TITLE_LAYER],
    ['the export document assembly', EXPORT_DOCUMENT],
  ]) {
    const src = read(path);
    check(`1. ${label} (${path}) exists`, src !== null);
    if (src === null) continue;
    check(
      `1. ${label} imports drawTitle from src/lib/titleRaster`,
      /import\s*\{[^}]*\bdrawTitle\b[^}]*\}\s*from\s*['"][^'"]*lib\/titleRaster['"]/.test(src),
      'CREATIVE §5.2: one rasteriser, used twice. A second implementation is two answers to ' +
        'the same question, and the preview and the file then disagree at exactly the sizes ' +
        'titles are drawn at.',
    );
    check(`1. ${label} calls it`, /\bdrawTitle\s*\(/.test(src));
  }

  /* No glyph drawing anywhere else. `fillText` and `measureText` are the two
     calls a second rasteriser cannot avoid making — text cannot be laid out
     without measuring it or drawn without filling it — so their absence outside
     titleRaster.ts is the property "there is only one rasteriser", stated in the
     one form that cannot be satisfied by a rename. */
  const glyphCalls = [];
  const sourceFiles = listSources();
  for (const file of sourceFiles) {
    if (file.endsWith('titleRaster.ts')) continue;
    const src = readFileSync(file, 'utf8');
    if (/\.(fillText|strokeText)\s*\(/.test(src) || /\.measureText\s*\(/.test(src)) {
      glyphCalls.push(file);
    }
  }
  check(
    '1. no module outside src/lib/titleRaster.ts draws or measures glyphs',
    glyphCalls.length === 0,
    `a second rasteriser lives in: ${glyphCalls.join(', ')}`,
  );
}

/** Every .ts/.tsx under src/ and electron/, so the search cannot miss a new file. */
function listSources() {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
  };
  for (const rel of ['../src', '../electron']) {
    try {
      walk(fileURLToPath(new URL(rel, import.meta.url)));
    } catch {
      /* a tree that is not there cannot hide a second rasteriser */
    }
  }
  return out;
}

/* ------------------------- 1b. the export's raster is LIVE, not merely imported

   `rasteriseTitles` returns an empty array when `OffscreenCanvas` is undefined,
   which it is in node — so the gate SUPPLIES one. It is a recorder, not a
   renderer: the real `drawTitle` runs against it and every call it makes is
   captured, which is what turns "the import exists" into "the pixels were
   drawn". The measured facts are the ones §5.2 promises: one entry per title
   clip, at PROJECT resolution, carrying the title's own text. */

{
  const drawn = [];

  class FakeCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.calls = [];
    }
    getContext() {
      const calls = this.calls;
      return {
        canvas: this,
        font: '',
        fillStyle: '',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        measureText(text) {
          calls.push(['measureText', text]);
          // A plausible Chromium answer: enough for the layout maths to run, and
          // an ascent above zero so the cap-height probe is not the fallback.
          return { width: String(text).length * 40, actualBoundingBoxAscent: 144 };
        },
        fillText(text, x, y) {
          calls.push(['fillText', text, x, y]);
        },
        fillRect(...a) {
          calls.push(['fillRect', ...a]);
        },
        setTransform() {},
        clearRect() {},
        scale() {},
      };
    }
    async convertToBlob() {
      drawn.push(this);
      return { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
    }
  }
  globalThis.OffscreenCanvas = FakeCanvas;

  const s = fresh();
  const v1 = s.addTrack('video');
  const t1 = addTitle(s, v1, 0);
  const t2 = addTitle(s, v1, 300);
  s.setClipTitle(t1, { text: 'FIRST CARD' });
  s.setClipTitle(t2, { text: 'SECOND CARD' });

  const doc = await buildExportDocument(s);
  const titles = doc.titles ?? [];
  check('1b. one ExportTitle per title clip', titles.length === 2, `got ${titles.length}`);
  check(
    '1b. each is rastered at PROJECT resolution',
    titles.every((t) => t.width === 1920 && t.height === 1080),
    JSON.stringify(titles.map((t) => [t.width, t.height])),
  );
  check(
    '1b. each carries PNG bytes',
    titles.every((t) => typeof t.png === 'string' && t.png.length > 0),
  );
  check(
    '1b. and the ids are the title clips',
    titles.map((t) => t.clipId).sort().join(',') === [t1, t2].sort().join(','),
    JSON.stringify(titles.map((t) => t.clipId)),
  );

  const texts = drawn.flatMap((c) => c.calls.filter((call) => call[0] === 'fillText').map((call) => call[1]));
  check(
    '1b. the export actually DREW the text through the shared rasteriser',
    texts.includes('FIRST CARD') && texts.includes('SECOND CARD'),
    'the canvas received no fillText for the title text — the export imports drawTitle and ' +
      'never reaches it, and `rasteriseTitles` swallows the failure by design (a title that ' +
      'cannot be drawn costs one title, not the export), so nothing else would say so. ' +
      `saw: ${JSON.stringify(texts)}`,
  );

  delete globalThis.OffscreenCanvas;
}

/* ============================================================================
   2. A TITLE CLIP NEVER REACHES A MEDIA LOOKUP — §5.1, §9.4 item 2.

   All behavioural: the projections are run and the resulting sets are read. The
   control case in 2a is what makes the rest mean anything — a projection that
   marked NOTHING offline would pass every "the title is not offline" assertion
   for the wrong reason.
============================================================================ */

{
  const s = fresh();
  const v1 = s.addTrack('video');
  const footage = addMedia(s, v1, 0, 60);
  const title = addTitle(s, v1, 200);

  const stray = s.addClip({ mediaId: 'm_gone', trackId: v1, start: 400, duration: 60 });
  const strayId = stray.ok ? stray.id : null;
  check('2. the control clip was created', strayId !== null, JSON.stringify(stray));

  const emptyLookups = (label) => {
    const hits = s.mediaLookups.filter((k) => k === '');
    check(
      label,
      hits.length === 0,
      "the empty MediaId a title carries was used as a key into `items`. It misses TODAY, so " +
        'nothing downstream is wrong yet — which is exactly why this is asserted at the lookup ' +
        'and not at its consequence. `clipUsesMedia` is the predicate that exists for it ' +
        '(CREATIVE §9.4 item 2).',
    );
    s.mediaLookups.length = 0;
  };

  s.mediaLookups.length = 0;
  s.recomputeOfflineClips();
  emptyLookups('2. recomputeOfflineClips resolves no empty MediaId');
  check(
    '2a. the projection is live — a clip whose media is missing IS offline',
    strayId !== null && s.offlineClipIds.has(strayId),
    JSON.stringify([...s.offlineClipIds]),
  );
  check(
    '2a. a title clip is NOT offline',
    !s.offlineClipIds.has(title),
    'CREATIVE §9.4 item 2: a title carries `mediaId: \'\'` and resolves NOTHING. Resolved as ' +
      'media it misses, joins the offline set, and the lane paints the user\'s own titles as ' +
      'missing footage — in red, on a project with nothing wrong with it.',
  );
  check('2a. and the ordinary media clip is not offline', !s.offlineClipIds.has(footage));

  // `markClipsOffline` is the incremental arm of the same projection, and '' is
  // the mediaId a title carries — so this is the exact call that turns every
  // title in the project red if the gate is missing.
  s.markClipsOffline('');
  emptyLookups("2. markClipsOffline('') resolves no empty MediaId");
  check(
    '2b. markClipsOffline(\'\') does not take the titles down with it',
    !s.offlineClipIds.has(title),
    JSON.stringify([...s.offlineClipIds]),
  );

  const durationBefore = s.clips[title].duration;
  s.clampClipsToSource();
  emptyLookups('2. clampClipsToSource resolves no empty MediaId');
  check(
    '2c. clampClipsToSource leaves a title alone',
    s.clips[title].duration === durationBefore && !s.offlineClipIds.has(title),
    `duration ${durationBefore} -> ${s.clips[title].duration}, offline ${s.offlineClipIds.has(title)}`,
  );
}

/* ------------------- 2d/2e. and the export document and graph agree with that */

{
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return {
        canvas: this,
        font: '',
        fillStyle: '',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        measureText: (t) => ({ width: String(t).length * 40, actualBoundingBoxAscent: 144 }),
        fillText() {},
        fillRect() {},
        setTransform() {},
        clearRect() {},
        scale() {},
      };
    }
    async convertToBlob() {
      return { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
    }
  };

  const s = fresh();
  const v1 = s.addTrack('video');
  const footage = addMedia(s, v1, 0, 60);
  const title = addTitle(s, v1, 60);
  void footage;

  s.mediaLookups.length = 0;
  const doc = await buildExportDocument(s);
  check(
    '2d. the export document assembly never resolves the empty MediaId',
    s.mediaLookups.every((k) => k !== ''),
    "`referencedSources` used a title's `mediaId: ''` as a key into `items`. CREATIVE §9.4 " +
      'item 2 names `clipUsesMedia` as the predicate for exactly this.',
  );
  check(
    '2d. the export document resolves NO source for a title',
    doc.sources.every((src) => src.mediaId !== ''),
    JSON.stringify(doc.sources.map((src) => src.mediaId)),
  );
  check('2d. exactly one source, the real footage', doc.sources.length === 1, `${doc.sources.length}`);
  check('2d. the title clip is still in the document', doc.clips.some((c) => c.id === title));

  const result = buildExportGraph(
    {
      filename: 'out',
      folder: '/out',
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      quality: 'good',
      range: 'entire',
      burnSubtitles: false,
      startFrame: 0,
      durationFrames: 210,
      document: doc,
    },
    { scriptPath: '/tmp/s.txt', outputPath: '/tmp/o.mp4', titlePngs: { [title]: 'title_0.png' } },
  );

  check(
    '2e. the graph builds — a title is not `source-missing`',
    result.ok === true,
    result.ok ? '' : `${result.error.code}: ${result.error.message}`,
  );
  if (result.ok) {
    check(
      '2e. and the title PNG is an ffmpeg input',
      result.graph.args.includes('title_0.png'),
      'the rasterised title never reached argv, so the exported file has no title in it and ' +
        'the encode succeeds anyway',
    );
    check(
      '2e. fed as a looping still at the output rate',
      /-loop/.test(result.graph.args.join(' ')),
      result.graph.args.join(' '),
    );
  }

  delete globalThis.OffscreenCanvas;
}

/* ============================================================================
   3. TITLE RENDERING IS NOT CONDITIONED ON THE CLOCK CLIP.

   The three arrangements the old code could not produce, plus the two negative
   cases that stop the fix from becoming "draw every title always" — which would
   be the same lie mirrored: a title visible in the preview and absent from the
   file.

   `addTrack('video')` UNSHIFTS (timelineSlice), so the second video track added
   is EARLIER in `trackOrder` and therefore higher in the stack. The fixture
   never states that; it reads it back from `trackOrder` and from
   `selectVideoClipIdAtFrame`, so it is true whichever way the stack runs.
============================================================================ */

{
  /* 3a. A TITLE UNDER FOOTAGE. The case CREATIVE §11.2 owes a re-measurement on,
     and the one that is impossible to reach when drawing is gated on the clock
     clip: the clock clip is the footage, so the title below it drew nothing. */
  const s = fresh();
  const lower = s.addTrack('video');
  const upper = s.addTrack('video'); // unshifted — above `lower`
  const footage = addMedia(s, upper, 0, 120);
  const title = addTitle(s, lower, 0);

  check(
    '3a. fixture: the footage really is the clock clip',
    timelineSelectClock(s, 50) === footage,
    `clock is ${timelineSelectClock(s, 50)}, expected the footage on the upper track`,
  );

  const drawn = drawnTitles(s, 50);
  check(
    '3a. a title BENEATH footage is drawn',
    drawn.includes(title),
    'Nothing was drawn for a title that is in range on a visible video track, because the ' +
      'clip carrying the playback clock is the footage above it. That is the D1 defect: the ' +
      'clock clip is a fact about which element carries the clock and the sound, never a fact ' +
      'about what is on screen. The export composites this title correctly, so the preview and ' +
      "the file disagree in the direction where the user believes the title is missing.\n    " +
      `drawn: ${JSON.stringify(drawn)}, expected to contain ${title}`,
  );
  check(
    '3a. and it is drawn BELOW the clock clip, where the footage covers it',
    splitTitleClipIds(selectTitleClipIds(s, 50, 'below')).includes(title),
    'drawing it above would be the same lie mirrored — a title the user can see in the ' +
      'preview and cannot find in the file',
  );

  /* 3b. HIDING THE TRACK ABOVE MUST NOT MAKE THE TITLE APPEAR. The tell that
     separates a real fix from a coincidence: under the old code the title
     appeared only once the footage above it stopped being the clock clip. */
  s.toggleVisible(upper);
  check(
    '3b. hiding the track above leaves the title present rather than making it appear',
    drawnTitles(s, 50).includes(title),
  );
  s.toggleVisible(upper);
  check('3b. and showing it again leaves the title present', drawnTitles(s, 50).includes(title));
}

{
  /* 3c. TWO TITLES AT ONCE. There is exactly one clock clip, so a clock-gated
     preview can draw at most one title however the stack is arranged. */
  const s = fresh();
  const lower = s.addTrack('video');
  const upper = s.addTrack('video');
  const low = addTitle(s, lower, 0);
  const high = addTitle(s, upper, 0);

  const drawn = drawnTitles(s, 10);
  check(
    '3c. two titles in range are BOTH drawn',
    drawn.includes(low) && drawn.includes(high),
    `drawn: ${JSON.stringify(drawn)}, expected both ${low} and ${high}`,
  );
  check('3c. and neither is drawn twice', new Set(drawn).size === drawn.length, JSON.stringify(drawn));
}

{
  /* 3d. A LONE TITLE — which IS the clock clip — is drawn EXACTLY once. The
     stack is split at the clock clip's own rank, so a title on the boundary is
     the case an off-by-one in that comparison drops or doubles. */
  const s = fresh();
  const v1 = s.addTrack('video');
  const only = addTitle(s, v1, 0);

  const drawn = drawnTitles(s, 10);
  check('3d. a lone title is drawn', drawn.includes(only), JSON.stringify(drawn));
  check('3d. exactly once', drawn.length === 1, JSON.stringify(drawn));
}

{
  /* 3e. THE NEGATIVE CASES. Out of range, and on a hidden track — the same two
     gates the export document applies, so a preview that drew either would put a
     title on screen that is not in the file. */
  const s = fresh();
  const v1 = s.addTrack('video');
  const title = addTitle(s, v1, 100);

  check('3e. a title before its start is not drawn', !drawnTitles(s, 50).includes(title));
  const end = s.clips[title].start + s.clips[title].duration;
  check('3e. a title at its exclusive end is not drawn', !drawnTitles(s, end).includes(title));
  check('3e. a title inside its range is drawn', drawnTitles(s, 110).includes(title));

  s.toggleVisible(v1);
  check(
    '3e. a title on a HIDDEN track is not drawn',
    !drawnTitles(s, 110).includes(title),
    'the export drops a hidden track\'s clips, so drawing one here is a title in the preview ' +
      'that is not in the file',
  );
}

/** The clock clip, read through the same selector the preview uses. */
function timelineSelectClock(s, frame) {
  return timeline.selectVideoClipIdAtFrame(s, frame);
}

/* ------------------------------------------------------------------ verdict */

if (failures.length > 0) {
  keepBundle = true;
  console.error(`\ntitles: ${failures.length} failure${failures.length > 1 ? 's' : ''}.\n`);
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
  'titles: ok — one rasteriser drawn live into the export document, no media lookup resolves a ' +
    'title (offline, markClipsOffline(\'\'), clamp, sources, graph), and the preview draws a ' +
    'title under footage, two titles at once and a lone title exactly once — never gated on the ' +
    'clock clip',
);
