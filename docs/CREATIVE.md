# CREATIVE.md — track mix, grade, effects, transitions, titles, subtitles

The plan for six features added after v0.1.6. Written before any code; amended
only here. Every section states the exact declarations, so no implementer has to
invent a field name.

The rule that governs all six: **preview and export are computed from one shared
pure function wherever it is possible at all.** Where it is not possible, this
document says so out loud and names the discrepancy. A preview that quietly
disagrees with the file is worse than no preview.

---

## 0. Ownership

`src/types/model.ts`, `src/types/api.ts`, `src/lib/color.ts`, `src/lib/srt.ts`,
`src/lib/titleRaster.ts` and `src/lib/project.ts` are **scaffold-owned**: written
once, up front, by the planner. No implementer edits them. An implementer that
needs a field it does not have states the exact declaration in its report and
stops — it does not patch around the gap and it does not edit the file.

Everything else has exactly one owner:

| Area | Owns |
| --- | --- |
| **state** | `src/state/timelineSlice.ts`, `src/state/uiSlice.ts` |
| **graph** | `electron/export/graph.ts`, `electron/ipc/export.ts`, `src/components/export/*` |
| **preview** | `src/components/preview/*` |
| **timeline** | `src/components/timeline/*` |
| **inspector** | `src/components/inspector/*`, `src/components/ui/Fader.tsx`, `src/components/ui/index.ts` |
| **gates** | `scripts/*.mjs`, `docs/*`, `README.md`, `package.json` |

A file not in this table is nobody's. Ask the planner.

**AMENDED — three areas turned out to be nobody's, and all three were edited
anyway.** The table is now:

| Area | Also owns |
| --- | --- |
| **graph** | `electron/ipc/*`, `electron/preload.ts` — the export channel already crossed all three, and §6.5's import channel makes it four |
| **timeline** | `src/keyboard/shortcuts.ts` — `edit.addTitle` is a registered row consumed by `useTimelineInteraction`, so registry and consumer are one change |
| **gates** | `src/keyboard/useShortcuts.ts` — the global handler record. |

**AMENDED AGAIN — the rule above said "a registry row without a handler is a
broken build, not a handoff". That was too blunt and the timeline owner improved
on it.** `ShortcutDef.handler` is now optional, meaning *this row is dispatched by
its own region*, and `SHORTCUTS_BY_COMBO` is narrowed to the rows that do carry
one so `useShortcuts.ts` typechecks untouched. That is not a handoff — the row is
fully wired, by the region that owns the gesture — and there was already
precedent, `nav.stepBack`/`nav.stepForward` being consumed by
`onPlayheadKeyDown`. The distinction it introduces is real and the old model
conflated it.

What my rule was actually aimed at is a row **nobody** dispatches, and the right
place to enforce that is the gate, not the type. The timeline owner declared the
hole this opens rather than hiding it: `check-linking`'s one-row-per-combo check
(docs/LINKING.md §10 — NOT this document's §10, which is the verification pass)
now reads a map that excludes region-dispatched rows, so `T` is uncovered. It
exported `SHORTCUT_COMBOS` (all rows) to close it.

**Rule, restated:** a row may be dispatched globally or by its region, but every
row is covered by LINKING §10's combo-uniqueness gate, which reads
`SHORTCUT_COMBOS` and never `SHORTCUTS_BY_COMBO`. A row and its dispatch still
land in the same change.

Stated because a rule that says "ask the planner" and is then not asked is a rule
that has already failed. If an area is missing from this table, it is the
planner's error, not the implementer's.

---

## 1. Track volume

### 1.1 Model

```ts
// Track
volume?: number;   // 0..2, 1 = unity. ABSENT ≡ 1.
export const trackVolume = (t: Track): number => t.volume ?? 1;
```

Optional for the reason `streams` and `linkId` are optional (model.ts §2.4): a
`.veproj` written before this feature has no such key and must stay a *valid
project file* rather than become a migration, and an ordinary track must not
carry a redundant `1` into every save.

### 1.2 Why it is on the track and not a master

There is already a per-clip `properties.volume` and a per-track `muted`. What was
missing is the middle term — the thing you reach for when one camera was louder
than the other for the whole edit. Effective gain is the product:

```
gain = clipVolume × trackVolume        (and 0 when track.muted)
```

Multiplication, not the minimum and not a sum in dB, because that is what a
mixer does and it is what makes `trackVolume` composable with a clip the user
already trimmed by ear.

### 1.3 Where it applies — all three, or it is a lie

1. **Export** — `graph.ts` §1.7: `volume=` takes the product. `wantsAudio`
   gains `trackVolume(track) > 0`, so a track faded to silence contributes no
   input, exactly as `muted` already does.
2. **Preview mix** — the per-track voice gain in `useAudioMonitor` multiplies by
   `trackVolume`.
3. **The clock clip's own audio** — `VideoSurface` carries the clock clip's
   audio on the `<video>` element and nothing else carries it. Its
   `.volume` multiplies by `trackVolume` too. Missing this is the classic bug:
   every track obeys the fader except the one you are looking at.

### 1.4 Control

A new `Fader` primitive in `src/components/ui/`. Horizontal, 56px, sits in the
track head under the three toggles, on **every** track — a video track carries
audio in this model (`clipHasAudio` is true for an `av` clip on V1), so a fader
only on audio tracks would be unreachable exactly where most audio lives.

- Hidden below **53px** — AMENDED from `DENSE_HEIGHT` (48). 48 was a guess made
  before the control existed; 53 is measured against the one that shipped
  (14.3px label + 24px `sm` IconButton + 14px `.ve-fader` = 52.3px), and at 48
  the fader spills into the lane below by 4.3px. A measured number beats a
  stated one, and the plan is what changes. Nothing becomes unreachable: §1.4's
  own fallback already covers every height below the threshold, and the 48–52px
  band simply joins it. Default heights are unaffected — video 56 shows the
  fader, audio 40 uses the menu.
- The fallback is the track context menu, and it is **seven dB presets**
  (Silent, −12, −6, −3, unity, +3, +6) rather than nudge items, because `Menu`
  closes on select and a nudge item would mean reopening the menu per step. The
  current gain rides on the submenu **label**, so a density-hidden fader is still
  readable without opening anything. That is a better fallback than the plan
  asked for and it is now the specified one.
- `role="slider"`, `aria-valuemin/max/now`, and `aria-valuetext` in **dB**
  (`"−6.0 dB"`, `"unity"`, `"silent"`) because dB is what the number means.
- Arrow keys ±1 dB, Shift ±0.1 dB, Home = silent, End = +6, `0` = unity.
- Double-click resets to unity.
- State is **not** carried by hue: the fill is `--accent` but the handle position
  and the `aria-valuetext` carry the value, and unity is marked with a tick.
- **The unity tick is a SIBLING of the groove, drawn beneath it — not a child.**
  This looks like an odd construction and it is load-bearing; the obvious
  simplification puts the defect back.

  A tick inside the groove has **two** backdrops, not one: the well below unity
  and the `--accent` fill above it. Those sit at opposite ends of the lightness
  ramp, so **no single colour clears 3:1 against both.** Measured: `--text-ink`
  gives 18.33 against the groove and **2.04 against the fill** in `signal`;
  swapping to `--text-on-well` — the token DESIGN §2 split for exactly this case
  — fixes `daylight` and still leaves `signal` and `instrument` at ~2.0. It is a
  structural fact about the two backdrops, not a bad token choice, which is why
  the token swap was the wrong fix.

  The consequence was worse than a contrast miss: above unity the fill *covers*
  the tick, so **the unity mark disappeared exactly when "am I above unity?" is
  the question being asked** — in `signal`, the default theme. The guarantee
  above ("unity is marked with a tick") was false at half the control's values.

  As a sibling the tick has one backdrop in every theme at every value — the
  track head — and takes `--text-ink` exactly as the handle does: **11.72 /
  12.14 / 13.43** across the three themes, the same colour-and-backdrop pair the
  handle already uses.

---

## 2. Grade (colour correction)

### 2.1 Model

```ts
// ClipProperties, added
brightness: number;   // -1 .. 1,  0 = unity   (additive)
contrast: number;     //  0 .. 3,  1 = unity   (multiplicative about mid-grey)
saturation: number;   //  0 .. 3,  1 = unity
temperature: number;  // -100 .. 100, 0 = unity (negative cooler, positive warmer)
```

### 2.2 The shared function — `src/lib/color.ts`

This is the crux. CSS `filter: brightness()` is **multiplicative**; ffmpeg
`eq=brightness` is **additive**. Wiring the model straight into both would give a
preview that disagrees with the file at every setting except the default, and the
disagreement would grow with the correction — worst exactly where the user is
looking hardest.

So neither consumes the model value directly. `src/lib/color.ts` is pure, has no
DOM and no node import, and is compiled into **both** the renderer bundle and
`dist-electron`. It exports one function:

```ts
export interface GradeMath {
  /** feComponentTransfer type="linear": out = slope·in + intercept. */
  slope: number;
  intercept: number;
  /** Per-channel gain for temperature. 1 = untouched. */
  rGain: number; gGain: number; bGain: number;
  /** 0..3, the saturation matrix parameter. */
  saturation: number;
  /** True when every term is unity — the caller emits NO filter at all. */
  neutral: boolean;
}
export function gradeMath(p: ClipProperties): GradeMath;
```

- **Export** builds `eq=contrast=…:brightness=…:saturation=…` followed by
  `colorchannelmixer=rr=…:gg=…:bb=…`, from `slope`/`intercept`/`saturation`/gains.
- **Preview** builds an SVG `<filter>` — `feComponentTransfer` with
  `type="linear" slope intercept` per channel, then `feColorMatrix
  type="saturate"`, then a diagonal `feColorMatrix` for the gains — and applies it
  with `filter: url(#…)`. The primitives are the same maths in the same order.

`neutral` exists so an ungraded clip costs nothing: no `eq` in the graph, no
`filter` on the element, and the fast path stays exactly as fast as it is today.

### 2.3 Order is normative

contrast → brightness → saturation → temperature. It is `eq`'s own internal
order, so following it means the export needs one filter where a different order
would need two, and the preview has one order to copy rather than a choice.

---

## 3. Effects

A **fixed catalogue**, stored as ordinary `ClipProperties` fields, not an
orderable effect stack.

```ts
// ClipProperties, added
blur: number;      // 0 .. 50 sigma, 0 = off
sharpen: number;   // 0 .. 2,        0 = off
vignette: number;  // 0 .. 1,        0 = off
flipH: boolean;
flipV: boolean;
```

A stack would need an order model, a reorder gesture, per-entry ids, orphan
rules and its own migration, and would buy nothing until there are two effects
worth reordering. Five fields persist for free, undo for free, and migrate
through the same `normalizeClipProperties` choke point as everything else. When
a sixth effect makes the ordering matter, that is the moment to build the stack.

| Field | Export | Preview |
| --- | --- | --- |
| `blur` | `gblur=sigma=` | `filter: blur(σpx)` |
| `sharpen` | `unsharp=5:5:A:5:5:0` | `feConvolveMatrix` 3×3 |
| `vignette` | `vignette=a=` | radial-gradient overlay |
| `flipH` | `hflip` | `scaleX(-1)` on the existing transform |
| `flipV` | `vflip` | `scaleY(-1)` |

`blur` is in **project-resolution** sigma and is rescaled onto the output grid by
`rx` in the graph, the same way `positionX` already is (EXPORT §1.3): a blur
authored at 1080 and exported at 4K must look the same, and an unscaled sigma
would be half as strong.

**AMENDED — what `blur` is measured against.** Sigma is in pixels of the
**finished frame**, not of the clip's own source. A clip at `scale: 0.5` with
`blur: 10` shows a 10px blur on the composited output, not a 5px one. This is
the definition both sides already implement and it is the one a user can
predict — the blur you see is the blur you get, and it does not change when you
resize the clip in the frame.

It falls out of the order each side runs in, and both are consistent with it:

- **Export** emits `gblur` AFTER `scale=` in the clip chain, and that `scale=`
  already carries `props.scale` (the target box is `req.width * props.scale`).
  The sigma therefore lands on already-scaled pixels, i.e. on the output grid.
  `rx` alone is the correct rescale; no division by `props.scale`.
- **Preview** applies CSS `filter` BEFORE `transform`, so a sigma written to the
  element is multiplied by `props.scale` on its way to the screen. Dividing by
  `props.scale` first is therefore not a fudge, it is exactly what puts the
  preview on the same grid as the export.

Neither owner is wrong. Anyone changing either order must change the other.

Preview `sharpen` and `vignette` are **approximations** and are labelled as such
in the inspector help text. `saturation` was on that list under `eq` and came off
it in §2.4. `blur` gets its own treatment — §3.1.

## 3.1 `blur` — the DEFINITION is verified; the FILTER is a tunable approximation

Two separate claims live in §3 and the third verification pass settled them
differently.

**The scale ruling is verified on both sides, exactly as written.** The preview is
scale-invariant to four figures — edge width 2.762% of frame height at clip scale
0.50 and 2.762% at 0.25 — and the CSS confirms the arithmetic term for term: at
scale 0.25 the layer carries `filter: blur(19.275px)` under `transform:
scale(0.25)`, which is `12 × (771/1920) ÷ 0.25` with the transform multiplying it
back. The export emits an identical `gblur=sigma=10.000` at every clip scale and
rescales 10 → 20 from 1920 to 3840. Sigma is in pixels of the finished frame, it
does not move when the clip is resized, and it survives a resolution change.
That part of §3 needed no amendment.

**The magnitude did not agree, and `gblur`'s default is why.** ffmpeg's `gblur` is
a recursive IIR approximation whose fidelity is controlled by `steps`, which
defaults to **1** — and at 1 it is materially narrower than the true Gaussian the
preview's CSS `filter: blur()` produces. Measured on a step edge through the
pinned binary, 10–90 rise width against the analytic `2.563σ`:

| `steps` | implied σ / authored σ |
| --- | --- |
| **1 (default)** | **0.897** |
| 2 | 0.936 |
| 3 | 0.956 |
| 5 | 0.975 |

It converges. This is not a fixed error to be labelled and lived with — it is a
filter option nobody set. **`steps` is raised until the residual is under 3%**,
which the table puts at 5; the cost is IIR passes on an offline export, which is
the cheapest currency this project spends.

**Blur's claim is therefore a stated tolerance, not a word.** §2.4 established
that "exact" here means "within a measured bound"; blur's bound is a *percentage
of sigma* rather than ±1/255, because that is the observable. It is neither
"exact" in the brightness sense nor "approximate" in the sharpen/vignette sense,
and the inspector footnote must say the measured thing rather than pick the
nearest existing word.

**The field ratio is NOT settled by the table above and must be re-measured.** The
pass reported preview σ 11.61 against file 8.58 — a ratio of 1.353, well past the
1.115 that `steps=1` alone explains. It flagged its own method honestly: the
fixture was a **title glyph**, because all six `dev-media` files are perfectly
flat (`YMIN=YMAX`) and nothing else in the app had an edge to blur. A glyph is a
narrow stroke, not a step edge, so the 2.563σ relation does not hold for it, and
the file's glyph additionally passed through scaling and chroma subsampling that
the preview's did not. The ratio is likely part filter and part fixture in unknown
proportion — which is §7.4 entry 5 again, a measurement partly of the medium.

### 3.1a The measured tolerance, and `steps=6`

`steps` is **6** — not the 5 the sweep above suggested, because 5 measures
3.0–3.4% on a finer sweep and does not clear the bar. Six does, and six is the
maximum `gblur` accepts, so this is the filter's floor rather than a knob left
partly turned. There is no further tuning available here; the next improvement
would be a different filter.

**THE CLAIM: the preview and the file agree to within 1.6% of full swing across
the whole edge profile** — worst normalised amplitude difference 1.60% at σ = 8
and 1.33% at σ = 25, same fixture, same extraction applied to both engines,
amplitude normalised between the flat levels. The divergence is systematic and
tiny: the preview sits +0.011 to +0.016 above the file on the dark side of the
edge and matches within ±0.010 on the light side. The preview's own capture floor
explains almost none of it — removing it in quadrature moves σ=25 from 1.0137 to
1.0133.

**That is the number, and it is the only one.** It compares the pair the rule at
the head of this document is about, and — decisively — **it has no estimator to
name.** An amplitude difference across a normalised profile is not a derived
width statistic; there is no crossing pair to choose and therefore no way to
quote it against a different measurement of the same thing.

*(σ = 50 is excluded from the preview comparison: at that width the fixture
block's own top edge bleeds into the sample rows and the flat field stops being
flat, `hi` falling 232 → 212. Instrument, not blur — declared rather than
averaged in.)*

### RETIRED: every transition-width figure in this build, including 2.9%

`gblur`'s 2.9%, verification's 2.9% end to end, and the whole steps table are
**withdrawn as statements of tolerance.** They measured each engine against an
ideal Gaussian that *neither* implements, and they are estimator-dependent to a
degree that makes any single value unquotable: measured between the two engines
at σ = 25, they look **0.6% apart at 95–5 and 6.1% apart at 60–40** — the same
two profiles, in the same frame. Spread across crossing pairs is 3.16 points at
σ = 8 and 5.57 at σ = 25.

So a transition-width number here is not a loose tolerance, it is a number that
can be made to say almost anything by choosing where to read it. Superseded, not
qualified. Nothing in this document or the inspector footnote states one.

**The steps table keeps ONE job**, and it is not the tolerance: it is why
`steps = 6`. Both engines approximate a Gaussian — CSS `filter: blur()` by three
box passes, `gblur` by IIR — and both converge toward one, so pushing `gblur` to
its maximum fidelity moves it toward CSS as well as toward the ideal. The 1.6%
agreement above is measured *at* `steps = 6`; the table is the record of getting
there.

**Where the estimator lesson still applies in full.**
`gblur`'s output is not a Gaussian, so no single sigma describes it: a true
Gaussian yields the same implied σ from every crossing pair, and this does not.
At authored σ = 25 —

| crossing pair | implied σ | residual |
| --- | --- | --- |
| 5–95% | 24.926 | **−0.30%** |
| 10–90% | 24.359 | −2.58% |
| 25–75% | 23.665 | −5.35% |
| 40–60% | 23.410 | **−6.26%** |

— heavy tails and a narrow core, which is the IIR signature. So "within 2.9%" and
"within 6%" are both true statements about the same filter, and quoting one
against a measurement taken with the other manufactures a regression that does
not exist. **A tolerance without its estimator is not a tolerance**, and a bare
"2.9%" in this document would have been a §7.4-class trap aimed by the plan at
its own future reader. The inspector footnote carries the estimator too, in
whatever plain words fit.

### 3.1c Why the retired numbers were measuring the wrong thing — RESOLVED

*(This section asked for the profile measurement. It has been taken; §3.1a
carries the result. Kept because the reasoning is why the answer changed, and
because the same mistake is available in every other preview/file claim here.)*

Every blur figure this build produced before the profile comparison — the steps
table, graph's 2.9%, verification's 2.9% end to end — compared **one engine
against an ideal Gaussian**. Neither engine implements one. `gblur` is a six-pass
IIR approximation; CSS `filter: blur()` is specified as three successive box
passes and is no more Gaussian than `gblur` is. Both approximate, and they
approximate *differently*, so the distance from each to the ideal says nothing
reliable about the distance between them.

The governing rule at the head of this document is not that either matches
mathematics. It is that **the preview and the file agree with each other.** Once
that comparison was actually taken it came back at **1.6% of full swing** — a
tighter and more meaningful result than any of the numbers it replaced, and one
with no estimator to argue about.

The general form, which applies to every claim in this document that pairs a
preview against a file: **compare the two things the rule is about, not each of
them against a third thing that is easier to describe.** An ideal is a convenient
reference precisely because it is not what either side does.

At **σ = 2 it is 5.0%** and does not improve with steps. It is stated and not
hidden, with the reason it does not matter: **the percentage is worst exactly
where the absolute error is smallest.** Five percent of a two-pixel blur is a
tenth of a pixel. A tolerance expressed as a ratio always looks worst at the
bottom of the range, and reading that as "blur is unreliable at low sigma" would
be exactly backwards.

Cost, measured rather than asserted: 1080p/100 frames 632 → 833 ms, 4K/30 frames
1152 → 1420 ms. About a third more on the blur filter alone, offline, which is
the trade §3.1 already said this project is willing to make.

### 3.1b The coupling underneath it — `workFmt` was gated on the GRADE

The emitted chain measured −4.07% where the filter in isolation measured −2.56%,
and the gap was not the filter. The higher-precision working format was gated on
the **grade** being non-neutral, so a clip with **blur and no grade** ran the
whole look block in 8-bit `yuva420p` — and `gblur` at six IIR passes quantises on
every one of them.

The same authored sigma therefore landed **4.1% narrow on an ungraded clip and
2.6% narrow on the same clip with any grade set.** Nobody would think to look for
it, and it would have made this very measurement irreproducible depending on
which fixture happened to be used — a defect that corrupts the instrument as well
as the output.

The condition is now `!gradeMath(gp).neutral || !effectsNeutral(gp)` — **any
look, not only a grade.** A clip with no look at all still never leaves
`yuva420p`, so EXPORT §1.8's A/B/C transcripts stay byte-exact.

**This is the same shape as §2.5's half-landing, and it is worth naming as a
class: a condition that serves several consumers, derived from only one of
them.** There, a bound was declared in three places and left out of the one that
emits. Here, a working depth was gated on one of the two things it protects. Both
read as complete from every angle except the one that matters. See §9.6.

**One number is deliberately absent.** End to end through the trailing
`format=yuva420p`, against an ideal put through the same 8-bit limited-range
quantisation, the residuals came out −4.9% at σ=4, −1.6% at σ=25, −3.1% at σ=50
— **non-monotonic**, which means the control was not perfectly modelling ffmpeg's
RGB→limited-range-YUV rounding. The filter column is reported because it is
reproducible; the end-to-end column is not reported at all, because the owner
could not separate the filter from its own model of the container conversion.
Verification owns that number, with a control this environment could not
validate. Declining to publish a figure you cannot stand behind is the standard —
a non-monotonic residual is the data telling you the instrument is wrong.

**Gate gap, named rather than papered over:** `check-grade` does not assert blur
width, and it cannot until `dev-media` carries a step edge (already with gates).
When it does, the case it most needs is **blur with no grade**, because that is
the branch this coupling lived in and the branch a naturally-written fixture will
miss.

So: the tolerance above is written from the step-edge filter measurement. The
glyph figure remains unused, exactly as ruled.

**Fixture gap, and it is a real one:** the app's own `dev-media` cannot exercise
any spatial effect. Six flat files means blur, sharpen and vignette have no
fixture in this repo that shows what they do. `make-dev-media.mjs` should produce
at least one clip carrying hard edges and fine detail. Nothing spatial can be
verified end to end until it does, and that is why this defect reached a third
pass before anyone could see it.

## 2.4 D4 — the export leaves `eq`. The claim was false; it is now made true.

Verification measured brightness and contrast end to end and found the preview
and the file disagreeing by **7–9 / 255**. §2.2 called those two EXACT. They were
not, and the reason is a domain error in the scaffold, not in either consumer:
`eq` works on **limited-range YUV**. Its `brightness` moves Y, which expands by
×1.164 on the way back to RGB; its `contrast` scales **luma only**, holding
chroma, so it shifts hue where the preview's per-channel RGB transfer does not.
That is why the contrast row disagreed per channel rather than uniformly.

I reproduced it independently against the bundled binary. On a pixel measuring
46,95,158, `eq=brightness=0.2` returns 104,153,216 where `gradeMath` says
97,146,209 — the same +7. `eq=saturation=0` returns 86,88,85, which is not even
neutral grey.

**`check-grade` could not catch this and that is the important part.** It tested
my algebra against my own restatement of `eq`'s formula. Both sides shared the
false premise, so the gate was green while the product claim was wrong — the
exact failure mode §7 says gates exist to prevent. A gate that restates the
implementation tests nothing. **Every gate in §7 is now required to assert
against measured output or observed behaviour, never against a restatement of
the thing under test.**

### The ruling: one domain, and it is RGB

There were two honest outcomes — make it true, or stop claiming it. Stopping
would have meant all four grade terms labelled approximate, which guts the
feature §2.2 opens by calling "the crux": a grade preview you cannot trust is a
grade panel you have to export to use. So: **make it true.** The export moves off
`eq` into the same RGB domain the preview works in.

```
format=gbrp,
lutrgb=r='clip(val*S+B*255+0.5,0,255)':g='…':b='…',     # contrast + brightness
colorchannelmixer=<gradeMatrix>:aa=<opacity>,            # saturation × temperature
format=<clipPixFmt>
```

- `lutrgb` takes `slope`/`intercept` **exactly as `gradeMath` already emits them**
  and exactly as `feComponentTransfer type="linear"` consumes them. `+0.5` inside
  the `clip` is round-half-up; without it the LUT truncates and loses 1 LSB.
- `gradeMatrix(saturation, rGain, bGain)` — new, in `src/lib/color.ts` — folds
  saturation and temperature into ONE 3×3, because both are 3×3 RGB matrices and
  their product is another one. The export spends one `colorchannelmixer`, the
  preview one `feColorMatrix`, and there is no intermediate for the two sides to
  round differently. Saturation uses the Rec.709 weights `feColorMatrix
  type="saturate"` is *defined* with, so the two match by construction.
- **`saturation` therefore comes OFF the approximation list.** It was approximate
  only because it was delegated to `eq`. Doing it in RGB makes it exact.

Measured on the bundled build, against the true post-conversion input:
brightness exact; contrast within 1 LSB; `saturation=0` lands on 89,89,89 where
the Rec.709 luma of that pixel is 89.1; `saturation=1.5` matches term for term.

**The tolerance is ±1/255 and it is stated, not hidden.** That is the 8-bit
quantisation floor and no arrangement of filters beats it. "Exact" in this
document now means "within the quantisation floor, measured", which is a claim
that can be checked — unlike the one it replaces.

`lutrgb` and `gbrp` join `REQUIRED_FFMPEG_FILTERS` (§7). Both are present in the
pinned build; verified, not assumed.

`eq` is no longer used by this project. Leaving it for brightness/contrast while
doing saturation in RGB would be two domains in one chain, which is how this
happened.

## 2.5 `saturation` is 0..1.8, because 0..3 cannot be encoded

`check-grade`, rewritten per §7.1 to run the pinned binary, found on its first
honest run that **a legal grade makes the export refuse.**
`colorchannelmixer` clamps every coefficient to `[-2, 2]` and rejects the whole
filtergraph outside it. The saturation matrix's own diagonal is
`LUMA_B + (1 − LUMA_B)·s`, scaled by the temperature gain — which crosses 2 at
**s = 1.846** with `TEMPERATURE_GAIN = 0.12` at its coolest, matching the
measured table exactly. The model declared `0..3`, the clamp allowed `0..3`, and
the slider offered `0..3`, so roughly the top third of the control was a hard
export failure that nothing upstream could see.

This predates the gate rewrite. The old gate could not have found it, because it
never ran the binary. **§7.1 paid for itself on its first run.**

### Why the matrix is NOT split across two passes

The obvious fix is to emit two `colorchannelmixer` passes, and the algebra
encourages it: saturation matrices compose exactly, `S(a)·S(b) = S(a·b)`, because
the luma matrix `L` is idempotent, so `S(√3)` twice should be `S(3)` with every
coefficient legal. **I was about to rule that way and the binary refused it.**

Measured, `S(√3)` twice on a pixel reading 99,104,112: the ideal is 90,105,129,
the two-pass result is 90,**107**,128. Two independent defects, either fatal:

1. **Clipping does not compose.** `colorchannelmixer` clamps to the pixel range
   after *each* pass, and clamping is non-linear. High saturation is exactly the
   regime where channels clip, so the split diverges precisely where it was
   introduced to help — and the preview clamps once, at the end, so the export
   would disagree with the preview in the same region.
2. **Two matrix passes quantise twice.** Even on the non-clipping pixel above the
   error is 2/255 — double the ±1/255 budget, on its own. It is the same
   compounding that forced `gbrap10le`, arriving again with nothing left to
   absorb it.

So the range is narrowed instead, and the narrowing is honest: **the declared
range is now the range that can actually be encoded.** 1.8 rather than 1.846 for
headroom. It gives up nothing real — Premiere's Lumetri and Resolve both top out
at 2×, so `0..3` was the outlier, not the loss.

**The bound lives in FOUR places and the emitter is the one that matters.**
`ClipProperties.saturation` declares it, `normalizeClipProperties` clamps it,
`GradeGroup`'s slider stops at it — and `gradeMath` in `color.ts` is what
actually emits the coefficients. The first three were narrowed and the fourth was
left at 3, so the gate stayed red: a value that can no longer enter the store
legitimately could still reach the emitter through any caller that does not
launder its input through the sanitiser, and the binary refuses the whole
filtergraph rather than the coefficient. **A bound is only real at the point that
emits.** All four now agree.

**Headroom at s = 1.8, measured at both extremes — and the worst case is COOL,
not warm.** The two temperature ends bind different coefficients, so checking one
proves nothing about the other:

| temperature | `rr` | `bb` | worst |
| --- | --- | --- | --- |
| −100 (cool) | 1.4340 | **1.9515** | **1.9515** |
| +100 (warm) | **1.8252** | 1.5333 | 1.8252 |

Warm is worst for `rr`; cool is worst for `bb`; **cool binds overall at 1.9515.**
So the real margin below the limit is **0.0485 — about 2.4%, not the ~9% the
`rr`-only reading suggests.**

Confirmed independently from the other side of the seam: sweeping every
coefficient `gradeMatrix` can produce across the entire declared range
(saturation 0…1.8 × temperature −100…+100) puts the largest `|coefficient|` at
**1.9515, on `bb`, at saturation 1.8 / temperature −100** — the same number, and
the real binary accepts the real emitted chain at all four corners plus
everything-at-once, on h264 and ProRes.

### The coupling invariant — read this before widening either constant

**`saturation`'s 1.8 ceiling and `TEMPERATURE_GAIN`'s 0.12 are not two
independent constants. It is their PRODUCT that crosses 2.** Raising either one
alone walks straight back into a hard export refusal. The governing inequality is
the cool-`bb` corner:

```
(1 + TEMPERATURE_GAIN) · (LUMA_B + (1 − LUMA_B) · saturationMax)  ≤  2
        1.12            ·        (0.072 + 0.928 · 1.8)           =  1.9515  ✓
```

Solve it for whichever you want to move; the other must come down. At
`TEMPERATURE_GAIN = 0.12` the ceiling is 1.846 and 1.8 is the rounded-down
declaration. Wanting a stronger warm/cool push means a lower saturation ceiling,
and wanting more saturation means a weaker temperature — **unless** the `lut3d`
route above is taken, which removes the coefficient limit entirely and dissolves
the coupling.

This is stated here, next to the derivation, because the constants live in
`color.ts` while the filter that refuses them is emitted from `graph.ts`. The
next person to want more saturation will find the ceiling in one file and the
reason in neither. Now they find both.

`ClipProperties.saturation`, the clamp in `clipProperties.ts`, `gradeMath`'s
clamp, and `GradeGroup`'s slider `max` all move together. A project saved before this clamps
down on load, which is the one place it can happen quietly and correctly.

**If the range is ever wanted back**, the route is a generated `lut3d` — it has
no coefficient limits and one pass, so it quantises once. That is real
complexity (a LUT file per graded clip beside the filter script) and it buys
range past what two major NLEs offer, which is why it is recorded here rather
than built.

**AMENDED — `saturation` is not exact, and §2.2 used to claim it was.**
*(SUPERSEDED by §2.4 — saturation is exact once it leaves `eq`. The analysis
below is why it was wrong under `eq`, and is kept because it is also the reason
the fix has to be a domain change rather than a coefficient tweak.)* ffmpeg
`eq=saturation` scales chroma in YUV; SVG `feColorMatrix type="saturate"` is a
luma-preserving matrix in RGB using Rec.709 weights. Those coincide closely for
BT.709 material and diverge for BT.601 (SD) sources, whose luma weights differ,
and at clipping, where one clamps in YUV and the other in RGB. Nobody has
verified them equal, and an unverified exactness claim is worse than an honest
approximation label — it is the same "preview quietly disagrees with the file"
failure this document opens by refusing. brightness, contrast and temperature
remain exact: they are linear per-channel operations on gamma-encoded values,
which `feComponentTransfer type="linear"` reproduces term for term.

`ClipFilter` must carry `color-interpolation-filters="sRGB"`. Without it SVG
defaults to linearRGB and every grade term lands on a differently-transferred
signal than the file's — silently, and worst at large corrections.
`check-grade.mjs` asserts the attribute is present.

---

## 4. Transitions

### 4.1 Model — on the clip, not in a collection

```ts
export type TransitionKind = 'fade' | 'dissolve';
export interface Transition { kind: TransitionKind; frames: Frames; }  // frames >= 1

// Clip
transitionIn?: Transition;
transitionOut?: Transition;   // kind is ALWAYS 'fade' — see §4.3
```

On the clip, not a `transitions` record keyed by id, because a transition has no
identity of its own: it cannot outlive its clip, cannot be selected apart from
it, and cannot be shared. Storing it on the clip means deleting a clip deletes
its transitions, undo covers them, `serializeProject` writes them and
`migrateProject` sanitises them — with no orphan pass anywhere, which is the pass
`linkId` needed and got wrong twice.

### 4.2 `fade`

`transitionIn: {kind:'fade'}` ramps the clip up **from black and silence** over
`frames`; `transitionOut` ramps it down. Video is an **alpha** ramp, not a
luminance one: the clip is one layer of an overlay stack, and fading its
luminance to black would punch a black hole through whatever is beneath it
instead of revealing it.

- Export video: `fade=t=in:st=…:d=…:alpha=1` in the clip chain, after
  `colorchannelmixer` and before the placement `setpts`.
- Export audio: `afade=t=in:st=…:d=…:curve=tri`.
- Preview: the clip's rendered opacity is multiplied by the ramp; the audio voice
  gain is multiplied by the same ramp, computed by one shared function
  `transitionGain(clip, frame)` so picture and sound cannot drift apart.

### 4.3 `dissolve` — incoming-owned, and why

`transitionIn: {kind:'dissolve', frames}` is a **cross-dissolve with the clip
immediately before it on the same track**, and it is authored on the *incoming*
clip only. There is no `kind:'dissolve'` on `transitionOut`.

One owner, because two would be two sources of truth for one visual event: an
outgoing 12-frame dissolve meeting an incoming 8-frame one has no correct
answer, and every NLE that allows it resolves the conflict with a rule the user
cannot see.

How it builds, which is where the existing architecture pays off. Same-track
clips are already emitted in ascending `start` order and each overlays the
previous composite (EXPORT §1.6) — so the incoming clip is **already on top of**
the outgoing one. A cross-dissolve is therefore:

1. Extend the outgoing clip's tail by `frames`, taking `frames` more source via
   its input `-t`, so it is still on screen underneath.
2. Alpha-ramp the incoming clip in over `frames`, exactly as `fade` does.

No `xfade`, no second pass, no reordering — the transition is two edits to a
graph the builder already emits, and it composites correctly against whatever
else is on the stack because it never leaves the alpha channel.

**Handle.** Step 1 needs `frames` of unused source after the outgoing clip's
out-point. Available handle is
`sourceDuration − (mediaIn + sourceLength)` in source frames, converted back
through `speed`. The build **clamps** `frames` to what exists. The store keeps
the value the user authored — clamping at build time and not at author time means
trimming the outgoing clip longer later restores the transition the user asked
for, instead of silently having shortened it forever.

If the available handle is **0**, the dissolve degrades to `fade` for that build
and the export reports it once in the notice channel. It does not fail: a
transition that cannot be honoured is not a reason to refuse an export.

**AMENDED — the clamp is ONE function, `dissolveFrames` in `src/lib/color.ts`.**
Scaffold-owned, compiled into both bundles, signature:

```ts
export function dissolveFrames(
  authored: number,
  outgoing: { duration: number; mediaIn: number; properties: { speed: number } },
  sourceDurationFrames: number | null,   // null = not probed yet ⇒ unlimited
): number;                               // 0 ⇒ no handle, degrade to fade
```

This exists because the graph clamps it to decide how far to extend the outgoing
input's `-t`, and the preview's dissolve underlay clamps it to decide how long to
keep the outgoing clip on screen. Two implementations is two answers to "how long
is this dissolve", and the user sees the disagreement directly: a preview whose
ramp outruns the file's. The preview must not instead freeze the underlay on its
last source frame for the remainder of an over-long ramp — that is a third
behaviour neither side of the plan asked for.

**A TITLE IS DECIDED INSIDE THE FUNCTION, and the first draft of this section got
that wrong.** The doc comment said a title "passes `Infinity`" while the
parameter was typed `number | null` and only `null` reached the unlimited
branch. The two consumers therefore adopted two different call conventions for
the same case — the graph passed `null`, the preview passed `Infinity` — and they
agreed only because `Infinity` happened to survive the `Math.min`. That is
agreement by coincidence, in the one function extracted specifically to stop it:
the duplication had been moved out of the implementations and into the call
conventions, which is worse, because it is invisible from either side alone.

The case is no longer expressible. `outgoing` now carries `kind`, the function
short-circuits a title to unlimited without consulting `sourceDurationFrames` at
all, and any non-finite value reads the same as `null`. One convention, because
one decision. **Neither consumer was wrong; the scaffold was.**

### 4.3b Ramp length at a partial handle — NORMATIVE, and it was ambiguous

The picture ramp runs for **exactly `dissolveFrames(...)`** — the clamped length,
not the authored one — whenever that is 1 or more. At a **zero** handle the
dissolve degrades to a plain `fade` over the **authored** length.

Both consumers must do this, and both do. The graph reads
`dissolveRamp.get(clip.id) ?? tIn.frames`: the clamped value when a dissolve was
resolved, the authored value when it was not, which is precisely the two branches
above. The preview clamps the alpha ramp to match, and deliberately does nothing
at zero handle.

The reason it must be the clamped length is the one the preview owner gave
unprompted, and it is right: the underlay ends when the handle runs out, so
ramping the picture over the *authored* length would fade the tail against black
in the preview and against footage in the file. The ramp and the thing it reveals
have to end together.

This was genuinely ambiguous in the plan and the ambiguity had already produced
one defect. It is not ambiguous now.

### 4.3d A dissolve out of a TITLE degrades to a fade — a capability removed, deliberately

A cross dissolve where the **outgoing** clip is a title is degraded to a plain
fade at build time, through the existing zero-handle path, and reported in the
notice channel. Title-to-**footage** and footage-to-footage dissolves are
unaffected, including a footage dissolve running underneath a title.

**The export could do it, and did.** Verified through the real builder: two title
clips, a 12-frame dissolve on the incoming one, emits `-t 2.500000` for the
outgoing title against its own 2.0s length — the tail extension, exactly 12
frames, with the incoming title alpha-ramping over it. A correct cross dissolve,
and `notices` empty.

**The preview cannot follow it, structurally.** `DissolveUnderlay` is a single
element at the bottom of the stage, in the picture plane. A title's underlay
placed there would sit *beneath the footage*, which is worse than not drawing it.
So the preview shows the incoming title fading up over whatever is beneath, and
the file shows two titles cross-fading. That is a visible disagreement in the
ordinary case — two cards cross-fading is what credits and lower-third sequences
are made of.

**This is §4.3a's precedent, applied consistently.** There, the graph had built
and *measured* a correct audio crossfade and it was removed because
`useAudioMonitor` is one voice per track and the preview could not follow. The
same rule decides the same way here: **this project does not ship an export
behaviour the preview cannot show.** Ruling otherwise would make §4.3a arbitrary
in hindsight, and the doctrine at the head of this document would mean whatever
was convenient that day.

It is strictly better off than §4.3a in one respect: the degradation is
**announced**. The zero-handle path already pushes a notice, `ExportProgressEvent.notices`
now carries it to the user, and the sentence should name the cause — a dissolve
out of a title card — rather than the handle.

**The condition for lifting this is specific**, so it is not a permanent excuse:
a per-title underlay living *inside* the title stack rather than at the bottom of
the stage. That is a real feature, it is preview's, and the day it exists this
degradation comes out and the export's existing behaviour is simply re-enabled —
nothing in `graph.ts` needs designing, only the `continue` removing.

### 4.3c A dissolve OUT OF a title is intended

§5.1 already says it — "transitions and grade all apply, because a title is just
an input" — but it had never been read against §4.3, and the preview owner found
the gap by following a doc comment that was itself wrong.

A title card dissolving into the footage under it is an ordinary thing to want
and the model has always permitted it. Its handle is unlimited because a title is
a `-loop 1` still with no out point to run past, so it can hold any tail asked of
it. The preview's dissolve underlay therefore has to be able to draw a title, not
only a `<video>` — the same `drawTitle` and the same spec, or a dissolve out of a
title cross-fades against black in the preview and against a title in the file.
That is now built and it is required, not incidental.

### 4.3a A dissolve is a PICTURE event. It applies no audio ramp. — NEW

Neither side. Not the incoming clip, not the outgoing one. The audio at a cross
dissolve is a hard cut, which is the same cut every ordinary edit point in this
programme already makes.

This settles a defect the transitions gate caught in the first build: the
incoming clip took `afade=t=in` because the ramp was derived from
`transitionIn.frames` without consulting `transitionIn.kind`, while the outgoing
clip's audio stopped dead at its `atrim`. For the length of the transition the
only thing playing was a clip fading up from silence — an audible hole, and the
worst of the three available answers.

The other two were both coherent, and this is why they lost:

- **Crossfade both sides.** The export can do it, and did: the graph owner built
  it and *measured* it against the real binary — RMS dipping ~2.5 dB at the
  midpoint and recovering, which is the correct figure for a linear crossfade of
  uncorrelated sources. It works. The preview cannot follow it. `useAudioMonitor`
  picks **one voice per track** (`picked` is a `Map<TrackId, Candidate>`), and a
  cross dissolve is two clips on the SAME track that would have to sound at once.
  Matching the export would mean doubling the voice pool inside a budget of
  eight, for handle material that is not in the edit. So the choice is not
  "crossfade or not", it is "crossfade in the file only" — a preview that hard
  cuts where the file blends, which is the one failure this document opens by
  refusing.
- **Ramp only the incoming side.** That is the bug, restated as a policy.

**A correction to this section's own first draft, which argued badly for the
right answer.** It claimed the model "already expresses" an audio crossfade as
`fade out` + `fade in`. It does not. `transitionIn` holds ONE `Transition`, so a
clip whose in-edge is a dissolve has no slot left for an audio fade — the user
cannot author the combination at all. The reasoning above does not depend on that
claim and stands without it, but the claim was false and is withdrawn.

What actually settles it is convention plus architecture. Every professional NLE
treats a video transition and an audio transition as **separate objects** —
Premiere's Cross Dissolve is a video effect and Constant Power is a different,
independently placed audio one. PRODUCT principle 3 says this app follows NLE
convention. A picture-only dissolve is therefore the conventional answer, not the
cheap one, and it happens to be the previewable one as well.

**Named consequence, stated rather than hidden:** there is currently no way to
author an audio crossfade at a cut. That is a real gap and it is deferred, not
solved. When it is built it is a separate pair — `audioTransitionIn` /
`audioTransitionOut` — not a widening of `Transition`, because the whole reason
this section exists is that one field standing for two independent events is what
produced the bug in the first place.

`transitionGain` therefore takes a required third argument,
`stream: 'video' | 'audio'`, and returns 1 for an audio `dissolve`. Required
rather than defaulted so `tsc` enumerates every call site rather than leaving one
silently on the picture rule. The rule is written there and nowhere else.

The inspector says so on the control: a cross dissolve is labelled as affecting
picture only, with `Fade` named as the way to ramp the sound.

### 4.4 Authoring

- Drag the small ramp handle in a clip's top corner. Timeline area owns it.
- Clip context menu: `Fade in`, `Fade out`, `Cross dissolve` (enabled only when
  an adjacent earlier clip on the same track ends exactly at this clip's start),
  `Remove transitions`.
- Default duration: 12 frames, clamped to a third of the shorter clip.
- Inspector shows both as numeric frame fields with a kind select.

---

## 5. Titles

### 5.1 A title is a clip with no media

```ts
export type ClipKind = 'media' | 'title';   // ABSENT ≡ 'media'

export interface TitleSpec {
  text: string;
  /** Cap height as a fraction of frame height. 0.02 .. 0.4 */
  sizePct: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  /** '#rrggbb' */
  color: string;
  /** '#rrggbb' plate behind the text. */
  background: string;
  /** 0..1. 0 = no plate. */
  backgroundOpacity: number;
  align: 'left' | 'center' | 'right';
  /** Anchor of the text block within the frame, 0..1. 0.5/0.5 is centred. */
  anchorX: number;
  anchorY: number;
}

// Clip
kind?: ClipKind;
title?: TitleSpec;
export const clipIsTitle = (c: Clip): boolean => c.kind === 'title';
```

A title clip carries `mediaId: ''`. Every media lookup must skip title clips
rather than resolve an empty id — `offlineClipIds` in particular, or every title
would show as offline media.

Not a new `MediaKind`: `Track.kind` is a `MediaKind`, so widening it would invent
a "title track" that this app does not have. A title belongs on a video track,
above the footage, where the user already knows to put it.

### 5.2 The renderer rasterises. Both times.

drawtext with `fontfile=` is the obvious route and it is the wrong one: it means
font resolution, `:` and `\` escaping inside a filter script, no web font, no
kerning parity, and a preview drawn by Chromium that will never agree with a file
drawn by freetype. The disagreement is not subtle at large sizes.

Instead: **one rasteriser, used twice.** `src/lib/titleRaster.ts` exports

```ts
export function drawTitle(ctx: CanvasRenderingContext2D, spec: TitleSpec, w: number, h: number): void;
```

- **Preview** draws it to a `<canvas>` layered over the video at stage size.
- **Export** calls the same function on an `OffscreenCanvas` at project
  resolution, in the renderer, while assembling the `ExportDocument`; the PNG
  goes in as base64 on a new `ExportSource` variant. Main writes it beside the
  filter script and feeds it as `-loop 1 -framerate <OF> -t <dur> -i title.png`.

The exported title is then, byte for byte, the pixels the user was looking at.
That is worth an input per title clip and a few hundred KB in the IPC payload.

Titles otherwise flow through the existing chain unchanged — `scale`, `opacity`,
placement, transitions and grade all apply, because a title is just an input.

---

## 6. Subtitles (SRT)

### 6.1 Model — project-level, not clips

```ts
export type CueId = string; // 'q_' + nanoid
export interface SubtitleCue {
  id: CueId;
  start: Frames;   // project frames, inclusive
  end: Frames;     // exclusive, > start
  text: string;    // '\n' separates lines. No markup.
}
export interface SubtitleStyle {
  sizePct: number;    // 0.02 .. 0.2 of frame height
  color: string;      // '#rrggbb'
  outline: number;    // 0..4 px at 1080, scaled with output
  marginPct: number;  // 0..0.4, distance of the baseline from the bottom
}
// ProjectFile
subtitles: SubtitleCue[];
subtitleStyle: SubtitleStyle;
```

Project-level, not clips on a track, because subtitles are a property of the
programme and not of any clip in it: they survive re-cutting the footage
underneath them, and putting 400 of them on a track would wreck the "legible
under load" budget the timeline is designed against (PRODUCT principle 4).

### 6.2 `src/lib/srt.ts` — pure, both directions

```ts
export function parseSrt(text: string, fps: number): SubtitleCue[];
export function formatSrt(cues: SubtitleCue[], fps: number, offsetFrames?: number): string;
```

Tolerant on read: BOM, CRLF, `,` or `.` as the millisecond separator,
non-sequential indices, blank cues, and a missing trailing newline. Strict on
write: CRLF, `,`, 1-based sequential indices, one blank line between cues, which
is what every player agrees on.

Times round to the nearest project frame on read. That is lossy against the
source milliseconds and it is deliberate — everything in this store is whole
frames (model.ts §2.1), and a cue that is 3 ms off a cut it was authored against
is a cue that flickers.

### 6.3 Burn-in

`ExportSettings` gains `burnSubtitles: boolean`, default `false`.

Main writes the cues to `subs.srt` **in the same temp directory as the filter
script**, offset by the export range start and clipped to it, and spawns ffmpeg
with `cwd` set to that directory so the filter can say

```
subtitles=filename=subs.srt:force_style='…'
```

with a bare relative filename. This is the whole reason for the `cwd`: escaping
an absolute Windows path inside a filter script means `C\:/Users/…`, and the
userData path on this machine contains spaces and a capital-letter drive, which
is precisely the shape that breaks. A relative name has nothing to escape.

The filter is appended to the **terminal** video chain, after the last overlay
and before the final `format`, so subtitles sit above every clip and are not
affected by any clip's grade.

`force_style` is built from `SubtitleStyle` with the font size scaled to the
output height, so a burn-in at 4K matches the preview at 1080.

### 6.3a Measured — and "matches" was the wrong word

Resolution independence is **verified and strong.** One 1920×1080 project rendered
at three sizes, glyph bounding box as a fraction of frame dimensions:

| output | glyph height | baseline from bottom | centre x |
| --- | --- | --- | --- |
| 960×540 | 8.15% | 12.41% | 50.05% |
| 1920×1080 | 8.24% | 12.31% | 50.05% |
| 3840×2160 | 8.24% | 12.31% | 50.08% |

**0.09 points of spread on size and 0.10 on position across a 4× range.**

**DO NOT "FIX" THE UNCHANGING `force_style`.** It emits `FontSize=36,
MarginV=29` *identically* at all three resolutions, which reads as a scaling bug
and is not one: libass scales those through its own script resolution. The table
above is what happens, and it is right. Anyone who spots the constant and adds an
output-height multiplier will break a verified behaviour — this paragraph is here
because that edit looks obviously correct.

**Preview against file at 1080 is a SCALED match, not a pixel match**, and the
sentence above overclaimed by saying "matches" without qualification:

| observable | agreement |
| --- | --- |
| glyph size | within **0.6%** relative |
| baseline position | **0.58 pts** of frame height, preview higher |
| block width | preview **1.5%** narrower |

That is a divergence, not a failure, and the distinction is real: §6.3 claims a
scaled match where §5.2 claims pixel identity for titles, and only §5.2 is built
on a shared rasteriser. Subtitles are drawn by **two different text engines** —
Chromium shaping the preview, libass the file — and `SubtitleLayer`'s own header
already said they "do not agree on line breaking, on the exact outline join, or
on shaping."

So the code was honest and the plan was not. That is the same gap that produced
§2.4 and §3.1a: a claim in this document that the implementation's own comments
contradict. **The numbers above are now the claim**, and §6.3's "matches" is read
subject to them — the way §5.2's claim is read subject to its 0.1%.

Burn-in requires **libass**. It is compiled into the pinned build; `stage-ffmpeg.mjs`
now asserts it (§7).

### 6.4 Sidecar

`Export subtitles (.srt)` in the app menu writes `formatSrt(cues, fps)` next to
wherever the user chooses. Independent of any encode, available with an empty
timeline, and the reason `formatSrt` takes an `offsetFrames` it does not use
here.

### 6.5 Editing

A subtitle panel in the inspector: the cue list, click to seek, edit text and
both times inline, `+` to add a cue at the playhead, Delete to remove. Import
replaces or appends — the user is asked which, once, and only when there are
already cues.

**AMENDED — import goes through a native dialog, not a hidden `<input
type="file">`.** A hidden file input is a browser affordance, and this app's
first hard anti-reference is a desktop tool that reads as a web page in a window.
Every other file operation here — open, save, save as, export, the `.srt`
sidecar write in §6.4 — goes through main and a native dialog, and an import that
did not would be the one place the app forgot what it is. It also cannot reach a
recent-files list, cannot remember a directory, and hands the renderer a `File`
whose path it is not allowed to know.

New channel, symmetric with `subtitles:export`, which `api.ts` already declares:

```ts
subtitlesImport: 'subtitles:import';
// main → { ok: true; text: string; path: string } | { ok: false; reason: 'cancelled' | 'read-failed' }
```

Main opens the dialog filtered to `.srt`, reads UTF-8, and returns the text.
Parsing stays in the renderer with the scaffold's `parseSrt`, because `fps` lives
in the store and §6.2 rounds to whole project frames on read.

**Owner: graph** — see the §0 amendment; `electron/ipc/*` and `preload.ts` are
now graph's. The inspector calls it.

## 6.6 Writing subtitles by hand — NEW, and it is the point of §6

§6.5 gave subtitles a data structure and an editor. It did not give them an
**authoring loop**, and without one the feature exists without being usable: to
write a line today you watch, reach for the mouse, find the inspector, click `+`,
click the text field, type, and go back for the next line. Four hundred times.
The first principle in PRODUCT.md is that the keyboard is the primary instrument,
and this is the clearest case in the app of that principle being stated and not
honoured.

### 6.6.1 The loop, which is two keys and typing

The convention every subtitling tool converges on, because it is the shape of the
task: you hear a line begin, you hear it end, and in between you type it.

1. Playing. The line starts. **`C`** — a cue is created at the playhead, the
   subtitles group opens if collapsed, and **its text field takes focus.**
2. Type the line.
3. The line ends. **`Ctrl+Enter`**, from inside that field — the cue's `end`
   snaps to the current playhead and focus leaves the field.

`C` is free; so is `Ctrl+Enter`. Neither collides with the registered set.

Three things about this are normative, not incidental:

- **`C` creates AND focuses.** A shortcut that only creates a row has bought
  nothing: the user still reaches for the mouse to type into it. The focus jump
  is the feature. If it is dropped, the shortcut should be dropped with it.
- **Playback does not stop.** Not on `C`, not on focus, not on `Ctrl+Enter`. A
  transport that pauses when the text field takes focus destroys the loop — the
  whole point is to write against running picture. Any global "space pauses"
  handling must already be inert inside a text field; verify it, do not assume it.
- **`Ctrl+Enter` is field-scoped, so "which cue" is never ambiguous.** There is
  deliberately no "most recently touched cue" concept anywhere. The cue being
  closed is the cue whose field has focus. A global out-point key would need one
  and would get it wrong the first time the user clicked somewhere else.

### 6.6.2 The four questions, answered

**A cue already covers the playhead.** Create anyway, and touch nothing that
exists. Overlapping cues are legal — `SubtitleLayer` already joins concurrent
cues with `\n` and libass already stacks them in time order, so both consumers
agree and neither needs a change. Two speakers talking over each other is the
case, not the corner case. Silently truncating the neighbour to make room is the
"no overwriting a neighbour" that `timelineSlice`'s rule 1 forbids, and the user
already has an explicit way to end the previous cue: `Ctrl+Enter` in it.

**The default end.** `start + 2s`, which is what `addCue` already does. Keep it,
and treat it as **provisional** — the value `Ctrl+Enter` overwrites. It exists so
a cue is never invalid (`end > start` is an invariant, not a preference) if the
user never closes it. "Runs until the next cue" was the alternative and it is
worse: it makes a cue's length depend on a cue that does not exist yet, and it
changes a length the user already accepted when the next cue is added.

**A dedicated typing mode.** No. A mode is a thing to enter, remember being in,
and leave; this loop needs none of that, because the text field IS the mode and
focus is its indicator. Depth on demand (principle 2) is satisfied by the group
staying closed until there is a reason to open it.

**Overlap in the burn-in.** Already correct on both sides; see above. `formatSrt`
writes overlapping cues in time order, which is legal SRT, and every player
stacks them.

### 6.6.3 The seam — `focusCueId` on `uiSlice`

`C` is dispatched by the timeline region; the field it must focus lives in
`SubtitlesGroup.tsx`, which is inspector's. Neither may reach into the other, so
the signal goes through the store, one way:

```ts
// uiSlice
focusCueId: CueId | null;
requestCueFocus(id: CueId | null): void;
```

The handler calls `addCue(playhead)`, then `setInspectorGroupOpen('subtitles', true)`,
then `requestCueFocus(id)`. `SubtitlesGroup` watches `focusCueId`, focuses that
row's field, and **clears it to `null` immediately**. Clearing is the row's own
job and is not optional: a `focusCueId` left set would re-steal focus on the next
unrelated render, which is the classic form of this bug.

`focusCueId` is UI state, not document state. It is not in `TimelineDoc`, it does
not push history, and it does not dirty the project.

**A bare `CueId` is enough. No `{id, seq}` nonce.** This was an open risk rather
than a decision: the worry was that requesting focus for the id already in
`focusCueId` would be a no-op, so a repeat would be swallowed. It is not, and the
reason is structural — **the consuming row clears to `null` the moment it takes
focus**, so every request is a `null → id` transition and there is no same-value
write to swallow. Measured, not argued: repeated requests for the same id land on
the correct textarea every time. The clear is therefore not merely hygiene
against a stale request; it is what makes the plain id sufficient. Anything that
weakens it — clearing on blur, clearing in an effect that can be skipped, or
holding the value for a second consumer — brings the nonce back with it.

**A focus request must not depend on an event firing.** In a windowed list the
requested row may be outside the mounted range, so something has to widen the
window before the row can take focus at all. Doing that by scrolling and waiting
for the scroll handler makes the whole loop ride on event delivery, and it was
measured failing: a programmatic scroll to row 300 put the element at the correct
offset while the mounted window still held rows 1–6, so the row never mounted,
never focused, and never cleared the request — §6.6.3's stale-request hazard,
reached through the ordinary `C` key rather than through an error.

The window is therefore set **directly, alongside the scroll**, and — the part
that is easy to get wrong in the other direction — **only on the instant path.**
An animated scroll emits a stream of events that walks the window across with the
travel; jumping it to the destination would mount the far-end rows while the
element was still moving and the user would watch blank space slide past. Instant
scroll sets the window; animated scroll lets its own events carry it.

### 6.6.3a The cue list must be REACHABLE, which it currently is not

§6.6.1 said "the subtitles group opens if collapsed" and stopped there. That was
written thinking only about the group's own collapse, and it missed the panel
underneath it. Intersect the two real gates —

- `selectInspectorVisible` = `selection.size > 0 || inspectorPinned`
- `SubtitlesGroup` renders only in `Inspector`'s `clips.length === 0` branch

— and the cue list is on screen **only when the selection is empty AND the
inspector is pinned**. In every other state `C` creates a cue, opens a group that
is not rendered, and files a focus request with no consumer to answer it. The
request then sits non-null until the user happens to empty the selection with the
inspector pinned, and the caret jumps somewhere they cannot connect to anything.
That is the stale-request hazard §6.6.3's own comment warns about, reached by the
ordinary path rather than by an error.

The timeline owner declined to paper over it with a fourth step, and was right on
both counts: auto-pinning invents persistent user-visible state nobody asked for,
and auto-deselecting destroys the user's selection to make a shortcut work.

**Two changes, and neither is sufficient alone.**

**1. `SubtitlesGroup` renders in BOTH of `Inspector`'s branches.** This is not a
concession to the shortcut — it is a defect the shortcut exposed. §6.1 puts
subtitles at the project level precisely because they are a property of the
programme that survives re-cutting the footage beneath them. Gating them on an
empty selection says the opposite: that they are visible only when you are not
editing. A user captioning a cut who wants to see the caption over the clip they
have selected currently has to deselect it. The group stays collapsed by default
in both branches, so the calm default screen is unchanged.

**2. `selectInspectorVisible` gains `|| inspectorGroups.subtitles`.**

**NOT `|| focusCueId !== null`**, which is what was proposed and which cannot
work: the row clears the request the instant it takes focus, so panel visibility
keyed on it would unmount the panel at the exact moment of success, taking the
focused field with it. The request is a one-shot handoff; visibility needs
something that persists.

The open flag is that thing, and `cueCommand` already sets it. It persists for
exactly as long as the user is working with cues, it is set by the same step that
files the focus request, and it is released by an obvious, reversible gesture —
collapsing the group. One sentence states the whole rule: **an open cue list
keeps the inspector on screen.**

Accepted consequence, stated rather than discovered later: `inspectorGroups`
persists across sessions, so a user who leaves the cue list open gets an
inspector on launch with nothing selected. That is indistinguishable from having
pinned it, it is their own doing, and collapsing the group undoes it. That is a
better trade than a shortcut that silently does nothing two states out of three.

**Owners:** inspector (change 1), state (change 2 — `selectInspectorVisible` is
in `uiSlice.ts`). Timeline's third is already correct and does not change.

### 6.6.4 Four hundred rows

Principle 4 is explicit that this is designed for load. The cue list is the one
surface in the app that can plausibly hold 400 rows, and 400 mounted text inputs
is not a list, it is a stall.

- The list is **windowed**: only rows near the viewport are mounted. A row's
  editable fields may mount on demand, but the row's height must not depend on
  whether they have, or the list jumps as it scrolls.
- The cue under the playhead is **marked and scrolled into view** during
  playback, so the loop does not require the user to chase it. Under
  `prefers-reduced-motion` that scroll is instant, never smooth — a real
  alternative, per CLAUDE.md, not a disabled one.
- The marking is not carried by hue alone.
- Adding a cue must not re-render 400 rows. Subscribe per row by id, the way the
  timeline subscribes per clip.

### 6.6.5 Owners

| Piece | Owner |
| --- | --- |
| `focusCueId` + `requestCueFocus` on `uiSlice`; `addCue` unchanged | **state** |
| `subtitle.addCue` row (`C`, scope `timeline`, not repeatable) and its dispatch | **timeline** |
| Focus consumption, `Ctrl+Enter` handling, windowing, playhead-following | **inspector** |

The shortcut row and whatever dispatches it land in the **same change** — §0.

---

## 7. Gates

Every feature ships with a gate, and every gate is proven to bite by feeding it
the broken input before it is trusted. This is not optional and it is not
"if there's time".

| Gate | Asserts |
| --- | --- |
| `check-mix.mjs` | effective gain is the product of clip, track and mute in **all three** consumers; a track at 0 emits no input **in the export**. In the PREVIEW a track at 0 is permitted to keep its voice and gate it to gain 0 — `monitorAudible` deliberately does not test `trackVolume > 0`, because dropping and reloading a source every time a live fader drag crosses zero is a worse defect than an idle silent element. The gate asserts effective GAIN on that path, never voice count. |
| `check-grade.mjs` | **AMENDED by §2.4 — see §7.1.** `gradeMath` is the only source of both filters; `neutral` emits nothing; and the grade claim is asserted by **running the pinned binary on a known pixel through the actually-emitted chain** and comparing against `gradeMath`'s prediction within ±1/255. No `eq` identity anywhere: `eq` is not in this project's grade path. |
| `check-transitions.mjs` | a dissolve extends the outgoing `-t` by exactly the clamped frames; handle clamping; degradation to `fade` at zero handle; **neither side of a dissolve carries an audio ramp** (§4.3a) |
| `check-titles.mjs` | `drawTitle` is called by both preview and export document; a title clip never reaches a media lookup |
| `check-srt.mjs` | `parseSrt`/`formatSrt` round-trip; the tolerant-read cases in §6.2 each parse |
| `stage-ffmpeg.mjs` | extended with `REQUIRED_FFMPEG_FILTERS` — `lutrgb`, `colorchannelmixer`, `gblur`, `unsharp`, `vignette`, `fade`, `afade`, `subtitles`, `hflip`, `vflip`. `subtitles` is the libass canary |
| `check-export-graph.mjs` | extended: the six features' constructs appear in a built graph and are absent when unset |

`REQUIRED_FFMPEG_FILTERS` is the direct descendant of the v0.1.4 failure, where a
build answered `-version` perfectly and had no `-filter_complex_script`. A build
without libass would answer `-version` perfectly and burn no subtitles.

### 7.1 `check-grade` runs the binary. The row above was stale and the gate caught it.

§2.4 took `eq` out of this project and **did not amend this section's row for
`check-grade.mjs`**, which went on instructing the gate to round-trip
`slope`/`intercept` against `eq`'s definition. The gate stayed green while
asserting an identity against a formula the export no longer emits. That is the
standing rule of §2.4 catching itself a second time, in the document rather than
in the code, and it is my error twice over: I wrote the rule and then left the
row that violates it.

The recommendation was to assert against the emitted `lutrgb` expression instead.
**That is better but not sufficient, and stopping there would be the third
iteration of the same mistake:** comparing `gradeMath`'s numbers against an
expression this project also generates is still two of our own outputs agreeing.
It would not notice a `lutrgb` semantics change, a `gbrap` depth regression, or a
pixel-format conversion silently reintroducing the range expansion — which is the
entire class §2.4 exists to close, and precisely what §10.1 says only a real
binary finds.

**The assertion is the measurement.** `check-grade` builds a real graph, runs the
**pinned binary** on a synthetic known pixel through the **actually emitted**
clip chain, and asserts the output matches `gradeMath`'s prediction within
**±1/255** — the tolerance §2.4 states. Brightness, contrast, saturation,
temperature, and all four together, which is the row that first exceeded the bar
and forced the depth choice. Reading the emitted expression is welcome as a
diagnostic that says *why* a failure happened; it is not what passes the gate.

**No skip path.** If the binary is not staged the gate FAILS, naming
`stage-ffmpeg`. A gate that cannot run is not a gate that passed, and "skipped
because unavailable" is how a suite rots into decoration.

### 7.2 Two rules about how gates are written, learned from building them

**Assert the guard's stated property, not its consequence.** Dropping
`clipUsesMedia` from `referencedSources` left every assertion green, because
`items['']` simply misses and no bad source is emitted — the guard protects a
lookup that is harmless *today*. The right response was not to drop the mutation
for failing to bite; it was to make the gate assert §7's literal wording, "a
title clip never reaches a media lookup", by recording every key read through a
`Proxy` and requiring that `''` never arrives. A gate written against the
downstream effect goes quiet the moment the effect is incidentally benign, and
comes back only when someone makes the lookup harmful again — which is the one
moment it was supposed to speak.

**Assert behaviour, never the presence of a string.** On why the D1 gate is
behavioural rather than a grep, verbatim, because it is the clearest statement of
this the project has produced:

> A grep passes the moment somebody re-derives the same gate under another name,
> and fails on a module that legitimately mentions `selectVideoClipIdAtFrame` —
> which this one does, deliberately, to read the clock clip's rank so titles
> below it composite below it. The string is not the defect; "a title in range on
> a visible video track that the preview does not draw" is.

So every arrangement the old code structurally could not produce is a case: it
survives renames and it holds whichever way the stack runs — the same property
§11.1 requires of the ordering gate, arrived at independently.

### 7.3 The instrument must not be downstream of the thing it measures

§7.1 says measure rather than restate. §11.2 says build fixtures through real
actions. A gate can obey both and still be worthless, and this is the case that
proves it.

`check-grade`'s first ceiling gate binary-searched the pinned binary for the
saturation at which `colorchannelmixer` refuses, and asserted
`reachable <= encodable`. It was a real measurement against the real binary, and
it independently reproduced the derivation in §2.5 to four decimals without ever
being told the formula — **1.8467 measured against 1.846 derived.** That is a
gate doing everything this document had asked of it.

It was still the wrong gate. **Every probe it sent was built through `gradeMath`
— whose clamp is the thing under test.** So the moment that clamp was narrowed to
the legal range, the search could no longer reach an illegal coefficient and
reported "no ceiling found". A gate that goes blind at exactly the moment the
code becomes correct, and that would then stay blind through any later
regression. It surfaced only because a mutation setting `gradeMath` to 1.8 —
run to confirm the fix would go green — returned a failure instead.

**The rule: a gate must not route its probes through the code it is checking.**
If the subject can filter, clamp, or reshape the input on its way to the
observation, the observation is a statement about the subject's own behaviour and
cannot contradict it. This is not covered by §7.1, because it *was* a
measurement, nor by §11.2, because the fixtures *were* real.

### 7.3a The pattern that replaced it: write no bound down at all

The rebuilt gate names no number. It pushes
`[1.85, 1.9, 2, 2.5, 3, 10, 1e6, Infinity, -Infinity, '3', NaN, undefined]`
through the real `normalizeClipProperties`, takes whatever comes back, builds the
emitted chain **from the sanitiser's output** at all three temperature extremes,
and requires the pinned binary to run it.

**The sanitiser names the value; ffmpeg gives the verdict; the gate supplies
neither.** Two independent authorities, and the gate is only the wiring between
them — so there is no constant in it to go stale, which is the failure §7.1 was
written about and which this gate had itself committed in another section
(`saturation must clamp to 3`, left behind and still passing while the model said
1.8). That constant is gone. No bound is written down anywhere in the file.

`saturation: 3` was not deleted from the suite — it **moved**, from "must be
encodable" to "must be unreachable". A narrowed range is only a fix if the
narrowing is enforced, and that is the assertion that enforces it.

**Why the round trip earns its cost, when a cheaper check exists.** A cross-clamp
agreement check between `gradeMath` and `normalizeClipProperties` catches either
clamp being widened alone. It does not catch both being widened **in step** —
which is the realistic regression, because "let's allow 3 again" is one intention
expressed in two files. Only the round trip through the binary catches that, and
it fires on the first value past the bound naming the coefficient and the corner.
Cheap checks that cover the easy half are worth having; they are not worth
mistaking for the gate.

### 7.4 Ways to be confidently wrong — every one of them found in this build

*(This heading said "Four ways, all four found" for three entries longer than it
was true. A count in a heading is a constant that goes stale the moment the list
grows, and it went stale in the section warning about exactly that. No count now.)*

Recorded together because each was found only after the previous one had been
fixed, and none of them is caught by the rule that catches the one before:

1. **Paper against binary.** §2.4 — `eq`'s identity holds algebraically and in a
   different colour domain than the preview's, so the gate and the code agreed
   while the product claim was false.
2. **A proof that clipping breaks.** §2.5 — `S(a)·S(b) = S(a·b)` is true and the
   split still fails, because clamping between passes is non-linear and two
   matrix passes quantise twice. Proved on paper by the planner, refuted by the
   binary within the hour.
3. **A measurement too narrow to discriminate.** §7.1's probe set — a depth
   regression reading exactly 1.00/255 on four pixels, on the bar, staying green.
   The tolerance was right; the sample was not.
4. **A measurement taken through the subject.** §7.3 — correct algebra, correct
   measurement, instrument downstream of the clamp under test.
5. **A measurement sensitive to the medium rather than the subject.** §5.2's
   verification — a raw glyph-pixel count showed preview and file 12% apart, and
   the 12% was **chroma subsampling softening glyph edges**, not a difference in
   what was drawn. Counting lit pixels measured the codec. A normalised bounding
   box measures the typesetting, and it came back within 0.1% of frame height
   across a 2× scale change. The verifier diagnosed this rather than reporting
   it, which is the only reason §5.2 is not currently recorded as failing.

   The general form: **choose the observable that is invariant under everything
   you are not testing.** A measurement that moves when the encoder changes is a
   measurement of the encoder.

   It happened a second time, on blur, and was caught by the owner: a
   second-moment estimator read the blur as **wider** rather than narrower — the
   wrong *sign*, not merely the wrong magnitude — because `(x−μ)²` weights the
   far tails hardest and the tails are exactly where an IIR approximation is
   worst. It was measuring the tails, not the width.

   The fix generalises better than the diagnosis: apply the estimator
   **identically to the output and to an analytic ideal at the same parameter**,
   and report the ratio. Whatever bias the estimator carries then cancels. When
   an observable cannot be made clean, make it *symmetric* — a biased instrument
   pointed at both sides still measures the difference between them.

   And its companion rule, exercised in the same report: when a control's own
   residuals come out **non-monotonic**, that is the data saying the instrument
   is wrong, not that the subject is strange. The end-to-end blur figure was
   withheld for exactly that reason.

6. **Re-measuring a FIXED thing and retracting the finding that caused the fix.**
   The rarest and the most expensive, because it destroys the record rather than
   producing a wrong number.

   The Fader's unity tick was measured at 1.26:1 against the groove and reported
   as a defect. It was fixed by **moving the tick out of the groove** — from a
   child to a sibling — so that its backdrop became the track head. Re-measured
   afterwards it read 11.77 / 12.13 / 13.38, and the pass concluded: *"I measured
   the tick against the groove; the tick does not sit on the groove."*

   The tick does not sit on the groove **now**. That is not an instrument error,
   **it is the fix.** The evidence is unambiguous even though `fader.css` and
   `Fader.tsx` are untracked and no diff exists: the groove carries
   `overflow: hidden`, and the current tick is `position: absolute; top: 10px`
   against a 4px groove — as a child it would be clipped to nothing and render
   *invisible*, not low-contrast. So the present arrangement cannot be the one
   that produced 1.26. Two owners independently measured the pre-fix pair and
   agreed (1.25 computed, 1.26 in-app); two owners independently measured the
   post-fix pair and agreed (11.72/12.14/13.43 computed, 11.77/12.13/13.38
   in-app). Four consistent measurements of two different arrangements.

   **Rule: a measurement taken after a fix cannot invalidate the measurement that
   motivated it.** Before retracting a finding, establish that the code is in the
   state the finding described — and if it is not, the finding was correct and the
   fix worked. The tell is a retraction whose reasoning is a fact about the
   current code ("the tick does not sit on the groove") offered as a fact about
   the past.

   The cost of accepting one is not a wrong number, it is a wrong *history*: the
   fix is recorded as a response to a phantom, the comment explaining why the
   construction is odd reads as unmotivated, and the next person simplifies it
   back. §1.4 carries the numbers and the structural argument for that reason.

7. **Widening a tolerance to cover an instrument artefact.** The tempting
   response to a residual you cannot explain is to loosen the bound until it
   fits. That does not document the subject, **it documents the instrument** —
   and it does it permanently, in the one place future readers will trust.

   The blur no-grade path measured 1.4–2.4 points narrower than the graded path,
   which is large against a 2.9% bar. It was not real. The proof is the technique
   worth keeping: **make the two cases differ only by something provably a
   no-op.** A saturation matrix's rows sum to 1, so on a grey step edge it is
   identity, and saturation-only emits no `lutrgb` at all — so blur-only versus
   blur+saturation differ by a filter that mathematically cannot change the
   fixture. Compared sample by sample rather than through a statistic, the
   profiles differed at **3 of 2048 samples, by 1.2 code values at 8-bit** —
   rounding in the matrix multiply. Those three samples moved the 10–90 residual
   by half a point, because the 10% crossing sits where the profile is nearly
   flat (slope 438/px against 1006/px at 40%), so one code value displaces it
   0.69 px ≈ 1.07% of the width.

   The decisive tell is general and cheap: **cases that are mathematically
   identical still differed.** When that happens the spread is the estimator, not
   the subject, and no amount of re-measurement will make it go away. Fix the
   observable or report the artefact — never widen the bound.

8. **Explaining away a gate failure with a mechanism you did not check.**
   `check-linking` failed once with
   `10. every combo maps to exactly one row — V -> edit.marker, edit.insertAtPlayhead`,
   did not reproduce, and was written up as the gate having bundled a
   half-written `shortcuts.ts` while its owner was saving.

   **That diagnosis was wrong.** Another owner was at that moment proving §10
   bites by *temporarily binding `V` to two rows*, and its report quotes the same
   message byte for byte. The gate read a file that was exactly as written and
   reported a real collision. **It caught a deliberate mutation in flight.**

   Nothing was broken and nothing needed fixing — but a hazard recorded on a
   misdiagnosis is worse than no hazard recorded, because it teaches a mechanism
   that was not operating. This entry replaced one that did exactly that, and the
   planner published it before the second report arrived.

   **The real lesson is narrower and more useful:** in a shared tree, owners run
   mutation tests by deliberately breaking things, so **another owner's gate run
   can observe a deliberate break and report it as a mystery.** An unreproducible
   failure naming a specific, plausible collision is as likely to be someone
   else's mutation as anything else. Say so in the report and the next reader
   spends a minute, not an hour.

   **The rule survives, and this episode is its best argument.** A green re-run is
   not evidence, and *naming* a mechanism is not evidence either — a guess in the
   grammar of a diagnosis is harder to challenge than an admitted guess. Either
   check the mechanism or say the failure is unexplained.

   **The cheap way to make it checkable: a gate that fails preserves its bundled
   input** and prints the path. esbuild already writes to a temp directory; skip
   the cleanup on failure. Here that would have settled it immediately — the
   preserved bundle would have shown `shortcuts.ts` complete, well-formed, and
   with `V` bound twice, which disproves "torn file" and names the real cause in
   one look. It costs one `rmSync` that does not run.

The through-line is that being right about the mechanism is not the same as
having checked it, and that each new form of rigour created the blind spot the
next one found. That is the argument for §10 existing at all, and for not
declaring anything done on a green suite alone.

---

## 8. Sequencing

1. **Foundation** — planner writes the scaffold-owned files in §0. Nothing else
   starts until `npm run typecheck` passes on the foundation alone.
2. **Fan out** — state, graph, preview, timeline, inspector, in parallel, one
   owner per file.
3. **Gates and docs**, then typecheck + build + `npm run check`, then the real
   app over CDP, then a real export of each feature diffed against the preview.

Nothing reports done on a typecheck. The bar is a file on disk that matches what
the preview showed.

---

## 9. Interfaces between owners — NORMATIVE

Five areas are built in parallel against each other's unwritten code. These are
the seams, declared here so nobody guesses. An owner that needs one of these to
be different says so to the planner; it does not change it unilaterally, and it
does not work around it.

### 9.1 `src/components/ui/Fader.tsx` — built by **inspector**, used by **timeline**

```ts
export interface FaderProps {
  /** 0..2, 1 = unity. */
  value: number;
  onChange(next: number): void;
  /** Names the thing being faded: "track V1", "master". Becomes the accessible name. */
  label: string;
  /** Below this the control is not rendered at all — the caller decides, not the Fader. */
  disabled?: boolean;
}
export function Fader(props: FaderProps): ReactElement;
```

Exported from `src/components/ui/index.ts`. Arrow ±1 dB, Shift ±0.1 dB, Home
silent, End +6 dB, `0` unity, double-click unity, `aria-valuetext` in dB.

### 9.2 Store actions — built by **state**, called by everyone

```ts
setTrackVolume(trackId: TrackId, volume: number): void;          // clamped 0..2
setClipTransition(clipId: ClipId, edge: 'in' | 'out', t: Transition | null): void;
addTitleClip(trackId: TrackId, startFrame: Frames): ClipId | null;
setClipTitle(clipId: ClipId, patch: Partial<TitleSpec>): void;
addCue(startFrame: Frames): CueId;
setCue(id: CueId, patch: Partial<Pick<SubtitleCue, 'start' | 'end' | 'text'>>): void;
removeCue(id: CueId): void;
replaceCues(cues: SubtitleCue[]): void;                          // import, replace mode
appendCues(cues: SubtitleCue[]): void;                           // import, append mode
setSubtitleStyle(patch: Partial<SubtitleStyle>): void;
```

State shape added to `timelineSlice`: `subtitles: Record<CueId, SubtitleCue>` and
`subtitleStyle: SubtitleStyle`. `hydrateTimeline` takes both — `src/lib/project.ts`
already passes them and is scaffold-owned, so this signature is fixed.

The existing per-clip property setter is **`updateClipProperties(ids: ClipId[],
patch: Partial<ClipProperties>): MutationResult`** — an earlier draft of this
section named a `setClipProperty` that does not exist anywhere in the repo. It
widens to accept the nine new fields, including the two booleans, and clamps
them by calling `normalizeClipProperties` from `src/lib/project.ts`, which is
exported for exactly that reason. Nothing restates those bounds locally: two
copies of a clamp table is two clamp tables that drift.

`InspectorGroupId` lives in `timelineSlice.ts` and is therefore **state**-owned,
but only **inspector** knows what groups it needs. State adds `'grade'`,
`'effects'`, `'transitions'`, `'title'` and `'subtitles'` to the union up front
so inspector is not blocked on a round trip.

**AMENDED — the seed values live in `INITIAL_INSPECTOR_GROUPS` and nowhere else,
and `title` seeds OPEN.**

There is no `defaultOpen` prop on `InspectorGroup`, and there must not be one.
Once every id carries a real boolean, a component-level default cannot tell
"never touched" from "the user collapsed it" — both are `false`. Had it ever
fired it would have reopened the group on every launch after the user
deliberately closed it: the one group in the panel that forgets what you told it.
That is a defect in the mechanism, not a preference. The seed belongs in the
initial record, where a persisted `false` correctly overrides it.

`title: true` is the ruling, and it is not an exception to "advanced groups start
collapsed". What the seed record actually encodes is *the group carrying the
selection's primary editing surface starts open* — `project: true,
transform: true`. For a media clip that surface is Transform. For a title clip it
is the text. Applying the existing rule to a clip kind whose primary surface
differs is not a carve-out from it.

Three things settle it against "uniform, collapsed":

1. Depth on demand is already satisfied by the group's existence condition —
   Title renders only when the whole selection is title clips, so it never
   appears on the calm default screen.
2. Every other new group has a second route. Transitions have a drag handle and a
   context menu; grade and effects act on a clip you can see and can be judged
   from the frame. Title text can be edited in exactly one place. Collapsed,
   creating a title gives an inspector with no visible text field — a "where do I
   type?" moment on the one action whose whole point is typing.
3. It is eleven rows, which is the real counterweight, and the choice
   self-corrects after one click either way.

`'grade'`, `'effects'`, `'transitions'` and `'subtitles'` seed `false`.

**RULED — `subtitles` STAYS in the persisted group record.** §6.6.3a made
`inspectorGroups.subtitles` contribute to `selectInspectorVisible`, so an open
cue list now keeps the inspector on screen — and because the record persists,
that survives a restart. A user who leaves the cue list open boots with an
inspector on an empty selection, indefinitely, until they collapse it. State
flagged this rather than acting on it, which was correct.

Keep it, for one reason that outranks the others: **at the moment of confusion,
the explanation is on screen.** The panel that is showing is showing the very
thing holding it open, and one click on the group header releases it. That is
categorically different from a hidden pin, which is the failure this would
resemble if the cue list were not the thing being displayed. "Finds the panel
where they left it" is the intended property and it is worth a persisted bit.

A fresh profile is unaffected — the group seeds collapsed, so the default screen
still opens to the editing loop with no inspector, and principle 2 is intact.

**Accepted cost, named so it is not rediscovered as a bug:** a user who opens the
cue list once and never collapses it holds the panel open on *every* project
afterwards, including projects with no subtitles at all, where it shows an empty
list. The mitigation is the same click.

**Rejected: `inspectorGroups.subtitles && cueCount > 0`.** It looks like a strict
improvement — no empty panel held open on unrelated projects — and the ordering
even works, since `cueCommand` calls `addCue` before it opens the group. It is
rejected because of what it does to import: a user who opens the cue list on a
project with **no** cues, intending to import a `.srt`, would watch the panel and
the Import button vanish the moment their selection emptied. A panel that
disappears during an interaction is a worse failure than one that persists after
one, because the first is immediate and inexplicable and the second is slow and
self-explaining. Dropping `subtitles` from the persisted record is rejected for
the same reason in a different order: it trades a visible, one-click annoyance
for the loss of the property the persistence exists to provide.

### 9.3 The title raster — built by **graph** (`exportDocument.ts`)

`ExportDocument.titles` is filled in the renderer, at document-assembly time, by
calling `drawTitle` from `src/lib/titleRaster.ts` on an `OffscreenCanvas` sized
to the PROJECT resolution, then `convertToBlob({type:'image/png'})` and base64.
One entry per title clip in the project — not per clip in range; the builder
filters by range and an unused entry costs an unread map lookup.

### 9.4 The two things that must not be forgotten

Both are the same shape of bug — a value applied in two of its three places —
and both have burned this project before:

1. **`trackVolume` on the clock clip.** `VideoSurface` carries the clock clip's
   audio on its `<video>` element. Applying the fader to the mix voices and not
   to that element gives a fader that works on every track except the one you are
   watching. **preview** owns both halves.
2. **A title clip in a media lookup.** `clipUsesMedia` exists for this. Anything
   that maps `clip.mediaId` into `items[…]` — `offlineClipIds` first — must skip
   title clips, or every title reads as offline media and the timeline paints it
   as an error.

### 9.4a `migrateProject` rebuilds every clip, and LINKING §12 changes to match

`migrateProject` now rebuilds every clip unconditionally so
`normalizeClipProperties` can be total — that is scaffold's doing, deliberate,
and the reason no code downstream of the load path has to ask whether a property
exists. `check-linking` assertion 9, "an untouched clip keeps its object
identity", cannot hold against it and **is not a state regression**: state moved
two sanitisers and touched nothing in that map, and it said so rather than
reaching into a file it does not own. An earlier brief in this project blamed it
for this and that brief was withdrawn.

The assertion becomes a **deep-equality** check — migration must not ALTER a clip
it had no reason to alter — and `docs/LINKING.md` §12 is updated to match.
Strictly stronger than identity: identity was only ever a proxy for "unchanged",
and it is a proxy that a total normaliser breaks while the property it stood for
still holds.

**Referential equality on open is a cost this document accepts.** Opening a
project replaces the whole store, so there is no prior render for a preserved
reference to spare; principle 4's render budget is about editing, not loading.
The fix, if it were ever needed, belongs in scaffold — return the original object
when normalisation changed nothing — and not in state. It becomes needed the day
`migrateProject` is used for anything incremental (a merge, a partial reload, an
undo across a format change); at that point identity is load-bearing again and
this paragraph is the note that says so.

### 9.6 A condition serving several consumers must be derived from all of them

Twice in this build, something correct was applied at *most* of the places that
needed it, and read as complete from every angle except the one that mattered:

- **§2.5.** The saturation ceiling was declared in the type, enforced in the
  sanitiser and stopped at in the slider — and left at the old value in
  `gradeMath`, the function that actually emits the coefficient. Three
  declarations of intent and no bound at the point of emission.
- **§3.1b.** The higher-precision working format was gated on the **grade** being
  non-neutral, though it protects the whole look block. A clip with blur and no
  grade ran six IIR passes in 8-bit, landing 4.1% narrow against 2.6% for the
  same clip with any grade set.

- **§12.** `isFiniteFrames` is `v === undefined || Number.isFinite(v)`. That is
  **correct** for an *optional* field, where absent means "take the default", and
  it is what the helper was written for. It is **wrong** for a *required* one,
  where `undefined` flows on as `Math.round(undefined) → NaN` — and NaN passes
  every comparison, including `start < 0` and `duration < 1`. Measured before the
  fix: `insertClips(ids, undefined, 0, v)` returned `{ok: true}` and wrote a NaN
  start into the document.

  State fixed it in `planPlacement`, which hardened `moveClips`/`moveClip` too,
  and correctly flagged `planTrim` rather than reaching into it. **The audit is
  wider than the one word**: `isFiniteFrames` guards a *required* argument in
  three places — `planTrim(nextFrame)`, `addClip(input.start)` and
  `insertMediaAt(start)`. All three are the same hole. Its uses on `duration`,
  `mediaIn` and `addMarker(frame)` are correct, because those are genuinely
  optional.

  **Fix all three, and rename the helper `isOptionalFrames`.** The name is the
  real repair: a helper called `isFiniteFrames` reads as "checks this is a finite
  frame" at every call site, which is exactly what it does not do. Renaming makes
  every future misuse visible where it is written instead of where it detonates.

  And extend `check-timeline-guards` to feed **`undefined`** at every entry point
  alongside NaN. It feeds NaN at twelve and `undefined` at none — so its summary,
  "12 entry points refuse non-finite input", is true and incomplete: `undefined`
  is not non-finite, it is absent. The hole is reachable precisely from untyped
  `.mjs` gate scripts, which is to say from the tooling meant to catch it.

The shape is identical and none is a typo — each is a condition written from one
consumer's point of view and then quietly relied on by another. Grep finds the
constant in the places it *is*; nothing points at the place it is not.

**Rule.** When a value or a guard serves more than one consumer, derive it from
the union of what it serves, at the point that uses it, and say in a comment what
the union is. `!gradeMath(p).neutral || !effectsNeutral(p)` is the shape to
copy: it names both consumers, so adding a third is a visible edit at the one
site rather than a silent omission at a new one.

The corollary for review: when a condition is found gated on one of several
consumers, the fix is not to add the missing consumer — it is to ask what else
that condition serves, because there is rarely exactly one omission.

### 9.5 No module cycle through the store. — NEW, and it is not advisory

`src/state/store.ts` calls its slice creators at MODULE-EVAL time: `create(...)`
runs `createTimelineSlice` while store.ts's own body is still executing. Any
cycle that can make `store.ts` the module that resumes first therefore reaches a
`const` arrow that is still in its temporal dead zone, and the whole store fails
to construct.

This is not hypothetical. `timelineSlice → lib/project → state/store →
timelineSlice` was introduced to share the load path's sanitisers, argued safe on
the grounds that "every binding involved is a hoisted `export function` used only
inside function bodies", and it broke three green gates on the way in —
`check-linking`, `check-timeline-guards` and `check-fps-snap` all die with
`TypeError: createTimelineSlice is not a function`. The argument was false twice
over: `readStore` and `createTimelineSlice` are both `const` arrows, not hoisted
declarations, and `store.ts` does call one of them at module scope.

**Rule.** A module that `state/store.ts` can reach, transitively, must not import
from `state/store.ts`. Pure helpers that both a slice and the load path need go in
a module that imports neither — `src/lib/*` with no `state/` import at all. The
sharing instinct was right; the module it reached for was not.

The distinction the broken version depended on — `function` vs `const` arrow — is
invisible to `tsc`, invisible in review, and one refactor away from silent
breakage. It is not an invariant, it is a coincidence.

---

## 10. The verification pass — OWNER: **verify**. NEW, and it is the last gate.

§8 step 3 has been the largest open item since the fan-out and it has had no
owner, which is why it has not started. It has one now.

Five owners have reported. Four of the five reports end with the same sentence:
none of this has been seen running. They are right to say so and it is to their
credit that they said it unprompted — but four disclaimers do not add up to a
verification, and this document's own bar is that **a feature is not done when it
typechecks, it is done when a file on disk matches what the preview showed.**
Nothing below is optional and none of it can be delegated back to a feature owner:
the point is that somebody who did not write it looks at it.

**verify** owns no source file. It writes findings, and defects go back to the
owner through the planner exactly as every other rework has.

### 10.1 The gate that outranks the others

Everything in §7 runs on bundled source. The v0.1.4 failure is the standing
reminder of what that misses: a build answered `-version` perfectly and had no
`-filter_complex_script`. This pass is the one that would have caught it.

The `tsconfig.electron.json` fix is the second reminder, from this feature set:
`src/lib/color.ts` was never compiled into `dist-electron` at all, so §2.2's
"one shared function" was **nominal** for the entire build. `check-export-graph`
passed the whole time, because esbuild bundled what the real app would not have
had. A gate that green-lights a runtime that cannot exist is worse than no gate,
and only a real launch finds it.

### 10.2 What has to be seen, per feature

For each of the six: set it in the running app, watch the preview, export the
file, and **compare the file against what the preview showed**. Not "the export
succeeded". The comparison is the deliverable.

| Feature | The specific thing that must agree |
| --- | --- |
| Track volume | §9.4 item 1 by ear: move a fader while watching a clip on that track. The clock clip's `<video>` and the mix voices must move together. The classic failure is a fader that works on every track except the one being watched. |
| Grade | A graded frame in the preview against the same frame in the file. brightness/contrast/temperature are claimed EXACT — hold them to it. saturation is claimed approximate — confirm it is close, and say how close. |
| Effects | blur at a clip scale ≠ 1, which is where §3's amended definition bites: the on-screen blur must not change when the clip is resized. sharpen and vignette are approximations; confirm they are in the right direction and the right rough magnitude. |
| Transitions | A fade's first frame (now fully transparent in BOTH, after the leading-edge change — verify it, it is the change most likely to be misread as a bug). A dissolve at full handle, at partial handle (§4.3b: ramp and underlay end together) and at zero handle (degrades to fade, and the notice actually reaches the user through `ExportProgressEvent.notices`). A dissolve out of a title (§4.3c). And **listen** to a dissolve: no audio ramp on either side, no dip. |
| Titles | The exported PNG against the preview canvas, at a non-default font, at a long line, and at 4K from a 1080 project. §5.2 claims byte-for-byte pixels; this is where that is true or is not. |
| Subtitles | The §6.6 authoring loop, at speed, with playback running: `C`, type, `Ctrl+Enter`. Then 400 cues — scroll it, play through it, add one. Then burn-in at 540/1080/2160 against the preview overlay. |

### 10.3 The things that are only visible in the running app

- **`prefers-reduced-motion`.** Every transition added by this feature set needs a
  real alternative, not a disabled one (CLAUDE.md). Turn it on at the OS and go
  through all six.
- **Keyboard operability, end to end.** The Fader, the transition handles, the
  track headers, the cue list. Every control reachable, every one showing focus.
  `C` and `Ctrl+Enter` must not fire while typing in an unrelated field.
- **Deuteranopia.** Simulate it and confirm nothing added here carries state by
  hue alone — the ramp wedge, the cue-under-playhead marking, the offline badge
  against a title clip.
- **Contrast against PANEL backgrounds**, not the shell (CLAUDE.md), on all three
  themes, for every new surface.
- **Legible under load**, which is principle 4 and is stated as a number: 40
  clips across 6 tracks, with transitions and titles among them, and 400 cues.
  Not a 3-clip screenshot.
- **The 53px fader threshold** at a real track height, and the context-menu
  fallback below it.

### 10.3a Numbers that need a compositor belong to THIS pass

The Browser pane cannot composite, so `requestAnimationFrame` never fires there
and true time-to-next-paint cannot be measured in it. An owner working in that
environment can measure store-write → React commit → forced layout, and that is a
real number, but it **excludes the compositor step** and is not like-for-like
against a paint-inclusive one.

The rule is not "do not measure" — a measurement with its exclusion stated is
worth far more than an assertion, and the ratio in the D3 case (105–209 ms
against 2.1 ms) is decisive whatever the missing step costs. The rule is that the
**paint-inclusive number is owed by the verification pass**, which drives the
real app and can paint. Any owner reporting a timing from a non-compositing
environment states the exclusion, as inspector did; `verify` closes it.

This applies to every timing claim in §7 and §10, not only to the cue list.

### 10.3b Prove the instrument is attached before trusting what it reads

§11.2 says build state through real actions. This is its other half, and it was
learned the same way — by an owner noticing its own instrument was disconnected
instead of reporting what the disconnected instrument said.

Attaching to an already-running dev server, it wrote
`inspectorGroups.subtitles = false` and the DOM stayed `aria-expanded="true"`.
The cause was that its dynamically imported `store.ts` was a **different module
instance** from the one the mounted app renders — HMR had reloaded the app's
copy. Every write it made went to a detached store. Had it reported findings from
that session they would have been confident nonsense: not noise, which is
recognisable, but a coherent story about an application nobody was running.

**Rule: before any measurement taken against a running app, perform a write whose
effect is visible in the DOM and confirm the DOM changed.** A toggle, a
selection, anything with a rendered consequence. If it does not change, the
session produces no findings — not tentative ones, none — and the report says the
instrument was detached rather than describing what was seen.

**STRENGTHENED, by the pass that this rule then caught.** A one-time check at the
start is not enough: the detachment can happen mid-session, and it did — a second
`store.ts` instance showed 2 tracks / 12 cues / width 1280 against a DOM showing
0 / 0 / 1920. The check is therefore a **standing store↔DOM sync assertion that
refuses to measure on disagreement**, re-evaluated at each measurement rather
than once at attach. And where a measurement can be taken through UI gestures
alone, it should be: a number produced by pressing the app's own button cannot be
measuring a detached store, because there is no second instance to press.

Only measurements carrying independent app-side evidence are reportable.

**THE TECHNIQUE, written here because three owners have hit this and only one
had the cure.** It was living in one agent's harness, which is why the third
owner hit it *after* the second had already diagnosed it. A fix that exists only
inside the tooling of whoever found it is not a fix, it is a private note.

The root cause is deterministic, not intermittent: Vite serves the app's module
at `/src/state/store.ts?t=<hmr-timestamp>`, so `import('/src/state/store.ts')`
with a bare specifier **reliably** instantiates a second copy. The cure is one
sentence — **discover the URL, do not guess it**:

1. Read the page's own `performance.getEntriesByType('resource')` and find the
   entry whose path matches the module, timestamp query and all.
2. `import()` *that* URL.
3. Probe with a reversible write that has a visible consequence — `seek()`, a
   group toggle — and confirm the DOM answered.

Anything that sets state and reads the DOM needs all three. A `setTheme` that
moves your own store while `data-theme` on the root stays put is this bug, not a
theming bug. And forcing the attribute directly to work around it produces
artefacts — a contrast ratio of exactly 1.00 against the wrong backdrop element
— which is a result to discard, not to report.

### 10.3d Luma comparisons cross a RANGE CONVENTION. Convert before concluding.

A preview reads RGB in full range, 0–255. An exported file carries limited-range
luma, 16–235. Comparing the two numbers directly manufactures a gap of roughly 14
units at the top of the scale that is not a disagreement at all — it is the
conversion:

```
limited luma  =  16 + full × (219 / 255)
RGB 200       →  187.8        (file measured 186)
```

Both blacks sit at the floor of their respective ranges, which is why the error
shows up as a *scale* difference rather than an offset and reads convincingly as
"the preview is brighter than the file".

This was caught, not published, while verifying §4.3d — on a feature that had
just been ruled on, where a reported 14-unit preview/file gap would have looked
like the ruling being wrong. **Every luma comparison in this project crosses this
boundary**, so it is not a one-off: convert first, and state which convention
each side of the comparison is in.

### 10.3c Measure interactive surfaces at the states that matter, not only at rest

A contrast sweep of a control's **default** state would never have found the
defect that shipped in `signal`, the default theme: the Fader's unity tick
measured 18.33 against the groove and disappeared entirely above unity, because
the fill covers it — **the mark vanished exactly when "am I above unity?" is the
question being asked.** At rest it was one of the best-contrasting elements in
the app.

So a control's contrast is a set of measurements, not one: every backdrop it can
acquire, at the values that produce them. For a fader that is below unity, at
unity and above it; for anything with a fill, on and off the fill; for anything
that moves, at both ends of its travel. The rule generalises past colour — a
state reachable only at a value is a state no static audit reaches, and §1.4's
own guarantee (unity carried without hue) was false at half the values the
control has.

This is the a11y counterpart of §11.2: build the state you are measuring, do not
measure the state you happen to load into.

This is what retroactively licences the D3 and D2 numbers: there the DOM
demonstrably answered — rows mounted changed, focus moved, the active row marked
— which is precisely the control that later failed. A measurement is only as good
as the proof that it was measuring the right object, and that proof is cheap,
so there is no reason to skip it.

**Operationally:** a dev server on the standard port may belong to another owner.
Attaching to it is reasonable, but it means someone else's edits are triggering
reloads underneath the measurement. Confirm attachment *after* the app has
settled, and re-confirm it after any reload observed mid-session.

### 10.3e The one claim in this build that is reasoned rather than observed

`ExportProgressEvent.notices` is verified rendering on `done`, latching from its
single mid-flight event to a completion screen seconds later, suppressed on
**cancel** (structurally — it was never visible mid-flight, so there was nothing
to clear), and not inherited by a second export in the same session.

**Not measured: the `error` branch.** Nobody induced a genuine mid-encode failure.

It does not block, and the reason matters more than the verdict. "It shares the
cancel branch's structure" is **not** an acceptable argument here — that is
precisely the reasoning §9.6 exists to reject, and it has failed twice in this
build already. The actual reasons are narrower:

1. The failure mode is **bounded and cosmetic** — at worst a completion screen
   showing an error *and* "exported with a change" together. Nothing is written,
   nothing is lost, nothing is silently wrong about the file.
2. Every §7.4 failure in this build came from a system with an **engine** in it —
   ffmpeg, Chromium, HMR, a colour-space conversion. This is a render branch with
   no timing and no engine, and reading a conditional is far stronger evidence
   there than reading a filter chain ever was.

It is written down rather than closed silently so that it is a **known** gap and
not a forgotten one. If a cheap induction exists — a read-only output folder is
the obvious candidate — take it; it is not worth a dedicated pass otherwise.

### 10.4 Reporting

**Every finding is labelled with the CODE STATE it was measured against.** A
finding is a statement about a version, not about a project, and an unlabelled
one silently becomes a claim about whatever is in the tree when it is next read.
This is what makes §7.4 entry 6 cheap to avoid rather than clever to catch: the
pass that retracted a real defect had, in its own records, the element dumped as
`{cls: "ve-fader-tick", w: 1, h: 4}` before the fix and `h: 3` at `top: 10px`
after it — **two different elements, in its own notes, never compared.** The
check that defeats a bad retraction is usually already in hand; what is missing
is the habit of looking at the earlier record before overturning it.

A defect gets: what was done, what was seen, what was expected, and which owner.
A feature that passes gets the same evidence — "grade matched" is not a finding,
a measurement is. `verify` may not fix anything, for the same reason the planner
may not: the owner who wrote it is the one who understands it, and a reviewer who
patches is a reviewer who has stopped reviewing.

---

## 11. Two rulings from the D1 fix

### 11.1 `trackOrder` is top-first, and it now earns an assertion — but not the obvious one

Preview's fix deliberately depends on the convention that `trackOrder` runs
top-to-bottom, deriving stacking from the one fact both sides already share
rather than copying `compositeTracks` out of `exportDocument.ts`. That was the
right call — "there is no ordering table here that can drift, because there is no
ordering table here" is the correct instinct, and a second table would have been
this defect class reproducing itself. But it makes an ungated convention
load-bearing in a second place, and the question of whether that earns a gate is
a fair one.

**"trackOrder is top-first" is not directly checkable.** Looking at `[t1, t2]`
tells you nothing about which the user believes is on top; it is a statement
about what the array *means*, and no assertion can read intent out of data. A
gate that claimed to check it would be a restatement — §2.4's lesson, again.

Two things around it ARE checkable, and both are required:

1. **The two consumers agree.** Build a doc with two overlapping video clips on
   different tracks and assert that the export overlays the `trackOrder`-earlier
   one **last** (so it lands on top) while the preview sorts it **first** in
   paint order. That is the actual cross-consumer invariant, it is observable
   rather than restated, and it fails loudly the day either side flips. It goes
   in `check-export-graph.mjs`, which already builds graphs and diffs them.
2. **The invariant is asserted on a ROUND TRIP, and `migrateProject` does not
   touch a hand-written order.** It is mechanical today: `addTrack` assigns
   `index`, video unshifts, audio appends, so within a kind **video descends by
   `index` through `trackOrder` and audio ascends**. The gate builds a document
   through `addTrack`, serialises it, migrates it back, and asserts that still
   holds — which catches a scaffold or state regression, the thing actually worth
   catching.

   **My own first draft of this said scaffold should re-sort a bad order, and
   that was wrong.** There is no track-reordering gesture in the app *yet*. The
   day one is added, `trackOrder` and `Track.index` legitimately diverge — and a
   sanitiser that sorts by `index` would silently undo every reorder the user
   made, on load, with no way to see why. A hand-edited order and a
   future-reordered order are the same bytes; nothing at the boundary can tell
   them apart. Silently rewriting user data to satisfy a convention is a worse
   failure than honouring an order we did not expect, and it is the kind that
   surfaces as "the app keeps rearranging my tracks".

   So: `migrateProject` honours whatever order it is given. The protection that
   actually matters is item 1, which holds *whichever way the stack runs*,
   because it asserts the two consumers agree rather than asserting a direction.

### 11.2 Verification fixtures are built through store actions. Always.

Verification's D1 measurement may have been taken on a `ProjectFile` hydrated
with tracks in `[V1, V2]` order rather than one built through `addTrack`, which
inverts the stack relative to the labels and makes V1 topmost. The main thread
read both the selector and `addTrack` and confirmed they are consistent: the
clock clip is the topmost visible video clip, and **state's selector is not
buggy.**

**D1 is still real** — preview's analysis stands without the measurement: with
two titles only one could ever render, and a title beneath other footage never
could. Both follow from gating a picture question on the clock clip, whichever
way the stack runs.

But the fixture is the same failure as §2.4's gate, in a different costume. That
gate tested my algebra against my own restatement of `eq`. This fixture tested
the app against a hand-assembled restatement of its own state — a document the
app cannot produce through any gesture a user has. Both are green-or-red readings
taken against a stand-in for the thing under test.

**Rule, and it is not advisory:** a verification fixture is built by calling the
same store actions the user's gestures call — `addTrack`, `addClip`,
`addTitleClip`, `setClipTransition`, `addCue`. Hydrating a hand-written
`ProjectFile` is permitted only when the migration path itself is what is being
tested, and it must say so. A measurement taken against a state the app cannot
reach measures nothing, and it costs more than no measurement, because it is
believed.

**Re-measurement owed** (§10, next pass), fixture rebuilt through `addTrack` /
`addTitleClip`: a title on V2 over footage on V1 yields exactly one
`ve-video-title` canvas at frame 50 with footage playing beneath it, and hiding
V1 leaves the title present rather than making it appear. Then the case the old
code could never do at all: two titles at once, and a title beneath other
footage.

---

## 12. Insert and push — "soap bubbles"

The user's words: *"make them behave like soap bubbles. i.e let them move each
other. for example if i drag a clip that was at the end and point it at the seam
between two clips. it should be placed there and scootch the right clip to the
right. the same goes for moving a clip that was at the end to the beginning it
should be placeable and scootch the rest"*

Today a drag onto occupied space is **refused** — `planMove` returns
`reason: 'overlap'` and nothing happens. There is no overwrite behaviour to
preserve, which simplifies every decision below: this feature adds a third
outcome to a set of two rather than changing an existing one.

Called **insert** in the interface, because that is what every NLE calls it
(PRODUCT principle 3), and **push** internally for the cascade. "Soap bubble" is
the feel, not the name — it says displacement should propagate and then stop,
which is exactly what §12.3 does.

### 12.1 The source leaves a hole. An insert changes only the target side.

**This is the biggest decision in the feature, and the answer is no: the gap does
not close behind the clip you moved.**

Both of the user's examples move a clip *from the end*, where there is no hole to
close. Closing it is a second rearrangement inside one gesture, and three things
argue against it:

1. **It breaks sync silently.** Closing the source gap re-times every clip
   downstream on that track against markers, subtitles, and every other track
   that did not move. Keeping those aligned is what this application is for.
2. **It cannot be aimed.** If the source closes on pickup, the target you are
   pointing at has already moved. If it closes on drop, the gesture does one
   thing while previewing another. Neither is honest.
3. **It is not reversible by eye.** Drop into the wrong seam with push-only and
   you drag straight back out — the world un-pushes. Had the source closed,
   dragging back does not reopen it, and where the clip came from is gone.
   Asymmetric operations are traps.

"Close the gap behind" is a coherent *separate* operation — a ripple lift — and
if it is ever wanted it gets its own command and its own name, not a silent ride
on every drag.

### 12.2 No modifier. Insertion is POSITIONAL, and it reuses the snap.

There is no key to hold. **A drop inserts when the dragged clip's START lands
exactly on a clip boundary on the track it is landing on AND the drop would
otherwise be refused for `overlap`.** Anywhere else, behaviour is exactly as it
is today: a legal drop lands, an overlapping drop with no start-edge snap
refuses.

**AMENDED — the first clause alone was wrong, and dangerously so.** Read by
itself it makes *every abutting drop an insert*, and butting one clip's start
against the previous clip's end is the single most common snap in the
application. Every ordinary assembly edit would have rearranged the timeline.
Caught by the timeline owner, from this section's own framing of "a third outcome
added to a set of two" — but the literal reading is the one a fresh reader takes,
so the condition is now stated in full in one sentence.

Both clauses are load-bearing:

- **Start-edge snap** distinguishes a seam from an abut. A clip whose END snaps
  to the next clip's start is an ordinary butt, not an insert.
- **Would-be `overlap`** is what makes the caret mean something. §12.6 says the
  caret distinguishes an insert from an ordinary drop; without this clause there
  is no ordinary drop left to distinguish it from.

The two clauses together give the caret a crisp guarantee: **when the caret
shows, at least one clip is genuinely displaced.** §12.3's own example — a seam
with three seconds of gap after it, taking a two-second clip — does not overlap,
so it never reaches the insert path at all; it is an ordinary drop that shifts
nothing, which is the same outcome by a simpler route.

That guarantee revises §12.6's "the cascade is absorbed immediately and nothing
visibly shifts". On a single lane that case no longer exists. It survives as the
**linked-pair** case: lane A overlaps and pushes, lane B has room and does not,
so the caret is showing while one of the two lanes stays still. The caret still
earns its place there, and that is now the case it is for.

That is the answer to "how does the user choose", and the user chose it:
*"point it at the seam between two clips."* Intent is expressed by aim, not by
mode. Three things fall out for free:

- **`Alt` stays unspent.** This project has a rule that Alt means one thing.
- **Ordinary dragging is unchanged**, so no existing gesture becomes dangerous.
- **The capture zone already exists.** `SnapEngine.snapTranslation` already takes
  the start and end of every moving clip as `edges` and every clip boundary as
  `targets`, and already returns the frame landed on. A seam capture *is* a snap.
  No new threshold, no new tuning, nothing new competing for space.

**The DRAG therefore requires snapping to be ON.** With snap disabled a drag
cannot insert, because there is no seam capture without a snap. That is coherent
rather than a limitation: snap-off is the deliberate "let me place this freely"
mode, and seam insertion is by definition a structured placement.

**RULED — the gate belongs to the GESTURE, not to the operation. It does not
reach `edit.insertAtPlayhead` (§12.8), and it comes out of `planInsert`.**

Three things decide it, and the first is a fact about the code rather than an
argument:

1. **The `!s.snapEnabled` branch inside `planInsert` is already dead for the drag
   path.** `applyMove` reaches `planInsert` only when
   `snapped.edge === 'start' && guide !== null`, and `snapTranslation` returns
   `edge: null` whenever snapping is suppressed — so a drag can never arrive
   there with snapping off. The branch's only *live* effect is to cripple the
   keyboard command. It looks like a shared safeguard and is not one, which is
   precisely the kind of accident that reads as consistency.
2. **`snapEnabled` is a positioning preference, not a safety.** Making it also
   mean "disable a named command" gives one control two behaviours — the same
   thing this project refused when it rendered the subtitle file input *only*
   where the native bridge is absent. No other command consults it;
   `splitAtPlayhead` does not, `addMarker` does not.
3. **A named command has no aim to assist.** Snap exists to help a pointer land
   on a meaningful frame. `V` on a selection is already an unambiguous request
   for a named operation, and refusing it because a pointer aid is switched off
   is a non-sequitur.

**I am withdrawing my own sentence on the other side.** An earlier draft here
said snap-off "is also the only way to get the old refuse-on-overlap behaviour
back, which is worth having." That was a rationalisation of a side effect
written to make the coupling feel less arbitrary, not a designed promise, and it
was the strongest argument for the position I am now rejecting. Nobody flips the
magnet off as an insert safety; they flip it off to place something precisely.

So `planInsert` does not consult `snapEnabled` at all. Its job is "can these
clips be inserted here", not "is the user's magnet on". The gesture gate stays
where it already lives and already works, in `applyMove` — and the ghost and the
commit still cannot disagree, because both reach `planInsert` only through it.

**The three spatial claims do not collide, and the reason is phase, not
geometry.** The trim edge (0.8→6.8px) and the transition handle (6.8→16.8px) are
**grab-time** affordances on a clip the pointer is resting over. Seam capture is
a **drop-time** property of the dragged ghost's leading edge, during a gesture
that is already captured — and while a move is in flight, no trim or transition
handle is live. A third spatial claim in that region would have been a problem.
This is not one, because it never exists at the same time as the other two.

**`SnapEngine` needs one addition.** `SnapOutcome` reports `{ delta, target }` —
the frame landed on, but not *which moving edge* landed on it. Insertion is a
property of the **start** edge specifically: a clip whose END snaps to the next
clip's start is an ordinary abutting drop, not an insert.

```ts
export interface SnapOutcome {
  delta: Frames;
  target: Frames | null;
  /** Which moving edge landed on `target`. null when nothing snapped.
   *  Insertion is a START-edge property; an END-edge snap is an ordinary abut. */
  edge: 'start' | 'end' | null;
}
```

### 12.3 The cascade — displacement propagates and stops

The metaphor earns its keep here. A push travels down the track and **is absorbed
by the first gap wide enough to take it.** Nothing beyond that moves.

Given a drop of a clip of duration `D` at seam frame `S` on track `T`, over that
track's clips **excluding every clip being moved**, in ascending start order:

```
previousEnd = S + D
for each clip C on T with C.start >= S, ascending:
    required = previousEnd - C.start
    if required <= 0: stop            // a gap absorbed the push
    C.start += required
    previousEnd = C.start + C.duration
```

- **Only what must move, moves.** Aiming at a seam with three seconds of gap
  after it and inserting a two-second clip shifts nothing.
- **It always terminates** — at a sufficient gap, or at the last clip.
- **It cannot fail for lack of source.** Pushing changes `start`, never
  `mediaIn`, so no clip can be pushed past what its media can supply.
- **Relative spacing downstream is preserved exactly.** Every clip in the pushed
  run keeps its duration and its distance from its neighbour. That is the
  defining property of an insert, and it is what §12.7's gate asserts.

**A locked track in the push set REFUSES the whole drop.** Pushing a clip on a
locked track is a write to a locked track. This needs no new vocabulary — the
drop refuses with `reason: 'locked'`, exactly as a move onto that track already
does.

### 12.4 The push does not cross tracks

It applies to the tracks the moving clips actually land on, and to no others.

Pushing every track from a single-clip gesture is an enormous action from a small
one, and it does not buy what it appears to: markers, subtitles and the project's
own timing do not move with it, so "keeping sync" by shifting all six lanes moves
the problem rather than solving it. Local push is the honest reading of the
metaphor — bubbles displace their own raft.

### 12.5 Linked clips: every landing track cascades, all or nothing

A linked A/V pair is already moved as a unit by `selectLinkedClosure` inside
`planMove`, and both members already land at the same start frame. So each member
lands on its own track and **each landing track runs its own independent
cascade** — the lanes have different neighbours and different gaps, and they are
allowed to push by different amounts, because the *pair* stays together
regardless.

If any one of those cascades is illegal — a locked clip in that lane's push set —
**the entire drop refuses**, both lanes, nothing moves. That is §3.4 rule 1
unchanged, and the existing `MoveFailure` vocabulary already expresses it.

### 12.6 Showing it before the drop: the clips actually move

A drag currently shows a *position*. This gesture rearranges the edit, so it must
show *displacement*, or it is unpredictable by construction.

**The push set renders at its pushed position, live, during the drag.** Not a
badge, not a count, not an outline — the clips move. That is the clearest
possible statement of what will happen, it is exactly what the metaphor promises,
and it is the only option that scales: at 40 clips the alternative is nine ghost
rectangles or a number the user has to translate.

- It is a `translateX` on clips that are already mounted — no re-layout, no new
  elements — and the run is bounded by the first absorbing gap, so it is usually
  short.
- **An insert caret** marks the seam, so an insert is distinguishable from an
  ordinary drop *before* anything moves — which matters most when the cascade is
  absorbed immediately and nothing visibly shifts.
- **`prefers-reduced-motion`:** the displacement is a position, not an animation.
  Reduced motion removes any easing on it; it does not remove the movement, which
  *is* the information. The same rule the fader fill already follows.
- Aborting the gesture (`Escape`, or dropping somewhere illegal) restores every
  pushed clip, because nothing was committed — the preview is a transform and the
  store is untouched until the drop.

### 12.7 Ownership, interface, and the gate

| Piece | Owner |
| --- | --- |
| `planInsert` (pure; dry run and commit share it) and the `insertClips` action | **state** |
| `SnapOutcome.edge`; seam detection during the gesture; the live displacement preview and the insert caret | **timeline** |
| `check-insert.mjs` | **gates** |
| Running-app verification of the gesture | **verify** |

The planner is pure and lives beside `planMove` / `planTrim` in
`timelineSlice.ts`, for the reason those two are exported: the ghost asks "would
this be legal, and what moves?" on every pointermove, and the commit must answer
identically. **One implementation, two callers.** A second would let the preview
and the drop disagree, which is the failure this whole document is about.

```ts
export type InsertPlan =
  | { ok: true; clips: Clip[]; pushed: Clip[] }   // `pushed` drives the live preview
  | { ok: false; reason: MoveFailure; blockingClipId: ClipId | null };

export function planInsert(
  s: StoreState, ids: readonly ClipId[], deltaFrames: number,
  deltaTrackIndex: number, primaryTrackId: TrackId | undefined,
): InsertPlan;

// TimelineActions — ONE history entry for the clip and every clip it displaces.
insertClips(ids: ClipId[], deltaFrames: Frames, deltaTrackIndex: number,
            primaryTrackId: TrackId | undefined): MutationResult;
```

**Undo is one entry** for the dragged clip and every clip it displaced, across
every track it touched. Not negotiable: a rearrangement that undoes in pieces is
worse than one that does not undo at all, and `detachAudio` already establishes
the transaction pattern for exactly this.

#### The gate, and what "proven to bite" means for a gesture

`check-insert.mjs` drives the **store action**, never `planInsert` alone — the
assertion is on the resulting document, because that is the behaviour (§7.2).
Fixtures are built through store actions (§11.2).

**The observable is chosen so that it does not restate the algorithm.** An
insert's defining property is that it changes absolute times while preserving the
*pattern*. So the gate extracts the downstream run as a sequence of
`(duration, gap)` pairs before and after the drop and asserts it is
**identical, only offset**. That is checkable without knowing how the cascade
computes anything, and it stays true if the implementation is rewritten.

Assertions:

1. **CORRECTED.** The first draft of this assertion said the downstream
   `(duration, gap)` sequence is preserved. **That is false, and it would have
   failed a correct implementation** — §12.3's cascade *consumes* gaps as the
   push travels, which is assertion 3's whole subject. Traced: occupants at
   60/140/200 with `S=60, D=60` land at 120/180/240, and the 20-frame gap that
   sat between the first two is gone. Preservation holds only on a **tight** run.
   Caught by state before a line of gate code was written; the trap was mine.

   The correct unified observable, which holds in **both** cases and still does
   not restate the arithmetic:

   > **Every clip that moved is butted against its predecessor** — the inserted
   > clip, or the previously moved clip — **and no clip's duration changed.**

   That is exact, because a clip that had slack in front of it would not have
   needed to move at all. It covers the tight run and the gapped run with one
   sentence, and it survives a rewrite of the cascade.

   The two cases still need **separate fixtures**, and the gate must carry both:
   a **tight** run, where the whole downstream pattern is preserved and offset by
   `D`; and a **gapped** run, where gaps are consumed in order.
2. A gap wide enough **absorbs** the push — clips beyond it do not move at all.
3. A partial gap absorbs *part* of it; the remainder propagates, and the consumed
   gap is **gone** rather than preserved.
4. Insert at frame 0 pushes the whole track right (the user's second example).
5. `clipsByTrack` invariants hold afterwards — **reused from `check-linking`, not
   restated**: sorted ascending, no overlaps, link groups of at least two.
6. Exactly **one** history entry, and `undo()` restores the document exactly.
7. A locked track anywhere in the push set refuses the whole drop, and **nothing
   moves on any track**.
8. A linked pair inserts on both lanes, with independent push amounts.
9. **REWRITTEN by §12.2's ruling — the snap gate belongs to the gesture, so it is
   no longer asserted at the action.** The old wording, "snap disabled means no
   insert", held at `insertClips` and would now be asserting a coupling that has
   deliberately been removed.

   The gate asserts the positive form instead, which is stronger because it is
   what the design actually claims:

   > **`insertClips` produces a byte-identical document with `snapEnabled` true
   > and false.** The planner is a placement operation and is indifferent to a
   > pointer-positioning preference.

   That fails loudly if anyone reintroduces a `snapEnabled` check inside
   `planInsert`, which is the regression worth catching.

   **The drag-path gate is `verify`'s, not the gate's**, because it is a gesture:
   with snapping off, an overlapping drag must refuse rather than insert, and no
   caret may appear. §12.7's closing paragraph already says the gate cannot reach
   the gesture; this is one more item on that list rather than an exception to it.
10. The source gap is **not** closed (§12.1) — asserted positively, because it is
    a deliberate absence that a future "improvement" would silently remove.
11. **`planInsert` and `insertClips` agree at EVERY landing frame across the
    fixture**, not at a sampled few. "One implementation, two callers" is the
    property §12.7 is built on, and it has been a comment everywhere it appears
    in this document. Swept as a test it becomes checkable: any divergence
    between what the ghost promises and what the drop commits fails, at the frame
    where it starts. Adopted from state's probe, which swept 0..260.

    This is the same shape as the both-entry-points requirement one level up —
    drag and `edit.insertAtPlayhead` must produce identical documents — and the
    pair of them is what keeps a third caller from quietly becoming a second
    implementation.

**Mutations that must bite**, each run before the gate is trusted:

- push applied to every downstream clip instead of the cascade (kills 2 and 3);
- push amount hardcoded to `D` instead of the computed requirement (kills 3);
- cascade crossing to other tracks (kills 1 on the untouched lane);
- the lock check omitted from the push set (kills 7);
- `beginHistory` / `commitHistory` dropped so each clip pushes separately
  (kills 6);
- insert firing on an END-edge snap — an abutting drop must stay an abutting drop;
- the source gap closed (kills 10).

**What the gate CANNOT prove, and `verify` owns:** that a pointer drag actually
reaches this action, that the live preview shows the same displacement the drop
commits, and that the insert caret appears when — and only when — the drop will
insert. §10.2's bar applies: the gesture is performed, not read. The transition
drag is the precedent, and it is the precedent because performing it was the only
way to know the two hit zones were separable.

### 12.8 The keyboard path — `Insert at playhead`. Ships WITH §12, not after.

§12 as first written is entirely a drag, because the request was entirely a drag.
That is not sufficient here: CLAUDE.md states that **the keyboard is the primary
instrument**, and a feature reachable only by pointer fails a standing
instruction rather than merely lacking a convenience. Trim has the inspector's
numeric fields; move has `,` / `.`; insert would have had nothing at all.

The timeline owner declared this gap rather than leaving it to be discovered,
and was right that the precedent is *not* a keyboard version of the gesture.
Nudge must not become insert-capable — that would make the most casual key in the
application capable of rearranging the timeline, which is the failure §12.2 just
spent a section avoiding.

**It is a command, not a modified nudge.**

```
edit.insertAtPlayhead — "Insert at playhead", scope `timeline`, not repeatable
```

- Takes the current selection (link closure, as every other command does) and
  places it at the playhead on each clip's own track, pushing by §12.3's cascade.
- **Refuses whole**, with the same `MoveFailure` vocabulary and the same notice
  channel as every other refusal — locked lane in the push set, kind mismatch,
  nothing selected.
- **One history entry**, same as the drag.
- It calls `insertClips`. There is no second planner and no second cascade: this
  is a third caller of the one implementation, which is the entire reason
  `planInsert` is pure and exported.
- **It is NOT gated on `snapEnabled`** (§12.2). Snap is a pointer aid; a named
  command has no aim to assist, and `V` is already an unambiguous request. The
  menu item's disabled reason must therefore never cite snapping — with the
  magnet off the item stays enabled and the command works.
- **The anchor is the earliest start in the LINK CLOSURE, not in the selection.**
  `insertClips` closes over links itself, so selecting one half of a pair moves
  both; an anchor taken over the selection alone lands the *wrong member* on the
  playhead whenever the unselected one starts earlier. This is not a detail —
  it is the difference between "the thing I selected arrives at the playhead" and
  "something arrives at the playhead", and only the first is a command a user can
  aim.

**Binding: `V`.** Avid's splice-in. Premiere's insert is `,`, which is spoken for
by the nudge pair and must stay an ordinary move; Premiere's `V` is a selection
tool this application has no equivalent of, so no muscle memory is overwritten.
Avid's term also names the *push*, which FCP's `W` does not — the binding and the
word agree about what the command does.

This is also the NLE convention it should have been from the start — Premiere
binds insert to a key and calls it an insert edit; the drag is the discoverable
form of the same operation, not the operation itself.

Owner: **timeline** for the row and its dispatch, per §0's amendment — and its
handler lands in the *same change* as the row.

Gate: `check-insert.mjs` runs its assertion set through **both** entry points,
the drag-shaped `insertClips` call and the command, and requires identical
documents out. That is cheap, because the command is a third caller of one
planner, and it is the assertion that keeps it one.

**This ruling paid immediately, and the record matters more than the principle.**
Building the command against the unchanged signature exposed a latent cascade
bug: a **multi-clip selection on one lane** was refused when it is perfectly
legal. The per-lane pass had treated arrivals as a *second stream* — pushing the
occupant clear of the first arriving clip, then meeting the second and refusing.
**Arrivals are fixed obstacles, not a stream.** The user aimed them; a displaced
clip must clear every one of them.

It was reachable **two** ways, not one: through the new command, and by **dragging
a link group that holds two clips on one track**, which LINKING §2 explicitly
permits. So the drag path — the feature the user actually asked for — carried it
too.

Had this been deferred as a follow-on, the bug would have shipped inside the
feature that *was* shipped, reachable by an ordinary gesture on a perfectly legal
document, and it would have been found by a user rather than by an owner. The
argument for pulling it in was CLAUDE.md's standing instruction about the
keyboard; the return was a defect in the pointer path. **A second entry point is
a second question asked of the same code, and that is worth something
independently of who uses it.**
