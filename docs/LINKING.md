# Linking — group and ungroup for detached audio

**Status:** normative. This document specifies one change to a shipped editor: detaching audio stops
producing two independent clips and starts producing a **link group**, and the user gains the two
commands — `Link` and `Unlink` — that make a group a thing they control rather than a thing that
happens to them.

It **replaces** `docs/AUDIO-FEATURES.md` §1.6 ("Linking: rejected, and the pair is fully
independent") and the four sentences elsewhere in that document that rest on it. §11 lists those
edits exactly. **There is no build in which both models exist.**

Where this document and `PRODUCT.md`, `DESIGN.md`, `docs/PLAN.md` or `docs/EXPORT.md` disagree,
**those win**, except at the four points named in §11.2, which are stated amendments rather than
divergences. Where this document and `docs/AUDIO-FEATURES.md` disagree, **this document wins** — that
is what "replaces" means.

Read order: `PRODUCT.md` → `DESIGN.md` → `docs/PLAN.md` → `docs/AUDIO-FEATURES.md` → this file.

Every line number in this document was read out of the tree at `HEAD = 533fd7d`. Every contrast ratio
in §8 was computed from the OKLCH values in `src/styles/tokens.css` through a real sRGB conversion,
and the converter was validated by reproducing DESIGN.md's own published figure for `--text-muted`
on `--surface-raised` (5.31:1, signal) to the last digit.

---

## 0. The argument, and the shape of the answer

### 0.1 What is wrong today

`Shift+D` turns a video clip into a video-only clip and mints an audio-only twin on the next free
audio track. From that instant the two clips have no relationship the store can see. They share a
`mediaId` and nothing else.

Move the picture, and the sound stays behind. Nothing refuses, nothing warns, nothing marks either
clip. The timeline still looks correct — a video clip on V1, an audio clip on A1 — and it is wrong by
however many frames the picture travelled. The user finds out at playback, or at export, or not at
all.

That is a **silent** failure of the one relationship the operation exists to create, and it is the
whole argument. This codebase refuses to clamp silently (`PLAN` §3.4 rule 1), refuses to let a
disabled control stay unexplained (§7.1), and refuses to let a status be carried by colour alone
(§7.6). It should not be willing to let sound drift out from under picture with no signal at all.

`AUDIO-FEATURES.md` §1.6 argued the other way, and its reasoning is worth restating rather than
waving away: linking is not a field, it is a cross-cutting rule every mutation must honour; the user
asked to *delete the picture and keep the sound*, and a joined model makes that the hard path. Both
sentences are true. §1.6 was wrong about which cost is larger, not about what the costs are. The
cross-cutting work is real and is enumerated in §5 of this document — it comes to five mutations and
one selection rule. Silent desync is unbounded.

### 0.2 The model, in five sentences

1. A clip may belong to at most one **link group**, recorded as an optional `linkId` on `Clip`.
2. Naming any member of a group names the whole group: selection, move, trim, split, delete, ripple
   delete and speed all apply to every member, all-or-nothing, in **one** undo step.
3. `Detach audio` links the picture and the sound it cut out. That is the only change to what
   `Shift+D` does.
4. `Unlink` dissolves a group. `Link` forms one from a multi-selection. Nothing else creates or
   destroys a group, and nothing infers one.
5. A group is visible at rest, without hue, without spending the accent budget, at every clip width
   the app renders.

### 0.3 What is deliberately not in scope

- **No sync-offset indicator.** Premiere shows a red frame count on a linked clip that has been
  slipped out of sync. This model has no such state to show: §5 makes an out-of-*start* group
  unrepresentable, because every operation that would change one member's `start` alone either
  applies to all members or is refused. A badge for an impossible state is dead code. (A group whose
  members carry *unequal speeds* can come out of a speed change with unequal durations — §5.6. That
  is not a sync state and needs no badge: it is visible on the timeline as one clip ending before
  another, which is the whole difference between a duration that diverges and a start that does.)
- **No "move into sync" command**, for the same reason.
- **No sync lock on tracks.** Premiere's per-track sync lock decides which tracks a ripple shifts.
  §5.5 solves the same problem with the group itself, which the user already has to think about, and
  adds no second concept to `Track`.
- **No nested groups, and no group-of-groups.** `linkId` is a single optional string, so nesting is
  unrepresentable rather than forbidden — the same argument `AUDIO-FEATURES.md` §1.1 makes for the
  three-valued `ClipStreams` union.
- **No group name, no group colour, no group in the media rail.** A group is a relation between
  clips on the timeline and has no identity of its own to present.
- **No re-attach.** Linking a video-only clip back to its audio twin does not merge them into one
  `av` clip. `Link` makes them move together; it does not undo `streams`.
- **No modifier-drag that slips one member.** §6 is the whole argument.
- **No change to export, to the audio monitor, or to the preview.** §10.

---

## 1. The model change

### 1.1 The field

`Clip` gains one optional field, and `model.ts` gains two readers beside `clipStreams` — which is the
established home for clip-derivation primitives (`clipEnd`, `clipSourceLength`, `clipStreams`,
`clipHasVideo`, `clipHasAudio`). `src/types/model.ts` is scaffold-owned under `PLAN` §0.2, so this is
a **scaffold escalation**; §11.1 restates it as the exact ask.

```ts
/** 'g_' + nanoid. The identity of a link group; it names no other thing. */
export type LinkId = string;

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
  /**
   * The link group this clip belongs to, or absent when it belongs to none.
   *
   * ABSENT means ungrouped. Optional for the same two reasons `streams` is: a
   * .veproj written before this feature has no such key and must stay a valid
   * project file rather than become a migration, and an ordinary clip must not
   * carry a redundant field into every save. Read it through `clipLinkId`.
   *
   * INVARIANT: every LinkId present in the store is carried by at least two
   * clips. A group of one is meaningless and is dissolved at the single choke
   * point that can create one — see §5.1.
   */
  linkId?: LinkId;
}

/** THE reader. Nothing anywhere may write `c.linkId ?? null` inline. */
export const clipLinkId = (c: Clip): LinkId | null => c.linkId ?? null;
/** True when this clip moves with others. */
export const clipIsLinked = (c: Clip): boolean => c.linkId !== undefined;
```

`src/lib/id.ts` widens one union — also a scaffold escalation:

```ts
export function newId(prefix: 'm' | 'c' | 't' | 'k' | 'g'): string
```

**The prefix is `g`, not `l`.** Ids are read in the mono face (`JetBrains Mono`, DESIGN.md §3) where
`l_` and `1_` are near-indistinguishable, and this project's ids are read by humans — they appear in
`data-clip-id`, in a hand-inspected `.veproj`, and in every debugging session through CDP. `g` is
also the honest noun: the id names a *group*, and `Link` / `Unlink` are the verbs that make and break
one.

### 1.2 Why `Clip` and not `ClipProperties`

The same argument `AUDIO-FEATURES.md` §1.1 makes for `streams`, and it holds unchanged.
`updateClipProperties` is the inspector's only write path, it is all-or-nothing across a
multi-selection, and it re-runs the overlap and source checks whenever the patch contains `speed`.
`linkId` is structural: a patch carrying it would be a patch that changes *which clips a later move
moves*, which that action has no vocabulary for. `linkId` is written by exactly three actions —
`linkClips`, `unlinkClips`, `detachAudio` — plus the two structural passes in §5.1 and §5.4.

### 1.3 Two encodings that lost

**Rejected — a `partnerId: ClipId` on each half.** A symmetric pointer pair. It is the obvious shape
for an A/V *pair* and it collapses the moment there are three members: three clips need six
pointers, and every mutation has to keep all six consistent or the graph tears. It also admits the
illegal state where A points at B and B points at C. A shared id admits neither.

**Rejected — a `groups: Record<LinkId, ClipId[]>` collection on `TimelineDoc`.** A real index, O(1)
expansion, and the "≥ 2 members" invariant checkable in one place. It loses on cost of custody:
`TimelineDoc` is what `cloneDoc` copies on every history push, what `withClips` rebuilds, what
`hydrateTimeline` accepts and what every snapshot in a 100-deep undo stack carries. It would need its
own sort/prune discipline exactly as `clipsByTrack` does, and it would introduce a second place a
clip's membership is recorded — which is a second place it can disagree with the first.
`selectLinkedClosure` (§3.1) walks the clip map instead, which is O(clips) once per gesture rather
than per frame. **Revisit only if `selectLinkedClosure` ever has to run on a store write** — that is
`PLAN` §1.3 rule 1's line, and it is where the trade would flip.

**Rejected — no field; infer the group from `mediaId` + `streams` + `start`.** Free, needs no
migration, and wrong in three separate ways. It cannot express a group of clips from *different*
media, which §2 argues is the right scope. It cannot express two independent detached pairs cut from
the same file at the same start on different tracks. And it retroactively invents groups in projects
that were built with the old model, which §4.3 forbids for a stated reason.

---

## 2. What may be grouped: any clips, not only A/V pairs

**A link group is an arbitrary set of two or more clips.** Not a video clip plus its audio twin; not
one clip per track; not one clip per kind. Any two or more.

Five reasons, in decreasing weight.

1. **The mechanism is identical either way.** Everything in §3 and §5 — closure over `linkId`,
   all-or-nothing planning, one undo step, the dissolve pass — is written against "the set of clips
   sharing a `linkId`" and never once asks how many there are or what kind they are. Restricting to
   A/V pairs would add a *validation* rule, a refusal sentence and a special case in `detachAudio`,
   and would remove no code.

2. **The pair-only rule makes real, ordinary edits illegal.** A picture, its detached sound, and a
   room-tone clip the user wants held against both. Two camera angles cut in sync on V1 and V2. A
   title over the shot it belongs to. None of these is exotic and none is an A/V pair.

3. **A pair-only rule needs an answer to a question an arbitrary set never asks.** What happens when
   a video clip that already has a twin is linked to a second audio clip? Replace the twin? Refuse?
   Silently make a triple, which is the arbitrary model anyway? There is no good answer, and the fact
   that the question exists at all is the tell.

4. **Convention is on this side.** Premiere ships `Group` (`Ctrl+G`) over an arbitrary selection
   *and* `Link` over A/V, as two commands with two behaviours. Resolve does the same. Shipping both
   would mean two models on one timeline, which the brief forbids and which `PRODUCT` §2 ("depth on
   demand", not depth twice) argues against independently. Given one, the arbitrary one is a
   superset: it does everything the A/V one does.

5. **`detachAudio` produces the A/V pair as a special case of the general rule**, in one line
   (§4.3). There is nothing to lose.

**The one structural constraint, and it is enforced by the shape rather than by a check:** a clip
belongs to *at most one* group, because `linkId` is a single optional string. Linking a clip that is
already grouped moves it out of its old group and into the new one, and §4.1 states what that does to
the clips it left behind.

**A group may contain two clips on the same track.** A repeated sting at 0 s and at 40 s, linked so
both move together, is a legitimate edit. Nothing in §5 depends on members occupying distinct tracks.

---

## 3. Selection

### 3.1 The expansion rule

> **Naming any member of a group names every member.** Selection expands, in every mode — `replace`,
> `extend` and `toggle` alike — with no exceptions.

One rule, zero exceptions, nothing to remember. A user who clicks a linked clip and sees two clips
select has learned the entire selection model.

```ts
/**
 * [UNSTABLE REFERENCE] readStore() / an action only. THE expansion rule, once:
 * the ids given, plus every clip that shares a linkId with any of them.
 *
 * The early return is not a micro-optimisation, it is the common case: on a
 * timeline with no groups, and on any selection that touches none, this never
 * walks the clip map at all. It is called once per selection change, once per
 * gesture start, once per planner call and once per history restore — never in a
 * rAF body and never on a per-frame path, which is what keeps it off PLAN §1.3
 * rule 1's list.
 *
 * It takes `Pick<StoreState, 'clips'>` rather than the whole store because it
 * reads exactly one field, and because §3.4 has to call it against a history
 * SNAPSHOT — a `TimelineDoc`, which is not a `StoreState` and never will be.
 * Every existing call site passes a full store and still type-checks.
 */
export function selectLinkedClosure(
  s: Pick<StoreState, 'clips'>,
  ids: Iterable<ClipId>,
): ClipId[] {
  const groups = new Set<LinkId>();
  const out = new Set<ClipId>();
  for (const id of ids) {
    const clip = s.clips[id];
    if (!clip) continue;
    out.add(id);
    if (clip.linkId !== undefined) groups.add(clip.linkId);
  }
  if (groups.size === 0) return [...out];
  for (const clip of Object.values(s.clips)) {
    if (clip.linkId !== undefined && groups.has(clip.linkId)) out.add(clip.id);
  }
  return [...out];
}
```

### 3.2 Where it is applied

In `selectMany`, which is the single funnel every selection path already goes through: `select`
delegates to it (`timelineSlice.ts:925-927`), the marquee calls it directly
(`useTimelineInteraction.ts:517`), shift-range calls it (`:921`), and the lane keyboard calls
`select` (`:1100`).

It is applied in exactly one other place, and that place is not a selection path — §3.4.

```ts
// timelineSlice.ts — selectMany, replacing the `valid` line at :931.
selectMany: (ids, mode) => {
  const s = get();
  // Expansion happens HERE and nowhere else. Every selection path in the app —
  // click, shift-range, ctrl-toggle, marquee, keyboard travel, the context
  // menu's pre-selection — funnels through this action, so one call closes the
  // rule for all of them. `selectLinkedClosure` already drops ids that are not
  // in `clips`, which is what the old `valid` filter was for.
  const valid = selectLinkedClosure(s, ids);
  …unchanged from here…
},
```

The `replace` fast path (`:932-935`) compares `valid.length` against `s.selection.size` and returns
early on no change; that comparison is still correct because both sides are now closures.

### 3.3 Three consequences, stated

- **`Ctrl`+click on a member toggles the whole group in or out.** It does not peel one member off.
  There is deliberately no modifier that selects a single member of a group — §6.
- **A marquee that touches one member selects the group**, including members outside the rectangle.
  This is right: a user rippling a region wants the sound that belongs to the picture in it, even
  when the sound sits on a lane the rectangle did not reach.
- **`clearSelection` is unchanged.** Emptying a set needs no closure.

### 3.4 The closure survives undo, or it is not an invariant

`selectMany` is not enough on its own, and the gap is reachable in four keystrokes.

`undo` and `redo` both go through `restore` (`timelineSlice.ts:561-573`), which puts back a whole
`TimelineDoc` — `linkId` included, per §10's history row — and then runs `pruneSelection`, which only
drops ids that no longer exist. It never re-closes. So:

> select a linked pair → `Ctrl+Shift+L` (both clips stay selected, correctly: there is no longer a
> group) → click one clip (`replace`-selects that clip alone, correctly, for the same reason) →
> `Ctrl+Z`.

The group is back and **one** member is selected. The next `Delete` would take half a group and the
next speed change would retime half a group. Every "`s.selection` is already the closure" argument in
§5 would be false, silently, on a path a user reaches by pressing undo.

So `restore` re-closes, and the closure becomes an invariant of the **store** rather than a habit of
one action:

```ts
// timelineSlice.ts — restore, replacing the `selection:` line at :570.
// The closure is taken against the RESTORED doc, not against get(): the snapshot
// is what carries the linkIds being put back, and get().clips is still the doc
// being undone. This is the call that makes selectLinkedClosure take
// `Pick<StoreState, 'clips'>` (§3.1) — a TimelineDoc is not a StoreState.
//
// pruneSelection returns its ARGUMENT when it drops nothing, and this preserves
// that: a restore that changes neither membership nor grouping hands back the
// same Set reference, so `selection` compares equal and nothing re-renders.
const pruned = pruneSelection(get().selection, doc.clips);
const closed = selectLinkedClosure(doc, pruned);
…
selection: closed.length === pruned.size ? pruned : new Set(closed),
```

Two consequences worth stating:

- **Undoing an `Unlink` re-selects the group it restored.** That is the correct read of the gesture:
  the user asked for the group back, and the interface now shows them the group they got.
- **`§5` no longer *depends* on this.** `planMove` (§5.2), `planTrim` (§5.3),
  `selectDeletableClipIds` (§5.5) and `updateClipProperties` (§5.6) each take their own closure over
  whatever ids they are handed. §3.4 is what makes the *selection* honest — the rectangle the user is
  looking at — rather than what makes the mutations correct. A rule enforced in one place and relied
  on in five is a rule that breaks in the sixth.

### 3.5 Focus is not selection

`focusedClipId` (the roving tabindex, `useTimelineInteraction.ts:224`) stays on exactly one clip and
does **not** expand. Focus is where the keyboard is; selection is what the commands act on. Expanding
focus is not even representable — `tabIndex` is per element. `Alt`+Left / `Alt`+Right travel by clip
within a lane and continue to move focus one clip at a time, while the selection each step produces
is the closure. That is the correct pairing and it needs no code beyond §3.2.

---

## 4. The three actions

### 4.1 `linkClips`

```ts
// src/state/timelineSlice.ts — TimelineActions gains two members.
/**
 * Form one link group from `ids`, defaulting to the current selection.
 *
 * The argument is closed over first (§3.1), so linking clip A to one member of an
 * existing group links A to ALL of it — there is no way to end up half joined.
 * Every target leaves whatever group it was in and joins the new one; a group
 * left with fewer than two members is dissolved by §5.1's pass, which is the same
 * pass that handles deletion.
 *
 * ONE history entry. Refuses whole, never partially (PLAN §3.4 rule 1).
 */
linkClips(ids?: ClipId[]): void;
```

```
linkClips(ids?):
  s = get()
  targets = selectLinkedClosure(s, ids ?? s.selection)          // closure FIRST
  if targets.length < 2:              setNotice(linkRefusal); return
  if any target sits on a locked track: setNotice(locked);      return

  linkId = newId('g')
  pushHistory()
  set({
    ...withClips(docOf(s), targets.map(id => ({ ...s.clips[id], linkId }))),
    selection: new Set(targets),        // see below
  })
  markDirty()
```

**Selection becomes the new group.** Not "unchanged". After the call, clicking any member selects all
of them, so the selection must already say so — otherwise the very next click would appear to *add*
clips the user thought were already selected. This is the one action whose closure can be larger than
what the user had selected (case: two selected clips, one of which was already in a group with a
third), and leaving the third out would be the interface lying about what it just did.

**A locked track refuses the whole call, rather than excluding that clip.** Two reasons. Rule 1: a
mutation applies whole or changes nothing and returns a reason — silently excluding a member would
produce a group the user did not ask for and cannot see the boundary of. And a group containing a
locked member cannot move at all (`planMove` refuses on `origin.locked`), so allowing it would build
a group that refuses every subsequent gesture with a message about a lock the user has forgotten
setting.

Refusal copy, `setNotice`, `tone: 'warning'`, checked in this order:

| Condition | Title | Message |
|---|---|---|
| the closure holds fewer than two clips | `Nothing to link` | `Select two or more clips first` |
| any target is on a locked track | `Could not link` | `Track is locked` |

**No refusal for "these are already linked to each other".** Re-linking an existing group mints a new
`LinkId` over the same membership: the document changes, one history entry is pushed, and the user
sees exactly nothing change. That is a harmless no-op with a cost of one undo slot, and inventing a
fourth refusal sentence to prevent it would be more surface than the thing it prevents.

### 4.2 `unlinkClips`

```ts
/**
 * Dissolve every link group any clip in `ids` belongs to, defaulting to the
 * current selection. Ungrouped clips in `ids` are ignored; a call that finds no
 * group at all raises a notice rather than pushing an empty history entry.
 *
 * No closure is needed and none is taken: a group is already the unit, and the
 * ids are only ever read for the LinkIds they carry.
 *
 * ONE history entry.
 */
unlinkClips(ids?: ClipId[]): void;
```

```
unlinkClips(ids?):
  s = get()
  groups = { clip.linkId for id in (ids ?? s.selection) if s.clips[id]?.linkId !== undefined }
  if groups.size === 0: setNotice({warning, 'Nothing to unlink', 'Select a linked clip first'}); return

  members = [clip for clip in Object.values(s.clips) if groups.has(clip.linkId)]
  pushHistory()
  set(withClips(docOf(s), members.map(stripLinkId)))       // `const { linkId: _drop, ...rest } = clip`
  markDirty()
```

**Selection is unchanged**, and after the call it holds every former member — which is exactly the
state the user needs, because it makes the next click meaningful: clicking one of them now selects
that clip alone.

**A track lock does NOT block an unlink, and the asymmetry with §4.1 is deliberate.** Unlinking
removes a constraint; it can only ever make more operations legal, and it changes no clip's geometry.
Refusing it on a lock would strand a user who locked a track and then needed to break a group that
reaches into it, with no way out but to unlock, unlink and relock.

**The key strips the key; it does not set it to `undefined`.** `{ ...clip, linkId: undefined }` leaves
an own property that shows up in an `in` check, in `Object.keys().length`, and — worst — in
`JSON.stringify`, where it is *dropped*, so the in-memory clip and the saved clip would disagree about
their own shape. `migrateProject` already establishes the rest-destructure idiom for exactly this
reason at `src/lib/project.ts:246`; this follows it.

### 4.3 `detachAudio`, rewritten

The eligibility rule (`selectDetachableClipIds`), the placement ladder (`findAudioHome`), the refusal
table and the `revealLane` reveal are all **unchanged** from `AUDIO-FEATURES.md` §1.4–§1.5. Two things
change: the twin joins a group with its source, and the two clips are written in **one** `withClips`
call instead of two writes.

```
detachAudio(ids?):
  before = get()
  targets = selectDetachableClipIds(before, ids)      // UNCHANGED
  if targets.length === 0: setNotice(detachRefusal(before, ids)); return
  sort targets ascending by (track index, start)      // UNCHANGED — deterministic undo

  beginHistory('Detach audio')
  pairs = []
  for clip of targets:
     trackId = findAudioHome(get(), clip)             // UNCHANGED — re-reads get() every pass
     result = addClip({ mediaId, trackId, start, duration, mediaIn,
                        name, properties, streams: 'audio' })   // NO linkId passed
     if !result.ok: abortHistory(); setNotice(…); return
     pairs.push({ source: clip, twinId: result.id })

  // ONE atomic write for every linkId this operation assigns. Both halves of a
  // pair acquire their group in the same `withClips`, so the ">= 2 members"
  // invariant is never even momentarily false and §5.1's dissolve pass — which
  // runs on every call — cannot strip a half-built group out from under this
  // action. Writing the twin's linkId through `addClip` instead would create
  // exactly that one-member window.
  next = []
  for { source, twinId } of pairs:
     linkId = source.linkId ?? newId('g')             // join the picture's existing group, or mint one
     next.push({ ...source, streams: 'video', linkId })
     next.push({ ...get().clips[twinId], linkId })
  set(withClips(docOf(get()), next))

  commitHistory(); recomputeOfflineClips(); markDirty(); revealLane(get(), lastHome)
```

**`source.linkId ?? newId('g')` is the whole of §2's "special case of the general rule".** If the
picture was already linked to something else, its new sound joins that group and everything continues
to move together. If it was not, the pair becomes a group of two. Two targets that already shared a
group both read the same existing `linkId`, so both twins join it and the group grows to four — which
is correct and is one undo.

**`AddClipInput` gains nothing.** An earlier shape passed `linkId` through `addClip` alongside
`streams`, `name` and `properties`. It is withdrawn: `addClip` commits before it returns, so the twin
would exist in a group of one for the length of one loop iteration, and every reader of the store in
that window — including §5.1's pass, which is inside `withClips` — would be entitled to dissolve it.
Assigning both ends in one write removes the window instead of documenting it.

**The cost to the workflow that motivated the original feature, stated plainly.**
`AUDIO-FEATURES.md` §1.4 leaves the selection on the originals so that *"delete the video while
keeping the audio"* is two keystrokes: `Shift+D`, `Delete`. Under linking, `Delete` now removes the
group — both halves. The task becomes four steps:

> `Shift+D` → `Ctrl+Shift+L` → click the picture → `Delete`

That is the price, it is paid on a deliberate and comparatively rare intent, and it buys the common
case: keeping sound under picture, which previously cost a hand-made multi-selection on **every**
subsequent move and now costs nothing. `Selection after the action` stays as §1.4 specifies —
unchanged, on the originals — which after §3.2's expansion means the pair.

---

## 5. Every mutation under grouping

The single rule the rest of this section implements:

> **The sync invariant.** No operation may change one member's `start` without applying the identical
> frame delta to every member of its group. `duration` and `mediaIn` are governed by the same rule
> **for a trim**. `duration` under a **speed** change is not governed and is not uniform: each member
> rescales from its own old speed (§5.6), so members that carried different speeds come out with
> different durations — which is visible on the timeline, unlike a start that drifts. `trackId` is
> deliberately **not** governed either: a lane carries no timing, so a group may span any lanes and
> members may change lanes independently.

The invariant is about `start` first because `start` is what silent desync *is*. A duration that
diverges is visible on the timeline as one clip ending before the other. A start that diverges is
invisible and is heard, once, at the wrong moment.

### 5.1 The dissolve pass — where a group of one dies

`withClips` (`timelineSlice.ts:279-314`) is the single funnel through which clip records are added,
replaced and removed. It gains one pass, and that pass is why no other action in this document has to
remember anything:

```ts
// timelineSlice.ts — inside withClips, between the removal/insert loops and the
// clipsByTrack rebuild.

// A LinkId carried by fewer than two clips is a group of one, which means
// nothing and would make `selectLinkedClosure` return a set of one — i.e. a
// clip that renders the link rail and behaves as if ungrouped. Enforced HERE,
// at the one funnel, rather than at the actions that can produce one —
// removeTrack (which deletes a lane's clips without consulting a group),
// splitAtPlayhead (whose right side can be a single half, §5.4) and unlinkClips:
// a rule spread over call sites is a rule the next call site will forget.
// deleteSelection and rippleDelete can no longer reach it at all — §5.5 makes
// their delete set a whole number of groups — but they run through this funnel
// too, and the pass is what keeps that a belt rather than a load-bearing
// assumption.
//
// The gate is exhaustive, not a heuristic. A group's census can change only if a
// member is written INTO it, written OUT of it, or deleted — and those are the
// three disjuncts. An edit that touches no grouped clip therefore never walks
// the clip map, which is every ordinary move, trim and property change on an
// ungrouped timeline.
const touchesGroup =
  removed.some((id) => doc.clips[id]?.linkId !== undefined) ||
  next.some((c) => c.linkId !== undefined || doc.clips[c.id]?.linkId !== undefined);

if (touchesGroup) {
  const census = new Map<LinkId, ClipId[]>();
  for (const clip of Object.values(clips)) {
    if (clip.linkId === undefined) continue;
    const list = census.get(clip.linkId);
    if (list) list.push(clip.id);
    else census.set(clip.linkId, [clip.id]);
  }
  for (const members of census.values()) {
    if (members.length >= 2) continue;
    for (const id of members) {
      const { linkId: _drop, ...rest } = clips[id];
      clips[id] = rest;
    }
  }
}
```

No `touched.add` is needed: dissolving changes neither `trackId` nor `start`, so `clipsByTrack` is
untouched. The clip *record* is replaced, which is what `Clip.tsx`'s
`useEditorStore((s) => s.clips[id])` subscribes to, so the rail disappears on the next render without
any further plumbing.

**`renameClip` writes `set({ clips })` directly (`:1210`) and bypasses `withClips`.** That is safe and
stays as it is: a rename cannot change any group's membership. It is noted here so the next reader
does not have to re-derive it.

### 5.2 Move

`moveClips` already plans a group of ids all-or-nothing and already refuses whole on the first
blocked member. **Two changes, and then nothing else.**

**(a) `planMove` closes its own moving set, exactly as `planTrim` does (§5.3).**

> **AMENDED — this closure now lives in `planPlacement`, and `planMove` is one of three callers.**
> CREATIVE §12 added insert-and-push, which needed every placement rule this section describes —
> the link closure, the lock on origin and target, the kind match, the lane offset, `start >= 0` —
> and differs from a move in exactly one respect: what it does about a collision. `planMove`
> refuses; `planInsert` cascades the occupants to the right. So the shared part was extracted into
> `planPlacement` and both planners call it, which is why the code below now sits there rather than
> in `planMove`. The rule and the reasoning are unchanged; a second copy of the placement rules is
> precisely how the ghost and the drop would start disagreeing about which drops are even legal.
> The third caller is `insertSelectionAtPlayhead`, the `V` command, which reaches it through
> `insertClips`.

```ts
// timelineSlice.ts — planMove, first line of the moving-set build at :440.
// The two dry-run planners have ONE rule between them: the caller names clips,
// the planner moves groups. Relying on §3.2 to hand this function whole groups
// would make it correct for the drag path and wrong for every other caller —
// `moveClip(id, next)` passes a bare `[id]`, and it is public API on
// TimelineActions (:142). A planner that desyncs a group when called directly is
// a planner with a trap in it.
const members = selectLinkedClosure(s, ids);
for (const id of members) {
  const clip = s.clips[id];
  if (clip) moving.push(clip);
}
```

The closure is idempotent, so the drag path — which already hands over a closed selection — plans
exactly what it planned before, and `MoveGesture.els` (collected from the same selection at
`:937-946`) still covers every clip the plan moves. §12 gate 6 asserts this rule rather than an
accident of the caller.

**(b) The vertical delta becomes kind-scoped, and `planMove` takes the gesture's primary track.**

```ts
export function planMove(
  s: StoreState,
  ids: readonly ClipId[],
  deltaFrames: number,
  deltaTrackIndex: number,
  primaryTrackId: TrackId | undefined,
): PlanResult;

moveClips(
  ids: ClipId[],
  deltaFrames: Frames,
  deltaTrackIndex: number,
  primaryTrackId: TrackId | undefined,
): MutationResult;
```

Inside the per-clip loop, `deltaTrackIndex` applies only to clips whose kind matches `primary.kind`
(the resolved primary track, below); every other clip keeps its `trackId` and takes the horizontal
delta alone.

This is required, not a nicety. Without it, dragging the picture of a V1/A1 pair up to V2 sends the
sound to A2, and on a project whose only audio lane is A1 the whole move is refused `no-track` and
falls back to the origin lane — so a detached pair could never change video lane at all, which is the
single most common thing a user does with layered picture. It is also *correct* independently: a
lane offset is a spatial fact about the lane the pointer is over, and applying a video-lane offset to
an audio clip was never anything but an unexamined coincidence of the two lists being indexed the
same way.

It changes one existing behaviour: an ungrouped marquee selection spanning V and A lanes, dragged
vertically, used to shift both kinds and now shifts only the dragged clip's kind. That is the better
behaviour on its own merits — nothing in the gesture expressed an intent to move the audio lanes, and
`applyMove` already refuses to compute a cross-kind `deltaTrack` at all
(`useTimelineInteraction.ts:346-349`).

The parameter is **required, not optional** — its *type* admits `undefined`, its *arity* does not —
so `tsc` enumerates every call site rather than leaving one silently on the old semantics. The
complete list, which the earlier draft of this section got wrong in both directions:

| Function | File | Passes |
|---|---|---|
| `moveClips` | `timelineSlice.ts:706` | its own parameter, straight through to `planMove` |
| `moveClip` | `timelineSlice.ts:693` | `clip.trackId` |
| `endGesture` | `useTimelineInteraction.ts:695` | `g.primaryTrackId` (held since `pointerdown`, `:955`) |
| the `,` / `.` nudge | `useTimelineInteraction.ts:1187` | see below — **there is no gesture here** |
| `applyMove` | `useTimelineInteraction.ts:357, 362, 366` | `g.primaryTrackId` — `planMove`, not `moveClips` |
| `largestLegalDelta` | `useTimelineInteraction.ts:1419, 1425` | its caller's `deltaTrack` and `g.primaryTrackId` — `planMove`, not `moveClips` |
| `check-timeline-guards.mjs` | `:129, :130, :133` | a real `trackId` — §11.4, and it is **untyped**, so `tsc` will not find it for you |

**The nudge has no gesture and therefore no primary track**, which is the case the earlier draft did
not have an answer for:

```ts
// useTimelineInteraction.ts — the `,` / `.` nudge at :1187.
// deltaTrackIndex is 0 here, and kind-scoping only ever decides WHICH lane list
// an index offset is applied to — at offset 0 every member resolves to its own
// track whatever the primary is. So any member's track is correct; focus is the
// honest one when it resolves, and the first moving id is the fallback.
const primaryTrackId = s.clips[focusedClipId ?? '']?.trackId ?? s.clips[ids[0]]?.trackId;
const result = s.moveClips(ids, delta, 0, primaryTrackId);
```

**And `planMove` fails closed when the primary track does not resolve**, so a missed JavaScript call
site is loud instead of silently degraded:

```ts
// timelineSlice.ts — planMove, after the isFiniteFrames guard at :437.
// Without this, `s.tracks[undefined]?.kind` is undefined, no clip's kind ever
// matches it, and every clip silently keeps its trackId — a vertical drag that
// quietly becomes a horizontal one. The gate scripts are .mjs bundled by
// esbuild: they will not fail typecheck and they will not throw.
const primary = primaryTrackId !== undefined ? s.tracks[primaryTrackId] : undefined;
if (!primary) return { ok: false, reason: 'no-track', blockingClipId: null };
```

**(c) Nothing else.** `planMove`'s existing pairwise overlap check across the moving set already
covers the case where two members of one group would land on top of each other, and its
all-or-nothing return already covers a member with nowhere to land.

**The "one member has nowhere to land" case, concretely.** Group `{V1@100, A1@100}`, dragged from V1
to V2 where V2 does not exist: `planMove` returns `{ ok: false, reason: 'no-track' }`, the drag ghost
shows the existing `no-track` refusal badge, and `applyMove`'s existing fallback (`:362-369`) drops
back to the origin lane so the group still moves horizontally under the pointer. No new refusal, no
new copy, no new code — the behaviour that was already correct for a multi-selection is correct for a
group because a group *is* a multi-selection as far as this function can tell.

### 5.3 Trim

`planTrim` (`:488-532`) becomes group-aware, in place rather than in a second function — it is the one
implementation both the pointermove dry run and the pointerup commit use, and a second one would let
the ghost and the commit disagree.

```
planTrim(s, id, edge, nextFrame):
  clip = s.clips[id];  … existing guards (missing clip, missing track, locked track) …

  // The delta the named edge travelled, computed once, from the named clip.
  delta = edge === 'in' ? round(nextFrame) - clip.start
                        : (round(nextFrame) - clip.start) - clip.duration

  members = selectLinkedClosure(s, [id])
  for member of members:
     if s.tracks[member.trackId]?.locked: return { ok:false, reason:'locked', blockingClipId: member.id }
     if edge === 'in':
        start    = member.start + delta                     ; if start < 0        → out-of-range
        duration = member.duration - delta                  ; if duration < 1     → out-of-range
        mediaIn  = member.mediaIn + round(delta * memberSpeed) ; if mediaIn < 0    → no-source
     else:
        duration = member.duration + delta                  ; if duration < 1     → out-of-range
     if violatesSource(s, updated) → no-source
  // Overlap is checked against everything EXCEPT the whole member set, not just `id`.
  for updated of members: overlapOnTrack(s, updated.trackId, updated.start, clipEnd(updated), new Set(memberIds))
  return { ok: true, clips: updated[] }
```

`PlanResult.clips` is already `Clip[]`, so the signature does not change and `trimClip` needs no edit
at all — it already does `set(withClips(docOf(get()), plan.clips))`.

**The ghost has to follow, and it cannot read the plan to do it.** `TrimGesture` currently holds one
`el` and `applyTrim` writes `left` / `width` to it (`useTimelineInteraction.ts:445-450`). Two facts
decide the shape of the fix:

1. `applyTrim` **never reads `plan.clips`**. It recomputes `start` / `end` / `duration` itself from
   `frame` and the one named clip (`:441-443`). The plan is consulted only for `ok` and `reason`.
2. On the refusal path — which is the *common* path, since every trim drag ends by pushing past
   something — there is **no plan at all**: `applyTrim` discards the failed one and re-derives
   `frame` from `largestLegalTrim` (`:436`).

So the members' ghosts are derived from the same `delta` §5.3's planner uses, not from a plan:

```ts
// useTimelineInteraction.ts — applyTrim, replacing the single-element write at
// :441-450. `frame` is already resolved by here, legal or clamped — and the
// clamp is group-legal for free, because `largestLegalTrim` binary-searches the
// group-aware `planTrim` above.
const delta = g.edge === 'in' ? frame - clip.start : frame - clipEnd(clip);
for (const { id, el } of g.members) {
  const m = s.clips[id];
  if (!m) continue;
  const start = g.edge === 'in' ? m.start + delta : m.start;
  const duration = Math.max(1, g.edge === 'in' ? m.duration - delta : m.duration + delta);
  el.style.left = `${framesToPx(start, s.zoom)}px`;
  el.style.width = `${Math.max(CLIP_MIN_RENDER_WIDTH, framesToPx(duration, s.zoom))}px`;
  if (guide !== null && !reducedRef.current) el.dataset.snapping = 'true';
  else delete el.dataset.snapping;
  if (reason) el.dataset.refused = 'true';
  else delete el.dataset.refused;
}
```

`delta` is defined identically to the planner's, so the ghost and the commit cannot disagree: `in`
gives `frame - clip.start`, `out` gives `frame - clipEnd(clip)`, both against the **named** clip.

```ts
interface TrimGesture extends Common {
  …
  /** The primary. Kept for the badge's lane and for `id`; it is also in `members`. */
  el: HTMLElement;
  /**
   * Every member with a rendered element, primary included, PAIRED — not two
   * parallel arrays. A member scrolled out of the lane has no element, and
   * `MoveGesture.els`'s trick of dropping it silently (`:943`) works there only
   * because a move writes the same transform to every element. A trim writes a
   * DIFFERENT geometry per member, so a dropped element that shifted the indices
   * would paint one member with another member's edge.
   */
  members: { id: ClipId; el: HTMLElement }[];
}
```

`members` is collected at `pointerdown` from `selectLinkedClosure(s, [id])`, in that order, by the
same `querySelector('[data-clip-id="…"]')` walk `MoveGesture` uses at `:939-946`. A member with no
rendered element is **skipped**, never a reason to abort the gesture — it is off screen, the commit
still moves it, and the next render paints it correctly.

`el` stays as the *primary*, because the trim badge is positioned against the primary's lane (`:457`)
and a badge per member would be four badges on a group of four. `data-snapping` and `data-refused`
go on **every** member, because the refusal is the group's, not the primary's.

`selectSnapTargets`' exclusion set (`:905`) widens from `new Set([id])` to the member set, or a
member's own edge becomes a snap target for the trim that is moving it.

**One copy fix follows from the group closure**, and it is the drag-ghost twin of §5.6's inspector
one. A trim can now be refused `locked` because a *member* is on a locked track while the clip under
the pointer is not, and the ghost's badge would say `Track is locked` about a track the user is not
touching. The existing guard returns `blockingClipId: null` when it is the named clip's own track
(`:501`) and §5.3 above returns `blockingClipId: member.id` when it is a member's, so the two cases
are already distinguishable at the call site:

```ts
// useTimelineInteraction.ts — refusalLabel's 'locked' case at :115-116.
case 'locked': {
  const name = blockingClipId ? s.clips[blockingClipId]?.name : undefined;
  return name ? `${name} is on a locked track` : 'Track is locked';
}
```

### 5.4 Split

`splitAtPlayhead` produces two clips from one. A group crossed by the playhead must produce **two**
groups — the left halves and the right halves — or the left half of the picture would still be linked
to the right half of the sound and moving one would drag a clip from the other side of the cut.

`AUDIO-FEATURES.md` §1.2 says *"`splitAtPlayhead` needs no change"* because `{ ...clip, … }`
propagates `streams` to both halves by construction. That claim is true of `streams` and **false of
`linkId`** — the identical construction is exactly the bug here. §11.2 scopes the sentence.

```ts
// timelineSlice.ts — inside splitAtPlayhead, replacing the loop body at :767-781.

/** One fresh LinkId per source group, minted lazily so an ungrouped split allocates nothing. */
const rightLink = new Map<LinkId, LinkId>();
const rightLinkFor = (g: LinkId): LinkId => {
  const existing = rightLink.get(g);
  if (existing !== undefined) return existing;
  const minted = newId('g');
  rightLink.set(g, minted);
  return minted;
};

for (const clip of targets) {
  …left and right built exactly as today…
  // The LEFT half keeps the original group; the RIGHT halves of one source group
  // form a new one. Both halves inherit `linkId` from `{ ...clip }`, so the right
  // half is REASSIGNED rather than assigned.
  if (clip.linkId !== undefined) right.linkId = rightLinkFor(clip.linkId);
  next.push(left, right);
  if (selection.has(clip.id)) selection.add(right.id);
}

/** The clips the loop above actually cut. Everything else in a split group is below. */
const splitIds = new Set(targets.map((c) => c.id));

// A member the playhead does not cross is not split, and it has to pick a side —
// otherwise the left group keeps a member that lies wholly to the RIGHT of the
// cut, and moving the left half of the picture drags an untouched clip a second
// away. `start >= at` is the test: a member that straddles `at` was split above,
// and a member wholly left of `at` stays in the original group with no write.
//
// There is deliberately no lock check in this loop. It cannot need one: the
// whole-group lock rule stated below runs BEFORE any of this and drops any group
// carrying a locked member that is not wholly left of the cut, so every clip this
// loop writes is on an unlocked track by construction.
for (const [source, minted] of rightLink) {
  for (const clip of Object.values(s.clips)) {
    if (clip.linkId !== source) continue;
    if (splitIds.has(clip.id)) continue;   // already handled by the loop above
    if (clip.start >= at) next.push({ ...clip, linkId: minted });
  }
}
```

**A group is split whole or not at all, and a lock on any member the split would *write* blocks the
whole group.**

The split writes exactly two kinds of member: the ones the playhead crosses, which become two clips,
and the ones at or after the playhead, which the migration pass above re-links. A member that ends
at or before the playhead (`clipEnd(member) <= at`) is never written at all, so a lock there is
irrelevant and must not block anything. That partition is exhaustive, which is what lets the rule be
one sentence: **a lock on any member that is not wholly left of the playhead blocks its group.**

This is the rule the earlier draft applied to crossed members only — which left the migration loop
free to rewrite `linkId` on a clip the user had locked. That is a document mutation applied to a
locked clip, which no other action in this file does, and it built exactly the
group-containing-a-locked-member that §4.1 refuses to create on the stated grounds that it "would
build a group that refuses every subsequent gesture with a message about a lock the user has
forgotten setting."

```ts
// timelineSlice.ts — after the `consider` walk at :743-744, before the
// `targets.length === 0` ladder at :750.
const grouped = new Set<LinkId>();
for (const clip of targets) if (clip.linkId !== undefined) grouped.add(clip.linkId);

const lockedGroups = new Set<LinkId>();
if (grouped.size > 0) {
  for (const clip of Object.values(s.clips)) {
    const g = clip.linkId;
    if (g === undefined || !grouped.has(g)) continue;
    if (clipEnd(clip) <= at) continue;               // never written; a lock here is not a lock on us
    if (s.tracks[clip.trackId]?.locked) lockedGroups.add(g);
  }
}

let blockedLinked = false;
if (lockedGroups.size > 0) {
  const kept = targets.filter((c) => c.linkId === undefined || !lockedGroups.has(c.linkId));
  blockedLinked = kept.length !== targets.length;
  targets = kept;                                    // `targets` becomes a `let`
}
```

**The refusal is never silent, whether or not the rest of the timeline still splits.** This is the
one place where the existing per-clip lock skip is not a good enough model. Today a locked clip under
the playhead is skipped in silence and the rest split, which is the pre-existing contract for
*ungrouped* clips and this document does not widen it. But a group dropped for a lock withholds clips
that are **not** locked and that the user can see are under the playhead — press `S`, watch most of
the timeline cut, and one pair silently does not. §0.1 makes "refuses to clamp silently" the argument
for the whole feature.

So `blockedLinked` raises a notice on **both** paths — the one where `targets` is now empty and the
one where other clips still split. It is a notice, not a refusal: the split still happens for
everything else.

| Condition | Title | Message |
|---|---|---|
| a group was dropped for a lock (`blockedLinked`) | `Could not split` | `A linked clip is on a locked track` |
| `targets` empty, `blockedByLock` (the pre-existing per-clip skip) | `Could not split` | `Track is locked` |
| `targets` empty, nothing under the playhead | `Nothing to split` | `Park the playhead over a clip first` |

Checked in that order, so the sentence names the cause the user cannot see rather than the one they
can. One cause, one sentence, whether it refused everything or only a pair.

```ts
// The existing early return at :750 keeps its shape; `blockedLinked` takes
// priority inside it, and gets a second, non-returning site after the write.
const linkedLockNotice = { tone: 'warning', title: 'Could not split',
                           message: 'A linked clip is on a locked track' } as const;
if (targets.length === 0) {
  get().setNotice(blockedLinked ? linkedLockNotice : blockedByLock ? … : …);
  return;
}
…the split, exactly as today…
if (blockedLinked) get().setNotice(linkedLockNotice);
```

**A right group of one dissolves itself.** Group `{A, B}` where the playhead crosses `A` and `B` lies
wholly to the left: the right side is `{A_right}` alone. §5.1's pass runs inside the very
`withClips` this loop feeds and strips it. Nothing here has to count.

`recomputeOfflineClips()` is already called after the split (`:787`) because a split mints clip ids;
that is unchanged and covers the new right halves for the same reason.

### 5.5 Delete, and ripple delete

#### The delete set is a closure, and a lock on a member refuses the whole call

Both actions ask `selectDeletableClipIds(s)` what to remove, and that selector is where the group
rule belongs — it is already the one place the lock rule lives, so it is the one place the group rule
can live without being written three times.

```ts
// timelineSlice.ts — selectDeletableClipIds at :1338.
// The closure is taken HERE rather than being assumed of `s.selection`. §3.4
// keeps the selection closed, but a selector that would silently halve a group if
// the selection ever were not is a selector with a trap in it — and the keyboard
// layer's focus hand-off asks this same question, so it gets the same answer.
for (const id of selectLinkedClosure(s, s.selection)) {
  const clip = s.clips[id];
  if (clip && !s.tracks[clip.trackId]?.locked) out.push(id);
}
```

That closure alone is **not** enough, and this is the defect the earlier draft shipped. The filter
above drops every clip on a locked track. A group with one member on a locked track therefore
deletes its unlocked members, leaves the locked one standing, and §5.1's dissolve pass strips the
survivor's `linkId` — a silent, partial application of an operation §0.2 rule 2 declares
all-or-nothing, with no notice at all, because the existing notice only fires when the whole set is
empty. §4.1 refuses to *create* a group with a locked member for exactly this reason; but
`toggleLock` after a link, and §5.4's split, both produce one.

So both actions refuse whole:

```ts
/**
 * A member of a group the selection touches that a track lock protects, or null.
 * Delete is all-or-nothing across a group (§0.2 rule 2), and a lock is the one
 * thing that can make that impossible.
 */
export const lockedLinkedClipId = (s: StoreState): ClipId | null => {
  for (const id of selectLinkedClosure(s, s.selection)) {
    const clip = s.clips[id];
    if (clip?.linkId !== undefined && s.tracks[clip.trackId]?.locked) return id;
  }
  return null;
};
```

`deleteSelection` and `rippleDelete` both call it **first**, before `selectDeletableClipIds`, and on
a hit set a notice and change nothing:

| Condition | Title | Message |
|---|---|---|
| any member of a touched group is on a locked track | `Could not delete` | `A linked clip is on a locked track` |

It is checked first so the sentence names the cause the user cannot see. An *ungrouped* selected clip
on a locked track keeps today's behaviour exactly — silently excluded, and the existing
`Could not delete` / `Track is locked` notice only when that leaves nothing to remove.

**`deleteSelection` needs nothing else.** Deleting a group removes every member in one history entry,
and `withClips`'s removal path plus §5.1's pass handle any *other* group that loses members to the
same call. `removeTrack` remains the one action that can orphan a member without asking — deleting a
lane is a deliberate destructive act on everything in it — and §5.7 states how the dissolve pass
covers it.

#### Ripple delete

**`rippleDelete` needs a real change**, because closing a gap moves clips that were not selected, and
it moves them **per track**. A downstream group whose members sit on tracks that ripple by different
amounts would come out of the operation desynced and still grouped — the exact state §5's invariant
forbids.

This is not caused by arbitrary grouping. Strict A/V pairs have it too: delete a `{V1, A1}` pair from
the head, and a downstream `{V1, A2}` pair sees V1 shift and A2 not shift at all, because nothing was
removed from A2.

One fact from the rule above makes the whole of what follows tractable: **every surviving group is
whole.** The delete set is a closure and a lock refuses the call, so no group is ever half removed.
`perGroup` below is therefore a statement about a complete membership, not about whichever members
happened to survive.

```
rippleDelete():
  if lockedLinkedClipId(s): setNotice(lockedLinkedRefusal); return   // NEW — above
  removing = selectDeletableClipIds(s).map(id => s.clips[id])        // now a closure
  if empty: existing lock notice; return                             // UNCHANGED

  // Step 1 — today's per-clip shift, computed exactly as it is now, per track,
  // for every surviving clip on a track something was removed from. A clip with
  // nothing removed before it has an entry of 0, not no entry — step 2 needs to
  // tell "did not move" apart from "was not considered", and both are 0.
  perClip: Map<ClipId, Frames> = { for each surviving clip on an affected track:
                                     sum of removed durations wholly before it }

  // Step 2 — a group moves as one or not at all, and "not at all" is the answer
  // far more often than the earlier draft assumed. See below.
  perGroup: Map<LinkId, Frames> = for each group among the surviving clips:
      members = every clip carrying that LinkId          // whole, by the rule above
      if every member has (perClip.get(member.id) ?? 0) > 0:  max over members
      else:                                                   0

  shiftOf(clip) = clip.linkId !== undefined ? (perGroup.get(clip.linkId) ?? 0)
                                            : (perClip.get(clip.id) ?? 0)

  // Step 3 — validate. Per-track ripple could never collide (order is preserved
  // and everything moves left by a non-increasing amount), which is why the
  // current implementation has no check at all. A group shift moves clips on
  // tracks that had no removal, so it can.
  candidate = withClips(docOf(s), shifted, removingIds)
  if any shifted start < 0:      setNotice(…); return    // change NOTHING
  if firstOverlap(candidate):    setNotice(…); return    // change NOTHING

  pushHistory(); set({ ...candidate, selection: EMPTY_SELECTION })
  markDirty(); recomputeOfflineClips()
```

**Why a group with any member at shift 0 takes shift 0, and does not take the max.** The earlier
draft applied the group maximum to every member unconditionally, including members that lie *before*
the removed clips or on tracks nothing was removed from. Those members get dragged backwards by a
shift that belongs to a downstream member, and step 3 then refuses — permanently, for an edit §2
offers as the motivating case for arbitrary grouping. Concretely: the repeated sting at 0 s and at
40 s, linked so both move together. Ripple-delete anything between them and the 0 s member is pushed
to a negative start, so the operation refuses **forever**, with copy that names no clip, no track and
no remedy.

A member at shift 0 is a member with nothing removed before it. It has no room to move left and no
reason to: the gap that closed is not in front of it. So the group holds still, which is:

- **uniform**, so the invariant holds — every member takes the same shift, and that shift is 0;
- **safe by construction**, because nothing that was already left of the removal moves, so this
  branch can neither push a start negative nor collide with anything;
- **the pre-linking behaviour**, exactly, for every group that spans the cut.

The residue is genuinely impossible rather than merely awkward: a group whose members are all
downstream, on tracks that freed different amounts, where the largest shift does not fit some
member's lane. That refuses — and now says what to do about it.

```ts
/**
 * The first adjacent pair that overlaps, or null. O(clips): `clipsByTrack` is
 * sorted ascending by start with no overlaps in a valid doc, so checking adjacent
 * pairs is sufficient — a clip that overlaps a non-adjacent one necessarily
 * overlaps the one between them.
 *
 * It returns the PAIR, not one id: the refusal copy has to name the linked clip,
 * and either of the two may be the linked one.
 */
function firstOverlap(doc: TimelineDoc): { id: ClipId; previousId: ClipId } | null {
  for (const ids of Object.values(doc.clipsByTrack)) {
    for (let i = 1; i < ids.length; i += 1) {
      const a = doc.clips[ids[i - 1]];
      const b = doc.clips[ids[i]];
      if (a && b && b.start < clipEnd(a)) return { id: b.id, previousId: a.id };
    }
  }
  return null;
}
```

The existing `Math.max(0, clip.start - delta)` clamp at `:909` is **removed** and replaced by the
refusal. A clamp is what desyncs: it silently gives one member a shorter shift than its partner. It
was safe under per-track ripple (nothing could go negative) and is not safe under group shift, so it
goes rather than being kept "just in case" — a clamp nothing can reach is a clamp nobody will notice
becoming reachable.

Refusal copy, `setNotice`, `tone: 'warning'`. Both name the clip and both name the remedy — the
earlier draft's copy named neither, which on a refusal the user cannot otherwise diagnose is the same
failure as a silent clamp with better manners:

| Condition | Title | Message |
|---|---|---|
| a shifted start would be negative | `Could not ripple delete` | `` `${name}` would be pushed before the start of the timeline, so unlink it first `` |
| the shifted document overlaps | `Could not ripple delete` | `` `${a}` and `${b}` would overlap after the gap closes, so unlink them first `` |

```ts
// `name` is the clip that went negative — the first one found, in clipsByTrack
// order, so the sentence is deterministic. `a` and `b` are firstOverlap's pair,
// linked one first; when neither carries a linkId (unreachable today, since the
// per-clip path cannot collide) the pair is named in track order.
```

Names, not ids, and no key chord: `refusalLabel`'s `Blocked by ${name}` (`:109-118`) is the
established shape for naming a clip in a refusal, and no notice in this codebase spells a shortcut
out — `Ctrl+Shift+L` is `⌘⇧L` on darwin and a notice is a plain string with no `ShortcutHint` in it.
"Unlink it first" is the actionable half; the command it names is in the context menu, the overlay
and the README keymap.

Both refusals are reachable only through the group shift; the per-clip path can produce neither.

### 5.6 Properties

`updateClipProperties(ids, patch)` is handed the selection by its only caller, and §3.4 keeps that a
closure — but `ids` is a *parameter*, and a parameter is not the selection. One line closes it here
too, on the same principle as §5.2(a) and §5.3:

```ts
// timelineSlice.ts — updateClipProperties, first line of the body.
// `speed` is the one property that changes GEOMETRY: PLAN §2.4 rule 4 rescales
// duration from it, twenty lines below. Every other field here is inert on the
// timeline, and per-member volume is exactly what a user wants — quieting a
// detached sound without touching the picture it is linked to.
const targets = patch.speed !== undefined ? selectLinkedClosure(get(), ids) : ids;
```

**What a group speed change actually does.** `updateClipProperties` writes an **absolute** speed
(`{ ...clip.properties, ...patch }` at `:1176`) and rescales each member's duration by its own
`oldSpeed / newSpeed` (`:1181-1184`). So members that carried the *same* speed come out with the same
duration factor, and members that carried *different* speeds do not. Group `{A: speed 1, duration
100; B: speed 2, duration 100}`, set to speed 4: A becomes 25 frames, B becomes 50.

That is not a defect to fix, and §5's invariant is stated to match it rather than the other way
round. Three reasons:

- **`start` is untouched.** `:1186` writes `{ ...clip, properties, duration }`. The thing the whole
  document exists to prevent — an invisible start drift heard once at the wrong moment — cannot
  happen here. A divergent duration is visible on the timeline as one member ending before another.
- **A detached pair cannot reach the divergent case.** `detachAudio` copies `properties` verbatim to
  the twin (`:823`), so both halves start equal, and every subsequent absolute write keeps them
  equal. The A/V pair — the case this feature exists for — stays in lockstep for free.
- **The alternative is two rules.** Applying a *relative* factor to the closured members would mean
  a group behaves differently from a hand-made multi-selection of the same two clips, in the one
  action the inspector uses for everything. `linkClips` deliberately has no equal-speed check (§4.1),
  so a group of unequal speeds is a thing the user built on purpose; retiming it by a ratio they did
  not type is a second, invisible rule.

**A locked member refuses the whole call**, through the existing early return at `:1174` — which the
closure now reaches, because a linked member on a locked track is in `targets` even when the user
selected only the unlocked one. That returns `{ ok: false, reason: 'locked' }`, and the inspector
renders it inline in the field's error slot through `describeMoveFailure` (`failure.ts:36-37`),
which today says `Track is locked` — true, and useless when none of the clips the user selected is
on a locked track. It gains one distinction:

```ts
// src/components/inspector/failure.ts — the 'locked' case.
// The lock may be on a clip the user did not select and cannot see from here.
// `readStore()` is already imported for `nextClipName`.
case 'locked': {
  const s = readStore();
  const own = ids.some((id) => {
    const c = s.clips[id];
    return c !== undefined && s.tracks[c.trackId]?.locked === true;
  });
  return own ? 'Track is locked' : 'A linked clip is on a locked track';
}
```

**And not a notice**, deliberately: `ClipPropertyRow` calls `updateClipProperties` on every scrub tick
(`:150-157`, `onChange`), so a refusal that raised a notice would raise sixty of them per second of
drag. The field's error slot is the channel that already exists for exactly this, it is `role="alert"`,
and it clears when the selection changes (`:146-148`).

### 5.7 The four passes that touch clips and are exempt

| Pass | Why it needs no group rule |
|---|---|
| `renameClip` | Changes `name`. No geometry, no membership. Bypasses `withClips` and may keep doing so (§5.1). |
| `clampClipsToSource` | Shortens a `duration` whose source no longer covers it. It never touches `start`, so it cannot desync anything in the sense that matters, and it is repairing an already-invalid clip: preserving a link's duration relationship at the cost of leaving a clip pointing past the end of its file would be preserving a fiction. A detached pair shares a `mediaId` and clamps identically anyway. |
| `markClipsOffline` / `recomputeOfflineClips` | A projection of media state, keyed by clip id, outside `TimelineDoc` and outside history (`timelineSlice.ts:11-15`). Both halves of a pair share a `mediaId` and go offline together. |
| `removeTrack` | Deletes every clip on the track through `withClips(docOf(s), [], doomed)`, so §5.1's pass runs and dissolves whatever it orphaned. Nothing to add. |

---

## 6. The Alt collision, resolved

`Alt` already has a meaning during a timeline drag: **it suppresses snapping for as long as it is
held, without changing the `snapEnabled` preference.** `altHeld` is written in exactly five places,
all in `useTimelineInteraction.ts`, in source order: every `pointermove` (`:734`), `Alt` keydown
(`:796`), `Alt` keyup (`:808`), the lane `pointerdown` (`:876`) and the ruler `pointerdown` that
begins a scrub (`:1023`). The two keyboard writes are **unconditional** — the ref tracks the physical
key whether or not a drag is in flight; it is only the *re-plan* that follows each of them (`:804`,
`:810`) that is gated on a live gesture, which is what makes pressing or releasing `Alt` mid-drag
re-plan immediately. `SnapEngine.ts:52` documents the contract. `Alt` additionally travels focus by clip in the lane
keyboard handler (`:1130`), which is a separate, non-overlapping context.

The obvious design gives `Alt`+drag a second meaning — *slip this one member out of the group* — which
is Premiere's and Resolve's binding. **That is rejected, and the collision is resolved by deleting one
of the two meanings rather than relocating it.**

**Why not just move snap suppression to another key.** Because the collision would come back. Every
modifier a drag can read is already spoken for at `pointerdown`: `Shift` extends a range
(`:920-921`), `Ctrl`/`Cmd` toggles (`:922-923`), `Alt` suppresses snapping. There is no fourth, and
relocating one meaning onto a chord (`Ctrl`+`Alt`, say) buys a binding nobody will find.

**Why the slip is the meaning that goes, and not snapping.** The two are not symmetric in cost.

- Holding `Alt` for a slip and losing snapping is an *annoyance*: the user is aligning sound against a
  cut and the magnet stops working. They notice within one gesture.
- Holding `Alt` to kill snapping and silently breaking a group is the *exact hazard this entire
  document exists to remove*. The user gets a clip that is no longer linked, no longer marked as
  linked, and is now some number of frames out of sync. They notice at playback, or at export, or
  never.

A key whose second meaning re-creates the failure the feature was built to prevent is not a
convention worth importing.

**Why there is no relocated slip modifier at all.** `PRODUCT.md` principle 3 requires that the
interface teach its own shortcuts — *"shortcut hints live on the controls themselves, not in a help
page nobody opens."* This app has exactly two teaching surfaces: `ShortcutHint`, which renders a
registry row on a control, and `ShortcutOverlay`, which lists the registry. **A drag modifier has no
control to live on and no row to be listed as.** It would be the only capability in the application
that cannot be discovered from the application. That is the deciding argument, and it applies
whichever key the modifier were given.

**So slipping a member is a named operation, and it costs one command:**

> `Ctrl+Shift+L` (unlink) → click the member → drag.

Both steps are in the registry, in the overlay, in the context menu and in the README keymap. The
group visibly disappears the moment it is broken (§8), so a user who unlinks and forgets is not
silently desynced — they are looking at two clips that no longer carry the rail. And `Ctrl+Z` puts the
group back in one step.

**`Alt` therefore keeps exactly one meaning during a drag, and this document adds no modifier to any
gesture.** That is a checkable claim rather than an intention: §12 gate 11 asserts that
`altHeld.current =` occurs exactly **five** times in the file, and that the multiset of assigned
expressions is exactly `{event.altKey ×3, true, false}` — a count plus a set of forms rather than an
ordered list of line numbers, so it survives ordinary line drift and still fails loudly on a sixth
write or on a changed meaning. The line numbers above are for the reader, not for the gate. It also
asserts
that no new `event.altKey` / `event.ctrlKey` / `event.shiftKey` read appears in `applyMove`,
`applyTrim` or `endGesture`.

---

## 7. Keyboard

### 7.1 The two rows

Checked against all **28 rows / 29 combos** currently in `src/keyboard/shortcuts.ts:110-159`. The
bound combo strings are: `Space`, `J`, `K`, `L`, `ArrowLeft`, `ArrowRight`, `Shift+ArrowLeft`,
`Shift+ArrowRight`, `Home`, `End`, `I`, `O`, `S`, `Delete`, `Shift+Delete`, `M`, `Shift+D`, `Ctrl+Z`,
`Ctrl+Shift+Z`, `Escape`, `+`, `=`, `-`, `Shift+Z`, `Ctrl+I`, `Ctrl+S`, `Ctrl+O`, `Ctrl+E`, `?`.

Neither `Ctrl+L` nor `Ctrl+Shift+L` is among them.

```ts
// src/keyboard/shortcuts.ts — ShortcutId gains two members …
  | 'edit.link'
  | 'edit.unlink'
// … ShortcutHandlerName gains two …
  | 'linkClips'
  | 'unlinkClips'
// … and SHORTCUTS gains two rows, directly after 'edit.detachAudio'.

  // docs/LINKING.md §7. Ctrl+L is the Link binding in Premiere and in Final Cut,
  // and it is unclaimed here: the bare `L` that shuttles forward normalises to
  // the combo string 'L', which is not 'Ctrl+L', so the two can never match the
  // same event. Ctrl+Shift+L is the paired inverse, in the shape Ctrl+Z /
  // Ctrl+Shift+Z already establishes for an operation and its opposite.
  //
  // Timeline-scoped like every other structural edit: Ctrl+L with focus in the
  // media rail must not restructure the timeline. Neither is repeatable — holding
  // Ctrl+L must not mint a new LinkId sixty times a second.
  { id: 'edit.link', keys: ['Ctrl+L'], label: 'Link selected clips', scope: 'timeline', handler: 'linkClips' },
  { id: 'edit.unlink', keys: ['Ctrl+Shift+L'], label: 'Unlink selected clips', scope: 'timeline', handler: 'unlinkClips' },
```

```ts
// src/keyboard/useShortcuts.ts — two entries beside detachAudio at :139.
// No branch and no guard: each action decides whether it has anything to do and
// raises its own notice when it does not, exactly as detachAudio does. Neither
// destroys a DOM node that could be holding focus, so neither needs the
// handOffFocusBeforeDelete that lift and rippleDelete take.
linkClips: () => readStore().linkClips(),
unlinkClips: () => readStore().unlinkClips(),
```

`REPEATABLE_SHORTCUTS` is **not** extended; the default (ignore `event.repeat`) is what both rows
want.

`comboFromEvent` normalises `Ctrl`+`l` to `'Ctrl+L'` and `Ctrl`+`Shift`+`l` to `'Ctrl+Shift+L'`
(`shortcuts.ts:254-275`: `Shift` joins the combo for alphabetic keys, and `Ctrl` is the platform
accelerator, so these render as `⌘L` / `⌘⇧L` on darwin through `comboTokens`). No further work.

### 7.2 `Shift+D` keeps its binding and its label

`Detach audio` still detaches audio; it now links what it detaches. The registry row, the label and
the README line are unchanged. Renaming it to `Detach and link audio` would describe the
implementation rather than the intent, and `PRODUCT.md`'s voice section is explicit that labels say
what things are.

### 7.3 README keymap

`scripts/gen-keymap.mjs` parses the `SHORTCUTS` literal with a regex and rewrites the block between
the two markers in `README.md` (lines 94–…). The two new rows match its
`/\{\s*id:\s*'…',\s*keys:\s*\[…\],\s*label:\s*'…',\s*scope:\s*'…'/` pattern exactly, so:

```
npm run readme:keymap
```

adds them under **Timeline**, after `Shift+D | Detach audio`:

```
| `Ctrl+L` | Link selected clips |
| `Ctrl+Shift+L` | Unlink selected clips |
```

`node scripts/gen-keymap.mjs --check` must pass afterwards; it is the gate that stops the README
drifting from the registry, and §12 runs it.

---

## 8. The visible tell

Clicking one clip and getting two selected is a surprise **unless the second clip was already marked
as belonging to the first**. The mark has to satisfy five constraints at once, and it is worth
listing them before the answer because four of them eliminate the obvious options.

1. **No hue.** `PRODUCT.md`'s colour-blind clause; DESIGN.md's Lightness-First Rule.
2. **No accent.** The Three Uses Rule is closed at the playhead, the selection and the one primary
   action, and it governs rendered interface surfaces.
3. **No new texture.** `PLAN` §7.6's table has four entries at four distinct angle/pitch pairs and is
   described as closed. A fifth angle would sit within 30° of two existing ones. Textures also encode
   *state* — locked, muted, offline, warning — and linking is not a state.
4. **No new plane.** DESIGN.md's Four Planes Rule; clips are `raised` and stay there.
5. **Legible below `CLIP_MIN_LABEL_WIDTH` (24 px)**, where the name and thumbnail strip have dropped,
   and at 40 clips across 6 tracks.

Constraint 5 is the sharp one. Icons drop at 16 px (`Clip.tsx:30`). Constraints 1–4 remove hue,
texture and tone. What survives is a **mark**: something painted at a fixed position inside the clip.

### 8.1 The link rail

A **2 px rule inset along the clip's bottom edge**, spanning the clip's full inner width, on every
member of a group and on nothing else.

```css
/* src/components/timeline/timeline.css — after the .tl-clip[data-offline] rule.

   Linking is not a STATE, so it does not enter §7.6's texture table, and it is
   not hue. It is carried by a mark at a fixed position: a 2px rule along the
   clip's bottom edge, at the same x-range and the same width on every member.
   Two members on adjacent lanes therefore show two rails that begin and end
   together, which is the POSITION channel PLAN §7.6 ranks above hue — and it is
   the channel that survives when the name, the strip and the icon have all gone.

   bottom: 2px clears BOTH marks the selected state already spends: the border
   that thickens to 2px and the 1.5px outline at outline-offset -1.5px. A
   selected linked clip therefore reads as an outline AND a rail, two separate
   marks, rather than as one thick bottom edge.

   left/right: 0 resolve against the padding box, so the rail narrows with the
   clip and disappears with it. There is no width arithmetic and nothing to
   clamp: at CLIP_MIN_RENDER_WIDTH the inner box is empty and the rail is not
   painted, which is the same width at which every other signal except texture
   has already gone (§7.6's degrade ladder). */
.tl-clip[data-linked='true']::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 2px;
  height: 2px;
  background-color: var(--text-muted);
  transition: background-color var(--dur-feedback) var(--ease-out);
}

/* --text-muted is forbidden on any -hover surface (PLAN §7.1), and all three of
   these put the clip on --surface-raised-hover. The identical lift .tl-clip-icons
   takes eight rules above, for the identical measured reason. */
.tl-clip:hover[data-linked='true']::after,
.tl-clip:focus-visible[data-linked='true']::after,
.tl-clip[data-selected='true'][data-linked='true']::after {
  background-color: var(--text-ink);
}
```

`::before` on `.tl-clip` is already taken by the `data-tiny` hit-target widener (`timeline.css:368`);
`::after` is free. `.tl-clip` is `position: absolute`, so it is already the containing block.

### 8.2 The token, and the measured rejection of the obvious one

`--border-structural` is the intuitive choice — it is already the clip's own border colour — and it
**fails**, measured:

| Pair (non-text UI, 3:1 floor) | signal | instrument | daylight |
|---|---|---|---|
| `--border-structural` on `--surface-raised` | 3.07:1 | 3.18:1 | 3.32:1 |
| `--border-structural` on `--surface-raised-hover` | **2.64:1** | **2.74:1** | **2.94:1** |
| `--text-muted` on `--surface-raised` | 5.31:1 | 5.10:1 | 5.04:1 |
| `--text-muted` on `--surface-raised-hover` | 4.56:1 | 4.40:1 | 4.46:1 |
| `--text-ink` on `--surface-raised-hover` | 10.07:1 | 10.47:1 | 11.88:1 |

A clip that is hovered, focused or **selected** sits on `--surface-raised-hover`
(`timeline.css:333, 345, 356`) — and selected is precisely the state a linked clip is in when the
user has just discovered the group. `--border-structural` there lands **below the 3:1 non-text floor
in all three themes**, on exactly the clips being looked at. It is disqualified, not merely
suboptimal — and the failure is invisible on the resting clip, where it passes at 3.07–3.32:1, which
is how a mark like this ships broken.

`--text-muted` clears 3:1 on every surface in every theme with margin, and the existing prohibition
on `--text-muted` over a `-hover` surface (`PLAN` §7.1, quoted verbatim in `timeline.css:433-435`) is
a **text** rule at the 4.5:1 floor, not a non-text one — the rail would pass at 4.40:1 without the
lift. It takes the lift anyway, through the same three selectors the icon strip uses, because a rail
that stayed muted while the icons beside it brightened would read as two different states rather than
one.

Ratios were computed from `tokens.css`'s OKLCH values through OKLab → linear sRGB → WCAG relative
luminance. The converter reproduces two of this project's own published figures to the last digit:
DESIGN.md's `--text-muted` on `--surface-raised` (5.31:1, signal) and `PLAN` §7.1's
`--text-muted` on `--surface-raised-hover` triple (4.55 / 4.40 / 4.45:1, against 4.56 / 4.40 /
4.46 computed here).

### 8.3 The other three channels

| Channel | Carries | Survives to |
|---|---|---|
| **The rail** | this clip has partners | every width down to an empty inner box |
| **Co-selection** | *these* are the partners | every width |
| **Accessible name** | the word `linked` | every width, including zero |
| **Inspector identity line** | `Linked, 2 clips` — the group's size, or `Linked, 2 groups` when the selection spans more than one (§8.5) | while a group is selected |

The rail is the *pre*-signal: it says a partner exists. Co-selection is the *proof*: it says which
one. That pairing is what makes the surprise stop being a surprise on the first click, and it is why
the rail does not need to encode the count or the identity of the partner.

`Clip.tsx` gains one subscription and two lines:

```ts
// [stable] — a boolean primitive, so React.memo still holds and a pointermove
// still causes zero renders here. Deliberately NOT the LinkId itself: the id is
// a string that changes on every re-link, and nothing in this component uses its
// value.
const linked = useEditorStore((s) => s.clips[id]?.linkId !== undefined);
…
data-linked={linked || undefined}
…
if (linked) states.push('linked');          // after the stream words, before 'format mismatch'
```

`data-linked={linked || undefined}` matches the existing `data-selected` / `data-offline` /
`data-tiny` convention, so the attribute is absent rather than `"false"` on an ungrouped clip.

A detached pair's picture half then announces as *"Market wide, 00:04.10, video only, linked"* and its
sound half as *"Market wide, 00:04.10, audio only, linked"*.

### 8.4 Three treatments that were considered and dropped

**A `Link2` glyph in the icon strip.** Rejected on arithmetic, not on taste. `fitClipName` is handed
`paintWidth - NAME_CHROME_PX - iconSlots * ICON_SLOT_PX` (`Clip.tsx:166-169`) at 16 px per slot. The
strip has three slots today — source-state, stream, track-state — and a detached pair *always* fills
the stream slot, so a link slot would make the common grouped clip carry two icons and lose 32 px of
name budget. That is the exact middle-truncation regression the comment at `Clip.tsx:34-48` was
written to prevent, and it would be paid on the majority of clips on a linked timeline. The icon also
drops at 16 px, so it fails constraint 5 anyway.

**A drawn connector between the two lanes.** The strongest possible signal and the most expensive.
Clips live at `--z-clip` inside `.tl-lane-content`, which is transformed for scroll; a connector
spanning the 3 px gutter between lanes would need its own layer above the clips, its own entry in
`PLAN` §7.7's z-index table, and its own scroll and zoom bookkeeping — and it would have to be
re-derived on every store write for up to twenty pairs. It buys precision the co-selection already
provides for free.

**Announcing the expanded selection through a live region.** A notice on every click is exactly the
ceremony `PRODUCT.md` §5 rules out, and `setNotice` is for things that went wrong. The word `linked`
arrives in the accessible name at the moment focus lands on the clip — *before* the selection changes
— which is the right moment and costs nothing. The count is one `Tab` away in the inspector heading,
which already reads `2 clips` for any multi-selection.

### 8.5 Inspector

The identity block (`Inspector.tsx:89-96`) already carries one spelled-out fact — `Audio only` /
`Video only` — in a `type-label` paragraph. It gains one more line, on the same pattern:

```tsx
// Derived from the `clips` memo that is already there (Inspector.tsx:61-65 does
// the same for `uniformStreams`). One number per GROUP, never one number across
// groups: "Linked, 4 clips" over two independent pairs asserts a four-member
// group that does not exist, which is a fabricated fact in a read-out whose whole
// job is to name the group's size.
const linked = useMemo(() => {
  const sizes = new Map<LinkId, number>();
  for (const c of clips) if (c.linkId !== undefined) sizes.set(c.linkId, (sizes.get(c.linkId) ?? 0) + 1);
  if (sizes.size === 0) return null;
  if (sizes.size > 1) return `Linked, ${sizes.size} groups`;
  return `Linked, ${[...sizes.values()][0]} clips`;
}, [clips]);
…
{linked ? <p className="ve-inspector-streams type-label">{linked}</p> : null}
```

Both branches are plural by construction: a group holds at least two clips (§1.1), and the `groups`
branch is only reached at two or more. Counting *within the selection* is counting the whole group,
because §3.4 makes the selection a closure — that is the one place in this document where the
closure invariant is load-bearing for a number the user reads.

**The class is `.ve-inspector-streams`, reused, not a new `.ve-inspector-linked`.** The earlier draft
invented a class and specified no rule for it anywhere, which ships the paragraph unstyled — no
`margin-top`, no `--text-muted`. This line is the same kind of thing as `Audio only`: a spelled-out
fact at the same type step, directly beneath it, in the same identity block. It wants the same rule
(`inspector.css:30-34`), and giving it a second class name with identical declarations would be two
names for one thing.

It is a **read-out, not a control**: `Link` and `Unlink` live in the context
menu and on the keyboard, where every other structural edit in this app lives — `Detach audio`,
`Split at playhead`, `Lift` and `Ripple delete` are all menu-plus-keyboard and none of them has an
inspector button. Putting one here would be the only exception, and it would spend panel height on a
control the user reaches faster with the key it is already being taught.

The count uses the sans, not `.type-numeric`: it does not change while the interface is live — it
changes when the selection changes, which is a re-render, not a tick — so the Tabular Rule does not
reach it.

### 8.6 Context menu

`ClipContextMenu.tsx` gains two items directly after `Detach audio`, before the existing separator,
decided over the same `effectiveIds` every other item uses:

```tsx
const closure = selectLinkedClosure(s, ids);
const linkable = closure.length >= 2 && !anyLocked(s, closure);
const unlinkable = ids.some((id) => s.clips[id]?.linkId !== undefined);

{ kind: 'item', id: 'link', label: 'Link', icon: <Link2 size={14} strokeWidth={1.75} />,
  shortcut: <ShortcutHint id="edit.link" />,
  disabled: !linkable,
  disabledReason: linkable ? undefined : linkRefusal(s, ids).message,
  onSelect: () => readStore().linkClips() },

{ kind: 'item', id: 'unlink', label: 'Unlink', icon: <Unlink2 size={14} strokeWidth={1.75} />,
  shortcut: <ShortcutHint id="edit.unlink" />,
  disabled: !unlinkable,
  disabledReason: unlinkable ? undefined : 'Select a linked clip first',
  onSelect: () => readStore().unlinkClips() },
```

`Link2` and `Unlink2` both exist in `lucide-react@0.468` (verified against the installed package).
`linkRefusal(s, ids): Notice` is exported from `timelineSlice.ts` beside `detachRefusal` and returns
§4.1's table, so the menu and the keystroke cannot explain themselves differently — the pattern
`detachRefusal` established.

Both items are **enabled or disabled, never hidden**. `PLAN` preamble S4's "do not render an
inapplicable control" governs controls that are *irrelevant* to the selection; these two are always
relevant to a clip and are merely unavailable, which is the `disabled` + `disabledReason` case the
`Menu` primitive already serves.

---

## 9. Accessibility

- **Every group operation is reachable without a pointer.** `Ctrl+L` and `Ctrl+Shift+L` are registry
  rows, so they are in the shortcut overlay (`?`), in the context menu opened by `ContextMenu` or
  `Shift+F10` on the focused clip, and in the README keymap. No group capability is pointer-only, and
  §6 exists in part to keep it that way.
- **Grouping is encoded without hue**, by a positioned achromatic mark plus a word in the accessible
  name. The check is deuteranopia, and it passes trivially because the rail carries no chroma at all:
  `--text-muted` is chroma 0.012 / 0 / 0.014 across the three themes.
- **Contrast is measured, not assumed** — §8.2, against `--surface-raised-hover` as well as
  `--surface-raised`, which is the pairing that actually fails.
- **The rail does not animate.** Its only transition is `background-color` over `--dur-feedback`, on
  the same lift the icon strip takes, and `--dur-feedback` collapses to 1 ms under
  `prefers-reduced-motion: reduce` (`base.css:210-216`). Nothing about a group's appearance,
  disappearance or selection is gated on an animation completing. **No new `@keyframes`, no new
  transition property, and no reduced-motion branch is required** — the existing token collapse is
  the alternative.
- **Focus is unchanged by every action here.** `linkClips` and `unlinkClips` destroy no DOM node, so
  neither needs `handOffFocusBeforeDelete`. `detachAudio`'s existing focus and reveal behaviour
  (`AUDIO-FEATURES.md` §1.4) is untouched.
- **The seven states are unaffected.** The two new menu items are `Menu` items and inherit all seven
  from the primitive; no new interactive element is introduced anywhere in this document.

---

## 10. Everything that does not change

Stated so it is not re-investigated.

| Area | Why nothing changes |
|---|---|
| **Export** — `electron/export/graph.ts`, `exportDocument.ts`, `electron/ipc/export.ts` | `linkId` is a fact about how the *editor* moves clips. The graph reads `start`, `duration`, `mediaIn`, `properties`, `streams`, `track.kind`, `track.muted`, `track.visible` — and would read the same values whether or not the clips were ever grouped. `exportDocument.ts` copies `Object.values(s.clips)` verbatim, so the key crosses the structured-clone boundary as a plain string on a plain object and is ignored on the far side. **Zero export edits.** |
| **Audio monitor** — `audioMonitor.ts`, `AudioTrackVoice.tsx`, `useAudioMonitor.ts`, `VideoSurface.tsx` | `monitorAudible` is a predicate over `streams`, media status, `track.muted` and `volume`. Grouping changes none of them. AUDIO-MONITOR §8.1's table-of-numbers assertion keeps working untouched. |
| **Preview** — `selectVideoClipIdAtFrame`, `selectNextVideoClipIdAfter` | Read `track.kind`, `track.visible` and `clipHasVideo`. A group has no bearing on which clip is on top. |
| **Persistence** — `serializeProject`, `ProjectFile`, `PERSISTED_MEDIA_KEYS`, autosave | Clips are written whole (`Object.values(s.clips)`), so `linkId` rides along with no scaffold edit, exactly as `streams` does. `PERSISTED_MEDIA_KEYS` is about `MediaItem`. `toAutosavePayload` calls `serializeProject`. **No scaffold edit is required for persistence.** |
| **History** | `TimelineDoc` carries whole `Clip` records, so `cloneDoc`'s `{ ...d.clips }` snapshots `linkId` and `restore` puts it back. Undo and redo restore groups with no per-field work and no new code. |
| **Snapping** — `SnapEngine.ts`, `selectSnapTargets` | Kind-agnostic and group-agnostic geometry: a clip's edges are its edges. The only edit anywhere near it is widening the trim gesture's *exclusion* set (§5.3), which is not a change to the engine. |
| **Media rail, import, rename-on-disk** | `linkId` is a timeline relation. `MediaItem` does not know it exists. |
| **`selectTimelineDurationFrames`, `selectClipCount`, `selectClipIdsInTrack`** | Read `clipsByTrack` and `clipEnd`. Both are `[stable]` and both stay allocation-free — §5.1's census is inside `withClips`, not inside a selector, so nothing new runs on a store write. |

---

## 11. Required edits

### 11.1 Scaffold escalations (`PLAN` §0.2)

| File | Edit |
|---|---|
| `src/types/model.ts` | `LinkId` type, `Clip.linkId?`, `clipLinkId`, `clipIsLinked` — §1.1 verbatim. |
| `src/lib/id.ts` | `newId`'s prefix union gains `'g'`. |
| `src/lib/project.ts` | `migrateProject`'s clip mapping gains the `linkId` sanitiser — §11.5. `validClip` is **not** touched: a pre-linking `.veproj` must validate unchanged. |
| `package.json` | The `check` script gains `&& node scripts/check-linking.mjs`, appended after `check-timeline-guards.mjs` (`:18`). §12 requires the new gate to be wired in, and `package.json` is scaffold-owned under `PLAN` §0 — so it is an escalation, not an edit this slice makes. |

### 11.2 Amendments to documents this one does not own

| # | Document | Current text | Amendment |
|---|---|---|---|
| B1 | `AUDIO-FEATURES.md` §1.6 | The whole section — *"Linking: rejected, and the pair is fully independent"* | **Superseded in full** by this document. The section is replaced by a two-sentence pointer: the reasoning it records is preserved verbatim as §0.1 here, together with why the trade was re-decided. |
| B2 | `AUDIO-FEATURES.md` §0.3 | *"No link/unlink model (§1.6)."* | Struck. |
| B3 | `AUDIO-FEATURES.md` §1.4 | *"The pair is INDEPENDENT afterwards (§1.6)."* in `detachAudio`'s doc comment, and the §1.6 pointer in the action's TSDoc | Becomes *"The pair is LINKED afterwards (docs/LINKING.md §4.3)."* |
| B4 | `AUDIO-FEATURES.md` §1.2 | *"`splitAtPlayhead` needs no change. It builds both halves with `{ ...clip, … }`, so `streams` propagates to both by construction."* | True of `streams` and false of `linkId`, where the same construction is the bug. The sentence is scoped: *"…so `streams` propagates to both by construction. `linkId` does not survive a split unexamined — see docs/LINKING.md §5.4."* |
| B5 | `PLAN.md` §3.1 | The closed list of actions permitted to call `markDirty()` | Gains `linkClips` and `unlinkClips`. |

`AUDIO-FEATURES.md` §1.4's *"The honest cost, stated"* paragraph and README's matching
*Known limitations* bullet are both replaced, not amended — §11.7.

### 11.3 `src/state/timelineSlice.ts`

| Location | Edit |
|---|---|
| `withClips` (:279) | §5.1's gate + dissolve pass. |
| `restore` (:561) | Re-close the selection against the restored doc — §3.4. |
| `selectMany` (:929) | `valid` becomes `selectLinkedClosure(s, ids)` — §3.2. |
| `planMove` (:431) | Closes its own moving set; `primaryTrackId` parameter; kind-scoped vertical delta; fails closed when the primary track does not resolve — §5.2. |
| `moveClips` (:706), `moveClip` (:693) | `primaryTrackId` parameter, passed through / from `clip.trackId` — §5.2. |
| `planTrim` (:488) | Group closure, per-member validation, member-wide overlap exclusion — §5.3. |
| `splitAtPlayhead` (:727) | Right-half re-linking, uncrossed-member migration, whole-group lock rule, the `blockedLinked` notice — §5.4. |
| `selectDeletableClipIds` (:1338) | Closes `s.selection` before the lock filter — §5.5. |
| `deleteSelection` (:852) | `lockedLinkedClipId` refusal, first — §5.5. |
| `rippleDelete` (:876) | Same refusal; per-group shift with the all-members-downstream rule; `firstOverlap` validation; the `Math.max(0, …)` clamp at `:909` removed — §5.5. |
| `updateClipProperties` (:1167) | Closure when `patch.speed !== undefined` — §5.6. |
| `detachAudio` (:790) | One atomic `withClips` for both halves; `linkId` assignment — §4.3. |
| `TimelineActions` (:135) | `linkClips`, `unlinkClips`. |
| new exports | `selectLinkedClosure`, `lockedLinkedClipId`, `linkRefusal`; `firstOverlap` stays module-local. |

### 11.4 Every other file this document changes

`PLAN` §0's ownership map splits these across three owners, and `scripts/**` appears in it under no
owner at all. The two gate scripts are listed with the slice whose store they drive, which is where
`check-timeline-guards.mjs` already lives in practice; `package.json` is the one line of this feature
that a slice may **not** write, and it is in §11.1 for that reason.

| Owner | File | Edit |
|---|---|---|
| **timeline** | `src/components/timeline/Clip.tsx` | `linked` subscription, `data-linked`, the `linked` state word — §8.3. |
| **timeline** | `src/components/timeline/timeline.css` | `.tl-clip[data-linked]::after` and its three lifted selectors — §8.1. |
| **timeline** | `src/components/timeline/ClipContextMenu.tsx` | `Link` / `Unlink` items with `disabledReason` — §8.6. |
| **timeline** | `src/components/timeline/useTimelineInteraction.ts` | `primaryTrackId` at `endGesture` (:695), `applyMove` (:357, :362, :366), the nudge (:1187) and `largestLegalDelta` (:1419, :1425) — §5.2. `TrimGesture.members`, collected at `:897-908`; `applyTrim`'s per-member geometry — §5.3. The trim's snap exclusion set at `:905` widens to the member set. `refusalLabel`'s `locked` case names the blocking clip (`:115-116`) — §5.3. |
| **inspector** | `src/keyboard/shortcuts.ts` | Two `ShortcutId`s, two `ShortcutHandlerName`s, two `SHORTCUTS` rows — §7.1. |
| **inspector** | `src/keyboard/useShortcuts.ts` | Two handler entries beside `detachAudio` (:139) — §7.1. |
| **inspector** | `src/components/inspector/Inspector.tsx` | The `linked` memo and its paragraph — §8.5. |
| **inspector** | `src/components/inspector/failure.ts` | The `locked` case distinguishes a lock on a linked partner — §5.6. |
| **inspector** | `src/components/inspector/inspector.css` | **No edit.** §8.5 reuses `.ve-inspector-streams` (`:30-34`). Listed because its absence is a decision, not an oversight. |
| **timeline** | `scripts/check-timeline-guards.mjs` | The three calls that changed arity: `:129` → `state.moveClips([clipId], NaN, 0, trackId)`, `:130` → `state.moveClips([clipId], 10, NaN, trackId)`, `:133` → `mod.planMove(state, [clipId], NaN, 0, trackId)`. Untyped, so `tsc` will not find these — and with `planMove` failing closed on an unresolved primary (§5.2), leaving them would turn three NaN-refusal assertions into three `no-track` refusals that pass while testing nothing. |
| **timeline** | `scripts/check-linking.mjs` | New. §12. |
| **README.md** | `README.md` | §11.7. |

### 11.5 `src/lib/project.ts` — migration

```ts
/**
 * A SANITISER, not a validator — the same contract `streamsOf` has. Anything that
 * is not a non-empty string collapses to undefined, which `clipLinkId` reads as
 * "ungrouped". Dropping a whole clip because a hand-edited file has a numeric
 * linkId would lose the user's edit over a typo, and `describeProjectProblem` has
 * no sentence for it.
 */
const linkIdOf = (v: unknown): LinkId | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
```

and, in the clips mapping at `:235-248`, after the existing `streams` handling and **after** the
`trackIds.has(c.trackId)` filter has run:

```ts
// A LinkId that survives on fewer than two clips is a group of one, and §1.1's
// invariant says those do not exist. This is reachable through no fault of the
// user: the filters above drop a clip whose trackId no longer resolves, and its
// partner would otherwise load carrying a rail and a group with nobody in it.
// Counted over the FILTERED array, which is why it is a second pass rather than
// part of the map.
const census = new Map<string, number>();
for (const c of kept) {
  const g = linkIdOf((c as { linkId?: unknown }).linkId);
  if (g !== undefined) census.set(g, (census.get(g) ?? 0) + 1);
}
const clips = kept.map((c) => {
  const raw = (c as { linkId?: unknown }).linkId;
  const g = linkIdOf(raw);
  const keep = g !== undefined && (census.get(g) ?? 0) >= 2;
  if (keep && raw === g) return c;          // untouched: allocate nothing
  const { linkId: _drop, ...rest } = c;
  return keep ? { ...rest, linkId: g } : rest;
});
```

**The map returns the original object when there is nothing to change**, so an untouched project
allocates no new clip records on open — the property `migrateProject`'s existing comment at `:233`
already claims and must keep.

### 11.6 Backward and forward compatibility

`PROJECT_VERSION` stays **1**. The field is additive and optional on the wire, for the reason
`AUDIO-FEATURES.md` §1.1 gives at length: `migrateProject` returns `null` on any other version, and
bumping would make every existing `.veproj` unopenable.

| Direction | Behaviour |
|---|---|
| **A `.veproj` written before linking, opened by the new build** | No clip has a `linkId`, `validClip` does not inspect one, and §11.5's census finds nothing. **Every clip loads ungrouped. Zero clips change.** |
| **A project detached under the *current* shipping build, opened by the new build** | Identical to the row above. The picture is `streams: 'video'`, the twin is `streams: 'audio'`, neither has a `linkId`, and **neither acquires one.** |
| **A new `.veproj` opened by the new build** | Round-trips verbatim. `serializeProject` writes `Object.values(s.clips)`. |
| **A new `.veproj` opened by a build that predates linking** | `version` is still `1`, so it opens. `linkId` is an unknown key that `migrateProject` neither reads nor strips, and the old build renders the clips as ungrouped — which is exactly what that build has always done with a detached pair. The cost is *zero*, unlike the `streams` forward-compat case, which doubled the audio. |

**No group is ever inferred, and this is the part to get right.** There is no pass that walks existing
clips looking for a video-only clip and an audio-only clip that share a `mediaId`, a `start` and a
`duration`, and links them. It would be easy and it would be wrong:

- A user editing under the current build may have **deliberately** slipped the sound — a two-frame
  sound advance is a real technique — and a heuristic keyed on matching starts would either miss it or,
  worse, catch a pair the user had already separated on purpose.
- Two independent detaches of the same file at the same frame on different track pairs are
  indistinguishable from one detach, and the inference would cross-link them.
- A retroactive group **changes what the next `Delete` removes**. A user who opens an old project,
  selects a clip and presses `Delete` must get what they got yesterday.

Grouping is something the user does. Opening a file is not doing it. If they want their old pairs
linked, `Ctrl+L` over each is one keystroke and it is *their* keystroke.

### 11.7 README

Three edits, plus the generated block.

- **Line 23**, the feature bullet, currently *"Detach a clip's audio onto its own track — `Shift+D`,
  or the clip's context menu. The picture …"* — rewritten to say that the two halves stay linked, and
  to name `Ctrl+L` / `Ctrl+Shift+L`.
- **Known limitations, line 263**, currently *"**Detached audio is not linked to its picture.** Once
  detached, the two clips are fully independent…"* — **removed**, and replaced by an honest statement
  of the new model's cost:

  > - **Linked clips move as one, and there is no drag modifier to slip one out.** Detaching audio
  >   links the picture and the sound, so selecting either selects both and every move, trim, split
  >   and delete applies to the pair in one undo step. To move one half on its own, unlink it
  >   (`Ctrl+Shift+L`), move it, and link it back (`Ctrl+L`) if you want to. Holding a modifier
  >   during the drag deliberately does not do this: `Alt` already suppresses snapping, and a chord
  >   that silently breaks sync is the thing linking exists to prevent.

- **Line 294**, the documentation list, gains `LINKING.md (group and ungroup)`.
- **The keymap block** (lines 94–…) is regenerated by `npm run readme:keymap` — §7.3.

---

## 12. Gates

**Four** of the five existing gates (`npm run check`) pass unchanged. The fifth,
`scripts/check-timeline-guards.mjs`, is **updated** for the new `planMove` / `moveClips` arity
(§11.4) and then passes unchanged in substance. It has to be: it is untyped `.mjs` bundled by
esbuild, so §5.2's "the parameter is required, so `tsc` enumerates every call site" argument does not
reach it. Left alone, its three calls would pass `primaryTrackId === undefined`, `planMove` would
fail closed on it, and three assertions that exist to prove NaN is refused would go green while
proving that a missing argument is refused instead.

This document adds a sixth gate, `scripts/check-linking.mjs`, wired into the `check` script after
`check-timeline-guards.mjs` — which is a one-line `package.json` edit and therefore a scaffold
escalation, §11.1. It bundles `src/state/timelineSlice.ts` with esbuild and drives the slice creator
against a fake store, exactly as `check-timeline-guards.mjs` does at lines 19-50 — no test framework,
no renderer.

| # | Assertion |
|---|---|
| 1 | **The invariant, asserted directly.** After every scenario below, a census over `state.clips` finds **no** `LinkId` carried by fewer than two clips. This is the one assertion that catches a mistake anywhere in §5. |
| 2 | `detachAudio` on one `av` clip produces exactly one `LinkId`, carried by exactly two clips, and the store passes assertion 1 at every intermediate `set` — verified by wrapping `set` and running the census on each call. |
| 3 | `detachAudio` on a clip that is already in a group of two produces one group of **three**, not two groups. |
| 4 | **The dissolve is reachable and it fires.** `removeTrack` on a lane holding one member of a pair leaves the survivor with **no** `linkId`. (The earlier draft asserted this through "a `toggle`-narrowed selection", which §3.1 makes unreachable — `toggle` on a member takes the whole group in or out.) |
| 4b | **The closure survives history.** Link a pair → `unlinkClips` → `selectMany([oneMember], 'replace')` → `undo`. `state.selection` holds **both** members, and a `deleteSelection` from there removes both and leaves no clip carrying a `linkId`. This is the four-keystroke path §3.4 exists for. |
| 5 | `splitAtPlayhead` over a linked pair yields four clips in **two** groups of two, and the left group's id is the original. A pair where the playhead crosses only one member yields a left group of two and **no** right group. |
| 5b | **Split is whole-group under a lock.** A pair with a crossed member on a locked track does not split at all, an *unlinked* clip elsewhere under the playhead still does, and `state.notice` is `Could not split` / `A linked clip is on a locked track`. A pair whose only locked member ends before the playhead splits normally and raises **no** notice. |
| 6 | **`planMove` closes its own moving set.** `planMove(s, [oneMember], …)` returns a plan containing **both** members — asserted as the stated rule of §5.2(a), not as a property of the caller. A plan whose vertical delta would put a member on a nonexistent track returns `{ ok: false, reason: 'no-track' }` and mutates nothing. `planMove(s, ids, 0, 1, undefined)` returns `{ ok: false, reason: 'no-track' }` rather than silently moving nothing. A vertical delta with a video track as primary leaves the audio member's `trackId` **unchanged**. |
| 7 | `planTrim(oneMember, 'in', f)` returns both members with the identical `start` delta and the identical `duration` delta. |
| 8 | **A downstream group shifts by one number or by none.** `rippleDelete` of a leading pair leaves every member of a downstream group shifted by the **identical** amount, so the offsets between members are exactly what they were. Two constructions, and both are asserted: (i) removals on both members' lanes, of different lengths — the group takes the larger, and both members move by it; (ii) a removal on only one member's lane — the group takes **0**, and neither member moves, because §5.5's rule refuses to drag a member that had nothing removed in front of it. |
| 8b | **The §2 sting case works.** A group with one member at frame 0 and one at frame 1200 on the same track, with a third clip between them: ripple-deleting the middle clip **succeeds**, changes neither member's `start`, and raises no notice. Under the earlier draft's unconditional group maximum this refused, permanently. |
| 8c | A construction that genuinely cannot close — every member downstream, on lanes that freed different amounts — returns **unchanged state**, and `state.notice.message` contains a clip's `name` and the word `unlink`. |
| 8d | **Delete is group-atomic under a lock.** With one member of a pair on a locked track, `deleteSelection` leaves **both** clips present, both still carrying the same `linkId`, and sets `Could not delete` / `A linked clip is on a locked track`. Identically for `rippleDelete`. |
| 8e | **A group speed change closes and stays uniform.** `updateClipProperties([oneMember], { speed: 2 })` on a pair of equal speed returns `{ ok: true }` and leaves both members with equal `duration` and equal `start`. With one member on a locked track it returns `{ ok: false, reason: 'locked' }` and changes nothing. |
| 9 | `migrateProject` drops a `linkId` held by one surviving clip, keeps one held by two, and returns the **original object identity** for a clip it did not have to change. |
| 10 | Every combo in `SHORTCUTS_BY_COMBO` maps to exactly **one** row. This is a general assertion, added here because these are the first two rows in months to claim a new modifier chord. |
| 11 | **`Alt` still means one thing.** A source read of `useTimelineInteraction.ts` finds `altHeld.current =` exactly **five** times, and the multiset of assigned expressions is exactly `{event.altKey, event.altKey, event.altKey, true, false}`. It finds no `event.altKey`, `event.ctrlKey` or `event.shiftKey` read inside `applyMove`, `applyTrim` or `endGesture`. A count and a set of forms, not a list of line numbers, so ordinary drift does not fail it and a sixth write does. A text assertion rather than a behavioural one, because the property being defended is the *absence* of a binding. |

Plus, outside the new script:

- `npm run typecheck` — the required `primaryTrackId` parameter (§5.2) makes `tsc` enumerate every
  `planMove` / `moveClips` call site; none may be left on the old semantics.
- `npm run build`
- `node scripts/gen-keymap.mjs --check` — README keymap matches the registry.
- **In the real app, through CDP**: select a group of two and assert the inspector's identity block
  reads `Linked, 2 clips`; then extend the selection to a second, independent pair and assert it
  reads `Linked, 2 groups` — never `Linked, 4 clips`, which would name a group that does not exist.
  Assert the paragraph's computed `color` is `--text-muted` and its `margin-top` is `--space-xs`,
  i.e. that it picked up `.ve-inspector-streams` rather than shipping unstyled.
- **In the real app, through CDP**, on all three themes: build a detached pair, click one half, and
  assert `document.querySelectorAll('.tl-clip[aria-selected="true"]').length === 2` and
  `getComputedStyle(el, '::after').backgroundColor` resolves to the lifted `--text-ink` value on the
  selected member and the `--text-muted` value on an unselected linked clip. Assert
  `document.visibilityState === 'visible'` in the same sample, per the running notes.
- **One playhead writer, one rAF loop** — unchanged and re-measured. Nothing in this document runs on
  a store write (§10, last row) or touches the playback clock.

---

## 13. Summary of what ships

- `Clip.linkId?: LinkId`, two readers, one new id prefix. No file-format version bump, no migration,
  no inferred groups.
- One selection rule: naming a member names the group. Applied in `selectMany`, and re-applied on
  every history restore so that undo cannot hand back a group with half of it selected.
- Two commands — `Link` (`Ctrl+L`) and `Unlink` (`Ctrl+Shift+L`) — in the registry, the overlay, the
  context menu and the README keymap.
- `Detach audio` links what it detaches. Same key, same label, same eligibility, same placement
  ladder.
- Five mutations made group-aware, each all-or-nothing, each one undo step — with both planners
  taking their own closure, so a group cannot be halved by a caller that passes one id. One dissolve
  pass at one choke point that makes a group of one unrepresentable.
- A track lock never produces a half-applied group operation: it refuses the delete, refuses the
  ripple delete, withholds the split, and says which — a linked clip on a locked track — rather than
  quietly doing most of it.
- One visible mark, achromatic, positioned, contrast-verified in all three themes against the
  surface that actually fails.
- `Alt` keeps exactly one meaning.
