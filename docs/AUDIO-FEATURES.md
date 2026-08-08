# Audio features — detach audio, and audio-only export

**Status:** normative. This document specifies two additions to a shipped editor. It is the
integration contract between the implementer of these two features and the two areas being designed
in parallel against the same tree.

Where this document and a slice brief disagree on a *name, type, channel or argument*, this document
wins — report the conflict rather than diverging. Where this document and `docs/PLAN.md` or
`docs/EXPORT.md` disagree, **those win**, except at the two points named in §0.2, which are stated
amendments rather than divergences.

Read order: `PRODUCT.md` → `DESIGN.md` → `docs/PLAN.md` → `docs/EXPORT.md` →
`docs/AUDIO-MONITOR.md` → this file.

Every ffmpeg construct in §2 was executed against the ffmpeg this repo resolves
(`8.1.1-essentials_build`, gyan.dev) and the real media in `dev-media/` before being written down.
§2.10 is a transcript of runs that produced correct files, not a sketch. The byte counts in §2.5 are
`ls -l` output, not arithmetic.

---

## 0. Scope, and what is being added to what

### 0.1 The two features, in one paragraph each

**Detach audio.** A `Clip` is currently a whole-media reference with no stream selection: a clip cut
from an .mp4 always means "the picture and the sound of this file". The user wants to import a video,
detach its sound onto an audio track, and then delete the picture. §1 adds a three-valued `streams`
field to `Clip`, one action, one context menu, one keyboard binding, and the four consumer changes
that make the field mean something.

**Audio-only export.** `CODEC_OPTIONS` offers h264, h265 and prores — all video. §2 adds AAC in
`.m4a`, MP3, and WAV, reusing the existing, numerically verified audio mix rather than writing a
second path. Resolution and frame rate disappear from the form rather than greying out. The
size estimate stops being a video model and becomes, for WAV, an exact number.

### 0.2 Three stated amendments to existing normative documents

These are not divergences; they are changes this work makes to documents it does not own. All three
are listed again in §7 as required edits.

| # | Document | Current text | Amendment |
|---|---|---|---|
| A1 | `PLAN.md` §3.1 | The closed list of actions permitted to call `markDirty()` | gains `detachAudio` |
| A2 | `EXPORT.md` §1.3 | "`OF = out.fps`. … Nothing in the emitted graph runs at `F`." | For an audio-only codec there is no output frame grid, so `OF = F`. See §2.7 — this is a correctness fix, not a preference. |
| A3 | `SAFETY.md` §8 file table | "`serializeProject`, `applyProject` and `migrateProject` are unchanged" (of `src/lib/project.ts`) | True of SAFETY's own edits, false of the file: §7.3 here adds the `streamsOf` sanitiser inside `migrateProject`. The sentence becomes "unchanged **by this document**". Both briefs' edits apply and are disjoint; scaffold owns the file and lands both. |

Everything else this work needs from a file it does not own is a **scaffold escalation** under
PLAN §0.2 rather than an amendment — `src/types/model.ts` (§7.0), `src/types/api.ts` (§7.1),
`src/lib/constants.ts` (§7.2) and `src/lib/project.ts` (§7.3). All four are named in PLAN §0.2's
cross-cutting list, so all four are routed the same way. An earlier draft took `model.ts` directly in
§6, which was the one inconsistency in that set.

### 0.3 What is deliberately not here

No re-attach. No waveform rendering. No per-clip audio channel
selection (a 5.1 source is downmixed to stereo by the existing `aformat`, unchanged). No audio-only
*import* changes — `MediaItem.kind` and probing are untouched. No `-an` "silent video" export option
(§3.2). No new colour, no new token, no new texture.

---

## 1. Feature 1 — Detach audio

### 1.1 The model change

#### The shape, and the three alternatives that lost

`Clip` gains one optional field and three derived readers, all in `src/types/model.ts` beside
`clipEnd` and `clipSourceLength`, which is the established home for clip-derivation primitives.
`model.ts` is scaffold-owned (PLAN §0.2), so this is a **scaffold escalation** and the declarations
are restated in §7.0 as the exact ask:

```ts
/**
 * Which streams of the referenced media this clip uses.
 *
 * ABSENT means 'av'. The field is optional so that a .veproj written before this
 * feature — which has no such key — is a valid project file rather than a
 * migration, and so that an ordinary clip does not carry a redundant "av" into
 * every save. Read it through `clipStreams`, never directly.
 */
export type ClipStreams = 'av' | 'video' | 'audio';

export interface Clip {
  id: ClipId;
  mediaId: MediaId;
  trackId: TrackId;
  start: Frames;
  duration: Frames;
  mediaIn: Frames;
  name: string;
  properties: ClipProperties;
  /** Undefined ≡ 'av'. Written only by `detachAudio`; see docs/AUDIO-FEATURES.md §1.1. */
  streams?: ClipStreams;
}

/** THE reader. Nothing anywhere may write `c.streams ?? 'av'` inline. */
export const clipStreams = (c: Clip): ClipStreams => c.streams ?? 'av';
/** True when this clip puts pixels on the canvas. */
export const clipHasVideo = (c: Clip): boolean => clipStreams(c) !== 'audio';
/** True when this clip puts samples in the mix. */
export const clipHasAudio = (c: Clip): boolean => clipStreams(c) !== 'video';
```

**Rejected — two booleans (`usesVideo: boolean; usesAudio: boolean`).** They admit a fourth state,
`false/false`, which is a clip that does nothing. Every one of the eight consumers in §1.7 would
then have to decide what a nothing-clip means, and they would not all decide the same thing. A
three-valued union makes the illegal state unrepresentable, which is the same argument this codebase
already makes for `MutationResult` and `ProbeResult`.

**Rejected — a required field with a version bump.** `migrateProject` in `src/lib/project.ts` reads
`if (raw.version !== PROJECT_VERSION) return null`, and `describeProjectProblem` then tells the user
*"That project uses an older format (version 1) that this version can no longer open"*. Bumping to
version 2 would make **every existing `.veproj` unopenable**. The requirement is backward
compatibility; the file format version must stay `1`, which forces the field to be additive and
therefore optional on the wire. Making it required in the TypeScript interface while optional on the
wire would mean normalising on load, which §1.2 rejects for a stated reason.

**Rejected — no field; infer the stream from the track the clip sits on.** An audio-only clip would
be "a clip whose `mediaId` points at a video file but whose `trackId` is an audio track". This is
cheap and wrong in one specific way: it cannot express a **video-only** clip. The clip left behind by
the detach must stop contributing sound while staying on its video track, and there is no place to
record that. It would also make `clipKind` circular — the kind is derived from the track, and the
legal track is derived from the kind.

**Rejected — a `linkId` pair.** That is a different feature, not a different encoding: it records which clips move together, not which streams a clip uses. It was later built, on those terms and beside `streams` rather than instead of it — `docs/LINKING.md` §1.1.

#### One property this field does not have

`streams` is **not** a property of `ClipProperties`. `updateClipProperties` is the inspector's write
path, it is all-or-nothing across a multi-selection, and it re-runs the overlap and source checks
when the patch contains `speed`. Putting a structural field through it would mean a patch that can
create a clip on another track, which that action has no vocabulary for. `streams` is written by
exactly one action, `detachAudio`.

### 1.2 Backward compatibility, and the migration

**There is no data migration. That is the point.**

| Direction | Behaviour |
|---|---|
| Old `.veproj` (no `streams` key) opened by the new build | `validClip` does not inspect `streams`, so every clip validates unchanged. `clipStreams` returns `'av'` for all of them, which is exactly what those clips have always meant. **Zero clips change.** |
| New `.veproj` (some clips carry `streams`) opened by the new build | Round-trips verbatim: `serializeProject` writes `Object.values(s.clips)`, so the key rides along without a scaffold edit to `PERSISTED_MEDIA_KEYS` or to `ProjectFile`. |
| New `.veproj` opened by a **build that predates this feature** | `version` is still `1`, so the file opens. `streams` is an unknown key that `migrateProject` neither reads nor strips, and the old build renders the detached pair as two ordinary `av` clips — so the audio doubles in its preview and its export. This is a **stated, accepted cost** of not bumping the version, and it is the correct trade: a file that opens with a wrong mix is recoverable; a file that refuses to open is not. |

`migrateProject` gains exactly one line, a **sanitiser rather than a validator**:

```ts
// src/lib/project.ts — inside the clips mapping, after the existing filters.
const streamsOf = (v: unknown): ClipStreams | undefined =>
  v === 'video' || v === 'audio' ? v : undefined;   // 'av', absent, and anything unknown → undefined
…
clips: raw.clips
  .filter(validClip)
  .filter((c) => trackIds.has(c.trackId))
  .map((c) => {
    const streams = streamsOf((c as { streams?: unknown }).streams);
    return streams === undefined ? c : { ...c, streams };
  }),
```

Sanitise, do not reject: dropping a whole clip because a hand-edited file says `"streams":"audi"`
loses the user's edit over a typo, and `describeProjectProblem` has no sentence for it. Degrading an
unknown value to `av` loses nothing and is self-explaining on screen. Note that the normalising map
**returns the original object when there is nothing to change**, so an untouched project allocates no
new clip records on open.

**Nothing writes `streams: 'av'`, ever.** `addClip` leaves the field undefined; only `detachAudio`
writes `'video'` or `'audio'`. Consequence: opening and re-saving a legacy project produces a
byte-identical clip array. A `.veproj` is a JSON file a user may keep in git, and a save that
rewrites forty clips to add a field meaning "unchanged" makes the diff useless.

**`splitAtPlayhead` needs no change.** It builds both halves with `{ ...clip, … }`, so `streams`
propagates to both by construction. `linkId` does **not** survive a split unexamined — see
docs/LINKING.md §5.4. Verified by reading `timelineSlice.ts:693-700`. The same holds
for the history snapshot: `TimelineDoc` carries whole `Clip` records, so undo/redo restore `streams`
with no per-field work.

### 1.3 `clipKind`, and which tracks a clip may live on

`clipKind` is the single function that decides "video clip or audio clip", and it is what
`planMove`, `moveClip` and `addClip` consult before allowing a clip onto a track. It currently reads
the media. It must read the *clip* first:

```ts
// src/state/timelineSlice.ts — replaces the existing clipKind.
/** The media kind a clip carries. `streams` outranks the media; the track is the last resort. */
export function clipKind(s: StoreState, clip: Clip): MediaKind {
  const streams = clipStreams(clip);
  if (streams === 'audio') return 'audio';
  if (streams === 'video') return 'video';
  return s.items[clip.mediaId]?.kind ?? s.tracks[clip.trackId]?.kind ?? 'video';
}
```

This one edit buys the whole placement story:

- an `audio` clip cut from an .mp4 is legal on an A-track and refused on a V-track (`kind-mismatch`);
- a `video` clip stays legal only on a V-track;
- dragging the detached audio clip back onto a video lane fails whole, with the drag ghost's existing
  refusal label, rather than half-succeeding.

`addClip` has a second, independent copy of the rule at `timelineSlice.ts:550`
(`if (media && media.kind !== track.kind) return { ok: false, reason: 'kind-mismatch' }`). It must
consult the same function. `AddClipInput` gains **three** optional fields — `streams`, and the
`name` / `properties` that §1.4 needs in order to create the twin in **one** call:

```ts
export interface AddClipInput {
  mediaId: MediaId;
  trackId: TrackId;
  start: Frames;
  duration?: Frames;
  mediaIn?: Frames;
  /** Defaults to undefined ≡ 'av'. Only `detachAudio` passes it. */
  streams?: ClipStreams;
  /** Defaults to the media's name, as today. Only `detachAudio` passes it. */
  name?: string;
  /** Defaults to `{ ...DEFAULT_CLIP_PROPERTIES }`, as today. Only `detachAudio` passes it. */
  properties?: ClipProperties;
}

// inside addClip, replacing the media.kind comparison at :550:
const wantKind: MediaKind =
  input.streams === 'audio' ? 'audio'
  : input.streams === 'video' ? 'video'
  : (media?.kind ?? track.kind);
if (wantKind !== track.kind) return { ok: false, reason: 'kind-mismatch' };

// …and the clip literal at :557-566, which is what the two checks at :568-571 then run against:
const clip: Clip = {
  id: newId('c'),
  mediaId: input.mediaId,
  trackId: input.trackId,
  start,
  duration,
  mediaIn,
  name: input.name ?? media?.name ?? 'Clip',
  properties: input.properties ? { ...input.properties } : { ...DEFAULT_CLIP_PROPERTIES },
  // Conditional, never `streams: input.streams` — §1.2 forbids writing an explicit 'av',
  // and an `undefined`-valued key would still show up in an `in` check and a key count.
  ...(input.streams !== undefined ? { streams: input.streams } : {}),
};
```

**`properties` has to be an `addClip` *input*; it cannot be patched on afterwards.** This is the
single most important sentence in §1.3, because the obvious alternative is silently wrong. The only
properties writer is `updateClipProperties`, and PLAN §2.4 rule 4 makes it rescale duration whenever
the patch contains `speed`:

```ts
// timelineSlice.ts:1045-1048
const duration = newSpeed === oldSpeed
  ? clip.duration
  : Math.max(1, Math.round((clip.duration * oldSpeed) / newSpeed));
```

A twin created with `DEFAULT_CLIP_PROPERTIES` (speed 1) and then patched to its source clip's
speed 2 would come out **half** the length of the picture it was cut from — and it would fail
*silently*, because `violatesSource` on the halved clip passes and no refusal is raised. Sound would
drift out from under picture on the timeline, and the export's `atempo` / `sourceLenFrames` chain
would read the wrong length. `renameClip` has the symmetric shape problem in miniature: it is a
separate history-pushing mutation, so patching the name afterwards would also split the operation
into two undo steps.

**The `properties` input also fixes a pre-existing bug that this feature would otherwise expose.**
`violatesSource` at `:568` runs against the clip literal. Today that literal always carries speed 1,
so a full-length clip of a speed-0.5 source is judged as consuming `duration × 1` rather than
`duration × 0.5` frames — wrong in the safe direction for `insertMediaAt` (which never passes
`duration`), but wrong in the *refusing* direction the moment a caller passes both a `duration` and a
sub-unity speed, which `detachAudio` does. Building the real properties into the literal before the
check makes `violatesSource` and `overlapOnTrack` evaluate the clip that will actually exist. Order
is normative: **`name` and `properties` are applied at :557-566, above the checks at :568-571.**

`insertMediaAt` is unchanged: it inserts whole media and passes none of the three new fields.

**`MoveFailure` does not change.** An earlier draft of this document added a `'no-audio'` member.
It is withdrawn: nothing in this design ever returns it. `detachAudio` raises its refusals as
literal sentences through `setNotice` (§1.4), `addClip`'s only new refusal is the existing
`'kind-mismatch'`, and no move or trim can reach a "media has no audio" condition. A shared union
member that exists only to force two string tables to grow is a cost with no consumer. See §1.5 for
the one refusal copy `detachAudio` needs from `addClip`, and the note in §6 about what `tsc` does and
does not flag here.

### 1.4 The action

```ts
// src/state/timelineSlice.ts — TimelineActions gains one member.
/**
 * Detach audio. Turns each eligible clip into a video-only clip and creates an
 * audio-only twin on an audio track at the same start, duration and mediaIn.
 *
 * Operates on the ELIGIBLE SUBSET of `ids`, defaulting to the current selection —
 * the same shape as `splitAtPlayhead`, and for the same reason: one command, one
 * refusal, raised HERE rather than at the two call sites, so the menu item and
 * the shortcut cannot explain themselves differently.
 *
 * The pair is LINKED afterwards (docs/LINKING.md §4.3). One history entry for
 * the whole operation, including any tracks it had to create.
 */
detachAudio(ids?: ClipId[]): void;
```

```ts
/**
 * [UNSTABLE REFERENCE] readStore() only. THE eligibility rule, once. The context
 * menu asks it to decide `disabled` + `disabledReason`; the action asks it to
 * decide what to operate on.
 */
export const selectDetachableClipIds = (s: StoreState, ids?: Iterable<ClipId>): ClipId[] => {
  const out: ClipId[] = [];
  for (const id of ids ?? s.selection) {
    const clip = s.clips[id];
    if (!clip) continue;
    if (clipStreams(clip) !== 'av') continue;                 // already detached, or already audio-only
    const track = s.tracks[clip.trackId];
    if (!track || track.kind !== 'video' || track.locked) continue;
    if (s.items[clip.mediaId]?.hasAudio !== true) continue;
    out.push(id);
  }
  return out;
};
```

Eligibility, stated in prose so the four clauses are auditable:

1. **`clipStreams(clip) === 'av'`.** A clip that is already `video` has nothing left to give; a clip
   that is already `audio` is the *result* of a detach.
2. **Its track is a video track and is not locked.** Locking protects against editing, and this is an
   edit (EXPORT §1.9's table says locking has no effect on *delivery* — this is not delivery).
3. **`MediaItem.hasAudio === true`.** A property of the file. Note it is *not* "the file makes a
   sound": EXPORT.md's opening note is explicit that content silence is not `hasAudio === false`, and
   detaching a silent-but-present audio stream is a legitimate thing to do.
4. **Media status is irrelevant.** An **offline** clip is still detachable. The operation is purely
   structural, touches no file, and `hasAudio` survives on the persisted record. Refusing here would
   mean a user who unplugged a drive cannot restructure their own timeline.

The body:

```
detachAudio(ids?):
  targets = selectDetachableClipIds(get(), ids)   // computed ONCE, from one snapshot
  if targets.length === 0:
     raise the notice from the table below; return          // never silent (PLAN §3.4)

  beginHistory('Detach audio')          // one entry covers created tracks AND both clips
  for clip of targets, ascending by (track index, start):   // deterministic, so undo is reproducible
     trackId = findAudioHome(get(), clip)                   // §1.5 — re-reads the store, every pass
     result = addClip({ mediaId: clip.mediaId, trackId, start: clip.start,
                        duration: clip.duration, mediaIn: clip.mediaIn,
                        name: clip.name, properties: clip.properties, streams: 'audio' })
     if !result.ok: abortHistory(); raise §1.5's refusal; return
     patch the source clip in place: { ...clip, streams: 'video' }
  commitHistory()
  get().recomputeOfflineClips()         // see below — a new clip id needs a new projection
  markDirty()
```

**Two reads, and which one is which.** `targets` is computed **once**, before the transaction, so the
eligible set is a stable snapshot and cannot grow or shrink under the loop — the clips being detached
are exactly the clips that were eligible when the user pressed the key. `findAudioHome`, by contrast,
**re-reads `get()` at the top of every iteration**. Both are required, and confusing them is the bug
this note exists to prevent: `addClip` commits to the store on every call
(`set(withClips(docOf(get()), [clip]))`) and `addTrack` commits a new track, so a `findAudioHome`
written against a captured snapshot would be blind to *both*. Detaching three non-overlapping V1
clips would then create three audio tracks — one per clip — instead of stacking all three on A1,
because iteration 2 could not see the A1 that iteration 1 had just filled or the track iteration 1
had just made. Reading `get()` per iteration needs no side bookkeeping: **the store is already
authoritative after each `addClip`**, so committed clips and newly created tracks are both visible by
construction.

**`recomputeOfflineClips()` is called once, after `commitHistory()`.** `detachAudio` mints new clip
ids, and `offlineClipIds` is keyed by **clip** id rather than media id, so without this a twin cut
from an offline source would render with no `--texture-offline`, no `Unplug` glyph and no `offline`
in its accessible name, sitting directly beneath a picture half that shows all three. That is
reachable by design — eligibility rule 4 above explicitly permits detaching an offline clip.
`splitAtPlayhead` documents the identical hazard for the identical reason and takes the identical
step at `timelineSlice.ts:711-713`: *"A split mints a new clip id, so the offline projection no
longer covers the clip set."* Once, after the transaction — not per iteration; the projection is a
whole-store recompute and running it *n* times would be *n*−1 wasted passes over the clip set.

**One `addClip` call, no patching afterwards.** `name` and `properties` ride in as inputs (§1.3).
There is deliberately no follow-up `renameClip` or `updateClipProperties`: the first would add a
second history push inside the transaction, and the second would rescale the twin's duration on any
clip whose speed is not 1. §1.3 states that at length; it is repeated here because this pseudo-code
is what an implementer will copy.

**The new clip's fields, exactly.** Every one of them is either computed by `addClip` or passed to
it; none is written after the fact.

| Field | Value | Why |
|---|---|---|
| `id` | `newId('c')` | `addClip`'s own. Never derived from the source clip's id — PLAN §2.2. |
| `mediaId` | the source clip's | Both halves read the same file. This is what makes the export work with no new plumbing (§1.7.3). |
| `trackId` | §1.5 | |
| `start`, `duration`, `mediaIn` | copied verbatim | The stated requirement, and it is what keeps sound under picture. |
| `name` | copied verbatim, via `AddClipInput.name` | `name` labels the *material*, and the app already shows two clips with one name after a split. The distinction is carried by the lane, the missing thumbnail strip, the icon, and the accessible name (§1.8) — all of which survive a 24 px clip, and a `" audio"` suffix does not. |
| `properties` | copied **whole**, by value, via `AddClipInput.properties` | `speed` **must** match or the two halves drift apart on the timeline and in the export's `atempo` chain. `volume` must carry across or the detach would silently change the mix. `scale`/`position`/`rotation`/`opacity` are inert on an audio-only clip; copying them costs nothing and avoids inventing a second, partial `ClipProperties` shape that `updateClipProperties` would then have to know about. **Passed in, never patched on** — §1.3 for the duration-rescale trap. |
| `streams` | `'audio'` | |

**The source clip becomes `{ ...clip, streams: 'video' }` and nothing else changes.** In particular
its `volume` is **not** zeroed. Zeroing would be a second, redundant encoding of the same fact, and
it would be the *wrong* one: a user who later raised that volume back to 100 % would expect sound and
get none, because `streams` is what the export and the monitor actually read (§1.7).

Refusal copy, raised by the action, `setNotice`, `tone: 'warning'` throughout:

| Condition, checked in this order | Title | Message |
|---|---|---|
| `ids ?? selection` is empty | `Nothing to detach` | `Select a video clip first` |
| every candidate sits on a locked track | `Could not detach` | `Track is locked` |
| every candidate's media reports no audio | `Could not detach` | `Those clips have no audio to detach` |
| everything else (already detached, audio-track clips) | `Nothing to detach` | `Select a video clip that still has its audio` |

**Selection after the action: unchanged.** The originals stay selected.

The user's sentence was *"delete the video while keeping the audio"*. Leaving the selection on the
originals makes that literally two keystrokes — `Shift+D`, `Delete` — with no pointer and no
re-selection. Selecting the new clips instead would optimise for looking at the result and would
break the stated task. What tells the user the twin exists is the twin: it appears on screen, on the
lane below, at the same horizontal position. If the target lane is a track this action just created,
that track appears too. No notice fires on success — a notice for a success is ceremony, and
PRODUCT.md §5 rules it out.

**Focus:** unchanged, on whatever clip held it. **Scroll:** if the target lane is outside the lane
viewport's vertical range, the timeline scrolls the minimum distance to bring it fully into view,
through the existing scroll path — not a new animation, and subject to the existing
`prefers-reduced-motion` handling for timeline scroll.

### 1.5 Where the new clip goes when no audio track is free

`findAudioHome(s: StoreState, clip: Clip): TrackId` reuses the ladder `insertMediaAt` already
establishes at `timelineSlice.ts:586-614`. **It takes the store as an argument and `detachAudio`
passes it a fresh `get()` on every iteration** (§1.4) — that, and nothing else, is what makes a
multi-clip detach place its twins correctly:

1. Candidate audio tracks in **ascending `Track.index`** — A1 first, then A2, upward. (Not
   `trackOrder` position: `trackOrder` is display order and `removeTrack` deliberately leaves indices
   sparse, so `index` is the stable ladder.)
2. Skip a track that is `locked`.
3. Skip a track where `[clip.start, clip.start + clip.duration)` overlaps an existing clip.
4. If no candidate has room, `addTrack('audio')` — which appends to `trackOrder` and takes
   `maxAudioIndex + 1`, per PLAN §2.4's track-numbering contract — and use that.

**There is no `placed` array, and there must not be one.** An earlier draft threaded a list of
already-created twins through as a second argument, on the theory that step 3 had to check
uncommitted work. It does not: `addClip` commits with `set(withClips(docOf(get()), [clip]))` before
it returns, and `addTrack` commits its track the same way, so a twin placed in iteration 1 **is**
"an existing clip" by iteration 2 and a track created in iteration 1 **is** a candidate. Side
bookkeeping would only duplicate what the store already knows, and — worse — it would look like it
solved the problem while `findAudioHome`'s track list still came from a stale snapshot. Read
`get()`; check committed state; that is the whole rule.

Two consequences, stated so neither is a surprise:

- Detaching *N* video clips that **do not** overlap in time places all *N* twins on **A1** and
  creates **no** track. This is the common case and it is what the ladder is for.
- Detaching *N* mutually **overlapping** video clips can create up to *N* audio tracks. Two selected
  clips on V1 and V2 may overlap in time and their twins genuinely cannot share a lane. That is
  correct, and it is one undo.

Failure handling: `addClip` still returns a `CreateResult`. If any placement returns `{ ok: false }`
— which step 4 makes unreachable, but which must not be assumed — the whole operation calls
`abortHistory()` and raises

```ts
{ tone: 'danger', title: 'Could not detach', message: 'The detached audio could not be placed' }
```

**One fixed sentence, written inline.** Not a lookup into a per-reason table: the path is documented
as unreachable, so a table buys nothing, and the only table that exists — `REFUSAL` in
`src/components/media/MediaItem.tsx:62` — is module-local to a *component in another area*. Importing
it into `src/state/timelineSlice.ts` would invert the layering the whole §0 ownership map rests on
(a store slice reading copy out of a media-rail component), for one string on a branch that cannot
run. `abortHistory` restores the snapshot *and* removes any track this operation created, which is
precisely why the whole thing is one transaction. This mirrors `insertMediaAt`'s
"a refused clip must not leave a stray empty track behind" comment verbatim.

### 1.6 Linking — **superseded in full by `docs/LINKING.md`**

This section argued that linking is not a field but a cross-cutting rule every mutation must honour,
and that a joined model makes *delete the picture, keep the sound* the hard path — and both sentences
are still true. `docs/LINKING.md` re-decided which of the two costs is larger: the cross-cutting work
is bounded at five mutations and one selection rule, and silent desync is not. **`detachAudio` now
links the picture and the sound it cuts out**; the reasoning this section recorded is preserved
verbatim as `docs/LINKING.md` §0.1, together with why the trade was reversed. There is no build in
which both models exist.

### 1.7 Every consumer, and the exact change

Eight consumers read a clip and decide whether it makes picture or sound. All eight are listed —
four that change, four that do not. Nothing else in the tree needs to know the field exists.

(Two of the four that change carry a second edit each. `1.7.2` touches `monitorAudible`,
`VideoSurface`'s `clipVolume` **and** `useAudioMonitor`'s voice budget, because all three read the
same fact; `1.7.4` is five edits inside one component. The unit being counted is the consumer, not
the line.)

#### 1.7.1 Preview video pool — `selectVideoClipIdAtFrame` / `selectNextVideoClipIdAfter`

`src/state/timelineSlice.ts:1240`. Both already filter `track.kind !== 'video'`, and §1.3 makes an
`audio` clip illegal on a video track, so today the change is *defensive*. Make it anyway:

```ts
if (clip && frame < clipEnd(clip) && clipHasVideo(clip)) return clip.id;
```

Reason: the invariant currently rests on `clipKind` being consulted by every write path. A hand-edited
`.veproj`, or a future action that forgets, would put an audio-only clip on a V-track and the preview
would try to composite it. One `&&` removes the dependency. Both selectors stay `[stable]` — the
predicate is O(1) and allocates nothing.

#### 1.7.2 Audio monitor — `monitorAudible`, the `<video>` element's gain, and the voice budget

**This is the load-bearing change.** Without it, a detached pair is audible **twice**: once from the
`<video>` element carrying the video-only clip, and once from the `<audio>` voice carrying the twin.

`src/components/preview/audioMonitor.ts:171`:

```ts
export const monitorAudible = (clip: Clip, track: Track, media: MediaItem): boolean =>
  clipHasAudio(clip) &&          // ← added, first, because it is the cheapest and the most decisive
  media.status === 'ready' &&
  media.url !== '' &&
  media.hasAudio &&
  !track.muted &&
  clip.properties.volume > 0;
```

`audioMonitor.ts` already imports from `../../types/model`; `clipHasAudio` joins `clipEnd` in that
import. No new dependency, no store import, and the function stays pure — which is what lets
AUDIO-MONITOR §8.1's table-of-numbers assertion keep working.

That covers every `<audio>` voice (`AudioTrackVoice.tsx:101,106` and `useAudioMonitor.ts:256` all
route through it). The `<video>` element does **not** route through it, so it needs its own edit at
`src/components/preview/VideoSurface.tsx:240`:

```ts
// The clock clip's audio is carried by the <video> element and by nothing else
// (AUDIO-MONITOR §2.3). A video-only clip must therefore reach the gain law as
// volume 0, or the detached half is heard from the element that draws it.
const clipVolume = clip !== null && clipHasAudio(clip) ? clip.properties.volume : 0;
```

Writing it here rather than inside `effectiveGain` is deliberate: `effectiveGain` is the gain *law*,
asserted against a table of numbers, and it takes scalars rather than a clip. Adding a clip-shaped
argument to it would make that assertion untestable.

`useAudioMonitor.ts:432` needs no change — it is downstream of `monitorAudible` at line 256, which
already excluded the clip from `audioVoices`/`videoVoices`.

**One more line, in `useAudioMonitor.ts`: the voice budget's reserved slot.** It gains a
`clipHasAudio` import from `../../types/model` for it — a value import, same as `audioMonitor.ts`'s.
`useAudioMonitor.ts:275` reads

```ts
const budget = Math.max(0, MAX_AUDIBLE_SOURCES - (clockClipId !== null ? 1 : 0));
```

reserving one of the eight slots for the `<video>` element whenever `selectVideoClipIdAtFrame`
returns anything. After a detach the picture half is still the clock clip, so the slot is still
reserved — but that element has just been forced to gain 0 three lines away in `VideoSurface`, so the
reservation is spent on silence. On a dense timeline the user loses a monitored voice and can be told
*"Only 8 clips are monitored at once"* (line 279-284) one clip early. Gate the reservation on the
clock clip actually carrying audio, mirroring the `clipVolume` change exactly:

```ts
const clockClip = clockClipId !== null ? s.clips[clockClipId] : undefined;
const clockAudible = clockClip !== undefined && clipHasAudio(clockClip);
const budget = Math.max(0, MAX_AUDIBLE_SOURCES - (clockAudible ? 1 : 0));
```

Low stakes on its own; it is here because it is the *same fact* — "does the clock clip make sound" —
and reading it two different ways ten lines apart is how the two drift.

**Divergence check.** AUDIO-MONITOR.md's §1.1 comment says `track.kind`, `track.visible`,
`track.locked` and `opacity` are *deliberately absent* from the monitor predicate, mirroring
EXPORT §1.4. `streams` is being added to **both** predicates in the same commit and with the same
meaning, so the mirror is preserved rather than broken. That is the test to apply to any future
addition here.

#### 1.7.3 Export graph — `electron/export/graph.ts`

Two words, at `graph.ts:286-288`:

```ts
const wantsVideo =
  track.kind === 'video' && track.visible && props.opacity > 0 && nEnd > nStart && clipHasVideo(clip);
const wantsAudio = !track.muted && props.volume > 0 && clipHasAudio(clip);
```

`contributesAudio = source.hasAudio && wantsAudio` is unchanged, so the file/edit split EXPORT.md
insists on is preserved: `hasAudio` remains a property of the **file**, `volume`, `muted` and now
`streams` are properties of the **edit**.

**Import note, because PLAN §1.2 makes this a hazard.** `graph.ts` currently imports `Clip` with
`import type`. `clipHasVideo`/`clipHasAudio` are **values**, so this becomes a value import:

```ts
import { clipHasAudio, clipHasVideo } from '../../src/types/model';
```

That resolves at runtime because `tsconfig.electron.json` already compiles `src/types/model.ts` into
`dist-electron/src/types/model.js` and preserves the source tree beneath `dist-electron` — the same
mechanism that makes `import { CH } from '../src/types/api'` work. `graph.ts` stays a pure module:
`model.ts` has no React, no DOM and no node import, which is exactly why PLAN §1.2 permits it in the
electron build.

**`exportDocument.ts` needs no change.** It copies `Object.values(s.clips)` verbatim, so `streams`
crosses the structured-clone boundary as a plain string on a plain object. `validateRequest` in
`electron/ipc/export.ts` checks the document's *shape* (`Array.isArray(doc.clips)`) and not each
clip's fields, so it needs no change either — and it should not gain one: the graph builder is where
clip-level rules live.

**Why the audio-only twin exports with no extra plumbing.** Its `mediaId` points at a video file, so
`ExportSource.kind` is `'video'` and `hasAudio` is true. The graph opens that .mp4 as an ordinary
input and reads `[i:a]`. `wantsVideo` is already false because the clip is on an audio track. It
takes its index in pass two (§1.4 of EXPORT.md, the audio-only-contributors pass) and produces one
`[a<i>]` branch. Nothing about the audio path knows or cares that the file also contains pictures.

#### 1.7.4 Timeline clip appearance — `src/components/timeline/Clip.tsx`

See §1.8 for the design. Mechanically: `Clip` subscribes to one more primitive,

```ts
const streams = useEditorStore((s) => {
  const c = s.clips[id];
  return c ? clipStreams(c) : 'av';
});
```

`[stable]` — it returns a string primitive, so `React.memo` still holds and a pointermove still
causes zero renders here.

**Five edits follow, and the first one is the one that makes §1.8's icon channel exist at all.**

- **`showStateIcons` gains `|| streams !== 'av'`.** The *icon* strip — not the thumbnail strip two
  bullets down — is currently gated by

  ```ts
  // Clip.tsx:136-137
  const showStateIcons =
    showIcons && (offline || warned || trackLocked || trackMuted || trackHidden);
  ```

  A detached clip on an unlocked, unmuted, visible track whose media is online and warning-free
  satisfies **none** of those — which is the normal case, the one this whole feature exists for. Left
  as it is, the icon strip is never rendered, the stream glyph never appears, and §1.8's table
  quietly degrades to lane plus accessible name. So:

  ```ts
  const showStateIcons =
    showIcons && (offline || warned || trackLocked || trackMuted || trackHidden || streams !== 'av');
  ```

- **`iconSlots` gains `+ (streams !== 'av' ? 1 : 0)`.** Two slots become three: source-state
  (offline / warning), **stream**, track-state (locked / muted / hidden). This is not bookkeeping —
  `fitClipName` is handed `paintWidth - NAME_CHROME_PX - iconSlots * ICON_SLOT_PX` (`Clip.tsx:145-148`),
  so an un-widened budget is 16 px too generous and brings back exactly the middle-truncation
  regression that comment was written to prevent. `NAME_CHROME_PX` and `ICON_SLOT_PX` themselves are
  unchanged; only the count moves.

  ```ts
  const iconSlots = showStateIcons
    ? (offline || warned ? 1 : 0)
      + (streams !== 'av' ? 1 : 0)
      + (trackLocked || trackMuted || trackHidden ? 1 : 0)
    : 0;
  ```

- **The glyph itself is inserted between the source-state and track-state glyphs**, inside
  `.tl-clip-icons`, so the strip reads source → stream → track in the same order `iconSlots` counts
  them: `{streams === 'audio' ? <AudioLines size={14} strokeWidth={1.75} /> : null}` and the `Film`
  equivalent for `'video'`. No `data-tone` — this is not a status (§1.8).
- `showStrip` gains `&& streams !== 'audio'`. **This is not cosmetic.** The strip is
  `media.thumbnailUrl`, and the media is a video file, so without this the detached audio clip renders
  video thumbnails on an audio lane — the interface asserting something false.
- `states` (the accessible name) gains `audio only` / `video only`.

#### 1.7.5–1.7.8 The four that need nothing, stated so they are not re-investigated

| Consumer | Why nothing changes |
|---|---|
| `SnapEngine.ts`, marquee, `planMove`, `planTrim` | Kind-agnostic geometry. A clip's edges are its edges. |
| `clampClipsToSource`, `markClipsOffline` | Keyed on `mediaId` and source length. Both halves share a `mediaId`, so both go offline together and both clamp together — which is right. |
| `recomputeOfflineClips` | The function is unchanged, but it is **called once after the transaction** by `detachAudio` — same reason and same shape as `splitAtPlayhead` (`timelineSlice.ts:713`). A detach mints a clip id and `offlineClipIds` is keyed by clip id. See §1.4. |
| `selectTimelineDurationFrames` | Reads the last clip's `clipEnd` per track. Unchanged. |
| `serializeProject`, `PERSISTED_MEDIA_KEYS` | Clips are written whole; the media key list is about `MediaItem`, not `Clip`. **No scaffold edit is required for persistence.** |

### 1.8 Telling the three kinds apart without hue

The requirement is that a video-only clip and an audio-only clip be visibly distinguishable, and that
the distinction not rest on colour. Four channels carry it, none of them hue, listed in the order they
survive as a clip narrows.

| Channel | `av` | `video` (detached picture) | `audio` (detached sound) | Survives to |
|---|---|---|---|---|
| **Lane** | its own | a V-track | an **A-track** | every width |
| **Accessible name** | — | `…, video only` | `…, audio only` | every width |
| **Thumbnail strip** | present when the media has one | present | **suppressed** | ≥24 px |
| **Icon** | none | `Film` | `AudioLines` | ≥16 px |

**No new texture, no new token, no new colour.** PLAN §7.6's texture table has four entries at four
distinct angle/pitch pairs and is described as closed; a fifth angle would sit within 30° of two
existing ones and stop being distinguishable at a glance, which is the property the table exists to
guarantee. Textures also encode *state* — locked, muted, offline, warning — and `streams` is not a
state, it is what the clip **is**. Overloading the channel would make "muted" and "audio-only" argue.

**Position does most of the work, and that is by design.** PLAN §7.6 ranks contrast, position, shape
and label above hue; an audio-only clip is on a different lane from every video clip, which is the
strongest signal available and costs nothing. That a detached audio clip looks like an ordinary audio
clip is correct — it *behaves* like one, and inventing a mark to distinguish them would be a
distinction with no consequence.

**Icons name what the clip contains, not what it lacks.** `AudioLines` for sound, `Film` for picture.
The alternative vocabulary — `VideoOff` / `VolumeOff` — was rejected twice over: `VolumeX` already
means *track muted* in this exact icon strip (`Clip.tsx:195`) and a second volume-with-a-slash glyph
would collide with it at 14 px; and a negative glyph on a clip that is working normally reads as an
error state. `av` clips carry no stream icon at all, because the default must be silent — a mark on
all forty clips is noise, and PLAN §7.6's whole degrade ladder assumes the icon slot is usually empty.

**Below 16 px, a video-only clip is not distinguishable from an `av` clip.** Stated, accepted, and
bounded: at that width no clip in this app carries any signal except texture, and "this clip's sound
is unused" is an ordinary editorial fact rather than a failure state that PRODUCT.md's colour-blind
clause governs. The audio-only twin sitting directly beneath it, at the same start and the same
duration, is itself the strongest available indication that the clip above is silent. The accessible
name carries the fact at every width, so it is never *lost*, only not glanceable.

CSS: the clip root gains `data-streams={streams === 'av' ? undefined : streams}`, matching the
existing `data-selected` / `data-offline` / `data-tiny` convention. `timeline.css` needs no rule for
it in this build — the attribute exists so a future rule has a hook and so the DOM is inspectable —
which keeps the change to icons and the strip, both of which are React, not CSS.

### 1.9 Where the action lives

#### The clip context menu — new surface

There is no timeline context menu today. `src/components/media/MediaItem.tsx:172-235` is the
precedent and must be followed rather than reinvented: right-click opens at the pointer, the row
takes focus first (the menu acts on what it opened on, so that is where the keyboard returns), and
`ContextMenu` / `Shift+F10` open it at the focused element's bottom-left with the same `GAP_FROM_ROW`
offset. `src/components/ui/Menu.tsx` supplies the popover, the roving tabindex, the seven states, the
`disabledReason` and the shortcut slot; **no new primitive is defined** (PLAN §5).

New file: `src/components/timeline/ClipContextMenu.tsx`. Opened from the lane viewport's existing
delegated handlers — `event.target.closest('[data-clip-id]')`, exactly as `onLanePointerDown` already
resolves a clip at `useTimelineInteraction.ts:864` — so it costs no per-clip listener at forty clips.
A right-press must **not** change the selection when the clip is already selected (matching
`handlePointerDown`'s `if (event.button > 0) return` comment: a context-menu press is not a choice);
when the clip is *not* selected it selects it `replace` first, so the menu never acts on something
invisible.

**Every item is decided over `effectiveIds`, the same set its action will act on.** This is the rule
the rest of the section depends on, so it is stated before the table:

```ts
// ClipContextMenu.tsx — `id` is the clip the menu was opened on.
const effectiveIds: ClipId[] = s.selection.size > 0 ? [...s.selection] : [id];
```

Every one of these four actions already operates on the **whole selection** — `detachAudio` defaults
to it (§1.4), `splitAtPlayhead` splits every selected clip, `deleteSelection` and `rippleDelete`
remove everything deletable in it. Deciding `disabled` from the single clip under the pointer while
the action runs over the selection produces both failure directions: three clips selected, right-click
the one locked member, and all four items appear greyed out while `Delete` on the keyboard happily
lifts the other two; or an enabled `Lift` that silently spares a locked member. §1.9's own rule that a
right-press must not change an existing selection is what makes that divergence *routine* rather than
exotic. The menu explaining itself differently from the shortcut is exactly the failure §1.4 raises
its refusal inside the action to prevent, and this is the same fix applied one layer up. It costs one
expression; the alternative — widening `splitAtPlayhead(ids?)` / `deleteSelection(ids?)` /
`rippleDelete(ids?)` to take an explicit set — is a larger change to three shipped actions for no
behavioural gain, and is **rejected** on that ground.

Items, in order. Every one carries its `ShortcutHint` read from the registry, so a label can never
drift from its keys. Every predicate below quantifies over `effectiveIds`, and every
`disabledReason` names the *set* rather than the clip:

| Item | Shortcut | Disabled when | `disabledReason` |
|---|---|---|---|
| `Detach audio` | `Shift+D` | `selectDetachableClipIds(s, effectiveIds).length === 0` | §1.4's table, same four conditions in the same order |
| — separator — | | | |
| `Split at playhead` | `S` | the playhead is not strictly inside **any** clip in `effectiveIds` | `Park the playhead over a selected clip first` |
| `Lift` | `Delete` | **every** clip in `effectiveIds` is on a locked track | `Track is locked` |
| `Ripple delete` | `Shift+Delete` | **every** clip in `effectiveIds` is on a locked track | `Track is locked` |

§1.4's four sentences are reused verbatim rather than re-worded for the menu. None of them says
"this clip" — they are either imperatives about the selection (*"Select a video clip that still has
its audio"*) or statements about a condition (*"Track is locked"*, *"Those clips have no audio to
detach"*), so all four already read correctly over a set of any size. One copy of the copy, living in
the action, is the whole point of §1.4 owning the refusal; a menu that re-words them is a second copy
that will drift.

Note the quantifiers: `Detach audio` and `Split at playhead` are disabled when *nothing* is eligible,
`Lift` and `Ripple delete` when *everything* is refused — which in each case is precisely the
condition under which the action would do nothing. A partially eligible set leaves the item enabled,
and the action does what it already does today: it acts on the eligible members and refuses the rest
through the notice it already raises. Menu and keystroke then agree by construction, because they are
reading the same predicate over the same ids.

**The items still invoke their actions with no arguments** — `detachAudio()`, `splitAtPlayhead()`,
`deleteSelection()`, `rippleDelete()` — and that is correct rather than sloppy, because the
right-press has already guaranteed `effectiveIds` *is* the selection: an unselected clip was selected
`replace` first, and a selected one left the selection alone. `effectiveIds` therefore only ever
differs from `s.selection` in the one frame before the menu opens, and it exists so the predicates
have something to read. No action signature widens.

Four items and one separator. Nothing else goes in — PRODUCT.md §2 is *depth on demand*, and a menu
that mirrors the whole toolbar is the wall-of-controls anti-reference in miniature. Disabled items
keep a reason rather than an opacity, per PLAN preamble S4.

#### The keyboard binding

PRODUCT.md principle 3 makes the keyboard primary, so this cannot be menu-only.

**Chosen: `Shift+D`, scope `timeline`.**

Collision check against every combo the registry binds today — 27 rows, 28 combos, because
`view.zoomIn` binds both `+` and `=`:

```
Space  J  K  L  ArrowLeft  ArrowRight  Shift+ArrowLeft  Shift+ArrowRight  Home  End
I  O  S  Delete  Shift+Delete  M  Ctrl+Z  Ctrl+Shift+Z  Escape  +  =  -  Shift+Z
Ctrl+I  Ctrl+S  Ctrl+O  Ctrl+E  ?
```

`D` is unbound, and `Shift+D` is unbound. `comboFromEvent` normalises shift-plus-alphabetic to
`Shift+<UPPER>` (`isAlpha` guard, `shortcuts.ts:260`), so pressing shift+d yields exactly
`'Shift+D'`. **No collision.** It is also not adjacent to a destructive binding on the keyboard —
`Shift+Delete` is a reach away — and it is one-handed on the left, where `S`, `M` and `Shift+Z`
already live.

Scope `timeline`, matching `edit.split`, `edit.lift` and `edit.marker`: this is a structural edit on
the timeline selection, and scoping it means it cannot fire while focus sits in the media rail. Not
in `REPEATABLE_SHORTCUTS` — holding it would detach, then find nothing eligible, then raise the same
notice sixty times a second.

**Rejected: `Ctrl+L`,** which is Premiere's Link/Unlink and the closest thing to a category
convention. Chrome binds `Ctrl+L` to the omnibox at the browser-UI level, where a page's
`preventDefault()` does not reach it. The binding would work in the shipped Electron app and fail
silently under `npm run dev:web` — the harness the interface is actually developed in. A shortcut
that behaves differently in the two environments is the exact class of divergence this project's
`isElectron()` discipline exists to prevent. Recorded here so it is not "fixed" later.

**Rejected: `Ctrl+Shift+S`** (Final Cut's Detach Audio) — one keystroke away from `Ctrl+S`, which
saves, with the pinky already on shift. The failure mode is silent and the recovery is a manual undo.

Registry additions, in `src/keyboard/shortcuts.ts` (**not owned by this work** — §7):

```ts
export type ShortcutId = … | 'edit.detachAudio';
export type ShortcutHandlerName = … | 'detachAudio';

// in SHORTCUTS, in the editing block, directly after edit.split:
{ id: 'edit.detachAudio', keys: ['Shift+D'], label: 'Detach audio',
  scope: 'timeline', handler: 'detachAudio' },
```

and one handler in `useShortcuts.ts`: `detachAudio: () => readStore().detachAudio()`. The action
raises its own notice, so the handler has no branch — the same shape as `splitAtPlayhead`.

`ShortcutOverlay` picks the row up automatically from `SHORTCUTS`; no edit there.

### 1.10 Inspector

`src/components/inspector/Inspector.tsx`.

**One line of identity.** Directly beneath the existing `NamePropertyRow`, inside
`.ve-inspector-identity`, a `.type-label` line in `--text-muted` stating the non-default only:

- every selected clip `streams === 'audio'` → `Audio only`
- every selected clip `streams === 'video'` → `Video only`
- otherwise (all `av`, or mixed) → **nothing rendered**

No control, no toggle. It is a statement of what the clip is, in the one panel whose job is to say
what the selection is. It costs one line and it is the only place the fact is *spelled out* rather
than encoded.

**Controls disclose by relevance, and the rule is symmetric.** PLAN preamble S4 and PRODUCT.md §2
both say the answer to an inapplicable control is to not render it, never to disable it. Applied in
both directions:

| When every selected clip is… | Not rendered | Because nothing reads it |
|---|---|---|
| `streams === 'audio'` | the whole `transform` group, the whole `blend` group | scale, position, rotation, opacity |
| `streams === 'video'` | the **Volume** `ClipPropertyRow` inside `timeAndSound` | `monitorAudible` is false (§1.7.2), `VideoSurface`'s `clipVolume` is forced to 0 (§1.7.2), `wantsAudio` is false (§1.7.3) |

The second row is the correction to an earlier draft, which claimed *"`timeAndSound` (speed, volume)
always renders, for every stream value — both fields are live on all three."* Volume is **not** live
on a video-only clip. All three of its readers are gated off by §1.7, so the slider would change a
stored number and produce no audible and no exported effect — which is the *exact* failure §1.4 cites
when it declines to zero the source clip's volume (*"a user who later raised that volume back to
100 % would expect sound and get none"*). Hiding `transform` for audio-only clips on that reasoning
and then declining to apply it in the mirror direction was an inconsistency, not a decision.

`timeAndSound` itself still renders for every stream value, because **Speed is live on all three** —
it retimes the picture, it retimes the sound through `atempo`, and it rescales duration. So no group
ever disappears for a video-only selection, and **`InspectorGroupId` is unchanged**: no new group, no
`uiSlice` change, no `localStorage` migration for `inspectorGroups`.

A **mixed** selection renders everything, unchanged. `updateClipProperties` writes one patch to every
id all-or-nothing; writing `opacity` onto an audio-only clip, or `volume` onto a video-only one, is
inert rather than wrong, and hiding a control because one member of the selection ignores it would
make the panel's contents depend on selection order in a way the user cannot predict.

---

## 2. Feature 2 — Audio-only export

### 2.1 The format set

**Included: AAC in `.m4a`, MP3, WAV.** All three were built and probed against the real fixtures
(§2.10) with the encoder this repo resolves.

| Format | Encoder | Container | Why it is in |
|---|---|---|---|
| **AAC** | `aac` (ffmpeg native) | `.m4a` (`-f mp4`) | The default. Best quality per byte of the three, plays on everything the user owns, and it is the **same encoder and the same `-b:a 192k` the video path already ships** — zero new encoder surface. |
| **MP3** | `libmp3lame` | `.mp3` | The one audio format anything *outside* this machine will ask for by name. Verified present in the resolved build (`ffmpeg -encoders` shows `libmp3lame`), and the packaged app ships the build machine's own binaries via `scripts/stage-ffmpeg.mjs`, so "present here" means "present there". CBR so the size figure in §2.5 is real. |
| **WAV** | `pcm_s16le` / `pcm_s24le` | `.wav` | The lossless handoff into anything else. `pcm_s16le` is already the ProRes path's audio codec, so it too is a format this build has always produced. Its size is *arithmetic*, not an estimate. |

**Excluded, with reasons, because the interesting exclusions are the adjacent ones:**

- **FLAC** — lossless, like WAV, and smaller. It loses to WAV on the only axis that matters for a
  handoff: universal acceptance by whatever the file is being dragged into. Two lossless formats is
  one more than this tool needs.
- **ALAC** — FLAC's argument, minus the compatibility, plus an Apple-only ecosystem. This is a
  Windows build.
- **Opus** — genuinely the best of the compressed options at every bitrate, and it loses on the
  container question: `.opus`, `.ogg` and `.webm` are all defensible and each is wrong somewhere.
  A single-user tool does not need a third compressed format to explain.
- **Any sample rate other than 48 kHz, and any channel count other than 2.** The mix is *constructed*
  at 48 kHz stereo — `aresample=48000` and `aformat=…:channel_layouts=stereo` are inside the
  per-clip chain that EXPORT §1.7 pins and that §2.6 reuses unchanged. Offering 44.1 kHz would offer
  a setting the graph does not honour; changing the graph to honour it would touch the numerically
  verified mix, which is out of scope by a wide margin.
- **A bitrate field.** Three quality steps already map to three bitrates (§2.3). A free-form number
  is one more control on a form whose entire §2.4 story is having fewer.

### 2.2 The codec union

`ExportSettings['codec']` widens; no second field is introduced.

```ts
// src/types/api.ts
export type VideoCodec = 'h264' | 'h265' | 'prores';
export type AudioCodec = 'aac' | 'mp3' | 'wav';

export interface ExportSettings {
  filename: string;
  folder: string;
  width: number;
  height: number;
  fps: number;
  codec: VideoCodec | AudioCodec;
  quality: 'draft' | 'good' | 'best';
  range: 'entire' | 'inout';
}

/** THE discriminator. A value export, like `CH` — main and renderer share it. */
export const isAudioOnlyCodec = (c: ExportSettings['codec']): c is AudioCodec =>
  c === 'aac' || c === 'mp3' || c === 'wav';
```

**Rejected — an orthogonal `kind: 'video' | 'audio'` field.** It creates six combinations of which
three are illegal (`kind: 'audio', codec: 'h264'`), and every consumer — `validateRequest`,
`CONTAINER`, `BITRATE_KBPS`, `buildExportGraph`, the dialog's `Select` — would have to reject the
illegal half. Widening the union makes the illegal states unrepresentable, which is the same argument
`ClipStreams` makes in §1.1 and the same argument `MutationResult` already makes in `timelineSlice`.
It is also the minimum-diff option: `CONTAINER`, `CODECS` and the dialog's `Select` are all already
keyed by codec.

`api.ts` is compiled into `dist-electron` (PLAN §1.2), and `CH` is the precedent for a value export
living there, so `isAudioOnlyCodec` is importable by `graph.ts` and `electron/ipc/export.ts` with no
new build plumbing.

`electron/ipc/export.ts:201` gains three members:

```ts
const CODECS: ReadonlyArray<ExportRequest['codec']> =
  ['h264', 'h265', 'prores', 'aac', 'mp3', 'wav'];
```

`QUALITIES`, `RANGES`, `filenameProblem`, and the `width`/`height`/`fps` validity checks are all
**unchanged** — see §2.4 on why the request still carries a valid resolution.

### 2.3 Containers, encoders and the quality mapping

`CONTAINER` gains three rows, in both of its homes — `src/lib/constants.ts` (renderer, for the
dialog's `Output file` line) and `electron/export/graph.ts:112` (main, for `partPath`/`finalPath`):

```ts
export const CONTAINER: Record<ExportSettings['codec'], string> = {
  h264: 'mp4', h265: 'mp4', prores: 'mov',
  aac: 'm4a',  mp3: 'mp3',  wav: 'wav',
};
```

Encoder arguments. All three rows were run; §2.10 carries the transcripts.

| codec | audio args | container args |
|---|---|---|
| `aac` | `-c:a aac -b:a <B> -ar 48000 -ac 2` | `-f mp4 -movflags +faststart` |
| `mp3` | `-c:a libmp3lame -b:a <B> -ar 48000 -ac 2` | `-f mp3` |
| `wav` | `-c:a <PCM> -ar 48000 -ac 2` | `-f wav` |

`-f mp4` for `.m4a` is verified: exit 0, `format_name=mov,mp4,m4a,3gp,3g2,mj2`, one `aac` stream, no
video stream. `-f ipod` would also work and is rejected — it is a fourth muxer name for a container
the h264 and h265 paths already write, and `-map [aout]` alone is what makes the file audio-only.
`+faststart` is kept for `aac` because `.m4a` *is* the mp4 container and a front-loaded `moov` is
free; it is meaningless for `mp3` and `wav` and is not passed.

Quality is a live control for all three formats — none of them has a dead one:

| quality | `aac` `-b:a` | `mp3` `-b:a` | `wav` `-c:a` |
|---|---|---|---|
| `draft` | `128k` | `128k` | `pcm_s16le` |
| `good` | `192k` | `192k` | `pcm_s16le` |
| `best` | `256k` | `320k` | `pcm_s24le` |

`good` at `192k` is deliberately the same number the h264/h265 paths already pass, so an audio-only
export of a timeline sounds identical to the audio track of a video export of the same timeline —
which makes the two comparable, and makes a regression in one visible against the other. `320k` is
MP3's ceiling and the canonical "best"; `256k` is where AAC stops improving audibly. WAV's `best`
being 24-bit is not decoration: a lossless handoff into a mixing tool is the reason someone picks
WAV, and 24-bit is what that tool wants.

**Constant tables**, in `src/components/export/exportMath.ts` (renderer, for the estimate) and
mirrored in `graph.ts` (main, for the argument). Two copies is the existing pattern —
`CONTAINER` is already duplicated for exactly this reason (a pure `graph.ts` may not import from
`src/lib/`), and §2.5's acceptance test pins them to each other.

### 2.4 The dialog form

`src/components/export/ExportDialog.tsx`.

**The `Codec` row becomes `Format`.** The control now chooses an output *kind*, not a video
compressor; leaving the label as `Codec` would be the dialog misdescribing its own control. Options,
sentence case, each saying what it is rather than what it is called:

```ts
const FORMAT_OPTIONS: ReadonlyArray<{ value: ExportSettings['codec']; label: string }> = [
  { value: 'h264',   label: 'H.264 video' },
  { value: 'h265',   label: 'H.265 video' },
  { value: 'prores', label: 'ProRes video' },
  { value: 'aac',    label: 'AAC audio' },
  { value: 'mp3',    label: 'MP3 audio' },
  { value: 'wav',    label: 'WAV audio' },
];
```

Video first, audio second, and the suffix carries the grouping. No `<optgroup>`: the `Select`
primitive does not have one, adding grouping to a shared primitive for one call site is out of
proportion, and six flat options with a one-word suffix read fine.

**The dialog title changes from `Export video` to `Export`,** for the same reason as the row label.
The `file.export` registry row's label follows (`Export video` → `Export`), which is a
`src/keyboard/shortcuts.ts` edit — §7.

**Two rows disappear when an audio format is chosen.** Not disabled — not rendered:

```tsx
{isAudioOnlyCodec(settings.codec) ? null : (
  <>
    <PropertyRow label="Resolution" htmlFor="ve-export-resolution">…</PropertyRow>
    <PropertyRow label="Frame rate" htmlFor="ve-export-fps">…</PropertyRow>
  </>
)}
```

This is the pattern the component already uses for the `Range` row (`hasInOut ? … : null`), so it is
consistent rather than novel. PLAN preamble S4 forbids opacity-based disabling and requires a
`disabledReason` for anything genuinely disabled; six greyed fields with six copies of "not used for
audio" is precisely the wall of dead controls PRODUCT.md §2 rules out. The form goes from seven rows
to five.

Form order is unchanged for the rows that remain: **File name, Folder, [Resolution], [Frame rate],
Format, Quality, [Range], summary.** The two conditional rows sit *above* `Format`, so choosing an
audio format collapses the form from the middle and the `Format` control itself does not move — the
control the user just operated stays under the pointer. No animation on the height change; the dialog
does not animate today and this must not introduce the first one.

**`settings.width`, `settings.height` and `settings.fps` are retained in state and still sent.** They
are not cleared, not zeroed, not made optional. Three reasons:

1. `validateRequest` requires `isPositiveInt(width)`, `isPositiveInt(height)` and a finite positive
   `fps`. Sending `0` would fail validation with `invalid-request` — a fabricated error for a
   correct request.
2. Making them optional in `ExportSettings` forks the type and every consumer for one code path.
3. Retaining them means switching to WAV and back to H.264 restores the resolution the user chose,
   rather than resetting it to the project default. The dialog is a form; a form that forgets is a
   worse form.

Main ignores both for an audio-only codec — §2.6 and §2.7. The one place the retained `fps` could
have leaked into output is `adelay`, and §2.7 closes it.

Everything else in the dialog is untouched: `sanitiseFilename`, `resolveExportRange`, `browse`,
`startExport`, `cancelExport`, `requestClose`, the job-adoption guard, `PHASE_LABEL`, the footer
button set, and the `InlineNotice` error path. The **accent budget is unchanged** — the `Export`
button remains use 6 of 6 and is still the only primary action in the view.

### 2.5 The estimated size

The current arithmetic is `bitrate × duration × (width·height / 1920·1080)`. For an audio format,
**every term but duration is a fabrication**: there is no resolution, and the video bitrate table is
about pixels. Multiplying by a retained-but-unused 1920×1080 would produce a number that happens to
look right and is right by coincidence; setting resolution to 0 would produce `0 MB`. Both are worse
than branching.

```ts
// src/components/export/exportMath.ts
export const BITRATE_KBPS: Record<VideoCodec, Record<ExportSettings['quality'], number>> = {
  h264:   { draft: 4000,  good: 12000, best: 24000 },
  h265:   { draft: 2500,  good:  8000, best: 16000 },
  prores: { draft: 45000, good: 82000, best: 122000 },
};

/** The literal `-b:a` argument. Not a model — the number main passes to ffmpeg. */
export const AUDIO_BITRATE_KBPS: Record<AudioCodec, Record<ExportSettings['quality'], number>> = {
  aac: { draft: 128, good: 192, best: 256 },
  mp3: { draft: 128, good: 192, best: 320 },
  wav: { draft: 1536, good: 1536, best: 2304 },   // 48000 × 2ch × bytes × 8 / 1000
};

export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;
export const WAV_BYTES_PER_SAMPLE: Record<ExportSettings['quality'], number> =
  { draft: 2, good: 2, best: 3 };

export function estimateBytes(
  settings: Pick<ExportSettings, 'codec' | 'quality' | 'width' | 'height'>,
  durationSeconds: number,
): number {
  // WAV is not an estimate. It is sample rate × channels × width × time, exactly,
  // plus a header under 110 bytes that no display unit here can resolve.
  if (settings.codec === 'wav') {
    return AUDIO_SAMPLE_RATE * AUDIO_CHANNELS *
           WAV_BYTES_PER_SAMPLE[settings.quality] * durationSeconds;
  }
  // aac / mp3: CBR, so this is the bitrate ffmpeg is being told to hit. No pixel term.
  if (isAudioOnlyCodec(settings.codec)) {
    return (AUDIO_BITRATE_KBPS[settings.codec][settings.quality] * 1000 / 8) * durationSeconds;
  }
  const kbps = BITRATE_KBPS[settings.codec][settings.quality];
  const pixelScale = (settings.width * settings.height) / REFERENCE_PIXELS;
  return ((kbps * 1000) / 8) * durationSeconds * pixelScale;
}
```

`BITRATE_KBPS` narrowing from `ExportSettings['codec']` to `VideoCodec` is what makes `tsc` point at
every site that has not been taught about the audio branch. Do not widen it to keep the compiler
quiet. The `wav` row inside `AUDIO_BITRATE_KBPS` is redundant with the exact branch above and is kept
only so the table is total and greppable; the exact branch is authoritative.

**Measured against real files** — the §2.10 rig, 7.000000 s of mixed fixture audio:

| format / quality | predicted | actual (`ls -l`) | error |
|---|---|---|---|
| WAV 16-bit (`good`) | 1 344 000 | **1 344 078** | +78 B (the header) |
| WAV 24-bit (`best`) | 2 016 000 | **2 016 102** | +102 B (the header) |
| MP3 192k CBR (`good`) | 168 000 | **169 492** | +0.9 % (frame headers + the LAME tag) |
| AAC 192k (`good`) | 168 000 | **146 630** | −12.7 % |

So WAV and MP3 are effectively exact, and **AAC is an upper bound** — ffmpeg's `aac` encoder spends
fewer bits than asked on material it finds easy, and on digital silence it collapses entirely
(a 7 s silent AAC export measured **4 161 bytes** against a 168 000-byte prediction). That is not a
defect in the estimate; it is what CBR-requested AAC does.

**The label follows the honesty of the number.** The summary row reads `Size` for `wav` and
`Estimated size` for everything else — one ternary, and it stops the dialog hedging about a figure it
knows exactly:

```tsx
<span className="ve-summary-label type-label">
  {settings.codec === 'wav' ? 'Size' : 'Estimated size'}
</span>
```

`formatBytes` is unchanged. The value keeps `.type-numeric` — it changes as the settings change,
which is exactly what PLAN §7.2's tabular rule covers.

### 2.6 The filter graph — exactly what is shared

**Nothing is rewritten. The audio half of `buildExportGraph` runs unmodified and the video half is
not emitted.** Stated per construct, because "reuse the mix" is only a real commitment if it names
the lines.

#### Shared, byte-for-byte, no branch (`electron/export/graph.ts`)

| Lines | Construct | Note |
|---|---|---|
| 254-263 | `sourceById`, `clipsByTrack`, the per-track `sort((a,b) => a.start - b.start)` | |
| 269-320 | the whole collection loop: range intersection, `headFrames`, `S`, `E`, `timelineFrames` | |
| 252 | `toOut` | becomes the identity for audio-only — §2.7 |
| 298-302 | `sourceInFrames`, `sourceLenFrames`, and the `Math.max(1, …)` guard | |
| 310-311 | `ssSec` / `tSec`, at the **project** rate | a source offset is a time, not a grid position |
| 313 | `startMs` | |
| 288 | `wantsAudio` (as amended by §1.7.3) | |
| 295 | `contributesAudio = source.hasAudio && wantsAudio` | |
| 326-336 | the two-pass input assignment | pass one is empty; see below |
| 347-350 | `anullsrc=…,atrim=duration=…,asetpts=N/SR/TB[abase]` | |
| 179-188 | `atempoChain` | |
| 383-396 | **the per-clip audio chain**, verbatim: `asetpts=PTS-STARTPTS, <atempo>, volume=, aresample=48000:async=1:first_pts=0, aformat=…, adelay=delays=<ms>:all=1[a<i>]` | this is the numerically verified part |
| 398-401 | **the mix**: `[abase][a…]amix=inputs=<1+n>:duration=first:dropout_transition=0:normalize=0[aout]` | `normalize=0` and `dropout_transition=0` are load-bearing and unchanged |
| 403 | `filterScript = lines.join(';\n')`, written UTF-8 no BOM by the caller | |
| 407-412 | argv preamble and the `-ss/-t/-i` triples | |
| 414 | `-filter_complex_script` | |
| 440-441 | `-progress pipe:1 -stats_period 0.25 -nostats`, then the output path | |
| 249-250 | `durationSeconds = durationFrames / F` | the cut is as long as it is |

**One consequence of the shared two-pass assignment worth stating.** Pass one walks
`contributesVideo`, which is uniformly false for an audio-only export, so it contributes nothing and
pass two assigns every index. Input indices therefore **differ** between an audio-only export and a
video export of the identical timeline. That is harmless because the `[a<i>]` labels come off the
same counter, and it is the reason the labels are keyed to the input index rather than to a second
counter (EXPORT §1.4).

#### Not emitted when `isAudioOnlyCodec(req.codec)`

| Construct | graph.ts |
|---|---|
| `color=c=black:…[vbase]` | 343-346 |
| every `[<i>:v]…[v<i>]` chain | 353-365 |
| every `overlay=…` line | 369-379 |
| the terminal `[vc<n-1>]format=<basePixFmt>[vout]` | 380 |
| `-map [vout]` | 415 — the statement pushes both maps and must be split |
| `-c:v`, `-preset`, `-crf`, `-tag:v`, `-pix_fmt`, `-r` | 419-436 — and the `else` at 431 stops being ProRes's catch-all |
| the `CODEC_SHAPE` lookup | 340 — no pixel format exists for an audio codec |
| a non-zero `framesTotal` | 250 — there are no output frames (§2.8) |

Implementation. Forcing the video predicate false is necessary and **not sufficient** — it empties
the two loops and nothing else:

```ts
const audioOnly = isAudioOnlyCodec(req.codec);
…
const wantsVideo =
  !audioOnly &&
  track.kind === 'video' && track.visible && props.opacity > 0 && nEnd > nStart && clipHasVideo(clip);
```

`videoContributors` is then empty, so the per-clip chain loop (353-365) and the overlay loop
(369-379) emit nothing on their own. **Four constructs sit outside those loops and each needs its own
explicit branch.** An earlier draft of this section said three and claimed the terminal `format` line
"follows"; it does not, and the same draft's *"Not emitted"* table above already contradicted it by
listing both 340 and 380. The table is right.

**1 — `CODEC_SHAPE` is narrowed, and the lookup becomes conditional.** `graph.ts:340` reads
`const shape = CODEC_SHAPE[req.codec]` unconditionally. Leave the map typed
`Record<ExportRequest['codec'], CodecShape>` and widening the codec union makes the object literal
non-total, which `tsc` flags at the declaration — the intended signal, and the same mechanism §7.2
uses for `CONTAINER`. But `CONTAINER` legitimately gains three rows (§2.3), so the reflex is to add
three rows here too, and *that* is the trap: an invented `basePixFmt` for `wav` compiles, emits a
`[vout]` label, and ffmpeg then fails on an unconnected filtergraph output. Narrow it instead, so
there is no row to invent:

```ts
const CODEC_SHAPE: Record<VideoCodec, CodecShape> = { h264: …, h265: …, prores: … };
…
// `audioOnly` is the same const declared above, not a second one.
const shape: CodecShape | null = audioOnly ? null : CODEC_SHAPE[req.codec];
```

No cast is needed on that index. `isAudioOnlyCodec` is declared `(c: …) => c is AudioCodec` (§2.2),
`audioOnly` is a `const` holding that call, and `req` is never reassigned — so TypeScript's aliased
dotted-name narrowing gives `req.codec` the type `VideoCodec` in the false arm. If a future refactor
breaks that (reassigning `req`, or turning `audioOnly` into a `let`), the fix is to restore the
narrowing, **not** to add `as VideoCodec` — the cast would put back exactly the runtime hole this
whole item is closing.

**2 — the `[vbase]` push (343-346) is wrapped in `if (!audioOnly)`.**

**3 — the terminal `[vout]` push (380) is wrapped in `if (!audioOnly)`.** This line is *outside* the
`videoContributors.forEach` that ends at 379, so an empty contributor list does not suppress it. Left
alone it dereferences `shape.basePixFmt` on a `null` shape and throws `TypeError: Cannot read
properties of undefined (reading 'basePixFmt')`. That throw lands in `runJob`'s outer catch
(`electron/ipc/export.ts:494`), is classified by `classifyFsError(e, ERR['encoder-not-started'])`,
and tells the user *"The encoder could not be started, so nothing was encoded"* for a perfectly valid
WAV request.

**4 — the encoder tail (419-436) gains an explicit audio branch, and its `else` stops being
ProRes's.** The chain today is `if (h264) … else if (h265) … else { prores }`, so a widened union
sends `aac`/`mp3`/`wav` straight into the ProRes arm — which pushes `-c:v prores_ks` and reads
`shape.basePixFmt` at line 433, i.e. the same crash through a third door. The tail becomes an
explicit four-way branch keyed on `req.codec`, with the three audio arms from §2.3's table.

And the two one-line consequences that ride along with them:

- **`-map`.** `args.push('-map', '[vout]', '-map', '[aout]')` at 415 is a single statement pushing
  both maps; it splits, and only `-map [aout]` (preceded by `-vn`) is pushed when `audioOnly`.
- **`framesTotal`.** `graph.ts:250` is `const framesTotal = Math.max(1, Math.round(durationSeconds * OF))`
  — it can never return 0, which §2.8 requires. It becomes
  `const framesTotal = audioOnly ? 0 : Math.max(1, Math.round(durationSeconds * OF));`. Without this
  edit §2.8's pre-flight change in `ipc/export.ts` is pointless, because `runJob:438` does
  `job.framesTotal = built.graph.framesTotal` and overwrites the 0 straight back to a fabricated
  video frame count.

Six edits, then: two `if (!audioOnly)` wraps around a construct that has nothing to say (2 and 3),
two ternaries (the `shape` lookup and `framesTotal`), one argv statement split (`-map`), and one
`if/else if/else` grown a fourth arm (the encoder tail). Still no parallel code path, and the audio
half is still untouched — but *"the video half disappears on its own"* was wrong, and an implementer
who believes it ships a WAV export that reports an encoder failure for a perfectly valid request.
Acceptance test 20 exists because test 21 diffs a filter script and would never reach the throw.

#### The argv tail

```
-filter_complex_script <temp>/ve-export-<jobId>.txt
-vn -map [aout]
-c:a aac -b:a 192k -ar 48000 -ac 2
-t 7.000000 -movflags +faststart -f mp4
-progress pipe:1 -stats_period 0.25 -nostats
<partPath>
```

**`-vn` is emitted, and it is redundant.** With `-map [aout]` as the only map, no video stream can
reach the muxer. It is passed anyway for the same reason the trailing output `-t` is passed even
though the base's `d=` already fixes the length (EXPORT §1.8): it is a hard statement of intent that
bounds the output even if a future `-map` edit is wrong, and a wrong-shaped file is the failure that
would not announce itself. It costs two argv elements.

`<partPath>` is `path.join(folder, '.' + filename + '.' + ext + '.part')` with `ext` from `CONTAINER`
— unchanged mechanism, three new extensions. ffmpeg is told the muxer explicitly with `-f`, so the
`.part` suffix is irrelevant to it, exactly as it already is for mp4.

### 2.7 `OF = F` for an audio-only export — a correctness fix, not a preference

EXPORT §1.3 sets `OF = out.fps` and says nothing in the emitted graph runs at `F`. With no video
there is **no output frame grid**, and `req.fps` is a retained value from whenever the user last
picked a video format (§2.4). Leaving `OF = req.fps` quantises `adelay` onto a grid that no longer
exists:

```
project F = 30, retained req.fps = 24, a clip at project frame S = 7
  nStart  = round((7/30) × 24) = round(5.6) = 6
  startMs = round((6/24) × 1000)            = 250 ms
  correct = round((7/30) × 1000)            = 233 ms      →  17 ms early, audibly
```

So:

```ts
const F  = doc.fps;
const OF = isAudioOnlyCodec(req.codec) ? F : req.fps;
```

`toOut` becomes the identity, `nStart === S`, and `startMs = Math.round((S / F) * 1000)` — the clip
lands on the project's own grid with no quantisation at all. This is **amendment A2** (§0.2) and must
be recorded in `docs/EXPORT.md` §1.3, because that document currently states the opposite as an
invariant.

`durationSeconds = durationFrames / F` is unchanged and remains the `-t` value and the §2 progress
denominator.

### 2.8 Progress, `framesTotal`, and the frame counter

**Measured, not modelled — unchanged, and it is what makes this feature nearly free.** `-progress`
blocks still arrive, and `out_time_us / durationSeconds` is still the fraction. That expression never
mentioned frames.

Two facts, read off a real audio-only run rather than assumed:

1. **There is no `frame=` key.** With no video stream ffmpeg simply does not emit one. `flushBlock`'s
   `Number(block.frame)` becomes `Number(undefined)` → `NaN` → `Number.isFinite` is false → it takes
   the `Math.round(progress * framesTotal)` branch. No crash, no `NaN` on screen. Verified.
2. **The encoding phase can be exactly one block.** The 7-second §2.10 export ran at 55× and finished
   inside the 250 ms `-stats_period`, so ffmpeg wrote a single block, and that block was
   `progress=end`. The dialog must not assume more than one — it already does not, because it holds
   only the latest event. Worth stating because a bar that goes 0 → 100 in one step looks broken and
   is in fact correct.

`graph.framesTotal` is **0** for an audio-only export. That is the honest answer to "how many output
frames" and `ExportProgressEvent.framesTotal` documents itself as output frames. Consequences, all
benign: `flushBlock`'s `Math.min(job.framesTotal, …)` yields 0; the terminal
`emit(job, 'encoding', 1, job.framesTotal)` yields 0; the finalizing events yield 0.

**That 0 has to be made, not assumed.** `graph.ts:250` is
`const framesTotal = Math.max(1, Math.round(durationSeconds * OF))`, which cannot return 0, so the
edit listed as consequence 6 in §2.6 — `audioOnly ? 0 : Math.max(1, …)` — is what this whole
subsection rests on. It is also the *load-bearing* half of the pair: `runJob` line 438 assigns
`job.framesTotal = built.graph.framesTotal` after the graph is built, so without the graph.ts edit
the pre-flight below is overwritten a few lines later and the dialog is back to a fabricated video
frame count. The dialog omits the counter for audio-only (below), so nothing is visibly wrong — but
`ExportProgressEvent.framesTotal` would be carrying an output-frame count over IPC for a file that
has no frames, and the stub would have to fabricate the same lie to stay indistinguishable.

`electron/ipc/export.ts`'s best-effort pre-flight `framesTotal` at `preparing/0.15`
(`runJob`, line ~407) is kept as well as, not instead of. It covers the window between
`preparing/0.15` and `preparing/0.55`, before the graph exists, and without it the counter flashes a
video frame count and then drops to zero:

```ts
if (isAudioOnlyCodec(req.codec)) job.framesTotal = 0;
else if (req.document && req.document.fps > 0) { …existing… }
```

**The dialog omits the frame counter entirely for an audio-only export.** The `Frame N of M` line is
not rendered:

```tsx
{isAudioOnlyCodec(settings.codec) ? null : (
  <p className="ve-export-frames type-numeric">Frame {…} of {…}</p>
)}
```

Not "Frame 0 of 0", and not a substituted seconds read-out. There are no frames; the percentage and
the determinate bar already state progress, and inventing a second read-out means computing
`progress × durationSeconds`, which is derived rather than reported — the one thing EXPORT §2 forbids
the dialog from doing.

`exportStub` (`dev:web`) must match: it reports `framesTotal: 0` for an audio-only codec, so the
browser harness and Electron render the identical progress panel. The stub and the real bridge being
indistinguishable is EXPORT.md's stated acceptance test for the dialog.

### 2.9 A timeline with no audible audio

**It is not an error, no warning is shown, and a silent file is written.**

The mechanism is already in `graph.ts` and needs one guard relaxed. `if (collected.length === 0)
return ERR['empty-timeline']` at line 322 is correct for a video export — no contributors means an
empty range. For an audio-only export it fires on a perfectly ordinary case: every clip on a muted
track, every clip at `volume: 0`, or every source with `hasAudio: false`.

```ts
// §2.9 — for an audio-only export an empty contributor set is a SILENT FILE, not an
// error. The `durationFrames >= 1` check above already caught the genuinely empty
// request; what is left here is a range that contains picture and no sound, which is
// an ordinary edit.
if (collected.length === 0 && !audioOnly) return { ok: false, error: ERR['empty-timeline'] };
```

The graph then emits `[abase]` and `amix=inputs=1:duration=first:dropout_transition=0:normalize=0`
with **no `-i` arguments at all**. Verified: exit 0, a valid 7.000000 s file of digital silence, and
`sourcePaths` is empty so the §2.3 `access(R_OK)` pre-flight is a no-op that passes.

Keeping `amix=inputs=1` rather than relabelling `[abase]` to `[aout]` is deliberate: the script's
shape is then identical whether there are zero branches or forty, which is one fewer thing that can
be wrong on the path that runs least often.

**This is not a new judgement.** EXPORT §1.2 already decided it for the video path, in these words:
*"An audio stream is always emitted, even for a timeline with no audible clip. … branching the
mapping on 'does anything make sound' is a second code path that would be exercised rarely and
therefore be wrong when it ran."* §2.9 extends the same decision to the case where the audio stream
is the *only* stream. Consistency, not a new rule.

**No pre-flight warning in the dialog, and this is the harder call.** A note reading "nothing in this
range is audible" would be genuinely useful. It would also require the renderer to evaluate
`contributesAudio` — track mute, clip volume, `hasAudio`, range intersection — which is exactly the
second copy of the exclusion rules that EXPORT §1.9 forbids: *"exclusion has exactly one
implementation, in one place, that can be exercised without a browser."* A second copy that drifts
would eventually warn about a file that has sound, or stay quiet about one that does not, and a
lying warning is worse than none. **Rejected on those grounds**, and recorded here so it is not
re-proposed without also proposing a way for main to report audibility back — which would be a
protocol change and is out of scope.

The degenerate case, stated: on a completely empty timeline `resolveExportRange` returns
`durationFrames: Math.max(1, 0)` = 1, so an audio-only export produces a file one project frame long
— 33 ms of silence at 30 fps. Odd, honest, and exactly what the video path already does (a one-frame
black file). Not special-cased.

### 2.10 Worked example D — verified transcript

The audio half of EXPORT §1.8's example A, exported as audio only. Same fixtures, same timeline,
same numbers; the point is that the audio lines are *identical* to A's, which is what "reuse" means.

**Project:** 1920×1080, 30 fps. **Export:** entire timeline, AAC, good. `F = OF = 30` (§2.7).
`durationFrames = 210` → `durationSeconds = 7.000000`, `framesTotal = 0` (§2.8).

| Track | Clip | source | start | dur | mediaIn | speed | volume | `hasAudio` | contributes |
|---|---|---|---|---|---|---|---|---|---|
| V1 | A | `interview_wide_a.mp4` | 0 | 90 | 0 | 1 | 1 | true | audio → input 0 |
| V1 | B | `broll_market_street.mp4` | 150 | 60 | 300 | 1 | 1 | true | audio → input 1 |
| V2 | C | `macro_coffee_pour.mp4` | 60 | 120 | 0 | 2 | **0** | true | **nothing** — `volume === 0` |
| V2 | D | `drone_pass_02.mp4` | 180 | 30 | 0 | 1 | 0.5 | true | audio → input 2 |
| V3 | G | `interview_close_b.mp4` | 0 | 90 | 0 | 1 | 1 | true | audio → input 3 |
| A1 | H | `vo_take_04.m4a` | 30 | 120 | 0 | 1 | 0.8 | true | audio → input 4 |

Note the index shift against example A, per §2.6: in A these clips are inputs 0, 1, **2**, 3, 4, 5
because C takes an input for its picture. Here C contributes nothing at all and never costs a
decoder. G, which in A is an audio-only contributor at index 4, is index 3 here.

**Filter script, verbatim:**

```
anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=7.000000,asetpts=N/SR/TB[abase];
[0:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a0];
[1:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=5000:all=1[a1];
[2:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=0.500,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=6000:all=1[a2];
[3:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=1.000,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=0:all=1[a3];
[4:a]asetpts=PTS-STARTPTS,atempo=1.000,volume=0.800,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=1000:all=1[a4];
[abase][a0][a1][a2][a3][a4]amix=inputs=6:duration=first:dropout_transition=0:normalize=0[aout]
```

There is no `[vbase]`, no `[v<i>]`, no `overlay` and no `[vout]`. Every remaining line is
character-for-character an example-A line with its input index renumbered.

**The argv:**

```
ffmpeg -hide_banner -nostdin -loglevel error -y
  -ss 0.000000  -t 3.000000 -i <dev-media>/interview_wide_a.mp4
  -ss 10.000000 -t 2.000000 -i <dev-media>/broll_market_street.mp4
  -ss 0.000000  -t 1.000000 -i <dev-media>/drone_pass_02.mp4
  -ss 0.000000  -t 3.000000 -i <dev-media>/interview_close_b.mp4
  -ss 0.000000  -t 4.000000 -i <dev-media>/vo_take_04.m4a
  -filter_complex_script <temp>/ve-export-<jobId>.txt
  -vn -map [aout]
  -c:a aac -b:a 192k -ar 48000 -ac 2
  -t 7.000000 -movflags +faststart -f mp4
  -progress pipe:1 -stats_period 0.25 -nostats
  <partPath>
```

**Observed, all four formats, same graph, same inputs:**

| tail | exit | stderr | probe |
|---|---|---|---|
| `-c:a aac -b:a 192k … -f mp4` | 0 | empty | `aac / 48000 / 2ch / 7.000000`, `format_name=mov,mp4,m4a,3gp,3g2,mj2`, **146 630 B**, no video stream |
| `-c:a libmp3lame -b:a 192k … -f mp3` | 0 | empty | `mp3 / 48000 / 2ch / 7.000000`, `bit_rate=193705`, **169 492 B** |
| `-c:a pcm_s16le … -f wav` | 0 | empty | `pcm_s16le / s16 / 48000 / 2ch / 7.000000`, `bit_rate=1536089`, **1 344 078 B** |
| `-c:a pcm_s24le … -f wav` | 0 | empty | `pcm_s24le / s32 / 48000 / 2ch / 7.000000`, `bit_rate=2304116`, **2 016 102 B** |

**The observed `-progress` stream** (AAC run, complete — this is every block ffmpeg wrote):

```
bitrate= 167.6kbits/s
total_size=146630
out_time_us=7000000
out_time_ms=7000000
out_time=00:00:07.000000
dup_frames=0
drop_frames=0
speed=55.1x
progress=end
```

One block, no `frame=` key, and `out_time_us` reaching the **full** 7 000 000 rather than falling one
frame short as it does on the video path — there is no frame period for it to fall short by. The
existing `progress === 'end' → emit(1)` rule covers both.

**The silent case** (§2.9), zero `-i` arguments, `amix=inputs=1`: exit 0, a valid 7.000000 s file.
AAC: **4 161 bytes** — the encoder spending almost nothing on silence, which is why §2.5 calls the
AAC figure an upper bound. WAV: **1 344 078 bytes**, identical to the non-silent WAV, because PCM
size is a function of time alone.

---

## 3. Where the two features meet

### 3.1 A video-only clip in a video export

No special case, and nothing to decide: `clipHasAudio` is false, so `wantsAudio` is false, so the
clip produces no `[a<i>]` branch — arriving at exactly the same place a clip at `volume: 0` arrives
at, through a different door. It still contributes its picture and therefore still takes an input,
which is what EXPORT §1.4's union predicate exists for.

The detached audio twin is described in §1.7.3: an audio-track clip whose source happens to be an
.mp4, contributing one audio branch and no video. Both halves of a detached pair export correctly
with **no change to the export contract beyond the two words in §1.7.3.**

### 3.2 Should a video export be able to drop its audio? No.

Feature 2 invites the symmetric question — if there is an audio-only output, why not a video-only
one, `-an` and no `[aout]`. **Rejected.**

EXPORT §1.2 already answered it: *"An audio stream is always emitted, even for a timeline with no
audible clip. A silent track is normal in a delivered file; branching the mapping on 'does anything
make sound' is a second code path that would be exercised rarely and therefore be wrong when it
ran."* A "no audio" option is precisely that branch, bought deliberately.

It also fails on its own terms:

- The timeline can already express it, three ways: mute the audio tracks, set the volumes to 0, or —
  now — detach and delete. Feature 1 makes the third a two-keystroke operation, which is the *reason*
  the two features interact and the reason a checkbox is redundant rather than merely unnecessary.
- It would need a boolean on `ExportSettings`, creating a combination (`codec: 'wav'` with
  `silent: true`) that is meaningless and that `validateRequest` would have to reject — reintroducing
  the illegal-state problem §2.2 just designed away.
- A muted delivery is unusual enough that making it a *setting* would misrepresent how often anyone
  wants it, and PRODUCT.md §5 says every pixel of surface earns its place.

**So: a video export always carries an audio stream, silent if nothing in the range is audible.
Unchanged from today, restated because Feature 2 makes the question obvious.**

---

## 4. Design and accessibility compliance

Checked against the hard rules rather than asserted.

| Rule | How this work satisfies it |
|---|---|
| No hardcoded colour; semantic tokens only | This work introduces **no colour at all** — no new token, no new texture, no `--status-*` use. `grep -nE '#[0-9a-fA-F]{3,8}\|rgba?\(\|oklch\(\|hsl\('` over the changed files must stay at zero. |
| The accent budget is a closed list of 7 (PLAN §7.4: four families, six uses) | Unchanged. The `Export` button remains the one primary action; the context menu spends no accent (`Menu` renders `checked` as an icon, never a colour); `Detach audio` is an ordinary `MenuItem`. |
| Status is icon + text first, colour third | §1.4's four detach refusals and §1.5's unreachable danger case are all `Notice`s, which already render `AlertCircle` + a title + a sentence with the colour on the border only. Stream identity uses no status colour at all — it is icon + lane + accessible name, and the stream glyph carries no `data-tone` precisely because it is not a status. |
| Live-changing numerals use `.type-numeric` | The `Size` / `Estimated size` value keeps it. The removed `Frame N of M` line took its `.type-numeric` with it. |
| No shadows on in-flow surfaces | The clip context menu is a `Menu`, which really has left the plane and takes the **Popover** shadow — a permitted floating layer, same as the media row's menu. |
| Every interactive element ships all seven states | Every new control is a `MenuItem` from `src/components/ui/Menu.tsx`, or an existing `Select`/`PropertyRow`. **No new primitive is defined.** |
| `prefers-reduced-motion` alternative on every animation | This work adds **no animation**. The form's height change on format switch is a plain relayout; the scroll-into-view after a detach uses the timeline's existing scroll path and inherits its reduced-motion handling. |
| Sentence case | `Detach audio`, `Split at playhead`, `Lift`, `Ripple delete`, `Format`, `AAC audio`, `Audio only`, `Estimated size`, `Export`. No title case, no uppercase except the track labels the model already owns. |
| No modal where an inline affordance works | The detach is a menu item and a keystroke. No confirmation dialog, no "are you sure". The two rows that vanish from the export form vanish inline. |
| One playhead writer, one rAF loop | Untouched. `detachAudio` is a store mutation on `pointerup`/keydown; the `streams` subscription in `Clip` returns a string primitive; `monitorAudible` stays pure and is called from the existing single pass. **Nothing here adds a subscription, a timer or a frame-rate write.** |
| Keyboard operability | `Shift+D` (registry-scoped), `ContextMenu` and `Shift+F10` on a focused clip, and the `Menu` primitive's own roving tabindex and Escape handling. The context menu is reachable with no pointer. |
| Colour-blind safe | §1.8's four channels are lane, thumbnail presence, icon shape, and text. Deuteranopia cannot affect any of them because none is hue. The icon channel is only real because §1.7.4 widens `showStateIcons` — without that edit this row would be asserting a channel that never renders, so acceptance test 13 is what keeps this row honest. |
| Legible at 40 clips × 6 tracks | `Clip` gains one `[stable]` primitive subscription and stays `memo`-clean. The third icon slot is subtracted from `fitClipName`'s budget (§1.7.4), so a name still truncates at its head rather than its middle at 40 clips. The context menu is opened by the existing delegated lane handler, adding zero per-clip listeners. |

---

## 5. Acceptance tests

Ordered so a failure lands close to its cause.

**Feature 1**

1. `migrateProject` on a `.veproj` written before this change returns a project whose every clip has
   `streams === undefined`, and `clipStreams` returns `'av'` for all of them.
2. Open that project, save it, and diff: the `clips` array is byte-identical. No clip gained
   `"streams":"av"`.
3. `migrateProject` on a hand-edited file containing `"streams":"nonsense"` keeps the clip and
   returns `streams: undefined`.
4. `detachAudio` on one V1 clip: the original has `streams: 'video'`; a new clip exists on A1 with
   `streams: 'audio'` and identical `start`, `duration`, `mediaIn`, `name` and `properties`; the
   selection still holds the original; the project is dirty; `history.past` grew by **one**.
5. **The speed case, which is the one a patch-afterwards implementation fails silently.** Detach a
   clip whose `properties.speed` is `2`. The twin's `duration` equals the source clip's `duration`
   exactly — not half of it — and its `properties` compare deep-equal. Repeat at `speed: 0.5` and
   assert the detach is not refused with `no-source`. (§1.3.)
6. `undo` restores both — the twin is gone and the original is `av` again.
7. **Detach three V1 clips that do NOT overlap in time, with only A1 present: all three twins land on
   A1 and `trackOrder.length` is unchanged.** No track is created. This is the test that catches a
   `findAudioHome` reading a captured snapshot instead of `get()` (§1.4, §1.5).
8. Detach two clips that overlap in time on V1 and V2 with only A1 present: two twins land on two
   different audio tracks, A2 is created, and one `undo` removes the twin pair **and** A2.
9. **Detach a clip whose media is in `status: 'error'`: both halves are in `offlineClipIds`,** both
   render `--texture-offline` and the `Unplug` glyph, and both carry `offline` in their accessible
   name. Fails whenever `recomputeOfflineClips()` is missing from §1.4's body.
10. Drag the twin onto a video lane: refused with `kind-mismatch`, nothing moves.
11. `Shift+D` with an empty selection raises `Nothing to detach / Select a video clip first` and
    changes nothing.
12. `Shift+D` inside the media rail's filename field does nothing (the `TEXT_INPUT_SELECTOR` guard),
    and `Shift+D` with focus in the media rail does nothing (scope `timeline`).
13. **The stream glyph is present on a detached clip with no other state** — an online, warning-free
    clip on an unlocked, unmuted, visible track, at a paint width above `CLIP_MIN_LABEL_WIDTH`.
    `AudioLines` on the twin, `Film` on the picture half. Fails whenever `showStateIcons` was not
    widened (§1.7.4). Assert alongside it that `fitClipName` was given a three-slot budget: the same
    clip's rendered name is 16 px shorter than the same clip at `streams: 'av'`.
14. **Menu and keystroke agree.** Select three clips of which one sits on a locked track, right-press
    the locked one: the selection does not change, and `Lift` is **enabled**. Invoke it; the two
    unlocked clips go, the locked one stays, and the existing refusal notice fires. Then lock all
    three and reopen: `Lift` is disabled with `Track is locked`. Repeat the pair for `Detach audio`
    with one already-detached member. (§1.9.)
15. Play across a detached pair: the sound is heard **once**. Set the video-only clip's `volume` to
    200 % and it is still heard once, at the twin's level. (This is the regression that
    `monitorAudible` and `VideoSurface`'s `clipVolume` exist to prevent.)
16. Delete the video-only clip: the twin plays on, alone. This is the user's stated request, end to
    end.
17. **The inspector's disclosure is symmetric.** With only video-only clips selected, no Volume row
    is in the DOM and the Speed row is; `transform` and `blend` still render. With only audio-only
    clips selected, `transform` and `blend` are absent and both `timeAndSound` rows are present. A
    mixed selection renders every row. (§1.10.)
18. Export that timeline to h264: exactly one `[a<i>]` branch for the twin, `amix=inputs=2`, and the
    picture is black where the video clip used to be.
19. `buildExportGraph` on a document with a `streams: 'video'` clip emits its `-i` and its video
    chain and **no** `[a<i>]` branch.

**Feature 2**

20. **`buildExportGraph` with `codec: 'wav'` returns `ok: true`.** Assert it before diffing anything
    — test 21 only compares a filter script and would never reach the throw at `graph.ts:380`. Then
    assert the negative shape directly: `graph.args` contains no `-map [vout]`, no `-c:v`, no
    `-pix_fmt` and no `-r`; `graph.filterScript` contains no `vbase`, no `vout` and no `overlay`; and
    `graph.framesTotal === 0`. Repeat for `'aac'` and `'mp3'` — `'mp3'` in particular proves the
    encoder tail's `else` is no longer ProRes's catch-all. (§2.6.)
21. Build the §2.10 script in `graph.ts` and diff it against this document, character for character.
    Then build the §1.8-A script and confirm it is **unchanged** — the audio lines must be identical
    modulo input index.
22. `OF = F` regression: a document at `fps: 30`, a request at `fps: 24` and `codec: 'aac'`, a clip
    at `start: 7` → `adelay=delays=233`, not `250`.
23. Choosing an audio format removes the Resolution and Frame rate rows from the DOM (not
    `disabled`, not `aria-disabled`), and switching back restores the previously chosen values.
24. `Size` for `wav`, `Estimated size` for everything else, and the WAV figure matches the written
    file to within 110 bytes.
25. An audio-only export renders no `Frame N of M` line, and the progress bar reaches 100 % from a
    single `progress=end` block without stalling or showing `NaN`. Assert the event too:
    `ExportProgressEvent.framesTotal` is `0` on **every** event of the job, including the ones at
    `preparing/0.15` and after `preparing/0.55` — the pre-flight and the graph must agree (§2.8).
26. A timeline whose every audio track is muted, exported as WAV: exit 0, a valid silent file at the
    chosen path, phase `done` with `outputPath`. **Not** `empty-timeline`.
27. Cancel an audio-only export mid-run: phase `cancelled`, no file at the final name, no `.part`
    left behind. (The `.part` and `settle` machinery is untouched; this proves it.)
28. `dev:web`: the dialog with `codec: 'wav'` renders exactly the same five rows and the same
    progress panel as Electron, driven by `exportStub`.

**Gates:** `npm run typecheck`, `npm run build`, `npm run check` — all three clean, plus the
zero-colour-literal grep.

---

## 6. File ownership — the implementer's list

Files this work creates or edits. Nobody else touches them; if something outside this list needs to
change, it is in §7 instead.

| File | Change |
|---|---|
| `src/state/timelineSlice.ts` | `clipKind` rewrite; `AddClipInput` gains `streams?` / `name?` / `properties?`; `addClip`'s kind check **and** its clip literal, both above the `violatesSource` / `overlapOnTrack` checks; `detachAudio` action; `findAudioHome`; `selectDetachableClipIds`; `clipHasVideo` in `selectVideoClipIdAtFrame` and `selectNextVideoClipIdAfter`. `MoveFailure` is **unchanged** (§1.3). |
| `src/components/timeline/Clip.tsx` | `streams` subscription; `showStateIcons` gains `|| streams !== 'av'`; `iconSlots` gains its third slot; the `AudioLines`/`Film` glyph between the source-state and track-state glyphs; `showStrip` guard; `data-streams`; accessible name. All five per §1.7.4. |
| `src/components/timeline/ClipContextMenu.tsx` | **New.** Four items, one separator, shortcut hints, disabled reasons — every predicate quantified over `effectiveIds` (§1.9). |
| `src/components/timeline/useTimelineInteraction.ts` | `onLaneContextMenu`, plus `ContextMenu`/`Shift+F10` in `onLaneKeyDown`. **`REFUSAL_ICON` and `refusalLabel` are untouched**, because `MoveFailure` does not grow. Worth stating what the earlier draft got wrong here, since the same reasoning will be reached for again: `REFUSAL_ICON` (line 97) *is* a `Record<MoveFailure, …>` and would have failed `tsc`, but `refusalLabel` (107-126) ends in `default: return 'That move was refused'` and is **not** exhaustive — `tsc` would have said nothing about it, and an implementer trusting the promised compiler signal would have shipped a silent fallthrough. If a future change does add a `MoveFailure` member, that `default` must become a `never` assertion in the same commit. |
| `src/components/timeline/Timeline.tsx` | Mounts `ClipContextMenu`, wires the new handler. |
| `src/components/timeline/timeline.css` | Nothing required; `data-streams` exists as a hook. |
| `src/components/inspector/Inspector.tsx` | The identity line; conditional `transform`/`blend` groups; the conditional Volume `ClipPropertyRow` (§1.10). |
| `src/components/inspector/inspector.css` | The identity line's `.type-label` rule, if the existing identity block does not already cover it. |
| `src/components/export/ExportDialog.tsx` | `FORMAT_OPTIONS`; title `Export`; conditional Resolution/Frame rate; `Size`/`Estimated size`; no frame counter for audio. |
| `src/components/export/exportMath.ts` | `BITRATE_KBPS` narrowed to `VideoCodec`; `AUDIO_BITRATE_KBPS`, `WAV_BYTES_PER_SAMPLE`, `AUDIO_SAMPLE_RATE`, `AUDIO_CHANNELS`; `estimateBytes` branches. |
| `src/components/export/exportStub.ts` | `framesTotal: 0` for an audio-only codec. |
| `src/components/export/export.css` | Nothing expected; listed because the form loses two rows. |
| `src/components/preview/VideoSurface.tsx` | `clipVolume` gains the `clipHasAudio` gate. |
| `src/components/preview/audioMonitor.ts` | `clipHasAudio` first in `monitorAudible`. |
| `src/components/preview/useAudioMonitor.ts` | One line: the line-275 voice-budget reservation gates on the clock clip actually carrying audio (§1.7.2). |
| `electron/export/graph.ts` | `CONTAINER` gains three rows; **`CODEC_SHAPE` is narrowed to `Record<VideoCodec, CodecShape>`** and its lookup at 340 becomes conditional; value import from `model.ts`; `audioOnly` flag; `OF = F`; **`framesTotal` is 0 when `audioOnly`** (§2.6, §2.8); `clipHasVideo`/`clipHasAudio` in the two predicates; `if (!audioOnly)` around the `[vbase]` push at 343-346 **and** the terminal `[vout]` push at 380; the `-map` split at 415; the encoder tail at 419-436 becomes an explicit four-way branch whose `else` is no longer ProRes's; the empty-contributor relaxation; the three audio encoder tails; `-vn`. |
| `electron/ipc/export.ts` | `CODECS` gains three members; the pre-flight `framesTotal` is 0 for audio-only. Note that `docs/SAFETY.md` §9.3 adds `hasActiveExport` and `stopExportsSync` to this same file — two areas, one file, disjoint edits; expect the merge. |

`src/components/export/exportDocument.ts` is listed nowhere because it needs **no change** — verified
in §1.7.3.

---

## 7. Cross-area requirements

Changes outside the §6 list. Per PLAN §0.2 the implementer states the exact declaration needed and
codes against it as if it existed; the `tsc` failure is the signal, not a reason to patch around it
locally.

### 7.0 Scaffold — `src/types/model.ts`

`model.ts` is one of the five cross-cutting files PLAN §0.2 names, where **scaffold is the only
editor**. An earlier draft listed it in §6 as a file this work edits directly, which was inconsistent
with the same draft routing `api.ts`, `constants.ts` and `project.ts` through this section. A shared
type addition is precisely what §0.2 exists for. The exact declarations needed, additive only — no
existing declaration changes:

```ts
export type ClipStreams = 'av' | 'video' | 'audio';

// Clip gains one optional field, after `properties`:
  /** Undefined ≡ 'av'. Written only by `detachAudio`; see docs/AUDIO-FEATURES.md §1.1. */
  streams?: ClipStreams;

/** THE reader. Nothing anywhere may write `c.streams ?? 'av'` inline. */
export const clipStreams = (c: Clip): ClipStreams => c.streams ?? 'av';
/** True when this clip puts pixels on the canvas. */
export const clipHasVideo = (c: Clip): boolean => clipStreams(c) !== 'audio';
/** True when this clip puts samples in the mix. */
export const clipHasAudio = (c: Clip): boolean => clipStreams(c) !== 'video';
```

The three readers are **value** exports, which is load-bearing beyond convenience: `graph.ts` imports
two of them, and PLAN §1.2 compiles `model.ts` into `dist-electron/src/types/model.js`, so they
resolve at runtime in the electron build the same way `CH` does. See §1.7.3.

### 7.1 Scaffold — `src/types/api.ts`

```ts
export type VideoCodec = 'h264' | 'h265' | 'prores';
export type AudioCodec = 'aac' | 'mp3' | 'wav';

// ExportSettings.codec widens:
codec: VideoCodec | AudioCodec;

/** Value export, like CH. Imported by graph.ts, ipc/export.ts and ExportDialog. */
export const isAudioOnlyCodec = (c: ExportSettings['codec']): c is AudioCodec =>
  c === 'aac' || c === 'mp3' || c === 'wav';
```

No other change to `api.ts`. `ExportProgressEvent`, `ExportError`, `ExportErrorCode`,
`ExportDocument` and `ExportSource` are all unchanged — worth stating, because "an audio-only export"
sounds like it should need a protocol change and does not.

### 7.2 Scaffold — `src/lib/constants.ts`

```ts
export const CONTAINER: Record<ExportSettings['codec'], string> = {
  h264: 'mp4', h265: 'mp4', prores: 'mov',
  aac: 'm4a',  mp3: 'mp3',  wav: 'wav',
};
```

Adding `AudioCodec` to the union makes this `Record` non-total and `tsc` will point at it — which is
the intended mechanism.

### 7.3 Scaffold — `src/lib/project.ts`

The `streamsOf` sanitiser inside `migrateProject`'s clip mapping, exactly as written in §1.2.
`serializeProject`, `applyProject`, `PERSISTED_MEDIA_KEYS`, `validClip` and `PROJECT_VERSION` are all
**unchanged**, and `PROJECT_VERSION` must stay `1`.

**Known conflict, for scaffold to reconcile rather than discover.** `docs/SAFETY.md` §8 claims
`src/lib/project.ts` as one of its own owned files and its file table states *"`serializeProject`,
`applyProject` and `migrateProject` are unchanged"* while adding `toAutosavePayload` and the three
`AUTOSAVE_*` constants. That sentence is true of SAFETY's edits and false of the file once this
work lands. Both edits apply — they touch disjoint code, SAFETY adds new exports and this adds four
lines inside `migrateProject`'s clip mapping — but **SAFETY's ownership sentence needs correcting**
to "unchanged *by this document*", and scaffold, as the single editor of `project.ts`, is where the
two land. Flagged here rather than left for a merge conflict, because both briefs currently read as
assertions about the same function.

### 7.4 Inspector area — `src/keyboard/shortcuts.ts` and `useShortcuts.ts`

```ts
// shortcuts.ts
export type ShortcutId = … | 'edit.detachAudio';
export type ShortcutHandlerName = … | 'detachAudio';

{ id: 'edit.detachAudio', keys: ['Shift+D'], label: 'Detach audio',
  scope: 'timeline', handler: 'detachAudio' },

// and, following §2.4's title change:
{ id: 'file.export', keys: ['Ctrl+E'], label: 'Export', scope: 'global',
  handler: 'openExportDialog' },
```

```ts
// useShortcuts.ts — one handler, no branch; the action raises its own notice.
detachAudio: () => readStore().detachAudio(),
```

Not added to `REPEATABLE_SHORTCUTS`. `ShortcutOverlay` needs no edit.

### 7.5 Media area — nothing

Stated as a negative because an earlier draft asked for something here. `MediaItem.tsx`'s
module-local `REFUSAL: Record<MoveFailure, string>` (line 62) is **unchanged**: `MoveFailure` does
not grow (§1.3), and `detachAudio`'s one refusal string is written inline in `timelineSlice.ts`
(§1.5) rather than read out of a component in another area. The media area has no work in this
change.

### 7.6 Documentation

| Document | Edit |
|---|---|
| `docs/PLAN.md` §3.1 | The `markDirty()` list gains `detachAudio` (amendment A1). |
| `docs/PLAN.md` §2.4 | The `Clip` interface reproduced there gains `streams?: ClipStreams`, and the note "No `color` on `Clip`" is untouched — `streams` is not hue. |
| `docs/EXPORT.md` §1.3 | Amendment A2: `OF = F` for an audio-only codec, with §2.7's worked 17 ms example. |
| `docs/EXPORT.md` §1.10 | The codec table gains the three audio rows from §2.3. |
| `docs/AUDIO-MONITOR.md` §1.1 | `monitorAudible`'s predicate list gains `clipHasAudio`, alongside the existing note about which fields are deliberately absent. |
| `docs/AUDIO-MONITOR.md` §7.3 | Priority item 1, *"The clock clip (always — it is the picture's own sound)"*, becomes *"always, **when it has one** — a video-only clip carries no sound and takes no slot"*. §1.7.2. |
| `docs/SAFETY.md` §8 file table | Amendment A3: the `src/lib/project.ts` row's *"`migrateProject` … unchanged"* becomes *"unchanged by this document"*. |
| `README.md` "Known limitations" | Two entries: **"Detached audio is not linked to its picture"** (§1.6, worded as a decision) — *replaced by `docs/LINKING.md` §11.7's "Linked clips move as one"* — and **"Audio-only exports always produce a stereo 48 kHz file"** (§2.1). |
| `README.md` feature list | Mention detach audio and the three audio output formats. |

---

## 8. Deliberately left out, with the reopening condition

| Not built | Why | What would change my mind |
|---|---|---|
| ~~Link / unlink~~ | **Built** — `docs/LINKING.md` reversed §1.6. Manual co-selection on every subsequent move was exactly the friction that row named. | — |
| Re-attach audio | The inverse of a lossy operation; it would have to guess which twin belongs to which original. `Link` makes the two halves move together (`docs/LINKING.md` §0.3); it does not merge them back into one `av` clip. | — |
| A fifth clip texture for stream identity | §1.8 — PLAN §7.6's four-texture table is closed on angle/pitch distinguishability | A measured demonstration that a fifth angle survives deuteranopia at 8 px |
| FLAC, ALAC, Opus | §2.1 | A specific destination that refuses WAV and AAC |
| A free-form audio bitrate field | §2.1 — three quality steps already map to three bitrates | — |
| Sample-rate / channel-count controls | §2.1 — the mix is *built* at 48 kHz stereo inside the verified chain | A change to the mix itself, which is a much larger piece of work |
| A "this export will be silent" pre-flight note | §2.9 — it needs a second copy of the exclusion rules, which EXPORT §1.9 forbids | A protocol change letting main report audibility back before the encode |
| `-an` / silent video export | §3.2 — EXPORT §1.2 already decided it, and Feature 1 makes it a two-keystroke edit | — |
| Detaching straight onto a *new* track every time | §1.5 fills existing lanes first, because six tracks is the density target and a new lane per detach reaches it fast | — |
| A progress read-out in seconds for audio exports | §2.8 — it would be derived, and EXPORT §2 forbids the dialog deriving progress | — |
