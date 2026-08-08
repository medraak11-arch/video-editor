# Export — the ffmpeg contract

**Status:** normative. This document specifies how the timeline document becomes one video file.
It is the integration contract between two implementers: **MAIN** (`electron/**`) and **RENDERER**
(`src/components/export/**`). Where this document and a slice brief disagree on a *name, type,
channel or argument*, this document wins — report the conflict rather than diverging.

Read order: `PRODUCT.md` → `DESIGN.md` → `docs/PLAN.md` → this file.

Every ffmpeg construct below was executed against ffmpeg 8.1.1 and the real media in `dev-media/`
before being written down. The three worked examples in §1.8 are transcripts of runs that produced
correct files at 30 fps, at a 24 fps export rate, and at 29.97 — not sketches. Where a claim rests
on a frame index rather than on a frame count, it was verified by rendering a marker rig with the
identical timing numbers and reading back the per-frame luma, because a frame *count* cannot detect
a one-frame placement error.

**The fixtures can now be measured.** This paragraph used to record a limit: `make-dev-media.mjs`
built every fixture's audio from `anullsrc`, so all nine files carried a real AAC stream whose
content was digital silence, and the audio claims below could only be *structural* — which branches
exist, which input index they read, where `adelay` puts them, what `amix` does to the sum — verified
on a separate `sine` rig rather than on the fixtures themselves. That limit is gone. Every fixture
now carries an audible signature (`scripts/make-dev-media.mjs` documents each one), and the levels
below can be read straight back off a real export. A three-source `amix` of `interview_wide_a`
(300 Hz), `drone_pass_02` (1100 Hz) and `music_bed_low` puts each tone at −24.6 dB in its own band —
exactly the −15.05 dB source level less the 20·log₁₀(3) that `amix` averages away — and dropping one
input collapses its band to −91 dB while the survivors rise by precisely 3.52 dB. Under the old
fixtures every one of those numbers was −91, which is why a dropped or mis-weighted input could not
be caught here.

One thing the old paragraph got right is still worth keeping, because it bit an earlier draft of
this document: **content silence is not `hasAudio === false`.** Every fixture has an audio stream,
and a file that sounds like nothing still has one.

**What replaces what.** `src/components/export/exportStub.ts` stops being reached the moment
`getEditorAPI().export` is defined. The stub is not deleted — it remains the `dev:web` bridge, since
`npm run dev:web` has no main process. Nothing in the UI changes when the real bridge lands. That is
the acceptance test for this work: the dialog is finished and must be edited in exactly two places
(§6).

---

## 1. The filter graph

### 1.1 One invocation, one pass

A whole export is **one `ffmpeg` process**. There is no per-track intermediate, no temp render, no
two-pass. The timeline is expressed entirely as a filter graph and handed over once.

The graph is written to a temp file and passed as `-filter_complex_script <path>`, never as
`-filter_complex "<string>"`. At 40 clips the graph is ~11 KB; Windows caps a command line at 32767
characters and the input arguments already consume several KB of that. `-filter_complex_script` is
verified working with newline-separated filter chains and removes the ceiling entirely.

**The script file is written UTF-8 with no BOM, LF-separated, via
`fs.writeFile(scriptPath, filterScript, 'utf8')`.** This is not a style note. A script whose first
three bytes are `EF BB BF` fails with `No such filter: '<U+FEFF>color'` / `Error : Filter not found`,
exit 8 — verified; ffmpeg reads the BOM as part of the first filter's name.
CRLF line endings are harmless (exit 0), so the BOM is the only encoding hazard, and it is exactly
the one this machine produces if anyone reaches for PowerShell `Out-File` or `>` instead of
`fs.writeFile`.

**Spawning.** `spawn(bin, args, { windowsHide: true })`, exactly as `electron/ipc/media.ts:94`
already does. Never `shell: true`, never a concatenated command string: the project path on this
machine is `E:\Desktop\Video Editor`, with a space in it, and argv-array spawning is what makes that
safe — verified, including an output path containing a space and a leading-dot `.part` basename.
Without `windowsHide` a console window appears on win32 and *stays for the whole encode*; the media
probes never exposed this because they finish in milliseconds.

**Paths are joined with `path.join`, never string concatenation.** Both `partPath` and `finalPath`
(§3.1) are built that way. `folder` on this machine is a backslash path and the document must not
grow a hand-written separator anywhere.

### 1.2 The base-canvas decision, and why it is not concat

**Chosen:** a black base source of exactly the export duration, with every clip `overlay`-ed onto it
at its absolute time.

```
color=c=black:s=<W>x<H>:r=<OF>:d=<durationSeconds>,format=<basePixFmt>[vbase]
```

`<OF>` is the **output** frame rate and `<basePixFmt>` is a function of the codec (§1.10) — both are
spelled out in §1.3 and §1.10 respectively, and both were wrong in an earlier draft.

The rejected alternative is per-track `concat` with generated black filler segments in the gaps.
Four reasons, in order of weight:

1. **Error locality.** `concat` composes by *sequence*: every segment's length feeds the start time
   of every following segment. One clip whose decoded length is a frame short of its computed length
   silently shifts the entire remainder of that track, and the failure appears far from its cause.
   With a base canvas each clip carries its own absolute placement (`setpts=PTS+startSec/TB` plus
   `enable='gte(t,…)*lt(t,…)'`); a wrong number moves one clip and nothing else.
2. **Gaps need no representation.** With a base canvas a gap is the absence of an overlay. With
   `concat` a gap is a *thing you must construct* — a filler `color` source that has to match the
   neighbouring segments in resolution, SAR, pixel format and timebase or `concat` refuses. Every
   gap becomes a new opportunity to be wrong, and a timeline is mostly gaps on its upper tracks.
3. **One primitive for both axes.** Compositing V1→V2→V3 is `overlay` regardless. Choosing `concat`
   for the within-track axis means maintaining two placement mechanisms with two rounding
   conventions that must agree at every boundary. `overlay` for both means one convention.
4. **Exact output length, for free.** The base's `d=` fixes the duration. The output is
   `durationSeconds` long whether the timeline ends with a clip, a gap, or nothing at all — which is
   also what makes the progress denominator in §2 a fixed number rather than an estimate.

The cost is real and accepted: every clip is its own decoder, and a clip's frames are decoded even
while its `enable` window is closed for the frames that overlap other work. Input-level `-ss/-t`
(§1.4) bounds that to each clip's own trimmed span, so the decode cost is proportional to the
footage actually used. At 40 clips this is comfortable; if it ever stops being comfortable the fix
is `-filter_threads`, not a change of topology.

The audio side takes the identical shape, with silence as the base:

```
anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=<durationSeconds>,asetpts=N/SR/TB[abase]
```

**An audio stream is always emitted**, even for a timeline with no audible clip. A silent track is
normal in a delivered file; branching the mapping on "does anything make sound" is a second code
path that would be exercised rarely and therefore be wrong when it ran.

### 1.3 Two frame rates, and the grid the graph is built on

The request carries `startFrame` and `durationFrames` (the dialog resolves `range` — PLAN §8.9).
**The graph is built for the range only**, with time rebased so the output starts at zero. This is
what makes `out_time_us` in §2 directly usable and keeps in/out exports from needing `-copyts`.

There are **two frame rates in play and they are routinely different.** The export dialog offers a
frame-rate `Select` populated from `KNOWN_FPS` (`src/state/playbackSlice.ts:96` —
`[23.976, 24, 25, 29.97, 30, 50, 59.94, 60]`) on *every* export, so a 30 fps project exported at 24
is an ordinary request, not an edge case.

```ts
const F  = doc.fps;   // PROJECT rate. The unit every frame field in the DOCUMENT is expressed in.
const OF = out.fps;   // OUTPUT rate. The rate the base, every clip chain and the encoder RUN at.
```

**Amendment A2 — audio-only codecs (docs/AUDIO-FEATURES.md §0.2, §2.7).** For `aac`, `mp3` and `wav`
there is no video stream, so there is **no output frame grid**, and `req.fps` is a stale value
retained from whenever the user last chose a video format. `OF` therefore becomes `F`:

```ts
const OF = isAudioOnlyCodec(req.codec) ? F : req.fps;
```

This is a correctness fix, not a preference. Left as `req.fps` it quantises `adelay` onto a grid
that does not exist: project `F = 30`, retained `req.fps = 24`, a clip at project frame `S = 7`
gives `nStart = round((7/30) × 24) = 6` and `startMs = round((6/24) × 1000) = 250 ms`, where the
correct answer is `round((7/30) × 1000) = 233 ms` — **17 ms early, audibly.** With `OF = F`, `toOut`
is the identity, `nStart === S`, and there is no quantisation at all. `durationSeconds =
durationFrames / F` is unchanged, and remains both the `-t` value and the §2 progress denominator.

**`F` is the rate for *reading* the document. `OF` is the rate for *emitting* the graph.** For a
video codec nothing in the emitted graph runs at `F`; for an audio-only codec the two are the same
number by A2 above, which is not an exception to the rule so much as the degenerate case of it. The
base canvas, `fps=fps=`, every `enable` window, every
`setpts` shift, every `adelay`, and `-r` are all on the `OF` grid. Mixing the two is the specific
defect that produced a 2-frame / 83 ms picture-against-sound slip on a 30-project/24-export run
while `adelay` stayed exact — invisible in a frame count, audible as desync.

All frame fields in the document are in **project frames** at `document.fps`. `MediaItem.fps` is
never read (PLAN §2.4, the source-mapping invariant) and does not appear in the document.

For clip `c` with `speed = c.properties.speed`:

```ts
const rangeEnd = startFrame + durationFrames;

// Intersection with the range. Clips outside it are not emitted at all.
if (c.start + c.duration <= startFrame || c.start >= rangeEnd) continue;

const headFrames = Math.max(0, startFrame - c.start);  // trimmed off the clip's head
const S = Math.max(0, c.start - startFrame);           // PROJECT frame within the range
const E = Math.min(durationFrames, c.start + c.duration - startFrame);
const timelineFrames = E - S;                          // >= 1 by the intersection test

/* ---- source side: PROJECT rate, because a source offset is a TIME, not a grid position ---- */
const sourceInFrames  = c.mediaIn + Math.round(headFrames * speed);
const sourceLenFrames = Math.round(timelineFrames * speed);   // = clipSourceLength on a whole clip
const ssSec = sourceInFrames  / F;   // input -ss
const tSec  = sourceLenFrames / F;   // input -t

/* ---- placement: OUTPUT grid, always ---- */
const toOut  = (projectFrame: number): number => Math.round((projectFrame / F) * OF);
const nStart = toOut(S);             // output frame index of the clip's first frame
const nEnd   = toOut(E);             // output frame index one past its last

const startSec   = nStart / OF;                 // setpts=PTS+<startSec>/TB
const startMs    = Math.round(startSec * 1000); // adelay=delays=<startMs>
const enableFrom = (nStart - 0.5) / OF;         // see §1.6 — frame CENTRES, not edges
const enableTo   = (nEnd   - 0.5) / OF;
```

Three properties of `toOut` are load-bearing and worth stating rather than rediscovering:

- **Abutment survives.** Two clips that meet at project frame `X` both compute `toOut(X)`, so the
  first's `nEnd` is exactly the second's `nStart`. No gap, no double-draw, at any rate pair.
- **Picture and sound cannot diverge.** `startSec` and `startMs` are derived from the *same*
  `nStart`. The earlier defect was `adelay` computed independently from `S / F`.
- **A clip can round to zero output frames** when `OF < F` and the clip is shorter than one output
  frame. When `nEnd <= nStart` the clip **contributes no video chain and no overlay** — an empty
  `enable` window would draw nothing anyway, and emitting it invites an off-by-one. Its audio is
  unaffected: sound is placed by `adelay` and its length is `tSec`, which has no grid.

The duration is the one number that must **not** move with the export rate — the cut is as long as
it is:

```ts
const durationSeconds = durationFrames / F;                          // base d=, output -t, §2 denominator
const framesTotal     = Math.max(1, Math.round(durationSeconds * OF)); // the base's own frame count
```

`durationSeconds` is computed once and reused; it is never recomputed from an encoder report.
`framesTotal` is genuinely the number of frames the base produces, which is what makes it
comparable to ffmpeg's `frame=` counter.

**Formatting is fixed so the graph is byte-reproducible.** Seconds: `toFixed(6)`. Factors (speed,
opacity, volume): `toFixed(3)`. Milliseconds (`adelay`): the integer from `startMs`. The same
document and settings must always produce the same script — that is what makes a bug reportable.

Two notes on the formatting, both verified rather than assumed:

- `enableFrom` is **negative** for a clip at `nStart === 0` (e.g. `-0.016667` at 30 fps). This is
  correct and ffmpeg accepts it: `gte(t,-0.016667)` is true from `t=0`. Do not special-case it; a
  branch here is a place to be wrong.
- `toFixed(6)` on `durationSeconds` cannot cost a frame. The rounding error is under 5e-7 s and the
  margin to the last frame's timestamp is a full frame period (≥ 16 ms at 60 fps). Verified at
  29.97: `durationFrames = 60` → `d=2.002002` → exactly 60 frames.

### 1.4 Inputs: one `-i` per contributing clip, trimmed at the input

```
-ss <ssSec> -t <tSec> -i <absolute source path>
```

Input-level `-ss` is accurate in modern ffmpeg (it seeks to the preceding keyframe and decodes
forward), and it resets the segment's timestamps to zero, which is what the per-clip chains below
assume. `-t` as an *input* option bounds the decode; the clip cannot run past its out point even if
the graph asks for more frames.

The path is the **absolute filesystem path** from `ExportSource.path`. Never a `ve-media://` URL —
that scheme exists for Chromium (PLAN §1.4) and ffmpeg cannot open it.

**A clip is emitted when it contributes video *or* audio; skipped only when it contributes
neither.** The two predicates, in full:

```ts
const contributesVideo =
  track.kind === 'video' && track.visible && c.properties.opacity > 0 && nEnd > nStart;

const contributesAudio =
  source.hasAudio && !track.muted && c.properties.volume > 0;

if (!contributesVideo && !contributesAudio) continue;   // no input, no chain, no overlay
```

The union is not a nicety. A clip faded to `opacity 0` while its sound holds under other picture is
an ordinary edit; so is a clip on a hidden video track. Both must keep their audio, and the audio
branch is spelled `[<i>:a]` — with no `-i` there is no `i`.

**Input index assignment is two passes, and the order is normative** because the labels `[<i>:v]`
and `[<i>:a]` index into the input list and a disagreement maps clips onto the wrong source files:

1. **Pass one** — every clip with `contributesVideo`, walking `document.tracks` in order (§1.6:
   bottom-first video tracks, then audio tracks) and within each track ascending by `start`.
2. **Pass two** — every remaining clip with `contributesAudio` (i.e. the audio-only contributors),
   walking the same tracks in the same order, ascending by `start`.

**Every clip contributes at most one input.** A clip that contributes both video and audio takes its
index in pass one and its audio branch reads `[<i>:a]` from that same input.

Audio branch labels are keyed to the **input index**, not to a second counter: the branch for input
`i` is `[a<i>]`. When input 2 contributes no audio the labels run `[a0] [a1] [a3] …`, with 2 simply
absent. One counter, no bookkeeping, and the gap is self-explaining in a transcript.

### 1.5 The per-clip video chain

Emitted only for a clip with `contributesVideo`. For input index `i`:

```
[<i>:v]setpts=(PTS-STARTPTS)/<speed>,
       fps=fps=<OF>,
       scale=<tw>:<th>:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,
       setsar=1,
       format=<clipPixFmt>,
       colorchannelmixer=aa=<opacity>,
       setpts=PTS+<startSec>/TB[v<i>]
```

Read left to right, each filter earns its place:

| Filter | Why |
|---|---|
| `setpts=(PTS-STARTPTS)/<speed>` | Normalises the trimmed segment to zero **and** applies speed in one step. `speed=2` halves the presentation interval, so the clip plays twice as fast — matching `clipSourceLength` and the preview's `video.playbackRate`. |
| `fps=fps=<OF>` | Conforms a source of any rate to the **output** rate, on a zero-based timeline where the resampling is deterministic. Runs *before* the placement shift so the frame grid is not a function of where the clip sits. This is why the base must also run at `OF` (§1.3). |
| `scale=…:force_original_aspect_ratio=decrease` | Fits inside the target box preserving aspect. `force_divisible_by=2` keeps both dimensions even, which 4:2:0 and 4:2:2 both require. |
| `setsar=1` | A source with a non-square SAR would otherwise composite at the wrong shape. |
| `format=<clipPixFmt>` | Adds the alpha plane that opacity and the letterbox both need. `yuva420p` on the h264/h265 path, `yuva422p10le` on the ProRes path — see §1.10. Getting this wrong re-subsamples chroma before the encoder ever sees it. |
| `colorchannelmixer=aa=<opacity>` | Per-clip opacity, as a scale on the alpha channel. **Emitted unconditionally**, including at `aa=1.000`: it is a no-op at unity and removing the branch removes a way for the builder and this document to disagree. |
| `setpts=PTS+<startSec>/TB` | Places the clip at its absolute time in the rebased range, on the output grid. `overlay` matches inputs by timestamp, so without this the clip lands at zero regardless of `enable`. |

**Letterbox and pillarbox are transparent, not black.** There is no `pad` filter: the clip is scaled
to fit and then centred by `overlay` expression. On V1 the base shows through and the bars read
black, which is what §1.2 promises. On V2 and above the track beneath shows through, which is what a
smaller clip over a larger one must do.

`tw`/`th` are the target box, which is where `ClipProperties.scale` is honoured:

```ts
const tw = Math.max(2, Math.round(out.width  * c.properties.scale));
const th = Math.max(2, Math.round(out.height * c.properties.scale));
```

**A clip with `opacity === 0` contributes no video chain and no overlay** — it cannot affect a single
pixel. It still contributes its `-i` and its audio branch when `contributesAudio` (§1.4). Only a
clip that contributes *neither* video nor audio is skipped entirely, and that is the case where
skipping removes a decoder.

### 1.6 Compositing: track order is overlay order

`document.tracks` arrives **bottom-first**: video tracks from the bottom of the stack upward, then
audio tracks in their own order. §6 gives the literal transform from the store's `trackOrder`, which
is *not* a plain reverse. Video clips are overlaid in that order, and within a track ascending by
`start` — clips on a track cannot overlap (`timelineSlice` invariant), so within-track order is
cosmetic, but fixing it keeps the script reproducible.

Track-major ordering is what makes compositing correct: every clip on a higher track is applied
after every clip on a lower one, so a clip on V2 draws over a clip on V1 wherever their `enable`
windows intersect.

Each clip consumes the previous composite and produces the next:

```
[vbase][v0]overlay=x=(W-w)/2+<posX>:y=(H-h)/2+<posY>:eof_action=pass:shortest=0:repeatlast=0:format=<overlayFmt>:enable='gte(t,<enableFrom>)*lt(t,<enableTo>)'[vc0]
[vc0][v1]overlay=…[vc1]
[vc1][v2]overlay=…[vc2]
…
[vc<n-1>]format=<basePixFmt>[vout]
```

The option list is not decoration. Each one prevents a specific, observed failure:

- **`enable` is load-bearing, twice.** Without it, `overlay` draws the clip's first frame from `t=0`
  (before the clip exists) and holds its last frame to the end of the file (after the clip ends) —
  the classic smear. It is also what makes a gap black: nothing is enabled there, so the base shows
  through. `between(t,…)` is *not* used: it is inclusive at both ends and would double-draw the
  single frame where two abutting clips meet. `gte * lt` is half-open, exactly like `clipEnd`.
- **The window is compared at frame CENTRES, not frame edges.** `enableFrom = (nStart - 0.5) / OF`
  and `enableTo = (nEnd - 0.5) / OF`, per §1.3. Comparing at edges (`nStart / OF`) is off by one
  frame roughly half the time at non-integer rates, and *also* one frame short: `toFixed(6)` rounds
  a frame's own timestamp up for about half of all frame indices at 29.97, 23.976 and 59.94, so
  `gte` is false at the base frame it was meant to include. Measured at 29.97, base
  `color=…:r=29.97`, white overlay:

  | intended window | edge form | centre form |
  |---|---|---|
  | `[4,13)` — 9 frames | frames 5..12 — **8 frames, one late and one short** | frames 4..12 — **9, exact** |
  | `[4,14)` — 10 frames | frames 5..14 — **one late** | frames 4..13 — **exact** |
  | `[7,17)` — 10 frames | frames 8..17 — **one late** | frames 7..16 — **exact** |
  | `[1,11)` — 10 frames | frames 2..11 — **one late** | frames 1..10 — **exact** |
  | `[3,13)` — 10 frames | frames 3..12 — exact *by luck*, 3/29.97 happens to round down | frames 3..12 — **exact** |

  The half-frame margin is half a frame period wide, which is enormous against a 5e-7 s formatting
  error, so the form is exact at every rate rather than usually exact. `enable='gte(n,<nStart>)*lt(n,<nEnd>)'`
  on integer frame indices is equally exact now that the base runs at `OF`, and is worth knowing
  about — but the half-frame time form is the one specified here, because it is the same expression
  at every rate and does not depend on `n` being defined on the composite.
- **`x=(W-w)/2:y=(H-h)/2`** centres using overlay's own size variables, so the builder never has to
  reproduce ffmpeg's `force_divisible_by` rounding to know where the clip landed. `+posX`/`+posY`
  add `ClipProperties.positionX/positionY`, which are already in project-resolution pixels.
- **`eof_action=pass`** — when a clip's stream ends, pass the base through instead of ending the
  output. Without it the file stops at the first clip's out point.
- **`shortest=0`** — the output runs as long as the base, not as long as the shortest input.
- **`repeatlast=0`** — belt and braces with `enable`; the ended overlay contributes nothing.
- **`format=<overlayFmt>`** pins the blend space so the chain does not silently promote to 444 and
  cost time. It is `yuv420` on the h264/h265 path and `yuv422p10` on the ProRes path (§1.10) — this
  option is a *codec* decision, not a fixed constant, and treating it as fixed is how a ProRes 422
  HQ file ends up carrying 4:2:0 8-bit data behind correct-looking metadata.
- The final **`format=<basePixFmt>`** drops the alpha the base never had, and is what the encoder
  expects.

### 1.7 The per-clip audio chain and the mix

**Which clips make sound:** `contributesAudio` from §1.4 — any clip whose `ExportSource.hasAudio` is
true, on a track that is not muted, with `volume > 0`. *This includes clips on video tracks*, which
matches the preview (`VideoSurface` unmutes the active clip's `<video>`), and it includes clips that
draw nothing (`opacity 0`, or a hidden video track).

```
[<i>:a]asetpts=PTS-STARTPTS,
       <atempo chain>,
       volume=<volume>,
       aresample=48000:async=1:first_pts=0,
       aformat=sample_fmts=fltp:channel_layouts=stereo,
       adelay=delays=<startMs>:all=1[a<i>]
```

- `asetpts=PTS-STARTPTS` zeroes the trimmed segment, mirroring the video chain.
- **The atempo chain** applies speed. `atempo`'s real range on this build is **`[0.5, 100]`** —
  verified: `atempo=0.1` fails with
  `Value 0.100000 for parameter 'tempo' out of range [0.5 - 100]` / `Result too large`, while
  `atempo=8` and even `atempo=100` run clean. The model permits `speed` in `0.1..8`
  (`ClipProperties.speed`, `src/types/model.ts`), so **only the lower end needs decomposing**:

  ```ts
  function atempoChain(speed: number): string[] {
    const out: string[] = [];
    let f = speed;
    while (f < 0.5) { out.push('atempo=0.500'); f /= 0.5; }
    if (Math.abs(f - 1) > 1e-6 || out.length === 0) out.push(`atempo=${f.toFixed(3)}`);
    return out;
  }
  // speed 0.1 -> ['atempo=0.500','atempo=0.500','atempo=0.500','atempo=0.800']   (verified)
  // speed 8   -> ['atempo=8.000']   — ONE stretch, in range
  ```

  There is deliberately **no upper decomposition loop.** Chaining `atempo=2.000` three times for
  `speed 8` is three lossy resamples where one is legal, and it degrades the audio for nothing.
  The `out.length === 0` guard is load-bearing and must stay: without it a `speed 1` clip emits an
  empty slot and the chain gets a double comma.
- `volume=<volume>` is `ClipProperties.volume` (`0..2`).
- `aresample=48000:async=1:first_pts=0` conforms every source to one rate. `async=1` corrects drift
  on sources whose timestamps are not exactly regular; `first_pts=0` prevents a leading gap.
- `aformat=…:channel_layouts=stereo` — `amix` requires a common layout; a mono VO and a stereo bed
  cannot be mixed without this.
- `adelay=delays=<startMs>:all=1` places the clip at its absolute time, from the same `nStart` the
  picture uses (§1.3). `all=1` applies the delay to every channel, which is why the delay is written
  once rather than repeated per channel. Verified sample-exact: `adelay=delays=5000` on a 1 kHz tone
  through this exact chain puts the first non-zero sample at 240001 of 48000 Hz — sample 240000 is
  the sine's own zero crossing at exactly 5.000000 s.

The mix is a single `amix` over the silent base plus every audio branch:

```
[abase][a0][a1]…amix=inputs=<1+n>:duration=first:dropout_transition=0:normalize=0[aout]
```

The branch labels listed here are exactly the `[a<i>]` labels that were emitted, in ascending input
index, with the gaps that §1.4 produces. `inputs` is `1 + (number of branches)`, not `1 + (number of
inputs)`.

- **`duration=first`** with the silence base first: the mix is exactly the export duration,
  regardless of what the clips do. This is the audio counterpart of the black base, and it is why
  gaps are silent without an `apad` anywhere in the graph.
- **`normalize=0`** is mandatory. `amix` defaults to dividing every input by the number of inputs; a
  timeline with eight audio clips would export at one-eighth volume, quietly, and the bug would be
  blamed on the source material. Verified on the tone rig: two overlapping branches at
  `volume=1.000` and `volume=0.500` sum to exactly 1.50× the single-branch peak.
- **`dropout_transition=0`** removes `amix`'s default 2-second volume ramp when an input ends. That
  ramp is an unrequested fade on every clip out point.

`amerge`+`pan` is rejected: it produces one output channel *per input channel* (n inputs × 2 = 2n
channels) and then needs a hand-written `pan` matrix whose length depends on the clip count. `amix`
does the job in one filter with a fixed option list.

### 1.8 Worked examples (transcripts of verified runs)

Three, because the two defects that survived the first draft were both invisible at 30-into-30 with
30 fps sources. **A** exercises compositing, gaps, speed, scale, opacity-0-with-audio, and a 24 fps
source in a 30 fps project. **B** exercises a project rate that differs from the export rate. **C**
exercises a non-integer project rate.

§6 makes all three the first acceptance step for MAIN — build them in `graph.ts` and diff them
against this document before wiring anything. Start with A, but do not stop there: A alone cannot
see either of the two defects that B and C exist to catch.

---

#### A — 30 fps project, 30 fps export

**Project:** 1920×1080, 30 fps. **Export:** entire timeline, 1920×1080, 30 fps, h264, good.
So `F = 30`, `OF = 30`.

**Timeline** — 3 video tracks, 1 audio track, a gap on V1:

| Track | Clip | media | start | duration | mediaIn | speed | scale | opacity | volume | source `hasAudio` |
|---|---|---|---|---|---|---|---|---|---|---|
| V1 (bottom) | A | `interview_wide_a.mp4` | 0 | 90 | 0 | 1 | 1 | 1 | 1 | **true** |
| V1 | B | `broll_market_street.mp4` | **150** | 60 | 300 | 1 | 1 | 1 | 1 | **true** |
| V2 | C | `macro_coffee_pour.mp4` | 60 | 120 | 0 | **2** | **0.5** | **0.5** | **0** | **true** |
| V2 | D | `drone_pass_02.mp4` (**24 fps source**) | 180 | 30 | 0 | 1 | 1 | 1 | 0.5 | **true** |
| V3 (top) | G | `interview_close_b.mp4` | 0 | 90 | 0 | 1 | 1 | **0** | 1 | **true** |
| A1 | H | `vo_take_04.m4a` | 30 | 120 | 0 | 1 | — | — | 0.8 | **true** |

Read the predicates straight off that table:

- **C contributes no audio because `volume === 0`** — *not* because its source is silent.
  `ffprobe macro_coffee_pour.mp4` shows stream 1 = `aac`. Every fixture has an audio stream (see the
  note at the top of this document); `hasAudio` is a property of the file, `volume` is a property of
  the edit, and only the second one excludes C.
- **G contributes no video because `opacity === 0`, but it still contributes an input and an audio
  branch.** It is the case §1.4's union predicate exists for.
- **D is a 24 fps source in a 30 fps project**, conformed by `fps=fps=30`. Its `mediaIn` and
  `duration` are project frames like everything else; `MediaItem.fps` is never read.

Frames 90–149 on V1 are a **gap**. `selectTimelineDurationFrames` = 210 → `durationSeconds` =
7.000000, `framesTotal` = 210. Clip C consumes `120 × 2 = 240` source frames = 8 s of source in 4 s
of timeline.

Input assignment, by §1.4: pass one takes the video contributors in track order — A→0, B→1 (V1),
C→2, D→3 (V2). G draws nothing, so pass two takes the audio-only contributors in the same order —
G→4 (V3), H→5 (A1). C has an input but no audio branch, so the branch labels run `a0 a1 a3 a4 a5`
and `amix` has `inputs=6`.

**The filter script** (`-filter_complex_script` file contents, verbatim):

```
color=c=black:s=1920x1080:r=30:d=7.000000,format=yuv420p[vbase];
anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=7.000000,asetpts=N/SR/TB[abase];
[0:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=30,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+0.000000/TB[v0];
[1:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=30,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+5.000000/TB[v1];
[2:v]setpts=(PTS-STARTPTS)/2.000,fps=fps=30,scale=960:540:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=0.500,setpts=PTS+2.000000/TB[v2];
[3:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=30,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+6.000000/TB[v3];
[vbase][v0]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,-0.016667)*lt(t,2.983333)'[vc0];
[vc0][v1]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,4.983333)*lt(t,6.983333)'[vc1];
[vc1][v2]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,1.983333)*lt(t,5.983333)'[vc2];
[vc2][v3]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,5.983333)*lt(t,6.983333)'[vc3];
[vc3]format=yuv420p[vout];
[0:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a0];
[1:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=5000:all=1[a1];
[3:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=0.500,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=6000:all=1[a3];
[4:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a4];
[5:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=0.800,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=1000:all=1[a5];
[abase][a0][a1][a3][a4][a5]amix=inputs=6:duration=first:dropout_transition=0:normalize=0[aout]
```

Note what is *not* there: no `[2:a]` branch (C is at `volume 0`), no `[v4]` chain and no fifth
overlay (G is at `opacity 0`), and no filter representing the 60-frame gap on V1. The gap is the two
`enable` windows `[0,90)` and `[150,210)` not covering `[90,150)`.

**The argv:**

```
ffmpeg -hide_banner -nostdin -loglevel error -y
  -ss 0.000000  -t 3.000000 -i <dev-media>/interview_wide_a.mp4
  -ss 10.000000 -t 2.000000 -i <dev-media>/broll_market_street.mp4
  -ss 0.000000  -t 8.000000 -i <dev-media>/macro_coffee_pour.mp4
  -ss 0.000000  -t 1.000000 -i <dev-media>/drone_pass_02.mp4
  -ss 0.000000  -t 3.000000 -i <dev-media>/interview_close_b.mp4
  -ss 0.000000  -t 4.000000 -i <dev-media>/vo_take_04.m4a
  -filter_complex_script <temp>/ve-export-<jobId>.txt
  -map [vout] -map [aout]
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 30
  -c:a aac -b:a 192k -ar 48000 -ac 2
  -t 7.000000 -movflags +faststart -f mp4
  -progress pipe:1 -stats_period 0.25 -nostats
  <partPath>
```

`<partPath>` is `path.join(folder, '.' + filename + '.mp4.part')` — §1.1 and §3.1. It is written as
one argv element, never quoted and never concatenated into a command string; verified with a folder
name containing a space.

**Observed result:** exit 0, empty stderr, `nb_read_frames=210`, video `duration=7.000000`, audio
stream `aac / 48000 Hz / 2 ch / 7.000000`.

Per-frame composite luma, sampled 3×3 across the frame (corner cells / centre cell):

| output frames | corners | centre | what it is |
|---|---|---|---|
| 0..59 | 62 | 61 | clip A full-frame; G, at `opacity 0`, contributes nothing |
| 60..89 | 62 | 70 | clip A with C blended into the centre quarter |
| **90..149** | **0** | 31 | the **gap** — black base, with C at half size and half opacity centred on it |
| 150..179 | 99 | 87 | clip B full-frame with C blended over the centre |
| 180..209 | 118 | 117 | clip D (the 24 fps source) covering B; C has ended |

Per-clip placement, verified against a marker rig carrying the identical `setpts` and `enable`
numbers, reading back which output frames each clip occupies:

| clip | intended | rendered |
|---|---|---|
| A | 0..89 | **0..89** |
| B | 150..209 | **150..209** |
| C | 60..179 | **60..179** |
| D | 180..209 | **180..209** |

The trailing output `-t` is redundant with the base's `d=` and is kept anyway: it is a hard stop
that bounds the file even if the graph is ever wrong, and a wrong-length file is the one failure
that would not announce itself.

---

#### B — 30 fps project, **24 fps** export

The case the dialog offers on every export and that an earlier draft got wrong by 2 output frames.
`F = 30`, `OF = 24`. Two clips on V1, back to back, both with audio.

| Track | Clip | media | start | duration | mediaIn | `nStart`→`nEnd` |
|---|---|---|---|---|---|---|
| V1 | A | `interview_wide_a.mp4` | 0 | 30 | 0 | 0 → 24 |
| V1 | B | `broll_market_street.mp4` | 30 | 30 | 300 | 24 → 48 |

`durationFrames = 60` → `durationSeconds = 60/30 = 2.000000` (**not** rebased by the export rate — a
1-second-per-clip cut stays 2 s long at any output rate). `framesTotal = round(2.0 × 24) = 48`.
Source-side `-ss/-t` stay at the project rate: A is `-ss 0.000000 -t 1.000000`, B is
`-ss 10.000000 -t 1.000000`.

```
color=c=black:s=1920x1080:r=24:d=2.000000,format=yuv420p[vbase];
anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2.000000,asetpts=N/SR/TB[abase];
[0:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=24,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+0.000000/TB[v0];
[1:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=24,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+1.000000/TB[v1];
[vbase][v0]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,-0.020833)*lt(t,0.979167)'[vc0];
[vc0][v1]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,0.979167)*lt(t,1.979167)'[vc1];
[vc1]format=yuv420p[vout];
[0:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a0];
[1:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=1000:all=1[a1];
[abase][a0][a1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[aout]
```

Encoder tail: `-r 24 -t 2.000000`.

**Observed result:** exit 0, `nb_read_frames=48`, `r_frame_rate=24/1`, `duration=2.000000`.
Placement on the marker rig: **A occupies output frames 0..23, B occupies 24..47** — exact, and both
clips' `adelay` (0 and 1000 ms) derive from the same `nStart`, so nothing slips against the picture.

For contrast, a separate rig — project 30 / export 24, a 3.333333 s canvas, one clip whose
`setpts` and `enable` numbers place it at output frame 24 — was rendered twice, changing only the
base's `r=`:

| base | clip rendered at | total frames |
|---|---|---|
| `r=24` (output rate, **correct**) | 24..47 | 80 |
| `r=30` (project rate) | **26..49** | 80 |

Two output frames, 83 ms, against an `adelay` that stayed exact — and an identical frame count in
both files. A frame count cannot see this. Do not build the base at `F`.

---

#### C — **29.97 fps** project, 29.97 fps export

The non-integer case, where frame-edge `enable` comparison fails about half the time. `F = OF = 29.97`.

| Track | Clip | media | start | duration | mediaIn | `nStart`→`nEnd` |
|---|---|---|---|---|---|---|
| V1 | A | `interview_wide_a.mp4` | 0 | 25 | 0 | 0 → 25 |
| V1 | B | `drone_pass_02.mp4` | 25 | 35 | 0 | 25 → 60 |

`durationFrames = 60` → `durationSeconds = 60/29.97 = 2.002002`. `framesTotal = 60`.
`ssSec/tSec`: A `-ss 0.000000 -t 0.834168`, B `-ss 0.000000 -t 1.167834`.
B's placement: `startSec = 25/29.97 = 0.834168`, `startMs = 834`,
`enableFrom = 24.5/29.97 = 0.817484`, `enableTo = 59.5/29.97 = 1.985319`.

```
color=c=black:s=1920x1080:r=29.97:d=2.002002,format=yuv420p[vbase];
anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2.002002,asetpts=N/SR/TB[abase];
[0:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=29.97,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+0.000000/TB[v0];
[1:v]setpts=(PTS-STARTPTS)/1.000,fps=fps=29.97,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,colorchannelmixer=aa=1.000,setpts=PTS+0.834168/TB[v1];
[vbase][v0]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,-0.016683)*lt(t,0.817484)'[vc0];
[vc0][v1]overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:shortest=0:repeatlast=0:format=yuv420:enable='gte(t,0.817484)*lt(t,1.985319)'[vc1];
[vc1]format=yuv420p[vout];
[0:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a0];
[1:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=834:all=1[a1];
[abase][a0][a1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[aout]
```

Encoder tail: `-r 29.97 -t 2.002002`.

**Observed result:** exit 0, `nb_read_frames=60`, `r_frame_rate=2997/100`, `duration=2.002002`.
Placement on the marker rig: **A occupies output frames 0..24, B occupies 25..59** — exact, and the
two windows abut on a single number (`0.817484`) because both came from `toOut(25)`.

### 1.9 Track flags

| Flag | Effect on export |
|---|---|
| `visible: false` (video track) | Its clips contribute **no video**. Their audio is unaffected — they still take an input. |
| `muted: true` | Its clips contribute **no audio**. Their video is unaffected. |
| `visible: false` (audio track) | Ignored. The flag is meaningless for audio and is not repurposed. |
| `locked` | **No effect.** Locking protects against editing, not against delivery. |

The two flags are independent because the model makes them independent, and they compose with the
per-clip `opacity` and `volume` exactly the same way: video is suppressed by `visible: false` *or*
`opacity === 0`, audio by `muted: true` *or* `volume === 0`. A clip that ends up with neither
contributes nothing and is skipped before it costs an input (§1.4).

**These rules are applied in the graph builder in main, not in the renderer.** The document is
serialised faithfully, flags intact; exclusion has exactly one implementation, in one place, that
can be exercised without a browser.

### 1.10 Encoder settings, and the composite pixel format

`CONTAINER` (PLAN §7.3) already maps codec → extension: `h264: mp4`, `h265: mp4`, `prores: mov`,
`aac: m4a`, `mp3: mp3`, `wav: wav`.

**The pixel format is a function of the codec in four places, not one.** The base's terminal
`format`, the per-clip `format`, `overlay`'s `format` option and the encoder's `-pix_fmt` must all
agree, or the graph subsamples chroma before the encoder ever sees it and the container metadata
still reads correct. That is how a ProRes 422 HQ file ends up carrying 4:2:0 8-bit data.

| codec | base + terminal `format` | per-clip `format` | `overlay` `format=` | encoder `-pix_fmt` |
|---|---|---|---|---|
| `h264` | `yuv420p` | `yuva420p` | `yuv420` | `yuv420p` |
| `h265` | `yuv420p` | `yuva420p` | `yuv420` | `yuv420p` |
| `prores` | `yuv422p10le` | `yuva422p10le` | `yuv422p10` | `yuv422p10le` |

All four ProRes values are verified on this build: `yuv422p10` is a legal `overlay` `format` enum
member, `yuva422p10le` is a legal pix_fmt, and the full graph encodes to
`codec_name=prores / profile=HQ / pix_fmt=yuv422p10le`, exit 0.

| codec | video args | audio args | container |
|---|---|---|---|
| `h264` | `-c:v libx264 -pix_fmt yuv420p -preset <P> -crf <C>` | `-c:a aac -b:a 192k -ar 48000 -ac 2` | `-f mp4 -movflags +faststart` |
| `h265` | `-c:v libx265 -pix_fmt yuv420p -preset <P> -crf <C> -tag:v hvc1` | `-c:a aac -b:a 192k -ar 48000 -ac 2` | `-f mp4 -movflags +faststart` |
| `prores` | `-c:v prores_ks -profile:v <N> -pix_fmt yuv422p10le -vendor apl0` | `-c:a pcm_s16le -ar 48000 -ac 2` | `-f mov` |

The three **audio-only** codecs (docs/AUDIO-FEATURES.md §2.3) emit no video argument at all — no
`-c:v`, no `-pix_fmt`, no `-r`. They are an explicit arm rather than a fall-through: ProRes used to
own the final `else`, and a widened union would otherwise have sent `wav` into `-c:v prores_ks`.

| codec | video args | audio args | container |
|---|---|---|---|
| `aac` | — | `-c:a aac -b:a <B> -ar 48000 -ac 2` | `-f mp4 -movflags +faststart` |
| `mp3` | — | `-c:a libmp3lame -b:a <B> -ar 48000 -ac 2` | `-f mp3` |
| `wav` | — | `-c:a <PCM> -ar 48000 -ac 2` | `-f wav` |

`-f mp4` for `.m4a` is correct and verified: `.m4a` *is* the mp4 container, and `-map [aout]` alone
is what makes the file audio-only. `+faststart` is therefore free and is kept for `aac`; it is
meaningless for `mp3` and `wav` and is not passed.

| quality | x264 preset / crf | x265 preset / crf | prores profile | `aac` `-b:a` | `mp3` `-b:a` | `wav` `-c:a` |
|---|---|---|---|---|---|---|
| `draft` | `veryfast` / `28` | `veryfast` / `32` | `0` (proxy) | `128k` | `128k` | `pcm_s16le` |
| `good` | `medium` / `20` | `medium` / `24` | `2` (422) | `192k` | `192k` | `pcm_s16le` |
| `best` | `slow` / `16` | `slow` / `20` | `3` (422 HQ) | `256k` | `320k` | `pcm_s24le` |

`good` at `192k` is deliberately the same number the h264/h265 paths pass, so an audio-only export
of a timeline sounds identical to the audio track of a video export of it — which makes a regression
in one visible against the other. WAV's `best` being 24-bit is not decoration: a lossless handoff
into a mixing tool is why someone picks WAV.

`libx264`, `libx265` and `prores_ks` are all present in the verified build. `-r <OF>` is always
passed. `-tag:v hvc1` is what makes an h265 mp4 openable by QuickTime and Finder preview.

**Known divergence, do not "fix":** `BITRATE_KBPS` in `exportMath.ts` under-reports ProRes at `good`
and `best` (the table's 82/122 Mbps against 422's ~147 and HQ's ~220 at 1080p30). `exportMath.ts` is
the dialog's *estimate* and is pinned by PLAN §8.9. Changing either the table or the profile mapping
to make them agree is out of scope; report it, do not edit it.

---

## 2. The progress protocol

**Progress is measured, never modelled.** No timer, no interpolation, no easing toward a target. If
ffmpeg has not said anything since the last event, the renderer sees the last real number.

### 2.1 Reading `-progress pipe:1`

ffmpeg is spawned with `-progress pipe:1 -stats_period 0.25 -nostats`. It writes newline-delimited
`key=value` blocks to **stdout**, each terminated by `progress=continue` or, once, `progress=end`.
stdout carries only this — the encoded file goes to a path — so the parser can own the stream.
`-nostats` suppresses the duplicate human-readable stats line on stderr, leaving stderr for errors
only, which §4 depends on.

An observed first block, verbatim:

```
frame=0
fps=0.00
stream_0_0_q=0.0
bitrate=N/A
total_size=48
out_time_us=N/A
out_time_ms=N/A
out_time=N/A
dup_frames=0
drop_frames=0
speed=N/A
progress=continue
```

Two facts from that transcript that the parser must be built around:

1. **`out_time_us` can be `N/A`.** It is `N/A` in the first block of every run, before any frame has
   been muxed. Parse failure ⇒ treat as `0`, never as `NaN`, never skip the block.
2. **`out_time_ms` is misnamed and carries microseconds.** In the verified runs both `out_time_us`
   and `out_time_ms` read `6933333` for a 6.93-second position. Using `out_time_ms` as milliseconds
   would report 1000× progress and peg the bar at 100% immediately. **Read `out_time_us`. Never read
   `out_time_ms`.**

The parser buffers stdout, splits on `\n`, accumulates `key=value` into a record, and flushes that
record when it sees a `progress=` key (which is always last in a block). Partial lines are retained
across chunk boundaries.

### 2.2 Mapping to `0..1`

```ts
const denom = durationSeconds;                       // durationFrames / doc.fps — §1.3
const outTimeSec = Number(block.out_time_us) / 1e6;  // NaN-guarded to 0
const raw = Number.isFinite(outTimeSec) && denom > 0 ? outTimeSec / denom : 0;
const progress = Math.min(1, Math.max(0, raw));
```

`durationSeconds` is exact **for the file's length**. It is *not* what ffmpeg's last block reports:
`out_time_us` is the presentation time of the **last frame**, so the final block falls short by
exactly one frame period. Verified on the §1.8 A run: the `progress=end` block reads
`out_time_us=6933333` against a 7.000000 s file — 0.9905, i.e. the encoding bar would top out at 99%
and, on a short export, visibly stall there.

**The fix is at the end, not in the denominator:** when the flushed block's `progress` value is
`end`, emit one final `encoding` event with `progress: 1` and `framesDone: framesTotal`, then move
to `finalizing`. One block, one event, and the denominator stays an honest statement about the
file's length rather than a fudge factor.

`framesTotal` is in **output** frames — `Math.max(1, Math.round(durationSeconds * out.fps))`, §1.3 —
so that it matches ffmpeg's own `frame=` counter, which counts frames the base actually produced.

```ts
const reported = Number(block.frame);
const framesDone = Number.isFinite(reported)
  ? Math.min(framesTotal, Math.max(0, Math.trunc(reported)))
  : Math.round(progress * framesTotal);
```

**Monotonicity is clamped in the `encoding` phase only.** The job holds `lastProgress` and
`lastPhase` (§3.1); a block that computes lower than `lastProgress` is emitted at `lastProgress`
instead, and `lastProgress` resets to `0` whenever the phase being emitted differs from `lastPhase`.
`encoding` is the only phase whose numbers come from ffmpeg and the only one where a rounding
artefact could make the bar twitch. Clamping across the phase boundary is a bug, not a safeguard:
`encoding` ends at 1.0 and `finalizing` *starts* at 0.5, so a phase-blind clamp would pin the bar at
100% through finalize and make the two finalizing events indistinguishable. The dialog renders
`Math.round(event.progress * 100)` with no phase awareness (`ExportDialog.tsx:299`), so there is
nothing downstream to absorb this.

### 2.3 Phases

`ExportProgressEvent.progress` is `0..1` **within the current phase** — the existing contract in
`api.ts`, unchanged. The dialog prints the phase label above the bar, so the bar filling once per
phase is legible.

| Phase | Emitted by | `progress` |
|---|---|---|
| `preparing` | main, before spawn, from real completed steps | see the table below |
| `encoding` | one per parsed block: `out_time_us / durationSeconds`, then `1` on `progress=end` | `0 … 1` |
| `finalizing` | after the child exits 0, across the rename | `0.5` at process exit, `1` after rename |
| `done` / `cancelled` / `error` | exactly once, terminal | `1` / last known / last known |

`preparing` fractions are stamped after the work they describe actually completes — they are
observations, not a schedule. **The order matters and is normative**, because the access checks must
come *after* the graph is built:

| After | `progress` |
|---|---|
| job accepted, id assigned | `0` — **mandatory, see below** |
| request validated: shapes, enums, filename legal (§5.2), range non-empty | `0.15` |
| output folder verified writable; `partPath`, `finalPath`, `scriptPath` chosen with `path.join` | `0.35` |
| `buildExportGraph` returned `ok` | `0.55` |
| every `graph.sourcePaths` verified with `access(R_OK)` | `0.80` |
| filter script written to temp, UTF-8 no BOM | `0.95` |
| `spawn` returned a live child | `1` |

**Only `graph.sourcePaths` is access-checked. Never `document.sources`.** The document carries every
source the project references; the graph references only the sources that survived range
intersection and the §1.9 track flags. Checking `document.sources` fails a whole export with
`source-missing` because of a file used solely by a clip outside the export range, or on a track
that is both hidden and muted — precisely the clips §1.9 says are skipped before they cost an input.
The graph is built before the check for exactly this reason: only `buildExportGraph` knows which
sources survived.

**The first event of every job must be exactly `{ phase: 'preparing', progress: 0 }`.** This is not
stylistic: `ExportDialog` adopts a job id from its first event and explicitly rejects any opening
event that is not `preparing`/`0` (guarding against adopting a late event from a cancelled job). A
job whose first emission is anything else is invisible to the dialog. Emit it unconditionally —
including for a request that is about to fail validation, whose sequence is then
`preparing/0` → `error`.

### 2.4 Cadence

`-stats_period 0.25` is the only rate control: four blocks per second, from ffmpeg, about work it
has actually done. Main forwards each parsed block as one IPC message, with one suppression: a block
whose `(phase, progress, framesDone)` triple is identical to the last emitted is dropped. The
displayed percentage is an integer, so four updates per second is already beyond what the eye
resolves, and no throttle beyond this is needed or permitted.

Terminal events are **never** suppressed or coalesced.

---

## 3. Cancel

### 3.1 The invariant

**Exactly one terminal event per job id, ever, and no event after it.** `done`, `cancelled` and
`error` all funnel through one function, which is the only code in the file permitted to emit a
terminal phase:

```ts
type Phase = ExportProgressEvent['phase'];

interface Job {
  id: string;
  sender: WebContents;
  state: 'preparing' | 'running' | 'finalizing' | 'settled';
  cancelRequested: boolean;
  child: ChildProcess | null;
  partPath: string;       // path.join(folder, `.${filename}.${ext}.part`)
  finalPath: string;      // path.join(folder, `${filename}.${ext}`)
  scriptPath: string;     // path.join(tmpdir(), `ve-export-${id}.txt`)
  framesTotal: number;
  lastPhase: Phase;
  lastProgress: number;
  lastFramesDone: number;
  stderrTail: string;     // last 8 KB
}

function settle(job: Job, phase: 'done' | 'cancelled' | 'error', extra?: …): void {
  if (job.state === 'settled') return;   // the whole race defence, in one line
  job.state = 'settled';
  jobs.delete(job.id);
  void rm(job.scriptPath, { force: true }).catch(() => undefined);
  emit(job, phase, …);
}
```

`settle` is idempotent by construction. Every path that could report an outcome calls it; the first
call wins and the rest are no-ops. There is no second place that sends a terminal phase.

**`settle` must be reachable from a `finally` on every async path.** This is a hard rule, not a
style preference. Every async listener and every async step in the preparing sequence puts its body
in `try { … } catch (e) { settle(job, 'error', classifyFsError(e, residual)); } finally { settle(job, 'error', residual); }`,
where `residual` is `ERR['encoder-not-started']` before the spawn point and `ERR['encoder-failed']` after it (§4).
The `finally` is a backstop that is a no-op whenever the body already settled, and the *only* thing
standing between a thrown filesystem error and a job that never emits anything.

That failure is not hypothetical — it is the shape of the `output-in-use` case §4 names. An
unguarded `await rename(...)` inside an `async` listener rejects the listener's promise, `settle` is
never reached, no terminal event is ever emitted, and the job stays in the registry. The renderer
then sits in `finalizing` forever: `RUNNING_PHASES` still contains it so the dialog is `running`,
and `requestClose` (`ExportDialog.tsx:291-297`) sees `running && jobRef.current !== null` and calls
`cancelExport` instead of closing — but `cancel` finds a job whose child has already exited, kills
nothing and emits nothing. Escape refuses, the footer offers only "Cancel export", and the modal is
unclosable with the focus trap engaged. Without the `finally`, the documented `output-in-use` error
is unreachable and the failure it describes produces a hang instead.

Two filesystem helpers, used everywhere in the close/finalize path. `ERR` is the §4 table as a
`Record<ExportErrorCode, ExportError>` — one frozen object, so a message is written once:

```ts
const removeFile = (p: string): Promise<void> =>
  rm(p, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);

function classifyFsError(e: unknown): ExportError {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'EPERM' || code === 'EBUSY') return ERR['output-in-use'];
  if (code === 'EACCES') return ERR['permission-denied'];
  if (code === 'ENOSPC') return ERR['disk-full'];
  return ERR['encoder-failed'];
}
```

`force: true` alone only swallows `ENOENT`; the retries are what handle a `.part` file Windows has
not finished releasing after the child exits.

### 3.2 The `.part` file is what makes "cancelled" true

ffmpeg writes to `path.join(folder, '.' + filename + '.' + ext + '.part')`. The file is renamed to
its real name **only** on the success path, after the process has exited 0. Consequences:

- A cancelled or failed export never leaves a file at the name the user chose. The dialog's
  "No file was written" is a fact, not a hope.
- Cleanup is one `removeFile(partPath)`, on every non-success path, and it cannot delete anything
  the user made.
- A truncated mp4 (killed before the moov atom is written) never reaches a name that looks
  playable.

**A successful export overwrites an existing file at `finalPath`, deliberately and silently.** On
win32 `rename` onto an existing path succeeds and replaces it (libuv uses
`MOVEFILE_REPLACE_EXISTING`) — verified — and that is the intended behaviour, not an accident of the
implementation. The dialog defaults `filename` to the project name and remembers the folder across
dialogs precisely so a re-export after a tweak is one click; a confirmation prompt would tax the
common case, and a silent numeric suffix would produce files the user did not name and cannot
predict, which is worse. Replacing the file you just exported is what every NLE does and what the
user means. This is a stated product decision — see §7.

### 3.3 Killing

```ts
async cancel(event: IpcMainInvokeEvent, jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job || job.state === 'settled') return;   // late cancel: silent no-op, emit NOTHING
  if (job.sender !== event.sender) return;       // not this window's job: same silent no-op
  job.cancelRequested = true;
  if (job.child !== null) job.child.kill();      // SIGTERM; TerminateProcess on win32
  // no emit here, ever — the close handler is the single settle point once a child exists
}
```

**The sender check is a boundary, not a nicety.** `Job.sender` exists and §3.5 already limits a
window to one job; without consulting it, any renderer can cancel another window's export by
guessing or observing a job id. The failure mode is silent and indistinguishable from a user cancel,
which is exactly the kind of bug that never gets reported.

ffmpeg is spawned with `-nostdin`, so the graceful `q` route is unavailable by design: a graceful
stop produces a *valid truncated file*, which we would delete anyway, in exchange for an unbounded
wait. Hard kill plus `.part` deletion is both faster and simpler to reason about.

**Two rules close the cancel-during-spawn race. Both are normative.**

**(a) The spawn and the assignment are one statement.**

```ts
job.child = spawn(bin, graph.args, { windowsHide: true });
```

`spawn` is synchronous and JavaScript is single-threaded, so no `cancel` can interleave between the
process existing and `job.child` referencing it. There is no window in which a live child is
invisible to `cancel`.

**(b) Once a child exists, `cancel` never settles.** It sets `cancelRequested`, calls `kill()`, and
returns. The `close` handler is the single settle point, exactly as §3.4(b) requires.

Rule (b) is what stops the worst outcome. `settle` deletes the job from the registry and emits the
terminal event, but it does not touch `job.child` or `job.partPath`. If a post-spawn boundary check
settled `cancelled` while a live child existed, the job would vanish, the user would be told the
export was cancelled and no file was written, and ffmpeg would keep encoding in the background to a
hidden `.part` file that no code path would ever clean up. §3.2's promise would become false.

If cancel lands **strictly before** the spawn statement, `child` is null and nothing is killed. The
preparing sequence re-checks `job.cancelRequested` at every step boundary *up to and including the
one immediately before the spawn statement*, and settles `cancelled` rather than spawning. After the
spawn statement there are no more such boundaries: the sequence emits `preparing/1` and hands off to
the child's handlers.

### 3.4 The three races, closed

**(a) Cancel arriving after natural completion must not report a false cancel.**
By the time `done` is emitted, `settle` has already set `state = 'settled'` and removed the job from
the registry. `cancel` finds nothing, returns, and emits nothing. The renderer's last event stays
`done`. The dialog also guards its own side (it only cancels while `jobRef.current !== null`), but
correctness does not depend on that.

**(b) Completion arriving after cancel must not resurrect the job.**
The child's `close` handler is the single settle point for a spawned job. It branches on
`cancelRequested` **before** it branches on the exit code, and its entire body is guarded:

```ts
child.on('close', (code) => { void onClose(job, code); });

async function onClose(job: Job, code: number | null): Promise<void> {
  try {
    if (job.cancelRequested) {
      await removeFile(job.partPath);
      return settle(job, 'cancelled');          // even if code === 0
    }
    if (code !== 0) {
      await removeFile(job.partPath);
      return settle(job, 'error', classifyExit(code, job.stderrTail));
    }
    /* ---- (c), below ---- */
    emit(job, 'finalizing', 0.5, job.framesTotal);
    if (job.cancelRequested) {
      await removeFile(job.partPath);
      return settle(job, 'cancelled');
    }
    await rename(job.partPath, job.finalPath);
    if (job.cancelRequested) {
      await removeFile(job.finalPath);
      return settle(job, 'cancelled');
    }
    emit(job, 'finalizing', 1, job.framesTotal);
    settle(job, 'done', { outputPath: job.finalPath });
  } catch (e) {
    await removeFile(job.partPath);
    settle(job, 'error', classifyFsError(e, ERR['encoder-failed']));
  } finally {
    settle(job, 'error', ERR['encoder-failed']);  // no-op if the body already settled
  }
}
```

A kill that arrives microseconds after ffmpeg finished still yields `cancelled`, and that is
truthful: the `.part` file was deleted, so no output exists. A killed ffmpeg also exits non-zero with
alarming stderr; checking `cancelRequested` first is what stops a user-initiated cancel from
surfacing as an encoder failure.

**(c) Cancel arriving during `finalizing`, across the rename `await`.**
The rename is the one place where a cancel can interleave with an `await`, and it is re-checked on
both sides — see the block above. The cancel is honoured on either side of the rename and the
delivered file is removed in both cases, so "cancelled" continues to mean "no file was written".

The `rename` itself is the throw this whole structure exists for. Verified on win32:
`fs.renameSync` onto a path another process holds open throws `EPERM`, while `fs.renameSync` onto a
merely-existing path succeeds. `EPERM` here is specifically the in-use case, which is why
`classifyFsError` maps it to `output-in-use` and why §4 marks that code retryable — closing the
other program and pressing Export again is a sensible next action.

### 3.5 Lifecycle

- **At most one job per `WebContents`.** A second `start` from the same sender emits
  `preparing/0` then `error` with code `busy` for the *new* job id, and does not disturb the running
  one.
- **Renderer went away** (`webContents` `destroyed`): kill the child, remove the `.part`, `settle`
  without emitting (`emit` no-ops on a destroyed sender, as `electron/ipc/media.ts` already does).
- **`app.on('before-quit')`**: kill every live child and remove every `.part` and script file
  synchronously enough to not leak, then let the quit proceed.
- **The temp filter script** is removed by `settle`, on every path.

---

## 4. Error taxonomy

`retryable` means precisely: **re-running the identical request, with the user changing nothing
outside the dialog, could succeed.** By that definition almost nothing is retryable, and that is the
useful answer — a retryable error is one where "Export" again is a sensible next action rather than
a way to see the same message twice. The dialog offers Export again on every error regardless; this
flag is what a future affordance would branch on, and what tells the implementer whether to bother
preserving state.

Messages follow the `MediaError` convention already in the codebase: one sentence, sentence case, no
trailing period, no apology, no exclamation mark, safe to show verbatim.

| Code | Detected by | Message | Retryable |
|---|---|---|---|
| `ffmpeg-missing` | `spawn` emits `error` with `errno.code === 'ENOENT'` | `ffmpeg was not found on PATH, so nothing can be encoded` | `false` |
| `invalid-filename` | request validation (§5.2) rejects `filename` or the joined path | `That file name cannot be used on this system` | `false` |
| `invalid-request` | request validation (§5.2) rejects any other field — missing, non-numeric, unknown enum, negative start frame, or a `document` present in the wrong shape | `The export settings are not valid, so nothing was encoded` | `false` |
| `empty-timeline` | `buildExportGraph` returns `ok: false` because no clip contributes video or audio inside the range — or `req.document` is absent | `There is nothing on the timeline to export` | `false` |
| `source-missing` | pre-flight `access(p, R_OK)` fails for a `graph.sourcePaths` entry, a clip's `mediaId` has no `ExportSource`, or stderr matches `/No such file or directory/` with a non-zero exit | `A source file is no longer where the project expects it` | `false` |
| `unsupported-codec` | stderr matches `/Decoder .* not found\|Unknown decoder\|Unsupported codec\|Could not find codec parameters/` | `A source uses a codec this build cannot decode` | `false` |
| `output-not-writable` | pre-flight `access(folder, W_OK)` fails with `ENOENT`, or the folder is not a directory | `The output folder is missing, so nothing can be written` | `false` |
| `permission-denied` | pre-flight `access` fails with `EACCES` **or `EPERM`**, `classifyFsError` sees `EACCES`, or stderr matches `/Permission denied/` | `The output folder does not allow this app to write` | `false` |
| `disk-full` | `ENOSPC` from `classifyFsError` on any write in the finalize path, or stderr matches `/No space left on device/` | `The drive ran out of space before the export finished` | `false` |
| `output-in-use` | `classifyFsError` sees `EPERM`/`EBUSY` — i.e. the **post-encode `rename`** threw (§3.4c), never the pre-flight folder `access` — or stderr matches `/Device or resource busy/` | `The output file is open in another program` | `true` |
| `busy` | a job is already running for this sender | `Another export is already running` | `true` |
| `encoder-not-started` | `spawn` throws or emits `error` with a code other than `ENOENT`, an unclassified throw in the preparing sequence, or the pre-spawn `finally` backstop in §3.1 | `The encoder could not be started, so nothing was encoded` | `true` |
| `encoder-failed` | non-zero exit that matched none of the above, an unclassified throw in the finalize path, or the post-spawn `finally` backstop in §3.1 | `The encoder stopped before it finished` | `true` |

**A message never names a cause that did not happen.** `encoder-failed` says the encoder stopped
mid-run, so it may only be reported once a child process has actually run. Everything that fails
before `spawn` — a malformed request, a launch that never happened — carries `invalid-request` or
`encoder-not-started` instead. This is why `classifyFsError` takes its residual bucket as an
argument: the same errno means different things either side of the spawn point.

**Pre-flight beats post-mortem.** Every check that can be made before `spawn` is made before
`spawn`, in the order §2.3 fixes: the request is well-formed and the filename is usable, the output
folder exists and is writable, the graph builds and is non-empty, every source the graph actually
references exists and is readable. Those are the failures a user can act on, and reporting them in
40 ms with a precise sentence is better than reporting them in 40 seconds from a stderr regex.

**Raw stderr is never shown to the user.** ffmpeg's diagnostics are not in the product's voice and
frequently name internals. Main keeps the last 8 KB of stderr, uses it for classification, and
`console.error`s it on failure so it is available while developing. `ExportProgressEvent.message`
carries only the sentence from the table above — which is also what the finished dialog already
renders through `InlineNotice`.

`cancelled` is a phase, not an error, and has no code.

---

## 5. The IPC contract

Added to **`src/types/api.ts`** — the shared file both implementers compile against. Written once,
by MAIN, exactly as below (§6). Everything here is structured-cloneable: plain objects, arrays,
strings and numbers. No `Set`, no `Map`, no `Date`, no class instance, no function. `Selection` is a
`Set` and is deliberately absent from the document.

```ts
/* ---- added to CH ------------------------------------------------------- */
export const CH = {
  // …existing entries unchanged…
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportProgress: 'export:progress', // main -> renderer
} as const;

/* ---- errors ------------------------------------------------------------ */

export type ExportErrorCode =
  | 'ffmpeg-missing'
  | 'invalid-filename'
  | 'invalid-request'
  | 'empty-timeline'
  | 'source-missing'
  | 'unsupported-codec'
  | 'output-not-writable'
  | 'permission-denied'
  | 'disk-full'
  | 'output-in-use'
  | 'busy'
  | 'encoder-not-started'
  | 'encoder-failed';

export interface ExportError {
  code: ExportErrorCode;
  /** One sentence, sentence case, no trailing period, safe to show verbatim. */
  message: string;
  /** True when re-running the identical request could succeed without user action. */
  retryable: boolean;
}

/* ---- the document handed to the graph builder --------------------------- */

/**
 * One source file. `path` is an ABSOLUTE filesystem path — never a 've-media://' URL,
 * which exists for Chromium (PLAN §1.4) and which ffmpeg cannot open.
 *
 * `hasAudio` is a property of the FILE, not of the edit: every dev-media fixture carries an
 * audio stream, each with its own audible signature (scripts/make-dev-media.mjs). Whether a
 * clip is audible is decided by `volume` and the track's `muted` flag (EXPORT §1.4), never by
 * guessing from content — a file whose content were silence would still have `hasAudio: true`.
 */
export interface ExportSource {
  mediaId: MediaId;
  path: string;
  kind: MediaKind;
  hasAudio: boolean;
  /** MediaItem.durationFrames — PROJECT frames, at ExportDocument.fps. */
  durationFrames: Frames;
  width: number;
  height: number;
}

/**
 * The timeline, flattened for the encoder. Every frame field is in PROJECT frames at
 * `fps`; MediaItem.fps is never carried, because no frame calculation may read it
 * (PLAN §2.4, the source-mapping invariant).
 */
export interface ExportDocument {
  fps: number;
  width: number;
  height: number;
  /**
   * COMPOSITE order: video tracks bottom-first, then audio tracks in `trackOrder`
   * order. This is NOT a plain reverse of the store's `trackOrder` — see EXPORT §6
   * for the literal transform, which reverses only the video tracks.
   */
  tracks: Track[];
  /** Every clip in the project. The builder filters by range and by track flags. */
  clips: Clip[];
  sources: ExportSource[];
}

/* ---- the request ------------------------------------------------------- */

/**
 * The DIALOG resolves `range` into absolute frames before calling (PLAN §8.9), and
 * attaches the document — a main-process bridge has no other way to see the timeline.
 *
 * `document` is OPTIONAL so that this file can land before the renderer call site that
 * fills it (EXPORT §6, "The seam"). Main treats an absent document as `empty-timeline`.
 * It may be tightened to required once the call site exists.
 */
export type ExportRequest = ExportSettings & {
  startFrame: Frames;
  durationFrames: Frames;
  document?: ExportDocument;
};

/* ---- progress (extended; existing fields unchanged) --------------------- */

export interface ExportProgressEvent {
  jobId: string;
  phase: 'preparing' | 'encoding' | 'finalizing' | 'done' | 'cancelled' | 'error';
  /** 0..1, monotonic within a phase. */
  progress: number;
  framesDone: number;
  /** OUTPUT frames: round(durationSeconds * settings.fps). */
  framesTotal: number;
  /** Required when phase === 'error'. Always equals `error.message` when `error` is set. */
  message?: string;
  /** Set when phase === 'error'. Lets a future UI branch on the code without a contract change. */
  error?: ExportError;
  /** Set when phase === 'done'. The absolute path actually written — main's `path.join`
      result, which is what the dialog renders (EXPORT §6, RENDERER). */
  outputPath?: string;
}

/* ---- the bridge (start's parameter widens; nothing else changes) -------- */

export interface ExportBridge {
  start(req: ExportRequest): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<void>;
  /** Returns its own unsubscribe. */
  onProgress(cb: (e: ExportProgressEvent) => void): () => void;
}

export interface EditorAPI {
  // …unchanged…
  /** PRESENT in Electron once electron/ipc/export.ts lands. Absent under dev:web,
      where ExportDialog falls back to exportStub. */
  export?: ExportBridge;
}
```

`Track` and `Clip` must be added to the existing `import type { … } from './model'` line.

### 5.1 The event stream, per job

```
start(req) ──▶ { jobId }

  preparing/0            ← ALWAYS first, unconditionally (§2.3)
  preparing/0.15 … 1     ← real completed steps, may be cut short by a failure
  encoding/…             ← one per ffmpeg progress block, 4/sec
  encoding/1             ← exactly once, on the `progress=end` block (§2.2)
  finalizing/0.5
  finalizing/1
  done/1                 ← terminal
                           or cancelled/<last>  or  error/<last>
```

Exactly one terminal event. No event after it. `cancel` on an already-settled job — or on a job
belonging to another window — emits nothing.

### 5.2 Main handlers

```ts
// electron/ipc/export.ts
export function registerExportIpc(ipcMain: IpcMain): void;

ipcMain.handle(CH.exportStart,  async (event, req: unknown): Promise<{ jobId: string }> => …);
ipcMain.handle(CH.exportCancel, async (event, jobId: unknown): Promise<void> => …);
// main -> renderer: job.sender.send(CH.exportProgress, ev satisfies ExportProgressEvent)
```

**`exportCancel` takes `event`, not `_event`.** The handler passes it to `cancel` so §3.3 can compare
`job.sender` against `event.sender`. Discarding the sender is what lets one window cancel another's
export.

`exportStart` **never rejects.** A bad request still resolves with a job id and reports the failure
through the event stream (`preparing/0` → `error`). The dialog's `catch` around `start` exists for a
bridge that dies outright and must stay unreachable in the happy and unhappy paths alike.

`req` is validated as untrusted input before anything touches the filesystem: type-check `folder`,
the dimensions, `fps`, the codec and quality enums, `startFrame`/`durationFrames`, and the
document's arrays.

**`filename` gets its own rules, because the renderer's `sanitiseFilename` is not a boundary.**
`ExportDialog.tsx:73-74` strips `\ / : * ? " < > |` and trims, which is a helpful affordance — but it
runs in the renderer and it leaves several things Windows rejects. Main rejects, with
`invalid-filename`, a request whose `filename`:

- is empty after `trim()`;
- still contains any of `\ / : * ? " < > |` or a control character (`\x00`–`\x1f`);
- ends in a dot or a space (Windows silently strips these, so the file lands at a name the dialog
  did not report);
- has a basename, case-insensitively and ignoring any extension, equal to a reserved device name:
  `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`;
- produces a `path.join(folder, filename + '.' + ext)` longer than 259 characters on win32.

These are checks on the request, not on the folder, which is why they need a code of their own
rather than being reported as `output-not-writable`.

### 5.3 Preload

```ts
// electron/preload.ts — added to the api object
export: {
  start: (req) => ipcRenderer.invoke(CH.exportStart, req) as Promise<{ jobId: string }>,
  cancel: (jobId) => ipcRenderer.invoke(CH.exportCancel, jobId) as Promise<void>,
  onProgress: (cb) => subscribe<ExportProgressEvent>(CH.exportProgress, cb),
},
```

Adding this member is what flips `getEditorAPI().export ?? exportStub` to the real bridge inside
Electron. The comment at the bottom of `preload.ts` explaining the deliberate absence is deleted
with it.

---

## 6. File ownership

Nobody creates, edits or deletes a file outside their own list (PLAN §0). If you need a change
elsewhere, state the exact declaration you need in your final message.

### MAIN

| File | Change |
|---|---|
| `src/types/api.ts` | **Shared type file. MAIN is its only writer.** Add §5 verbatim, as the *first* commit of this work. |
| `electron/export/graph.ts` | **New.** The pure graph builder. |
| `electron/ipc/export.ts` | **New.** `registerExportIpc`, the job registry, spawn, the progress parser, cancel, error classification. |
| `electron/main.ts` | **Two lines only**: `import { registerExportIpc } from './ipc/export';` and `registerExportIpc(ipcMain);` beside the existing two registrations. |
| `electron/preload.ts` | **One member only**: the `export` object in §5.3. |

`electron/export/graph.ts` is a **pure module**: no `electron` import, no `node:child_process`, no
`node:fs`. Signature:

```ts
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
export function buildExportGraph(
  req: ExportRequest,
  paths: { scriptPath: string; outputPath: string },
): { ok: true; graph: BuiltGraph } | { ok: false; error: ExportError };
```

`buildExportGraph` returns `{ ok: false, error: ERR['empty-timeline'] }` when `req.document` is
absent, and when the document is present but no clip contributes video or audio inside the range.

Purity is the point: the builder is the part most likely to be wrong and it can be exercised
directly from `dist-electron/electron/export/graph.js` with `node -e`, with no window, no app and no
encode. **Build all three §1.8 examples there first and diff them against this document before
wiring anything.** Example A alone will not catch a rate mismatch; B and C exist because they are
the two cases that a 30-into-30 example cannot see.

### RENDERER

| File | Change |
|---|---|
| `src/components/export/exportDocument.ts` | **New.** `buildExportDocument(s: StoreState): ExportDocument`. |
| `src/components/export/exportStub.ts` | Widen `start`'s parameter to `ExportRequest` (it ignores `document`). Nothing else. |
| `src/components/export/ExportDialog.tsx` | **Two call sites, listed below. Nothing else.** |

The two dialog edits:

1. **Line 241** — pass the document:
   `bridge.start({ ...settings, filename, folder, startFrame, durationFrames, document: buildExportDocument(readStore()) })`.
2. **Lines 382-386** — render the path main actually wrote:
   `Written to {event?.outputPath ?? <the existing folder + separator + outputName expression>}`.

Edit 2 is not cosmetic. `settings.folder` plus the dialog's own slash logic plus `outputName` is the
dialog's *guess* at the path, not the path main wrote: main builds it with `path.join`, which
normalises separators the dialog's `endsWith('/') || endsWith('\\')` branch does not, and §5.2 lets
main reject a filename the renderer's `sanitiseFilename` let through. The dialog can therefore state
a path that does not exist. Without this edit `ExportProgressEvent.outputPath` is a field in a contract both
implementers compile against that nothing can consume — which invites someone to wire it later
without reading this section. The fallback stays so the stub, which reports no `outputPath`, still
renders a sensible sentence under `dev:web`.

```ts
// src/components/export/exportDocument.ts
export function buildExportDocument(s: StoreState): ExportDocument;
```

It reads `s.fps`, `s.width`, `s.height`, `s.trackOrder`, `s.tracks`, `s.clips`, `s.items`; emits one
`ExportSource` per `MediaId` referenced by any clip, taking `path`, `kind`, `hasAudio`,
`durationFrames`, `width`, `height` from the `MediaItem`; and deep-copies nothing that is not plain
data. It **does not filter** — not by range, not by track flags, not by offline status. Filtering has
one implementation, in `graph.ts` (§1.9).

**The track transform is literal and is not a reverse:**

```ts
const vids = s.trackOrder.filter((id) => s.tracks[id].kind === 'video').reverse();
const auds = s.trackOrder.filter((id) => s.tracks[id].kind === 'audio');
const tracks = [...vids, ...auds].map((id) => s.tracks[id]);
```

`trackOrder` is top-to-bottom **with video above audio** (`src/state/timelineSlice.ts:216`), and
`createDefaultTracks()` returns `[V2, V1, A1, A2]` (`:228`); `addTrack` prepends video and appends
audio (`:807-808`). So `[...s.trackOrder].reverse()` yields `[A2, A1, V1, V2]` — audio first, and
audio tracks in descending index. Reversing only the video segment yields `[V1, V2, A1, A2]`, which
is what §1.6 means by bottom-first and what §1.4's input-assignment passes walk.

**No slice file is edited.** "Store wiring" here means a read-only adapter that lives in the export
folder and calls existing selectors. `src/state/**`, `src/lib/**` and every scaffold file other than
`src/types/api.ts` are untouched by both implementers.

### The seam

`src/types/api.ts` is the only file both implementers compile against, and it has exactly one
writer: MAIN. It lands first.

**`document` is declared optional in that first commit** (`document?: ExportDocument`, §5) and that
is not a stylistic choice — it is what lets both commits stay green without either implementer
touching a file they do not own. A required `document` breaks `ExportDialog.tsx:241` the instant
`api.ts` lands: the object literal there has no `document`, which is `TS2345` (verified), and §6
forbids MAIN from editing that file. MAIN's own commit would go red on a file MAIN may not fix.

The sequence, therefore:

1. **MAIN**, commit 1: `src/types/api.ts` with `document?: ExportDocument`. Green.
2. **RENDERER**: `exportDocument.ts`, the stub widening, and the two `ExportDialog.tsx` call sites.
   Green — it compiles against the type that already exists, and passing `document` to an optional
   field is legal.
3. **MAIN**, follow-up (optional): tighten `document?` to `document`, once the call site exists.
   Green.

Neither implementer is ever red, and neither crosses ownership. `exportStub.ts` needs no timing
coordination at all: TypeScript method parameters are bivariant, so its narrower `start` signature
satisfies `ExportBridge` in every one of the three states above (verified with the project's own
`tsc`). The widening in the RENDERER table is for readability, not to fix an error.

Neither implementer touches: `src/components/export/exportMath.ts`, `src/components/export/export.css`,
`docs/PLAN.md`, `PRODUCT.md`, `DESIGN.md`, `src/state/**`, `electron/ipc/media.ts`,
`electron/ipc/project.ts`.

### Gates

**Every commit is green. There is no permitted red window**, on either side, at any point in the
sequence above. Silently-red gates are how the electron postinstall failure went unnoticed once
already; a step that "will go green when the other side lands" is not a step, it is a wish.

```
npm run typecheck
npm run build
node scripts/check-contract.mjs
```

And the real acceptance test, which `dev:web` cannot perform: launch the packaged app, build a
timeline through the store over CDP, export it, and confirm the written file's frame count and
duration against `framesTotal` and `durationSeconds`. Run it at least twice: once with the export
rate equal to the project rate, and once with them different, because those are two different
graphs.

---

## 7. Out of scope for v1

Stated plainly so nobody gold-plates. Each of these is a deliberate omission, not an oversight.

- **No transitions.** No cross-dissolve, no fade to black, no wipe. There is no transition in the
  data model to export; adding one to the graph would mean inventing one.
- **No colour grading.** No LUTs, no curves, no `eq`, no white balance, no `colorspace` conversion
  beyond the `format` filters the pipeline needs to function.
- **No per-clip filters beyond `speed`, `opacity` and `volume`.** `scale`, `positionX` and
  `positionY` *are* honoured, because they are parameters of the `scale` and `overlay` filters the
  graph already emits — they add no filter and no code path.
- **`rotation` is not honoured.** It is the one `ClipProperties` field the export drops, and unlike
  the others it would require a new `rotate` filter, alpha-aware padding to avoid clipping the
  corners, and a rotation-origin convention that provably matches CSS `transform-origin: 50% 50%`.
  A clip with `rotation !== 0` exports unrotated. Do not add it silently; it needs its own decision.
- **Overwriting an existing file is intended and silent.** No confirmation, no numeric suffix, no
  `output-exists` error. A successful export replaces whatever is at `finalPath`; see §3.2 for the
  reasoning and the verified win32 `rename` behaviour this rests on.
- **No hardware encoder selection.** No NVENC, no QSV, no VideoToolbox, no AMF, no probing for what
  the machine has. `libx264` / `libx265` / `prores_ks` always. Hardware paths differ in flags,
  quality controls, pixel format constraints and failure modes per vendor and per driver, and each
  one is a separate error taxonomy.
- **No bundled ffmpeg.** `PATH` resolution only, exactly as `electron/ipc/media.ts` already does
  (PLAN §1.2). `ffmpeg-static` remains the named follow-up. Do not add it.
- **No export queue.** One job at a time per window; a second `start` returns `busy` (§4).
- **No two-pass, no target bitrate, no `-b:v`.** Quality is CRF for h264/h265 and a profile for
  ProRes (§1.10).
- **No audio normalisation, no loudness target, no limiter.** `amix` with `normalize=0`, and the
  per-clip `volume` the user set. Nothing else touches the levels.
- **No image sequence, GIF, or audio-only output.** Three codecs, two containers, per `CONTAINER`.
- **No "open containing folder" or "play result" affordance.** The dialog states the path it wrote;
  that is the whole completion story for v1.
- **No resume, no partial re-render, no render cache.** Cancel deletes the `.part` file and the next
  export starts from zero.
