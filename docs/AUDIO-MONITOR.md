# Audio monitoring — the preview mix contract

**Status:** normative. This document specifies how the preview plays every audible clip on the
timeline, so that what the user **hears while editing** matches what `docs/EXPORT.md` **renders**.
It is the integration contract for one implementer, **preview** (`src/components/preview/**`,
`src/state/playbackSlice.ts`). Where this document and a slice brief disagree on a *name, type,
number or channel*, this document wins — report the conflict rather than diverging.

Read order: `PRODUCT.md` → `DESIGN.md` → `docs/PLAN.md` → `docs/EXPORT.md` → this file.

**The gap being closed.** There is no audio-track playback in the preview at all. `grep` over
`src/components/preview/` returns no `<audio>`, no `AudioContext`, no branch on `kind === 'audio'`.
A user can place a voiceover on A1 and a bed on A2, the export mixes them correctly, and while
editing they hear only the embedded audio of the one video clip the pooled `<video>` happens to be
carrying. They are cutting sound blind. That is a functional hole, not a polish item.

**The three architectural constraints this design is built around, restated so they cannot be
lost:**

1. **The playhead has exactly one owner** (PLAN §8.3): `playbackSlice.playhead`. The audio monitor
   **reads** it and **never writes** it. It calls no transport action. It exports no setter.
2. **There is exactly one rAF loop** (PLAN §8.4): `usePlaybackClock`. The audio monitor adds none.
   It runs from `useEditorStore.subscribe(s => s.playhead, …)`, which is *driven by* that loop and
   fires at most once per advanced frame. This is the same mechanism `VideoSurface.syncTime` already
   uses; a `grep` for `requestAnimationFrame` in `src/components/preview/` must still return exactly
   one loop after this work lands.
3. **The source-mapping invariant** (PLAN §2.4 invariant 3) is the only expression permitted, in
   both directions, for audio as for picture. Frames are integers; `MediaItem.fps` never appears.

**A fourth, added by review and equally binding:** the monitor **never writes to the store from
inside the playhead subscription**. zustand runs `subscribeWithSelector` listeners synchronously
inside `set`, so a `setNotice` issued from the tick is a nested `setState` during listener
notification — the exact hazard `usePlaybackClock`'s `selfWriting` flag exists to document
(`usePlaybackClock.ts:56-67`). Every store write this document asks for is deferred; see §7.5.

---

## 1. What must be audible

### 1.1 The predicate

Monitoring audibility is `contributesAudio` from EXPORT.md §1.4, plus the two conditions that only
exist because monitoring happens in a browser engine rather than in ffmpeg:

```ts
const monitorAudible = (clip: Clip, track: Track, media: MediaItem): boolean =>
  media.status === 'ready' &&      // monitoring only; see §1.3 row 9
  media.url !== '' &&              // monitoring only; see §1.3 row 9
  media.hasAudio &&
  !track.muted &&
  clip.properties.volume > 0;
```

Compare, field for field, against the export graph:

| Condition | Export (`contributesAudio`) | Monitor | Same? |
|---|---|---|---|
| `source.hasAudio` | yes | yes | **yes** |
| `!track.muted` | yes | yes | **yes** |
| `clip.properties.volume > 0` | yes | yes | **yes** |
| `track.kind` | not tested | not tested | **yes** — see §1.2 |
| `track.visible` | not tested | not tested | **yes** — see §1.2 |
| `track.locked` | not tested | not tested | **yes** — locking protects editing, not delivery |
| `clip.properties.opacity` | not tested | not tested | **yes** — a clip faded to nothing keeps its sound |
| `media.status === 'ready'` | n/a (`access(R_OK)` fails the whole job) | required | monitor-only, §1.3 row 9 |
| `media.url !== ''` | n/a (ffmpeg opens the absolute path) | required | monitor-only, §1.3 row 9 |

So: **audio-kind clips on audio tracks, and the embedded audio of video clips, on every track,
whether or not that video clip is the one on screen.** A clip on V1 sitting under a clip on V2 is
audible in the export and must be audible in the preview. A clip on a hidden video track is audible
in the export and must be audible in the preview.

Playback range is not an audio question: monitoring stops where picture stops, at
`selectPlaybackStopFrame` (PLAN §3.3). There is no separate audio tail.

### 1.2 Hidden tracks are not silent — decided, and why

**`Track.visible` is a picture flag. It has no effect on audio, in monitoring or in export.**

EXPORT.md §1.9 already states this: `visible: false` on a video track suppresses its video and
leaves its audio untouched; `visible: false` on an audio track is ignored outright. Monitoring
adopts the same rule, unchanged, and the justification is not deference — it is that the opposite
rule destroys an ordinary edit. Hiding V2 to see what is underneath it, while the dialogue on V2
keeps running, is a normal thing to do in an assembly. If hiding implied silence, that edit would
require duplicating the clip onto an audio track first. EXPORT.md §1.4's union predicate
(`contributesVideo || contributesAudio`) exists precisely so a clip can contribute one and not the
other; monitoring must not re-couple what the model deliberately separated.

`Track.muted` is the audio flag, it is the *only* audio flag, and it already sits on the track head
with its own icon pair (`Volume2` / `VolumeX`) and its own accessible name.

**One consequence that §2.3 depends on.** `selectVideoClipIdAtFrame` skips tracks with
`visible: false` (`timelineSlice.ts:1243`). Hiding a video track therefore changes *which clip is
the clock clip* — the clip underneath becomes the picture, and the hidden track's clip stops being
carried by the `<video>` element and must be picked up by that track's voice. This is not a special
case in the code; it falls out of §2.3's predicate, which is computed from the same selector. It is
called out here because it is the mechanism behind acceptance test 4, and because it is the one
place where a *picture* flag changes *which element* carries a sound.

**No change is asked of `TrackHead.tsx`.** An earlier draft of this document proposed hiding the
`Eye` / `EyeOff` toggle on audio tracks on the grounds that it "does nothing at all". That
justification was wrong, and the change is withdrawn. The toggle does have behaviour on an audio
track — just not audio behaviour: `TrackHead` sets `data-hidden` and dims the label
(`timeline.css:229`), `Track` passes `trackHidden` into every clip (`Track.tsx:60`), and `Clip`
renders an `EyeOff` badge and appends `track hidden` to the clip's accessible state string
(`Clip.tsx:155,196`). Removing only the button would strand those states: reachable, unclearable,
and unrecoverable for any project already saved with `visible: false` on an audio track. Making the
whole thing coherent — a kind guard in `toggleVisible`, normalisation at hydrate, suppressing the
badge on audio clips — is a timeline-slice design question with a keyboard-order and a11y
consequence, it is not needed to close the audio gap, and this document does not own it. If it is
wanted, it should be raised on its own.

Do not, in any case, make hiding silence an audio track. That would put monitoring and export back
into disagreement, which is the entire failure this document exists to prevent.

### 1.3 Where monitoring deliberately differs from the export graph

Every entry here is a divergence the implementer must preserve on purpose. Anything **not** on this
list must agree with EXPORT.md exactly. The list is complete: if a behaviour differs from the export
graph and is not here, it is a bug.

| # | Divergence | Why |
|---|---|---|
| 1 | **A fixed −6.02 dB monitoring reference** (`MONITOR_REFERENCE_GAIN = 0.5`). Export renders at unity. | §5. Relative balance is exact across the model's full `volume` range; only absolute level differs, by a constant. |
| 2 | **No encode-time conforming.** Export runs `aresample=48000:async=1:first_pts=0` and `aformat=…:channel_layouts=stereo` on every branch; monitoring runs neither. | Both are format plumbing that `amix` requires and the OS mixer does for free. Neither changes level, balance or timing. |
| 3 | **Speed uses `HTMLMediaElement.playbackRate`, not an `atempo` chain.** | The element's rate range is `[0.0625, 16]`, which contains the model's `speed` range `0.1..8` in one step. Export decomposes below `atempo`'s 0.5 floor (EXPORT.md §1.7); the *result* is the same time-stretch. |
| 4 | **Reverse shuttle is silent, and forward shuttle above 4× is silent.** | §4. There is no negative `playbackRate` in Chromium, and 8× carries no editorial information. Export has no shuttle at all, so there is nothing to disagree with. |
| 5 | **Scrubbing is silent.** | §4. Export has no scrub. |
| 6 | **At most `MAX_AUDIBLE_SOURCES = 8` clips are monitored simultaneously; the export mixes all of them.** | §7.3. A decoder-exhaustion guard. Unreachable at this build's track count — the real ceiling is `trackOrder.length` — and it announces itself when it fires. |
| 7 | **Monitoring does not represent the export's summing headroom.** | Export sums with `amix … normalize=0` at unity and can clip at the encoder. Monitoring sits 6 dB below that and therefore may not audibly clip where the file will. There are no meters in this build (§6), so this is stated and not mitigated. |
| 8 | **Master volume and master mute** (`PlaybackState.volume`, `PlaybackState.muted`) scale the monitored mix and have no counterpart anywhere in the export graph. | §5.1. They are a monitoring control, like the OS mixer. They multiply **every** voice by the same factor, so they change absolute level and never relative balance — which is what keeps acceptance test 2 valid at any master setting. |
| 9 | **A clip whose media is not `status: 'ready'`, or whose `url` is `''`, is silent.** | §1.1. ffmpeg opens an absolute path and does not have these states. `'error'` and `'not-found'` are explained on screen (§7.4), but **`'probing'` and `'renaming'` are silent with no audio-specific explanation** — the row already shows a spinner, which is the explanation, and a notice for a condition that resolves in under a second would be noise. This is the one row where silence is not separately announced. |
| 10 | **A clip whose `speed × \|rate\|` falls outside Chromium's `[0.0625, 16]` is silent rather than desynced.** | §4.4. Reachable at `speed 8 × rate 4`. Export has no shuttle, so at `rate 1` the reachable product is `0.1..8` and this never fires; it is a shuttle-only divergence. |

**There is no encode-time normalisation to model.** EXPORT.md §1.7 pins `normalize=0` and the graph
contains no `loudnorm`, no `dynaudnorm` and no limiter. So monitoring has nothing to compensate for
— and, symmetrically, **monitoring must never divide by the number of active sources.** That is the
exact bug `normalize=0` exists to prevent (an eight-clip timeline exporting at one-eighth volume);
reintroducing it on the monitoring side would make the preview quieter as the mix got busier, which
is the most misleading behaviour available.

---

## 2. The element model

### 2.1 The decision

**Pooled `HTMLAudioElement` pairs, one pair per track, mirroring `VideoSurface`'s two-`<video>`
pool. Not a WebAudio graph.**

The video pool already solves the hard version of this problem — `derivePool` in
`VideoSurface.tsx:74` keeps the *next* clip's source decoded in the idle slot so a cut swaps
`active` instead of reloading, and `parkIdle` seeks that slot to the incoming clip's `mediaIn` so
the cut lands on a decoded frame instead of black. The audio problem is the same problem: arbitrary
source in-points, cuts that must not gap, seeks that must not click. The brief is explicit — mirror
it, do not invent a second architecture — and it is right. §2.2 states precisely where the mirror
has to be *corrected* rather than copied.

**Why not WebAudio**, stated so it is not relitigated:

1. `AudioBufferSourceNode` scheduling is sample-accurate, which is genuinely better than anything an
   element can do — but it requires the whole file decoded into RAM. Ten minutes of 48 kHz stereo is
   ~230 MB as float32. An editor holds dozens of sources. Non-starter.
2. `decodeAudioData` takes a complete `ArrayBuffer` and does not stream. PLAN §1.4 registers
   `ve-media://` with `stream: true` **specifically** so a media element can issue Range requests
   and seek without downloading the file. WebAudio throws that property away.
3. `AudioBufferSourceNode` is one-shot: every seek means stopping a node and constructing another.
   A mid-playback scrub would allocate and discard a node per correction. Media elements seek.
4. It would be a second sync architecture standing beside the video pool, with a second set of
   failure modes, in the same directory.

The honest cost: element scheduling is millisecond-accurate, not sample-accurate. §3's tolerances
are written against that reality rather than around it.

**A minimal WebAudio gain stage was also considered and rejected**, because it does not survive its
own edge cases: attaching a `MediaElementAudioSourceNode` permanently reroutes an element's output
through the graph, so a lazily-attached gain node would silence a playing element at the moment it
attached, and an eagerly-attached one makes every source silent whenever the `AudioContext` is
suspended — which is exactly the `dev:web` autoplay case in §7.2. §5 gets the full `0..2` gain range
without it.

**This rejection is about the shipping path only.** A throwaway `AudioContext` +
`MediaElementAudioSourceNode` + `AnalyserNode` rig, constructed by hand in a dev session and
discarded with the page, is a legitimate *measuring instrument* and §10.3 specifies one. Nothing
that rig does ships, is imported by a component, or survives a reload.

### 2.2 How many elements exist, and how they recycle

**Two `<audio>` elements per track that contains at least one clip.** With the 41-clip / 6-track
fixture project that is **12 `<audio>` elements**, beside the 2 `<video>` elements the video pool
already holds. A track with no clips gets no voice at all; a track whose clips are all inaudible
still gets its pair, but both slots carry **no `src` attribute** and cost nothing.

One track can have at most one clip under the playhead — clips on a track cannot overlap
(`timelineSlice.ts:75`) — so one active slot plus one preload slot is exactly sufficient, and that
is why the pool is per track rather than global.

#### 2.2.1 The pool is keyed on the CLIP, not on the URL — and this is a correction

`derivePool` as it stands keys slots on URL alone (`VideoSurface.tsx:74-95`): the only thing that
moves `active` is `srcs[active] !== currentUrl`. **That is not sufficient for a cut, and the
sufficiency claim must not be carried over.** Two clips cut from the *same source file* on the same
track — a split take, a re-ordered interview, a J-cut assembled from one recording — have identical
URLs, so no swap happens, and the one element is left playing clip A's material past A's out point
while the timeline is inside clip B.

Picture survives this today only because `VideoSurface` catches it somewhere else: the effect at
`VideoSurface.tsx:234-240` lists `clipId` in its dependencies and calls `syncTime(true)`, a *forced*
`currentTime` write, in the render that commits the cut. A forced hard write is an acceptable
correction for a frame. For audio it is a click at every same-source cut, which is exactly what the
pool exists to avoid. So audio cannot lean on that fallback, and the fix belongs in the shared
function rather than in a second copy of it.

**The slot record gains a clip id, and both surfaces use it:**

```ts
interface Slot { url: string; clipId: ClipId | null; }
interface Pool { slots: [Slot, Slot]; active: 0 | 1; }

/**
 * Pure and idempotent, so it runs during render. `contiguous` is a caller-supplied hint
 * meaning "the incoming clip continues the outgoing one through the same source at the
 * same rate" — see `sourceContiguous` below. It can only ever SUPPRESS a swap, so a stale
 * hint costs at most one drift correction (§3.2) and never a wrong source position.
 */
function derivePool(prev: Pool, current: Slot, next: Slot, contiguous: boolean): Pool;
```

Three rules, in order:

1. **Nothing under the playhead** (`current.clipId === null`): `active` does not move. Same as
   today's `currentUrl === ''` guard.
2. **The active slot already holds this clip** (`slots[active].clipId === current.clipId`): nothing
   moves. This is the steady state, every frame that is not a cut.
3. **A cut.** If `contiguous`, **relabel the active slot** — `slots[active] = current` — and issue
   no element operation at all: the source-mapping invariant already puts the running element on
   exactly the right sample, so touching it would be strictly worse than leaving it alone. This is
   the `split` case and it must stay seamless. Otherwise, swap to the idle slot when it already
   holds `current.clipId`, and only load into the active slot when it does not.

The preload rule changes with it: the idle slot is loaded when
`next.clipId !== null && next.clipId !== slots[active].clipId && slots[idle].clipId !== next.clipId`.
Note that this **does** load the idle slot when `next.url === slots[active].url` — two elements
holding one file at two different positions is the whole point of the correction, and it is legal.

```ts
/** True when B continues A through the same source at the same rate. Exactly what `split` makes. */
function sourceContiguous(a: Clip | null, b: Clip | null): boolean {
  if (!a || !b || a.mediaId !== b.mediaId) return false;
  const speed = a.properties.speed || 1;
  if (speed !== (b.properties.speed || 1)) return false;
  if (b.start !== clipEnd(a)) return false;                       // adjacent on the timeline
  return b.mediaIn === a.mediaIn + Math.round((b.start - a.start) * speed);
}
```

The general form is required, not the `start - mediaIn` shorthand: at `speed !== 1` the offset
between timeline and source is not constant, and `timelineSlice.split` computes the new `mediaIn` as
`clip.mediaIn + Math.round(leftDuration * speed)` (`timelineSlice.ts:702`). The expression above is
that identity, read back.

`clipEnd` comes from `src/types/model.ts`, not from `timelineSlice` — it is a pure model helper, so
importing it keeps `audioMonitor.ts` free of any store dependency as §8.1 requires.

The outgoing clip is `prev.slots[prev.active].clipId`, read from the committed pool ref during
render. Reading it back out of the store during render is safe here for one reason and one reason
only: if the clip has been deleted the lookup yields `undefined`, `sourceContiguous` returns false,
and the pool swaps — the safe direction.

`derivePool` still returns `prev` **by identity** when nothing moved, so effect dependencies on the
pool stay stable. It still **must run during render**, for the same reason the original comment
gives: committing the swap from an effect leaves one committed render in which the clip is new and
the pool is old, which is a black frame for picture and a dropout for sound.

#### 2.2.2 Preload is bounded, because three pipelines per file is not free

An `<audio>` element pointed at an `.mp4` is not an audio-only decoder. Chromium builds the same
`WebMediaPlayer` it builds for `<video>` and demuxes the container it is given. So a naive
"every voice preloads its own track's next clip, unconditionally" costs, for one video file at a
cut, up to **three** live pipelines on the same bytes: the video pool's active slot, its idle slot,
and a voice slot on the same track. That is not "one idle decoder".

The cost is bounded by the `preload` attribute rather than by withholding `src`, and that choice is
deliberate. Withholding `src` would put the clock-clip ownership predicate into the *pool*, where
§2.2.1's rules would have to grow a fourth case and §2.3's "the predicate is applied at play time,
never at preload time" would stop being true. Demoting `preload` costs nothing structurally and
reaches the same place.

**A video-track voice's slots sit at `preload="metadata"`, and are promoted to `preload="auto"` only
when the slot holds a clip that is all three of:**

1. **audible** per §1.1,
2. **not the clock clip** (§2.3) — the clip on screen has its sound carried by the `<video>`, so a
   promoted voice slot would be a second full decode of the file the user is looking at, muted,
   for as long as it stays on screen, and
3. **within `PRELOAD_LEAD_IN_MS = 2000` of the playhead.**

**Audio-track voices use `preload="auto"` throughout.** An audio-only source is the cheap case, and
it is the case the whole feature exists for.

A demoted slot keeps its `src`. That matters twice over: it is what lets the promotion be a
one-attribute change rather than a reload when ownership flips (§2.3's seam), and it is why the
rename hazard below is real even for a slot that never plays.

**The number is measured, not asserted.** Before this ships, record resident memory and the
`chrome://media-internals` player count for the fixture project at rest and mid-playback, in §10.2,
the way EXPORT.md §1.8 records verified transcripts rather than estimates. If the measurement says
the branch on track kind was unnecessary, delete the branch and record *that*.

An earlier draft argued that "branching preload on track kind buys nothing and adds a case". That is
right when the cost is one idle decoder and wrong when it is three pipelines per file, which is what
it actually is. The case is bought — and it is bought in the one place, the `preload` attribute,
that does not disturb anything else in this document.

`parkIdle`'s audio equivalent seeks the idle slot to `framesToSeconds(nextClip.mediaIn, fps)` on
`loadedmetadata` and on every change of the preloaded clip, exactly as `VideoSurface.parkIdle`
does. Without it the first `play()` after a cut starts at source zero and blurts the wrong material.

**Open file handles are a rename hazard.** Twelve `<audio>` elements on `ve-media://` sources hold
OS handles, and RENAME.md's file-lock protocol releases handles by querying the DOM for `video`
only. §8.4 change 2 fixes that, and it is a blocker for shipping this: without it, renaming a file
any voice is holding — including one it merely *preloaded* — starts failing with `file-in-use`.

### 2.3 Who owns the clock clip's audio

**The clip returned by `selectVideoClipIdAtFrame(s, s.playhead)` is the *clock clip*. Its audio is
carried by the pooled `<video>` element and by nothing else. Every other audible clip gets a voice.**

Both sides compute that predicate from the same selector in the same render, so they cannot
disagree and no registry field is needed to arbitrate. A voice skips a clip when
`clip.id === selectVideoClipIdAtFrame(s, s.playhead)`, full stop.

The alternative — mute the video element always and give the clock clip its own `<audio>` — was
rejected. Lip sync between a picture and its own soundtrack is the most perceptible sync
relationship on the screen, and it is *free* when both come out of one element. Routing it through a
second element that then has to be drift-corrected back against the first, in order to avoid one
`if`, trades the thing that matters most for tidiness. It also doubles the decode of the file the
user is looking at.

**The seam this creates, stated rather than hidden.** Ownership of a video clip's sound moves
between its track's voice and the `<video>` element whenever the clip's clock-clip status changes:
when a clip on a higher track ends and this one becomes the picture, or when the user hides the
track above. That hand-off is a source change for the `<video>` element and involves a real
reposition, so it is audible as a short gap — tens of milliseconds, faded per §3.3 on the voice
side. It is not smoothable without the second decode that was just rejected. It happens at gaps in
the upper track and at visibility toggles, not at ordinary cuts, and both are moments the user is
already looking at a picture change.

This does mean `VideoSurface` becomes a gain consumer: its element must apply the **same** law as
every voice (§5), not the master volume alone as it does today. That is a real defect being fixed,
not new scope — a video clip set to `volume: 0` currently monitors at full level while exporting
silent.

### 2.4 Where the elements live

`AudioSurface` renders one `AudioTrackVoice` per id in `trackOrder`; each voice renders its two
`<audio>` elements. They carry no `controls` attribute, so Chromium's UA stylesheet gives them
`display: none` and they are neither visible nor focusable. The wrapper is `aria-hidden="true"` and
carries `data-track-id` so the CDP harness can address a specific voice; each element carries
`data-slot="0" | "1"`, which §10.1 depends on.

**No CSS is added.** `preview.css` does not change.

---

## 3. The sync contract

### 3.1 The reference clock

The video element is the clock (PLAN §8.4) and the playhead has one owner. The audio monitor reads
both and writes neither.

```ts
/** Continuous timeline position, in seconds. Read-only. Never rounded to a frame. */
function referenceSeconds(s: StoreState, el: HTMLVideoElement | null): number {
  const playheadSeconds = s.playhead / s.fps;
  const clipId = selectVideoClipIdAtFrame(s, s.playhead);
  const clip = clipId ? s.clips[clipId] : undefined;
  const media = clip ? s.items[clip.mediaId] : undefined;

  if (!el || el.paused || el.seeking || el.readyState < 2) return playheadSeconds;
  if (!clip || !media || media.status === 'error' || media.url === '') return playheadSeconds;
  if (el.getAttribute('src') !== media.url) return playheadSeconds;   // pool has not swapped yet
  // NOTE: this url test alone does NOT catch a same-source cut — both clips share a url.
  // What catches that is `activeVideoRef` being null until the pool has swapped, which holds
  // because §8.2 redefines VideoSurface's `playable` in terms of the slot's CLIP ID. If that
  // definition is ever weakened back to a url comparison, this guard silently stops working.

  const speed = clip.properties.speed || 1;
  const elementSeconds =
    clip.start / s.fps + (el.currentTime - clip.mediaIn / s.fps) / speed;   // PLAN §2.4, inverted

  // The SAME trust test usePlaybackClock applies, so both clocks agree on which one is live.
  // ONE-SIDED, exactly as there: an element that is BEHIND by more than the tolerance is not on
  // this clip's source position and must not be believed; an element that is AHEAD is simply
  // taken, because an element cannot run backwards and the picture clock will follow it too.
  const lagFrames = (elementSeconds - playheadSeconds) * s.fps;
  return lagFrames >= -ELEMENT_LAG_TOLERANCE_FRAMES ? elementSeconds : playheadSeconds;
}
```

The asymmetry is not an oversight and `Math.abs` here would be a bug. `usePlaybackClock.ts:133-134`
reads `fromElement >= s.playhead - ELEMENT_LAG_TOLERANCE_FRAMES` and its comment spends a paragraph
on why *ahead is a different case and is simply taken*. If the monitor rejected an element that ran
two frames ahead, `usePlaybackClock` would accept it and pull the playhead forward while the monitor
had already fallen back to the wall clock — producing the precise state this section claims cannot
exist: picture following the element, audio following the wall clock, the two pulling apart by
design.

Two branches, and the choice between them is not arbitrary:

- **Video element live.** Audio locks to the picture. `el.currentTime` is continuous, so the
  reference has no quantisation.
- **No trusted element** — a gap, an audio-only region, the reverse path, an element that has not
  arrived after a cut. The reference is `playhead / fps`, which in exactly these cases is what
  `usePlaybackClock`'s wall-clock integrator is producing. It is a staircase quantised to ±0.5
  frame — ±16.7 ms at the fixture project's 30 fps, ±20.8 ms at 23.976 — which is why §3.2's dead
  band is derived from `fps` rather than fixed.

`ELEMENT_LAG_TOLERANCE_FRAMES` is `usePlaybackClock`'s existing constant (currently module-private,
value `2`). It gains an `export` keyword and is imported here. **One number, one predicate, two
clocks.**

Note what is *not* here: the audio elements never influence the reference. Even in an audio-only
region where the sound card clock is arguably the better master, the playhead stays wall-clock
integrated and the audio is corrected toward it, because the alternative is writing the playhead
from an audio element. Typical crystal mismatch between the system timer and an audio device is
50–100 ppm, i.e. 3–6 ms of drift per minute, which sits under §3.2's dead band for the first several
minutes and is then closed by a trim the user cannot hear.

### 3.2 Measuring and correcting drift

Per voice, per playhead tick:

```ts
const speed = clip.properties.speed || 1;
const elementSeconds = clip.start / fps + (el.currentTime - clip.mediaIn / fps) / speed;
const drift = referenceSeconds - elementSeconds;   // POSITIVE = element is BEHIND
```

Three bands. The band boundaries and the correction shape are the whole point of this section: a
hard `currentTime` write every frame clicks, and a hard write is also the only correction available
that is instantaneous, so the design has to earn the right to almost never use one.

| Band | Action |
|---|---|
| `\|drift\| < deadBandMs` | **Nothing.** `el.playbackRate` returns to its base value if it was trimmed. |
| `deadBandMs ≤ \|drift\| ≤ DRIFT_HARD_SEEK_MS` (120 ms) | **Playback-rate trim.** `base × (1 + clamp(drift / 1.0, ±DRIFT_TRIM_MAX))`, then clamped into `[PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX]`. |
| `\|drift\| > 120 ms` | **Hard `currentTime` write**, faded (§3.3). Rate-limited to one per `HARD_SEEK_MIN_INTERVAL_MS` (500 ms) per element, unless §3.4 has declared an external seek. |

#### The dead band is derived from `fps`, not fixed

```ts
const deadBandMs = Math.max(DRIFT_DEAD_BAND_FLOOR_MS, 750 / fps);   // 0.75 of a frame
```

A fixed 12 ms is wrong at every frame rate this app supports except 60. The fallback reference in
§3.1 is `playhead / fps`, a staircase quantised to ±0.5 frame: ±16.7 ms at 30 fps, ±20 ms at 25,
±20.8 ms at 23.976. A dead band narrower than the quantisation that produces the measurement means
the controller is driven by its own sampling noise — and it is driven hardest in exactly the case
the fallback branch exists for, an audio-only region, where nothing is wrong. On the dev fixtures,
which are sustained pure tones, a continuously jittering ±2 % trim is audible as a wobble on the
signals §10 uses to verify the feature. `750 / fps` is 0.75 of a frame, always strictly wider than
the ±0.5-frame staircase, and the `DRIFT_DEAD_BAND_FLOOR_MS = 12` floor keeps it above the
few-millisecond reporting noise on `el.currentTime` at high frame rates. At 30 fps the dead band is
25 ms; at 60 fps it is the 12 ms floor.

#### The controller is fed a median, not raw samples

Drift is **measured** on every playhead tick (two float reads per voice — cheap) and the samples are
kept in a small per-element ring. A **correction** is issued at most every `DRIFT_CHECK_INTERVAL_MS`
(250 ms) per element, and it acts on the **median of the samples collected since the last
correction** — roughly 7 samples at 30 fps, roughly 15 at 60. The median, not the mean: one sample
taken across a decode hiccup is an outlier of tens of milliseconds and a mean carries it into the
correction, while a median discards it for free at this sample count. Median of a ±16.7 ms staircase
over 7 samples lands inside about ±6 ms, which is comfortably inside the 25 ms dead band — so a
correctly-tracking element in an audio-only region issues **no correction at all**, which is the
behaviour being bought.

#### The rest of the numbers, each with its reason

- **±2 % rate trim** (≈ ±35 cents), `DRIFT_TRIM_MAX = 0.02`. A semitone is 5.9 %; 2 % is inaudible
  as pitch on speech, on music with any width, and on noise. It **is** faintly audible as a slow
  bend on a sustained pure tone, which is what the dev fixtures are — that is a property of the test
  signal, not a defect, and it is worth knowing before someone files it as one.
- **1.0 s correction window**, `DRIFT_TRIM_WINDOW_MS = 1000`. Two regimes, and the earlier draft's
  arithmetic described neither correctly:
  - **Below `DRIFT_TRIM_MAX × window` = 20 ms of error** the trim is proportional, so the error
    decays exponentially with a **time constant of 1.0 s**: 63 % gone in 1 s, 95 % in 3 s. It never
    "closes"; it decays.
  - **Above 20 ms** the trim saturates at ±2 % and the error closes **linearly at 20 ms per second**.
    At 30 fps the dead band is 25 ms, so the *entire* trim band (25–120 ms) is in the saturated
    regime and the correction is linear throughout: worst case, 120 ms down to 25 ms takes 4.75 s.
    The exponential regime only exists at frame rates high enough for the dead band to fall below
    20 ms, i.e. 60 fps.
  - Either way the correction completes far below the interval at which a user re-evaluates a mix,
    and it never overshoots into oscillation: it approaches the dead band edge and stops.
- **120 ms hard-seek threshold**, `DRIFT_HARD_SEEK_MS`. Above this, the element is not "drifting", it
  is *somewhere else* — a seek that missed, a decoder stall, a source that refused to seek, or an
  external jump. There is no correction that closes 120 ms gracefully, so stop pretending and move
  it. Note this is a threshold and not a trimmed value: the largest error the trim ever sees is just
  under 120 ms.
- **500 ms hard-seek rate limit**, `HARD_SEEK_MIN_INTERVAL_MS`. A source that needs continuous hard
  seeks is broken, not drifting, and hammering `currentTime` on it starves every other decoder.
  §7.4 turns repeated hard seeks into a verdict.

No correction of any kind is issued within `START_SETTLE_MS` (300 ms) of an element's `play()`.
`play()` resolves asynchronously and elements do not all start on the same tick; correcting inside
that window hard-seeks a healthy element that was merely still spinning up. The drift ring is
cleared when the settle window **expires**, so the first correction afterwards is computed only from
samples taken after the element was up.

### 3.3 A hard seek is faded — and the gain pass is the only writer of `volume`

The fade and the per-tick gain pass (§5.1) write the same property, so one of them has to be in
charge. **The gain pass is.** A design in which the fade sets `el.volume = 0` directly and the gain
pass independently writes `el.volume = g` every tick does not work: `seeked` on a local file lands
20–60 ms after the `currentTime` write, the next playhead tick lands in 16–33 ms, so the gain pass
restores full volume one or two ticks *before* the new samples arrive. That is precisely the
discontinuity the fade exists to hide, on every hard seek, and §3.4 routes every external seek
through the same path — so a timecode entry during playback would click on all six voices at once.

So: one writer, and a piece of per-element state it respects.

```ts
/** THE only place `el.volume`, `el.muted`, `el.playbackRate` and `el.preservesPitch` are written. */
function writeElement(el: HTMLMediaElement, v: VoiceState, want: Desired): void {
  const volume = v.fadeUntilSeeked ? 0 : want.gain;         // §5.1 computes `want.gain`
  if (v.wrote.volume !== volume) { el.volume = volume; v.wrote.volume = volume; }
  const muted = volume === 0;
  if (v.wrote.muted !== muted) { el.muted = muted; v.wrote.muted = muted; }
  if (v.wrote.rate !== want.rate) { el.playbackRate = want.rate; v.wrote.rate = want.rate; }
  if (v.wrote.pitch !== want.pitch) { el.preservesPitch = want.pitch; v.wrote.pitch = want.pitch; }
}
```

A hard seek is then three steps, in this order:

```
v.fadeUntilSeeked = true;
writeElement(el, v, desired);          // volume is now 0, BEFORE the seek — this is the fade
el.currentTime = target;
```

and the flag is cleared, followed by another `writeElement`, in **two** places:

1. The element's own `seeked` handler. This is the normal path, and it is what keeps the restore
   from landing before the new samples do.
2. A **`FADE_RESTORE_BACKSTOP_MS = 200` timer**, armed with the flag and cancelled by the `seeked`
   handler. `seeked` is not guaranteed: a `src` change, an `error`, a decoder stall or a `load()`
   between the write and the event will swallow it, and without the backstop that voice is silent
   for the rest of the session with no recovery path — §7.4's non-tracking detector mutes, it never
   unmutes. A stuck-silent voice is the worst failure this feature can have, because it is exactly
   the "hearing one thing, shipping another" bug the document exists to prevent, arriving through
   the machinery meant to prevent it.

Chromium de-zippers volume changes with a short internal ramp, so this is a fade of a few
milliseconds and not a gate. The resulting hole is 20–60 ms of silence, which is unnoticeable
against material and strictly better than the click a discontinuity in the sample stream produces.

**The write cache is not an optimisation, it is the reason this is allowed in the tick.** Six voices
plus the `<video>`, four properties each, is 28 DOM property writes per frame, most of them setting
a value to what it already holds — and `volume` and `playbackRate` are not free setters, they reach
the audio renderer. Caching the last written value per element and skipping the unchanged write
reduces the steady state to zero writes per tick.

### 3.4 External seeks are detected from the PLAYHEAD, not from the reference

The reference can jump: a timecode entry, a click on the ruler, `nav.start`, a keyboard shortcut.
It can also jump for a reason that is not a seek at all — §3.1's reference **switches branches**
between continuous `elementSeconds` and staircase `playheadSeconds` whenever the video element
crosses the trust boundary, pauses, seeks, drops below `readyState 2`, or has not yet swapped `src`
at a cut. A branch flip is a step discontinuity of up to the trust tolerance, it happens at every cut
and every decode hiccup, and a detector that compares the reference against its own previous sample
cannot tell it from a real timecode entry. It would fire the full external-seek path — faded hard
write on every voice, rate limit bypassed, dead band bypassed, settle window restarted — several
times a minute during ordinary playback.

**So the detector never looks at the reference.** The store already distinguishes the two, and
`usePlaybackClock` uses precisely this signal:

```ts
// First statement in the playhead subscription, before anything reads the reference.
const now = performance.now();
const elapsedFrames = ((now - lastTickMs) / 1000) * s.fps * Math.abs(s.rate);
const delta = s.playhead - lastPlayheadFrame;

const jumped =
  s.isPlaying && s.rate > 0
    ? delta < 0 || delta > elapsedFrames + EXTERNAL_SEEK_SLACK_FRAMES
    : false;   // paused: §4.3's throttled silent reposition already covers every case

lastTickMs = now;
lastPlayheadFrame = s.playhead;
```

Three things make this correct where the reference-based test was not:

- It is measured against **elapsed wall time**, so it scales with the shuttle rate and with a long
  frame automatically. No per-rate multiplier and no hand-tuned threshold per shuttle rung.
- **Backwards is always a jump** during forward playback. `usePlaybackClock` guarantees the playhead
  is monotonic while `rate > 0` (`next = Math.max(…, s.playhead)`), so any retreat is external by
  construction.
- `EXTERNAL_SEEK_SLACK_FRAMES = 4` is **not** `ELEMENT_LAG_TOLERANCE_FRAMES`. Giving both constants
  the value 2 was what let a branch flip reach the detection threshold. They measure different
  things and they are now separate: one is how far an element may lag and still be believed, the
  other is how far the playhead may move in one tick beyond what elapsed time explains.

The monitor never writes the playhead, so it needs no equivalent of `usePlaybackClock`'s
`selfWriting` flag. `lastTickMs` and `lastPlayheadFrame` are re-seeded from the current state on
every `isPlaying` and `rate` transition, so a start or a shuttle change never reads as a jump.

On a jump: every voice repositions immediately by the §3.3 faded write, the 500 ms rate limit is
bypassed, the dead band does not apply, the drift ring is cleared and `START_SETTLE_MS` restarts.
This is the same code path as a stalled element — deliberately, because "the element is not where
the reference is" has one remedy regardless of which side moved.

---

## 4. Transport behaviour

The monitor is a pure function of `(isPlaying, rate, playhead, timeline, media)`. It adds **no
state to the store** and requires none — in particular there is deliberately **no `isScrubbing`
flag**, and none may be added. Every behaviour below falls out of the rules already stated.

| Transport action | Audio |
|---|---|
| **play** | Position every audible voice by a faded write, *then* `el.play()`. Suppress correction for `START_SETTLE_MS`. |
| **pause** | `el.pause()` on every element. **No seek** — elements stay parked so the next `play()` is instant. |
| **seek while paused** | Silent reposition, throttled — see §4.3. |
| **seek while playing** | §3.4. The faded write, on every voice, immediately. |
| **step by frame** (`step()`) | **Silent.** `playbackSlice.step` pauses first (its documented contract), so this is the paused case. One frame is 33 ms of audio: playing it is a click, not information. |
| **J/K/L forward at 1×, 2×, 4×** | **Audible**, at the rate §4.4 defines. |
| **J/K/L forward at 8×** | **Silent.** All voices pause and the `<video>` element mutes. |
| **K (stop)** | Pause. Silent. |
| **J (reverse), any rate** | **Silent.** All elements pause. |
| **Scrubbing** (ruler drag, playhead marker drag, momentum) | **Silent.** |

### 4.1 Reverse plays nothing, stated plainly

`HTMLMediaElement.playbackRate` refuses negative values in Chromium. There is no element-driven
reverse and this design does not pretend otherwise — PLAN §8.4 already establishes that for picture,
where reverse is an honest rate-limited seek scrub. Applying the same trick to audio produces a
stutter of short *forward* fragments played in descending order, which is not "backwards": it is a
granular artefact with the attack transients in the wrong place. It would be worse than silence and
would be reported as a bug.

So: when `rate < 0`, every audio element **pauses** (not merely mutes — a paused element does no
decoder work, and reverse is already the most expensive path in the app). Audio re-engages on the
next forward start.

### 4.2 8× is silent, and why 4× is not

At 4×, one second of timeline passes in 250 ms and speech is still recognisable as speech —
recognisably enough to locate a word, which is the whole reason to shuttle with sound. At 8× it is
125 ms and the result is a chirp: it carries no editorial information and is genuinely unpleasant
over a long shuttle. `SHUTTLE_AUDIBLE_MAX_RATE = 4`. `SHUTTLE_RATES` is `[1, 2, 4, 8]`
(`playbackSlice.ts:93`), so this draws the line at the last rung and nowhere subtler.

The rule is expressed once, in §5.1's gain law, as `transportSilent`. That is what makes it apply to
the `<video>` element as well as to the voices without a second code path — and the `<video>` must
**mute**, not pause, because the picture keeps shuttling. §8.2 lists this as a change to
`VideoSurface`, because it is one: the element carries full sound at 8× today.

`el.preservesPitch` is part of the same per-tick write (§3.3):

```ts
want.pitch = Math.abs(s.rate) === 1;
```

At normal speed, clip `speed` is applied **pitch-preserved**, matching export's `atempo` chain
(EXPORT.md §1.7). While shuttling, pitch preservation is off — a shuttle is a locating gesture, not
a render, tape-style pitch rise is the NLE convention users expect from it, and a time-stretcher run
at 4× on top of a clip speed produces artefacts that a pitch shift does not. `preservesPitch`
changes only at a shuttle transition, which is already a discontinuity, so the change cannot click
into the middle of anything.

### 4.3 Scrubbing is silent, and it needs no code

Scrub audio done properly is a windowed grain stream resampled against pointer velocity — the
full-decode WebAudio territory §2.1 rejected on memory grounds. The only thing an element can do is
seek repeatedly, which produces clicks and repeated attack transients, and an artefact is worse than
nothing. Silence is the answer, and PRODUCT.md's "composure" is the reason to be comfortable with
it.

**It re-engages on the next `play()`, never on pointer-up and never during the gesture.** No
scrub-specific code exists: a scrub gesture never sets `isPlaying`, and voices only run while
`isPlaying && rate > 0`, so this falls out of one rule. That is exactly why no `isScrubbing` state
is needed — and adding one would put a monitoring concern into a slice the preview does not own.

While paused (scrub, step, idle), voices still **reposition silently**, throttled to
`IDLE_REPOSITION_INTERVAL_MS = 120` with a trailing call, so the next `play()` starts on the right
sample instead of seeking first. This is the audio counterpart of `parkIdle`: prefetch, not
playback. Unthrottled it would be 60 `currentTime` writes per second per voice during a scrub, which
is decoder thrash for no audible benefit.

### 4.4 A rate the element cannot honour is a silent voice, not a desynced one

`el.playbackRate` must be `speed × |rate|`, and that product is **not** guaranteed to be legal.
`ClipProperties.speed` reaches 8 (EXPORT.md §1.7, `src/types/model.ts`) and `SHUTTLE_RATES` reaches
8, so the product reaches 64 against Chromium's `[0.0625, 16]`. Even excluding 8× shuttle, which
§4.2 already silences, `speed 8 × rate 4 = 32` is reachable and illegal.

`VideoSurface` already clamps (`VideoSurface.tsx:258-261`). If a voice clamped the same way, the
audio would advance at half the timeline rate while the picture ran at the timeline rate; drift
would grow at ~500 ms per second, §3.2 would hard-seek every 500 ms forever, §7.4 would declare the
element non-tracking within 3 seconds, and the user would get an "Audio dropped" notice about a clip
that is not broken. So:

```ts
const base = speed * Math.abs(rate);
if (base < PLAYBACK_RATE_MIN || base > PLAYBACK_RATE_MAX) {
  // Out of the element's range. Pause the voice; do not clamp and do not report.
  // Divergence 10 in §1.3. It is a shuttle artefact, it ends when the shuttle ends,
  // and a notice for it would be noise on a normal gesture.
}
want.rate = clamp(base * (1 + trim), PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX);
```

The check is on `base`, before the drift trim, and the clamp afterwards is a guard for the ±2 % the
trim can add at the top of the range (`16 × 1.02` is out of range and must not throw). The
`<video>` element keeps its existing clamp: picture at a clamped rate is a visible speed error the
user can see and correct, whereas audio at a clamped rate is a silent desync they cannot.

`PLAYBACK_RATE_MIN` and `PLAYBACK_RATE_MAX` are declared once, in `audioMonitor.ts`, and imported by
`VideoSurface` — the same move `derivePool` makes (§8.1). Two copies of a range that must agree is
how they stop agreeing.

---

## 5. Gain — per clip, per track, master

### 5.1 The law

One expression, applied identically to every `<audio>` voice **and** to the active `<video>`
element:

```ts
export function effectiveGain(
  clipVolume: number,     // ClipProperties.volume, 0..2
  trackMuted: boolean,
  masterVolume: number,   // PlaybackState.volume, 0..1   — monitoring only, §1.3 row 8
  masterMuted: boolean,   // PlaybackState.muted          — monitoring only, §1.3 row 8
  transportSilent: boolean, // |rate| > SHUTTLE_AUDIBLE_MAX_RATE, or rate <= 0 — §4.2
): number {
  if (trackMuted || masterMuted || transportSilent) return 0;
  return Math.min(1, Math.max(0, MONITOR_REFERENCE_GAIN * masterVolume * clipVolume));
}
```

The result is `want.gain`, and it reaches the element **only** through `writeElement` (§3.3), which
is the single writer and which overrides it with 0 while a fade is in flight. `el.muted` follows
`volume === 0` — a muted element does no mixing work — and the idle pool slot is always gain 0
regardless of everything above, exactly as `VideoSurface` already does.

Master volume and master mute are the two terms with no counterpart in the export graph. They are
listed as divergence 8 in §1.3 and they are safe there for a specific reason: they multiply every
voice by the same scalar, so they move absolute level and cannot move relative balance. Acceptance
test 2 is valid at any master setting because of that property, not by accident.

### 5.2 `MONITOR_REFERENCE_GAIN = 0.5`, and the 0..1 problem

`HTMLMediaElement.volume` is `0..1`. `ClipProperties.volume` is `0..2` and the export honours the
whole range as a real linear gain (`volume=<v>` in EXPORT.md §1.7). Clamping at 1.0 would mean a
clip boosted to 2.0 monitors identically to one at 1.0 and then ships 6 dB louder — the exact class
of failure this document exists to prevent.

**Resolution: unity is 0.5, not 1.0.** There is no requirement that model unity map to element
unity. With a fixed reference of 0.5, the model's full `0..2` range maps onto the element's `0..1`
range with **no clamping anywhere in the reachable domain** and with relative balance preserved
exactly — which is the thing the user is actually judging when they set clip volumes.

The reference buys three things, not one:

1. Headroom for `clip.volume` up to 2.0, without a branch.
2. Headroom for the **sum**. Export sums with `normalize=0`, so overlapping clips get louder;
   monitoring sums at the device, where several elements each near 1.0 clip the output. −6 dB is two
   unity sources' worth of room.
3. A single tunable number in a single file if it ever needs to move.

What it costs: monitoring is 6 dB quieter than the exported file in absolute terms. That is what the
transport's master volume and the OS mixer are for, and it is listed as divergence 1 in §1.3.

**The clamp is a guard, not a behaviour.** If `ClipProperties.volume`'s ceiling is ever raised above
2, either `MONITOR_REFERENCE_GAIN` drops or clamping begins — and the check belongs on this one line
rather than spread across call sites. State the assertion in the implementation:
`MONITOR_REFERENCE_GAIN * CLIP_VOLUME_MAX <= 1`. Note that `masterVolume ≤ 1` is what keeps the
product inside the domain; if the master ever gains boost above unity, this assertion changes too.

### 5.3 What changes in `VideoSurface`

Today (`VideoSurface.tsx:269-275`):

```ts
el.volume = volume;                              // master only
el.muted = muted || index !== pool.active;
```

This ignores `clip.properties.volume` and `track.muted` entirely, so a video clip muted at the clip
or the track monitors at full and exports silent. It becomes a call to `effectiveGain` with the
clock clip's volume, its track's `muted`, and the `transportSilent` term that carries §4.2's 8×
rule, plus `el.preservesPitch` per §4.2. One effect, roughly twenty lines.

---

## 6. The UI surface

**Nothing new is added. No component, no token, no icon, no accent.**

PRODUCT.md principle 2 puts a full mixer out of scope, and the accent budget is closed at six uses
(PLAN §7.4). The complete user-facing surface for this feature already exists and, until now, has
been partly lying:

| Control | Where | Accessible name | What changes |
|---|---|---|---|
| Master mute | `Transport.tsx`, ghost `IconButton`, `Volume2` / `VolumeX`, `pressed={muted}`, **no** `accentWhenPressed` | `Mute preview` / `Unmute preview` | Nothing. The label was always written as *preview*, not *clip* — it becomes true for the first time, because it now silences the whole mix rather than one `<video>`. |
| Per-track mute | `TrackHead.tsx`, `pressed`, `accentWhenPressed` (accent use 5) | `Mute track A1` / `Unmute track A1` | Nothing. It already drives export; it now drives monitoring, which is what makes it honest. |
| Per-clip volume | Inspector, `ClipPropertyRow`, drag-scrub numeric | existing | Nothing. |

Consequences of "nothing new", stated so they are choices rather than omissions:

- **No meters.** A meter is a permanently-resident advanced control on the calmest surface in the
  app, and it would need real peak data the element API does not expose without WebAudio. Divergence
  7 in §1.3 is the price and is accepted.
- **No solo.** `Track` has no `soloed` field. Adding one would need a model change, an export-graph
  change, and a seventh accent use. Out of scope; report it if it is wanted.
- **No per-track fader.** `track.muted` is binary in the model and in the export graph. A monitoring
  fader that the export ignored would be the divergence this document forbids.
- **No "audio is playing" indicator.** The frame is the product; a blinking element at rest violates
  PRODUCT.md's sustained-session rule.
- **All seven states** is a requirement on interactive components. This feature ships none, so it
  inherits the states of the three controls above unchanged.

Failure states surface through the **existing** channels only: the `Notice` strip via
`setNotice(…)` (one at a time, never stacked), the media rail's `Unplug` + `Offline` row treatment,
and the offline texture on the clip. Exact strings are in §7.

---

## 7. Failure modes

Each of these has defined behaviour. None of them is "silently no sound".

### 7.1 A source that fails to load

Mirror `VideoSurface.handleMediaError` exactly — same four `MediaError` codes, same
`TRANSIENT_RELOAD_ATTEMPTS = 2` per source URL, same clearing of the attempt count on
`loadedmetadata`:

| `el.error.code` | Behaviour |
|---|---|
| `MEDIA_ERR_ABORTED` (1) | Ignore. It is us — `removeAttribute('src') + load()` is the rename protocol's own step. |
| `MEDIA_ERR_NETWORK` (2) | Transient. Reload, up to 2 attempts. Then verdict `not-found`: `<name> could not be read from disk`. |
| `MEDIA_ERR_DECODE` (3) | Transient. Reload, up to 2 attempts. Then verdict `unsupported-codec`: `<name> could not be decoded`. |
| `MEDIA_ERR_SRC_NOT_SUPPORTED` (4) | Verdict immediately, `unsupported-codec`. |

An error on an **idle** (preloading) slot never condemns anything: one quiet reload so the next cut
still lands cleanly, and nothing else.

A verdict writes `updateItem(id, { status: 'error', error })` — which fires the media-rail row
treatment and the offline clip texture automatically — and one `setNotice({ tone: 'danger', title:
'Cannot play audio', message })`. Before condemning, check `item.status === 'error'` and return if
it is already set; that is what stops the video pool and an audio voice from double-reporting the
same file.

These two writes run from the element's own `error` event, which is genuinely asynchronous and not
inside the playhead notification pass, so they are written directly. They are the **only** store
writes in this document that are. Everything else defers — §7.5.

**Two deliberate differences from the video path:**

1. **An audio failure never calls `pause()`.** `VideoSurface` pauses playback on a picture verdict,
   correctly — the frame is the product and there is nothing to look at. Sound failing on one of six
   tracks is not a reason to stop the edit.
2. The notice title is `Cannot play audio`, not `Cannot play clip`, so two simultaneous failures on
   the same file are distinguishable in the strip.

### 7.2 An element that will not start (autoplay policy)

Electron imposes no autoplay restriction. **`npm run dev:web` does** — Chrome blocks media with
audio until the document has had a user gesture.

**There is no priming step.** An earlier draft called `play()` then `pause()` on "every pooled
element" on the first gesture. That is wrong twice over. The `<video>` pool's two elements are
pooled elements: priming would start and stop the **active** one while the preview is paused, moving
its `currentTime` by the round-trip duration with nothing to correct it (`VideoSurface.syncTime`
only runs from a playhead subscription, and the playhead did not move), and it would start and stop
the **idle** one, knocking it off the `mediaIn` position `parkIdle` seeked it to — which is the
entire mechanism preventing a black frame at the next cut (`VideoSurface.tsx:277-294`). The user's
first click anywhere in the window would degrade verified video playback. And `play()` on a src-less
element rejects with `NotSupportedError` and grants nothing anyway.

It is also unnecessary. Chromium's autoplay gate is **sticky per-document user activation**, not
per-element: once any real `pointerdown` or `keydown` has reached the document, later programmatic
`play()` calls are permitted for the document's lifetime. Starting playback requires the user to
press Space or click the transport, so the activation is always already there by the time the first
voice starts. The blocked case is a genuine edge — a `play()` racing the very first gesture, or a
policy stricter than expected — and it is handled by recovery rather than by prevention.

The protocol:

1. **A `play()` rejecting with `NotAllowedError`** sets `blocked = true` and defers one
   `setNotice({ tone: 'warning', title: 'Audio blocked', message: 'Click in the window to enable
   preview audio' })` (§7.5). While `blocked` is true, no voice attempts `play()`.
2. **`blocked` is cleared by the events that actually change the browser's answer**, never by a
   successful start — a flag that suppresses the only code that could produce a success can never be
   cleared by one, and the earlier draft's rule deadlocked exactly there: the notice told the user to
   click, and clicking did nothing, and audio was dead for the session. It is cleared by either:
   - a `pointerdown` or `keydown` reaching the document, or
   - an `isPlaying` false→true transition.
3. On clearing, starts are re-attempted **once**. If `play()` rejects again, `blocked` returns to
   true and no new notice is emitted until a playback run has succeeded in between. **Never retry in
   a loop** — a rejected `play()` inside a 60 Hz subscription is an unbounded promise storm.
4. The document listener is **one named handler registered for both `pointerdown` and `keydown`**,
   with `{ capture: true }` and **without `once`**, removed explicitly for both event types on
   unmount. `{ once: true }` is wrong here twice: it removes only the listener that fired, leaving
   the other registered for the page's lifetime, and this listener must persist anyway because it is
   the re-arming mechanism in rule 2.

Any other rejection (`AbortError` from a `pause()` racing a `play()`) is swallowed; the element's
own `error` event owns reporting, so there is exactly one path to the user.

### 7.3 Too many simultaneous elements

Chromium exposes no element limit; the practical failure is decoder exhaustion, which surfaces as
`MEDIA_ERR_DECODE` on load or an element that never reaches `readyState >= 2`. So the monitor caps
itself rather than discovering the ceiling:

**`MAX_AUDIBLE_SOURCES = 8` concurrently *playing* elements**, the `<video>` counting as one.
Priority, applied every time the audible set changes:

1. The clock clip (always — it is the picture's own sound).
2. Audio-track clips, in `trackOrder` order.
3. Remaining video-track clips, in `trackOrder` order.

Anything past 8 is paused, not merely muted. When the cap first bites in a playback run, defer one
`setNotice({ tone: 'warning', title: 'Audio limited', message: 'Only 8 clips are monitored at once,
but the export mixes all of them' })` — once per run, not once per tick, and through §7.5. The
message names the divergence, because a silent cap is precisely the "hearing one thing, shipping
another" failure.

**The real ceiling is `trackOrder.length`, not 8.** Clips on a track cannot overlap
(`timelineSlice.ts:75`), so at most one clip per track sits under the playhead, so the audible set
can never exceed the track count — 6 in this build. The cap is therefore unreachable and is a guard
against a future track count, written down so that when it fires it is legible rather than
mysterious.

Total *allocated* elements are bounded separately and are the number that actually matters today:
voices exist only for tracks with at least one clip, at two elements each, with the video-track
preload restrictions of §2.2.2 on top. §10.2 records the measured figure.

### 7.4 A track whose media is offline, and an element that stops tracking

**Offline media** (`status === 'error'`, or `url === ''`) fails `monitorAudible` in §1.1. No element
is allocated, no `src` is set, no error is raised, and nothing is reported — because it is
**already** reported, on screen, by machinery that exists: the clip carries `--texture-offline` plus
a `--status-danger` border, and the media rail row carries `Unplug` + the word `Offline`. That is
icon, word and colour, in that order, per DESIGN.md's Icon Tax Rule. Silence there is explained, so
adding a second announcement would be noise. **`status === 'probing'` and `status === 'renaming'`
are silent on the same basis but with a weaker explanation** — a spinner on the row, and no mention
of sound. Both resolve in under a second, which is why no notice is added; it is recorded as
divergence 9 in §1.3 rather than left implicit.

**Non-tracking** is the other half, and it is the case that would otherwise be silent-and-unexplained.
An element is declared non-tracking when either:

- it needed more than `NON_TRACKING_SEEKS = 3` hard seeks within `NON_TRACKING_WINDOW_MS = 3000`, or
- its `readyState` stayed below 2 for more than `STALL_MUTE_MS = 1000` while `isPlaying`.

Behaviour: the element is **muted** through `writeElement` (so it cannot blurt out of position when
it recovers) but left running, and one `setNotice({ tone: 'warning', title: 'Audio dropped',
message: '<clip name> is not keeping up and has been muted' })` is deferred per §7.5, once per
element per playback run. Recovery is automatic: when the element sits inside the dead band for a
continuous second, the flag clears and the gain is restored on the next tick.

A brief underrun on first play is **not** non-tracking — that is what `START_SETTLE_MS` is for. A
voice muted by a `fadeUntilSeeked` flag is not non-tracking either; the §3.3 backstop owns that, and
the two mechanisms must not be allowed to hold the same element silent for different reasons without
either one being able to release it.

### 7.5 Store writes are deferred out of the tick — a rule, not a style preference

**No path that runs inside the playhead subscription may call a store action.** zustand runs
`subscribeWithSelector` listeners synchronously inside `set` (`store.ts:17`), and the playhead
subscription runs inside `s.seek(next)`, inside the one rAF tick. A `setNotice` from there is a
nested `setState` during listener notification: listeners still queued for the outer notification
then run against the outer pass's captured state, and their cached slice is updated from that stale
value, which can silently swallow the next genuine change. The listeners at risk are the ones
verified playback depends on — `usePlaybackClock`'s own playhead re-anchor and
`VideoSurface.syncTime`. `usePlaybackClock.ts:56-67` documents this exact class of bug and what it
looks like when it bites (integrated playback running at roughly double speed).

So the monitor keeps plain refs and flushes them after the notification pass:

```ts
if (pending.notice !== null && !pending.flushing) {
  pending.flushing = true;
  queueMicrotask(() => {
    const notice = pending.notice;
    pending.notice = null;
    pending.flushing = false;
    if (notice) readStore().setNotice(notice);
  });
}
```

This applies to §7.2's `Audio blocked`, §7.3's `Audio limited` and §7.4's `Audio dropped`. It does
not apply to §7.1, whose writes come from element `error` events and are already outside the pass.

This is the operational meaning of "the monitor adds no state to the store": it adds no fields, it
calls no transport action, and the three notices it can raise are the only store writes it makes —
all of them deferred, all of them at most once per playback run.

---

## 8. File ownership

Owner for all of the below: **preview**. Nobody creates, edits or deletes a file outside their own
list (PLAN §0).

### 8.1 New files

| File | Contents |
|---|---|
| `src/components/preview/audioMonitor.ts` | Every constant in this document, plus the pure functions: `effectiveGain`, `monitorAudible`, `elementTimelineSeconds`, `driftSeconds`, `sourceContiguous`, and `derivePool` **moved here from `VideoSurface.tsx`** with the clip-keyed signature of §2.2.1, so one pool implementation serves both. Also `PLAYBACK_RATE_MIN` / `PLAYBACK_RATE_MAX`, moved from `VideoSurface.tsx` for the same reason (§4.4). No React, no store import. |
| `src/components/preview/AudioSurface.tsx` | Renders one `AudioTrackVoice` per id in `trackOrder`, inside an `aria-hidden` wrapper. Subscribes to `trackOrder` only. |
| `src/components/preview/AudioTrackVoice.tsx` | One track's pooled pair. Subscribes to its own two `ClipId \| null` selectors, runs `derivePool` during render, renders two `<audio>` with `data-slot`, publishes both elements into the registry ref in a `useLayoutEffect`. Owns `parkIdle`, the `seeked` handler and its backstop timer (§3.3), and the `error` / `loadedmetadata` handlers for its slots. |
| `src/components/preview/useAudioMonitor.ts` | The engine. One `useEditorStore.subscribe(s => s.playhead, …)` plus subscriptions to `isPlaying` and `rate`. Owns the reference clock (§3.1), `writeElement` and the gain pass (§3.3, §5), the drift pass (§3.2), the external-seek detector (§3.4), the source cap (§7.3), the autoplay recovery listener (§7.2) and the deferred-notice flush (§7.5). **Contains no `requestAnimationFrame`.** |

### 8.2 Existing files that change

| File | Change |
|---|---|
| `src/components/preview/PreviewWell.tsx` | Create the voice registry ref, call `useAudioMonitor(activeVideoRef, registryRef)`, render `<AudioSurface registryRef={…} />`. ~6 lines. |
| `src/components/preview/VideoSurface.tsx` | Four changes: **(a)** import `derivePool` and `PLAYBACK_RATE_MIN` / `PLAYBACK_RATE_MAX` from `audioMonitor.ts` instead of declaring them, and adopt the clip-keyed signature — see the behaviour note below; **(b)** replace the volume effect (`:269-275`) with `effectiveGain` over clip volume, track mute, master volume, master mute and `transportSilent`; **(c)** the `transportSilent` term is what mutes the element at 8× shuttle per §4.2 — it does **not** exist today and must not be dropped in implementation; **(d)** add `el.preservesPitch` per §4.2. |
| `src/components/preview/usePlaybackClock.ts` | Add `export` to `ELEMENT_LAG_TOLERANCE_FRAMES` (§3.1). **One keyword. The loop body does not change.** |

**`playable` is redefined by (a) and this is load-bearing.** `VideoSurface.tsx:179` reads
`currentUrl !== '' && pool.srcs[pool.active] === currentUrl`. It becomes
`pool.slots[pool.active].clipId === clipId && pool.slots[pool.active].url === currentUrl`. Only the
clip-id term keeps `activeVideoRef` null across a same-source cut, and §3.1's reference clock and
`usePlaybackClock`'s `frameFromElement` both depend on that being null while the pool is stale.

**Behaviour note on (a), because it touches verified picture playback.** Clip-keying makes the video
pool swap slots at a same-source, non-contiguous cut where today it reuses one element and relies on
the `clipId`-dependent `syncTime(true)` to hard-seek it. The swap lands on the idle element that
`parkIdle` already seeked to the incoming `mediaIn`, so the cut lands on a decoded frame instead of a
seek — strictly better for picture, and identical for every other case. The `split` case is covered
by the contiguity exception and produces no swap at all, so the most common same-source cut is
unchanged. Acceptance check 10.1(f) exists specifically to confirm this did not regress.

### 8.3 Files that explicitly do NOT change

`src/state/playbackSlice.ts` — **the store gains no fields and no actions for this feature.**
`volume`, `muted`, `rate` and `playhead` already carry everything the monitor needs, and the monitor
writes none of them. Also unchanged: `Transport.tsx`, `TrackHead.tsx`, `Track.tsx`, `Clip.tsx`,
`timeline.css`, `preview.css`, `src/styles/tokens.css`, `src/lib/constants.ts`, every `electron/**`
file, every `src/components/export/**` file, and `docs/EXPORT.md`.

All tuning constants live in `audioMonitor.ts`, not `src/lib/constants.ts`, because no other slice
reads them — the same precedent `VideoSurface`'s `SEEK_EPSILON_SECONDS` and
`DRIFT_TOLERANCE_SECONDS` already set.

### 8.4 Required integration changes — report, do not write

Per PLAN §0.2: state the exact declaration needed, code against it as though it existed, and let the
`tsc` failure be the signal.

**1. `src/state/timelineSlice.ts` (owner: timeline)** — two `[stable]` id-returning selectors, the
per-track counterparts of `selectVideoClipIdAtFrame` / `selectNextVideoClipIdAfter`.

The reason they are needed is **capability**, not stability. `selectAudioClipsAtFrame` filters
`track.kind !== 'audio'` (`timelineSlice.ts:1345`), so it cannot see the video-track audio that §1.1
and EXPORT.md §1.7 both require, and it returns no per-track "next clip", so there is no primitive to
drive preloading from. Its `[UNSTABLE REFERENCE]` marking is a secondary point and not an obstacle —
its own doc comment says it is called via `readStore()`, which `useAudioMonitor` may legally do. The
stability of the *new* selectors is what makes them usable from `AudioTrackVoice`'s bare
`useEditorStore(…)` subscriptions under PLAN §1.3 rule 1. Both are O(log n) through the existing
`lastStartingAtOrBefore` binary search and allocate nothing.

```ts
/** [stable] The clip on `t` covering `frame`, or null. Kind-agnostic. */
export const selectClipIdInTrackAtFrame = (
  s: StoreState, t: TrackId, frame: Frames,
): ClipId | null => { /* binary search, then `frame < clipEnd(clip)` */ };

/** [stable] The first clip on `t` starting strictly after `frame`, or null. */
export const selectNextClipIdInTrackAfter = (
  s: StoreState, t: TrackId, frame: Frames,
): ClipId | null => { /* binary search + 1 */ };
```

**2. `src/state/mediaSlice.ts` (owner: media) — a blocker for shipping this feature.**
`videosHolding` (`mediaSlice.ts:239-244`) finds handles with
`document.querySelectorAll('video')`. After this work there are up to twelve `<audio>` elements
holding `ve-media://` sources — including sources they merely *preloaded* and will never play — and
on Windows an open handle answers `fs.rename` with `EBUSY`/`EPERM`. Renaming a file any voice holds
would start failing with `file-in-use`, regressing RENAME.md's definition of done.

The change is small and stays inside the design that file already documents — "found by source
rather than by reaching into that component's refs: the pool is its private business". Widen the
query and the types; the protocol, the microtask, and the re-attach path are unchanged:

```ts
function mediaHolding(url: string): HTMLMediaElement[] {
  if (url === '' || typeof document === 'undefined') return [];
  return Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio')).filter(
    (el) => el.getAttribute('src') === url,
  );
}
// detachSources(elements: HTMLMediaElement[]) and reattachSources(...) widen to match.
```

No registry handle is exposed for this and none should be: the DOM query is the mechanism that
already works, it needs no cooperation from the preview slice, and it cannot miss an element the
preview forgot to register. The voice re-attaches from the new url on the next render, as the video
pool does, because `derivePool` sees the changed `Slot.url`.

**3. `docs/PLAN.md` §8.4 (owner: whoever holds the plan)** — an amendment recording three things the
plan does not currently mention: that the audio monitor is a *subscriber to* the one rAF loop and not
a second one; that `VideoSurface`'s element volume is the full gain law rather than the master alone;
and that the pool is keyed on clip id with a source-contiguity exception rather than on URL (§2.2.1),
since the plan's description of `derivePool` predates that correction.

---

## 9. Constants, in one table

All in `src/components/preview/audioMonitor.ts`.

| Name | Value | § |
|---|---|---|
| `MONITOR_REFERENCE_GAIN` | `0.5` (−6.02 dB) | 5.2 |
| `DRIFT_DEAD_BAND_FLOOR_MS` | `12` — the dead band itself is `Math.max(12, 750 / fps)` | 3.2 |
| `DRIFT_TRIM_MAX` | `0.02` (±2 %) | 3.2 |
| `DRIFT_TRIM_WINDOW_MS` | `1000` (a time constant, not a completion time) | 3.2 |
| `DRIFT_HARD_SEEK_MS` | `120` | 3.2 |
| `DRIFT_CHECK_INTERVAL_MS` | `250` — corrections act on the **median** of the samples in the window | 3.2 |
| `HARD_SEEK_MIN_INTERVAL_MS` | `500` | 3.2 |
| `START_SETTLE_MS` | `300` | 3.2 |
| `FADE_RESTORE_BACKSTOP_MS` | `200` | 3.3 |
| `EXTERNAL_SEEK_SLACK_FRAMES` | `4` — **distinct from `ELEMENT_LAG_TOLERANCE_FRAMES`; they measure different things** | 3.4 |
| `IDLE_REPOSITION_INTERVAL_MS` | `120` | 4.3 |
| `PRELOAD_LEAD_IN_MS` | `2000` (video-track voices only) | 2.2.2 |
| `SHUTTLE_AUDIBLE_MAX_RATE` | `4` | 4.2 |
| `PLAYBACK_RATE_MIN` / `PLAYBACK_RATE_MAX` | `0.0625` / `16` — **moved here from `VideoSurface.tsx`, which imports them** | 4.4 |
| `MAX_AUDIBLE_SOURCES` | `8` — a future guard; today's real ceiling is `trackOrder.length` | 7.3 |
| `TRANSIENT_RELOAD_ATTEMPTS` | `2` (mirrors `VideoSurface`) | 7.1 |
| `NON_TRACKING_SEEKS` / `NON_TRACKING_WINDOW_MS` | `3` / `3000` | 7.4 |
| `STALL_MUTE_MS` | `1000` | 7.4 |
| `ELEMENT_LAG_TOLERANCE_FRAMES` | `2` — **imported from `usePlaybackClock.ts`, not redeclared** | 3.1 |

---

## 10. Acceptance

Split three ways by **what actually observes the result**, because an earlier draft asked for checks
nothing in this build can make. §2.1 rejects WebAudio on the shipping path and §6 rejects meters, so
the app cannot observe its own audio output; the CDP harness has no audio path either. The
frequency-signature argument belongs to EXPORT.md §1.7's `amix` verification, which decomposes a
*rendered file* — a thing that exists on disk and can be analysed offline. A monitor produces no
such artefact. Every check below names its instrument.

### 10.1 Machine-checkable through the CDP harness

These are element-state assertions. The harness reads them with
`CDP_PORT=9222 node …/cdp.mjs "<expr>"` over
`document.querySelectorAll('[data-track-id] audio')` and the `<video>` pool.
**Assert `document.visibilityState === 'visible'` in every sample** — an occluded window suspends
`requestAnimationFrame`, which freezes the playhead and makes every one of these look broken.

| # | Check | Assertion |
|---|---|---|
| a | Allocation | Two `<audio>` per track with at least one clip; zero for empty tracks. On the fixture project: 12. |
| b | Clock-clip ownership (§2.3, §2.2.2) | For the track carrying the clock clip, the voice slot holding that clip is `paused === true`, `volume === 0`, and `preload === 'metadata'` — it may hold the `src`, it may not be promoted and it may not sound. The `<video>` carries it. |
| c | Under-layer audibility (§1.1) | Park over a frame where V1 sits under V2. The V1 voice has a `src`, `paused === false`, and `volume > 0`. |
| d | Hidden-track audibility (§1.2) | Toggle V2 hidden. `selectVideoClipIdAtFrame` now returns V1's clip; the V1 voice releases its `src` and the `<video>` picks it up; the V2 voice acquires one. Both transitions complete within `START_SETTLE_MS + 2` ticks. |
| e | Same-source cut (§2.2.1) | Two clips from one file on one track, non-contiguous, adjacent. Across the cut, `pool.active` flips and the newly active element's `currentTime` is within `deadBandMs` of the incoming `mediaIn`. The failing case this exists for: no flip, and `currentTime` continuing past clip A's out point. |
| f | Split stays seamless (§2.2.1, §8.2) | Split a clip, play across the join. `pool.active` does **not** flip, no `seeking` is observed, and `currentTime` is monotonic across the join. This is also the regression check on the `VideoSurface` pool change. |
| g | Cumulative offset over 10 minutes | Sample every voice's `currentTime` against `referenceSeconds` once a second for 600 s. `max\|drift\|` never exceeds `DRIFT_HARD_SEEK_MS`, and the drift at t=600 s is not larger than at t=60 s. **This is a number, and it is the real content of the old "compare a bandpass against a real export" test.** |
| h | Transport (§4) | At 4×: voices `paused === false`, `playbackRate === speed × 4`, `preservesPitch === false`. At 8×: every voice `paused === true` and the `<video>` `muted === true`. Reverse at any rate: every element `paused === true`. |
| i | Out-of-range rate (§4.4) | A clip at `speed 8`, shuttle to 4×. Its voice is `paused === true`. No notice is emitted. |
| j | Scrub (§4.3) | Throughout a ruler drag and its momentum: every voice `paused === true`. On pointer-up: still `paused === true`. On play: `paused === false`. |
| k | External seek (§3.4) | Enter a timecode 40 s away during playback. Exactly one `seeking` transition per voice; no voice reports more than one hard seek; `blocked` is not set; no notice. |
| l | Branch-flip immunity (§3.4) | Play 60 s across ten cuts with a `seeked`/`seeking` counter installed on every voice. Total hard seeks ≤ 2. The failing case this exists for is a detector that fires at every cut. |
| m | Gain law (§5.1) | For each voice, `volume === clamp(0.5 × masterVolume × clipVolume, 0, 1)` and `muted === (volume === 0)`. Set a clip to `volume: 2.0` at master 1.0 and assert `volume === 1` exactly, with no other voice changing. |
| n | Write cache (§3.3) | With a `volume`/`playbackRate` setter spy installed, steady-state playback across 300 frames issues **zero** writes per element after the first. |
| o | Rename under load (§8.4 change 2) | With a file preloaded by an audio voice and not playing, rename it. The rename succeeds; no `file-in-use`. |
| p | One rAF loop (constraint 2) | `grep -rl 'requestAnimationFrame' src/components/preview/` returns exactly one path, `usePlaybackClock.ts`. (Occurrence *count* in that file is 4 today and is not the assertion — the assertion is that no second file schedules frames.) |

### 10.2 Measurements to record, not assert

Numbers this document currently guesses at. Record them in this section, the way EXPORT.md §1.8
records verified transcripts, and adjust §2.2.2 to whatever they say.

- Live media pipelines and resident memory for the fixture project, at rest and mid-playback, with
  and without the video-track preload restrictions of §2.2.2. `chrome://media-internals` gives the
  player count; the task manager gives the memory. If restricting preload changes neither, delete
  the restriction and record that instead.
- Observed `seeked` latency distribution on a local `ve-media://` source, to confirm
  `FADE_RESTORE_BACKSTOP_MS = 200` is a backstop and not the common path.

**Recorded.** Fixture project, production build, Chrome 1600×1000, `npm run dev:web` media:

| | at rest (playhead 0) | mid-playback (~6 s in) |
|---|---|---|
| `<audio>` allocated | 12 | 12 |
| carrying a `src` | 9 | 9 |
| `preload="auto"` | 4 | 6 |
| `preload="metadata"` | 5 | 3 |
| `readyState >= 2` | 9 | 9 |
| JS heap | 30.7 MB | 31.8 MB |

**The preload branch is not measurably saving anything on these fixtures, and the reason is the
fixtures.** Every sourced slot reaches `readyState 4` whatever its `preload` value, because
`parkIdle` seeks the idle slot and that fetch alone takes it there — and the fixture files are short
enough (12–90 s) that Chromium simply buffers all of them: `macro_coffee_pour.mp4` reports 12 s
buffered at `metadata` and 12 s at `auto`; `broll_market_street.mp4` reports the same 25 s on a
demoted voice slot as on the `<video>`'s promoted one. So this measurement cannot distinguish the
two, and §2.2.2's "delete the branch" clause must **not** be triggered on it — that would be
over-fitting to test material. The branch is kept: it costs one attribute, checks 10.1(b) and
10.1(d) assert on it, and the case it was written for (a multi-minute .mp4, where `metadata` does
decline to fetch the body) is not represented here. Re-measure on real footage before deciding.

`chrome://media-internals` is not reachable through the CDP harness, so the live *pipeline* count is
still unrecorded; the element and `readyState` counts above are the closest proxy this build can
take.

### 10.3 Measured by a throwaway rig, if a spectral claim is wanted

Frequency decomposition of the monitored mix is possible but **only** with an instrument that does
not ship: in a dev session, construct an `AudioContext`, attach a `MediaElementAudioSourceNode` to
each voice and an `AnalyserNode`, read `getFloatFrequencyData`, and discard the whole thing with the
page. This does not contradict §2.1, which rejects WebAudio on the *shipping* path for reasons
(memory, streaming, node lifetime) that do not apply to a measurement rig — but note the rig is
**invasive**: attaching a `MediaElementAudioSourceNode` permanently reroutes that element's output,
so the page must be reloaded afterwards. Never leave it in a committed file.

With that rig, the fixture signatures make the mix decomposable: the six video clips carry steady
sines at 300 / 500 / 700 / 1100 / 1300 / 1700 Hz, `music_bed_low.m4a` is an A-minor triad entirely
below 200 Hz, `vo_take_04.m4a` is 850 Hz in bursts, and `room_tone_hall.m4a` is low-passed brown
noise. Nothing is a harmonic of anything else. The checks worth running on it:

1. Park where a video clip, a music bed and a voiceover overlap. Play. All three bands present.
2. Mute A2. That band alone disappears; the others do not change level. **This is the `normalize=0`
   test** — if the survivors get louder, something divides by the source count and §1.3 has been
   violated.
3. Set a clip's `volume` to 2.0. Its band rises by 6.02 dB relative to the others, and does not
   clamp.

### 10.4 Listening checks — a person, with headphones

Labelled as such because no harness substitutes for them, and because pretending otherwise is how a
clicking build ships green.

1. Play across ten cuts including one split and one same-source non-contiguous cut. No clicks, no
   dropouts, no doubled material.
2. Enter a timecode 40 s away during playback. One faded reposition; no click on any voice.
3. Shuttle to 4× over dialogue: words are locatable. To 8×: silence, entered cleanly.
4. Ten minutes of a music bed under picture: no audible flanging against the picture's own audio, no
   pitch wobble on the sustained fixture tones. A wobble here means the §3.2 dead band is narrower
   than the reference quantisation and should be checked against `750 / fps` first.
5. Scrub the ruler: silence, no clicks. Release: still silence. Press play: sound, from the right
   sample.
