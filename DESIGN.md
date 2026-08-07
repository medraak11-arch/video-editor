---
name: Video Editor
description: A desktop video editor whose chrome stays dark and quiet so the frame is the only lit thing on screen.
colors:
  well: "oklch(0.10 0.008 265)"
  chrome: "oklch(0.215 0.014 265)"
  panel: "oklch(0.255 0.016 265)"
  raised: "oklch(0.31 0.018 265)"
  ink: "oklch(0.96 0.004 265)"
  muted: "oklch(0.72 0.012 265)"
  on-well: "oklch(0.96 0.004 265)"
  accent: "oklch(0.75 0.15 68)"
  on-accent: "oklch(0.17 0.03 68)"
  danger: "oklch(0.66 0.19 22)"
  warning: "oklch(0.90 0.15 100)"
  hairline: "oklch(1 0 0 / 0.08)"
  hairline-strong: "oklch(1 0 0 / 0.16)"
typography:
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.005em"
  numeric:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "normal"
    fontFeature: "'tnum' 1, 'zero' 1"
rounded:
  clip: "3px"
  sm: "4px"
  md: "6px"
  lg: "10px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "oklch(0.79 0.15 68)"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  button-ghost-hover:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    typography: "{typography.numeric}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "26px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px"
  track-head:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    padding: "0 6px"
    width: "88px"
    height: "32px"
  timeline-clip:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.clip}"
    padding: "0 6px"
  timeline-clip-selected:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.clip}"
---

<!-- Tokens below are final and contrast-verified (WCAG 2.2 AA plus deuteranopia / protanopia / tritanopia simulation). Components are SPECIFIED, not extracted — no code exists yet. Re-run /impeccable document once the shell is built to capture real component values and generate .impeccable/design.json. -->

# Design System: Video Editor

## 1. Overview

**Creative North Star: "The Darkroom Bench"**

A darkroom bench is not styled. It is dark because the work demands it — the only lit thing in the room is the image, and everything else recedes so your eye has nothing to adapt to but the picture. The tools are within arm's reach, laid out in a fixed order you learn once and never think about again. Nothing on the bench glows, pulses, or asks for attention. The bench is competent and silent, and its silence is what makes the image readable.

That is the whole system. The preview well is the darkest surface in the application and the frame inside it is the brightest thing on screen, and every other decision follows from protecting that relationship. Chrome sits in a narrow band of dark tones separated by lightness alone. Chroma in the interface is capped so low that the footage is, by construction, the most saturated thing visible. The accent appears on exactly three things — the playhead, the current selection, and the primary action — and nowhere else.

This system explicitly rejects the **muddy gray Electron chrome** it would otherwise default into: flat `#2b2b2b` panels on a `#1e1e1e` shell, every surface the same undifferentiated slab, distinguished by nothing. The answer is not more color; it is disciplined tonal separation. Four planes, each a measured step apart, each earning its place. It equally rejects the **wall-of-controls first impression** — depth exists but is disclosed, never shouted — and any **dashboard grammar** of stat tiles and card grids. This is an instrument.

**Key Characteristics:**
- Four in-flow planes separated by lightness, never by shadow
- Interface chroma capped at 0.018; the footage carries all the color
- One accent, three permitted uses
- Status separated by lightness first and hue second, because lightness survives color-vision deficiency
- Numerals are monospaced and tabular everywhere they can change
- Three themes that swap color tokens and nothing else

## 2. Colors

A narrow band of cool near-blacks, stepped by lightness, with a single warm accent that is the only saturated element in the chrome.

The system ships **three themes**. `signal` is the committed default; `instrument` and `daylight` are alternates held to the identical bar. The frontmatter above carries `signal` — it is normative. Themes are selected in settings and swap color tokens only.

### Primary

- **Signal Amber** `oklch(0.75 0.15 68)`: the accent. Permitted on exactly three things — the playhead, the current selection outline, and the single primary action in any view (`Export`, the confirm button in a dialog). Amber is chosen because it reads as *active* rather than as *brand*, and because it sits far from the blue-violet that Premiere and Clipchamp have made the category default. It is never a background for large areas, never a border on a resting element, never decorative.

### Neutral

The four planes, darkest to lightest. Each step is a deliberate lightness interval; the whole ramp lives inside 0.10–0.31.

- **Well** `oklch(0.10 0.008 265)`: the surround behind the video frame, and the inset background of numeric input fields. The darkest surface in the app. Nothing else uses it.
- **Chrome** `oklch(0.215 0.014 265)`: the application shell — titlebar, timeline background, the space between panels.
- **Panel** `oklch(0.255 0.016 265)`: media bin, properties, any bounded region with its own heading.
- **Raised** `oklch(0.31 0.018 265)`: track heads, secondary buttons, timeline clips, controls that sit on top of a panel.
- **Ink** `oklch(0.96 0.004 265)`: primary text and iconography. 14.04:1 on panel.
- **Muted** `oklch(0.72 0.012 265)`: labels, track names, inactive icons, timecode ruler. 6.36:1 on panel and 5.31:1 on raised — verified against *both*, because a muted label on a raised control is the pairing that actually fails in practice.
- **On-well** `oklch(0.96 0.004 265)`: text and transport iconography over the preview well. A separate token from ink because in the `daylight` theme ink is dark and would be invisible here.
- **Hairline** `oklch(1 0 0 / 0.08)`: the default 1px divider between planes. **Hairline-strong** `oklch(1 0 0 / 0.16)` for the boundary between major regions.

### Status

Three roles, not four. `success` was cut: it fires essentially once (export complete), and under deuteranopia it collapsed into `danger` at ΔE 0.07 — it was buying a collision rather than a signal. Completion is now the accent plus a check icon.

- **Danger** `oklch(0.66 0.19 22)`: destructive confirmation, offline media, failed export. 4.63:1 on panel.
- **Warning** `oklch(0.90 0.15 100)`: dropped frames, unrendered ranges, codec mismatch. 11.80:1 on panel. Deliberately much lighter than the accent — that lightness gap is what keeps it distinguishable from amber, since hue alone does not.

### Alternate themes

Identical structure, identical role names, fully verified.

| Token | `instrument` | `daylight` |
|---|---|---|
| well | `oklch(0.10 0 0)` | `oklch(0.13 0 0)` |
| chrome | `oklch(0.205 0 0)` | `oklch(0.97 0.004 290)` |
| panel | `oklch(0.245 0 0)` | `oklch(1 0 0)` |
| raised | `oklch(0.30 0 0)` | `oklch(0.94 0.006 290)` |
| ink | `oklch(0.96 0 0)` | `oklch(0.25 0.012 290)` |
| muted | `oklch(0.70 0 0)` | `oklch(0.50 0.014 290)` |
| on-well | `oklch(0.96 0 0)` | `oklch(0.96 0.002 290)` |
| accent | `oklch(0.72 0.13 205)` | `oklch(0.533 0.125 294.3)` |
| on-accent | `oklch(0.16 0.03 205)` | `oklch(0.99 0.002 290)` |
| danger | `oklch(0.66 0.19 25)` | `oklch(0.42 0.19 25)` |
| warning | `oklch(0.87 0.15 92)` | `oklch(0.55 0.13 72)` |

`instrument` runs chroma at exactly 0 through every neutral, so nothing in the chrome can bias a color judgment. `daylight` inverts the shell but keeps the well dark; note that its bright surround affects exposure judgment more than any chroma tint does, so it is the wrong theme for grading and the right one for daytime assembly work.

### Named Rules

**The Only Color Rule.** The footage is the most saturated thing on screen at all times. Interface chroma never exceeds 0.018 outside of `accent`, `danger`, and `warning`. If a surface needs emphasis, it moves along the lightness ramp — it does not gain chroma.

**The Three Uses Rule.** The accent appears on the playhead, the current selection, and the one primary action. A fourth use is a bug. When everything is accented, the selection is invisible, and the selection is the single most important piece of state in an editor.

**The Lightness-First Rule.** Status roles separate by lightness before hue. This is measured, not stylistic: with hue-led separation, `danger`/`success` collapsed to ΔE 0.07 and `warning`/`success` to ΔE 0.04 under simulated deuteranopia. Lightness survives every deficiency type; hue does not. Every status pair now holds ΔE ≥ 0.10 under normal, deuteranopic, protanopic and tritanopic simulation.

**The Icon Tax Rule.** Every status color ships with an icon and a word. Color is the third signal, never the first. A red dot alone is not an error state.

**The Palette-Only Rule.** A theme swaps color tokens and nothing else. No theme may change spacing, radius, type scale, motion timing, or layout. If a theme needs a different radius to look right, the radius is wrong in every theme.

## 3. Typography

**Body Font:** Inter (with `system-ui`, `sans-serif`)
**Numeric/Mono Font:** JetBrains Mono (with `ui-monospace`, `monospace`)

**Character:** One humanist sans carries the entire interface — headings, labels, buttons, body. Inter is chosen for its legibility at the 11–13px sizes this UI actually lives at, where geometric sans-serifs lose their distinctions between letterforms. The mono is not a stylistic pairing; it exists solely to hold numerals that change while you watch them.

Scale is fixed in px, not fluid. Ratio is roughly 1.15 between steps — deliberately tight, because a dense tool has many more type elements than a marketing page and exaggerated contrast reads as noise.

### Hierarchy

- **Headline** (600, 18px, 1.3, -0.01em): dialog and sheet titles only. Rare.
- **Title** (600, 15px, 1.35, -0.005em): panel headings — `Media`, `Clip`, `Export`.
- **Body** (400, 13px, 1.45): the default. Filenames, menu items, descriptions, dialog copy.
- **Label** (500, 11px, 1.3): property names, track names, button text, ruler marks. The most common style in the app.
- **Numeric** (400, 12px, tabular): timecode, durations, scale, opacity, speed, dimensions, bitrate.

### Named Rules

**The Tabular Rule.** Every numeral that can change while the interface is live uses `font-variant-numeric: tabular-nums` and the mono family. Proportional digits change width as they tick, so a running timecode visibly jitters and the transport looks broken. This covers timecode, durations, playhead position, and every numeric field in the properties panel. Non-changing numerals in prose may use the sans.

**The One Family Rule.** Inter carries everything except numerals. No display face, no second sans, no weight above 600. If a heading needs more presence, it gets more space around it, not a different typeface.

**The Sentence Case Rule.** All UI text is sentence case. No `ALL CAPS` labels, no tracked-out uppercase eyebrows above panel headings. Uppercase is reserved for track identifiers (`V1`, `A2`) where it is a name, not styling.

## 4. Elevation

This system is **flat in flow and layered by tone**. Depth is communicated entirely by position on the lightness ramp — `well` → `chrome` → `panel` → `raised` — never by shadow. Shadows on in-flow surfaces are what produce the muddy Electron look: they add visual noise without adding information, because the panels never actually move.

Shadows exist only for genuinely floating layers, where the surface really has left the plane.

### Shadow Vocabulary

- **Popover** (`box-shadow: 0 8px 24px oklch(0 0 0 / 0.44), 0 2px 6px oklch(0 0 0 / 0.32)`): context menus, dropdowns, the command palette.
- **Dialog** (`box-shadow: 0 24px 64px oklch(0 0 0 / 0.56)`): modal dialogs and sheets. Rare by design.

### Named Rules

**The Four Planes Rule.** Exactly four in-flow planes exist. A fifth means the layout is nested too deep — flatten it rather than inventing a tone. Nested panels are forbidden outright.

**The No-Shadow-In-Flow Rule.** If a surface cannot move, it casts no shadow. Panels, toolbars, track heads, and clips are all in-flow. Only menus and dialogs are permitted a shadow, and only while they are open.

**The Audit Test.** If two adjacent surfaces need a border to be told apart, the tonal step between them is too small — fix the step, don't add the border. Hairlines mark *regions*, not *elevation*.

## 5. Components

**These are specifications, not extractions — no implementation exists yet.** Re-run `/impeccable document` once the shell is built.

Every interactive component ships with all seven states before it is considered done: default, hover, focus-visible, active, disabled, loading, error. Half a component is not a component.

### Buttons

- **Shape:** gently rounded (`6px`), 28px tall, label type (500/11px).
- **Primary:** accent background, `on-accent` text (8.36:1). One per view, maximum. `Export` is the canonical instance.
- **Secondary:** `raised` background, `ink` text. The default button. Most buttons in this app are secondary.
- **Ghost:** transparent, `muted` text, `raised` background on hover with text lifting to `ink`. Toolbar icon buttons are ghost.
- **Hover:** background lightness +0.04, 120ms. **Focus-visible:** 2px accent ring at 2px offset — never a browser default outline, never removed.
- **Disabled:** avoid. Keep the control enabled and explain on use; a disabled button in a dark UI is nearly invisible and offers no reason.

### Inputs / Numeric fields

- **Style:** `well` background inset into the panel (darker than its surround — fields recede, they do not float), `4px` radius, 26px tall, numeric type, tabular.
- **Drag-scrub:** numeric fields are horizontally draggable to adjust, in NLE convention. Cursor becomes `ew-resize` on hover over the label.
- **Focus:** 2px accent ring; text selects entirely on focus so typing replaces.
- **Error:** 1px `danger` border plus an icon and a message. Never color alone.

### Panels

- **Corner style:** `10px`.
- **Background:** `panel`, on a `chrome` shell, separated by hairline.
- **Shadow strategy:** none — see Elevation.
- **Internal padding:** `12px`. Heading uses title type with `8px` below.
- Panels are resizable and collapsible. Collapsed state persists between sessions.

### Timeline clips

The signature component.

- **Shape:** `3px` radius — nearly square, because clips abut and large radii create false gaps that read as cuts.
- **Default:** `raised` background with the clip's own thumbnail strip along the top and its name in label type, truncated from the middle so both head and tail remain readable.
- **Selected:** 1.5px accent outline inset (`outline-offset: -1.5px`) so the outline never changes the clip's footprint and never shifts neighbors.
- **State encoding:** muted, locked, offline, and unrendered are each carried by an icon plus a texture, never by hue alone. Offline media additionally takes a `danger` hairline.
- **Density target:** legible at 40 clips across 6 tracks. Below roughly 24px of clip width the name is dropped and only the thumbnail strip remains — it degrades rather than overflowing.

### Track heads

- 88px wide, 32px tall, `raised` background, hairline right border.
- Track identifier in uppercase label type, followed by mute / lock / visibility toggles as ghost icon buttons.
- Active toggles take the accent; inactive stay `muted`. Every toggle has a distinct icon so state does not depend on color.

### Transport

- Sits directly beneath the preview inside the well, on the `well` surface using `on-well` text.
- Play / pause, step, and in / out markers as ghost icon buttons; timecode in numeric type immediately adjacent.
- Timecode is selectable and directly editable — typing a timecode jumps the playhead.

### Motion

Every component transitions at **150–250ms**; state feedback (hover, focus, toggle) runs at **120ms**. Easing is `ease-out` exponential — `cubic-bezier(0.22, 1, 0.36, 1)`. No bounce, no elastic, no orchestrated load sequence: the app opens directly into the task.

The timeline is the exception that earns weight. Scrubbing carries momentum, clip drag has inertia, and snapping is magnetic with a tactile settle over roughly 90ms. This is the one surface where motion is direct-manipulation feedback rather than decoration, and it is the difference between an editor that feels like software and one that feels like an instrument.

Under `prefers-reduced-motion: reduce`, every transition becomes an instant state change or a crossfade, and timeline momentum, inertia, and snap-settle are disabled — snapping still occurs, it simply lands immediately. Nothing essential is ever gated on an animation completing.

## 6. Do's and Don'ts

### Do:

- **Do** separate surfaces by lightness on the four-plane ramp (`well` 0.10 → `chrome` 0.215 → `panel` 0.255 → `raised` 0.31). Tone is the depth mechanism.
- **Do** keep the preview well the darkest surface in the application, always.
- **Do** cap interface chroma at 0.018 outside `accent`, `danger`, and `warning`, so the footage is by construction the most saturated thing on screen.
- **Do** restrict the accent to the playhead, the current selection, and one primary action per view.
- **Do** encode every state with icon and text first, color third. Verify against deuteranopia, not just a contrast checker.
- **Do** use tabular monospaced figures for every numeral that changes while the UI is live.
- **Do** check muted text against `raised`, not only against `panel` — the raised surface is where contrast actually fails.
- **Do** give every interactive element all seven states before calling it done.
- **Do** provide a real reduced-motion path for every transition, including timeline momentum and snap.
- **Do** design the timeline at forty clips across six tracks. That is the real target, not a three-clip screenshot.

### Don't:

- **Don't** ship **muddy gray Electron chrome** — flat `#2b2b2b` panels on a `#1e1e1e` shell with no measured tonal separation. This is the project's named anti-reference.
- **Don't** produce the **wall-of-controls first impression**. Advanced controls disclose in context; they are not permanently resident.
- **Don't** open a **modal for project setup**. Infer resolution and frame rate from the first clip imported and allow correction inline.
- **Don't** import **dashboard grammar** — no stat tiles, no card grids, no sidebar-of-nav-links.
- **Don't** put a shadow on anything that cannot move. Panels, toolbars, clips, and track heads are in-flow.
- **Don't** nest panels inside panels. Nested cards are always wrong.
- **Don't** use `border-left` or `border-right` greater than 1px as a colored accent stripe on any clip, row, or callout.
- **Don't** use gradient text (`background-clip: text`), decorative glassmorphism, or backdrop blur as styling. Blur is permitted only where it functions — behind an open modal scrim.
- **Don't** add a tracked-out uppercase eyebrow above panel headings, or number sections `01 / 02 / 03`. Both are scaffolding, not voice.
- **Don't** let a theme change anything but color. Spacing, radius, type, and timing are theme-invariant.
- **Don't** encode clip type, track state, or selection with hue alone — it fails under deuteranopia, which is measured and non-negotiable here.
- **Don't** exceed weight 600 or introduce a second sans family.
- **Don't** animate an entrance sequence on launch. The app opens into the task.
