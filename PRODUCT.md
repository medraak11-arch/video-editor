# Product

## Register

product

## Users

One user: the person building it. Not a market, not a persona set — a single editor with full context on every decision, editing their own footage on their own machine.

**Context of use:** a desktop application (Electron/Tauri), on a large display, in sessions that range from a five-minute trim to a multi-hour assembly. No network dependency assumed, no accounts, no collaborators. The user already knows what they want to do; the tool's job is to not be in the way of doing it.

**Job to be done:** import footage, arrange and trim it on a timeline, see the result immediately, export it. The full editing loop — not a wizard, not a template filler. Capability is expected; ceremony is not.

## Product Purpose

A desktop video editor built for its own author. It exists because general-purpose NLEs make you pay an upfront tax — a wall of panels, a project-setup dialog, a modal asking about your codec — before you can touch a frame, and consumer editors take away the control you need the moment the edit gets real.

The target is the middle: **open it and start cutting, but never hit a ceiling.** Full timeline editing, real export control, keyboard-driven throughout — presented so that the first screen is calm rather than exhaustive.

**Success looks like:** the author reaches for this instead of the installed professional NLE for anything that isn't color grading or motion graphics. Failure looks like opening it, feeling the friction, and going back to the other tool.

**First build target:** the complete editor shell — media library, preview/player, multi-track timeline, properties panel, export. The structural skeleton every later feature hangs on.

## Brand Personality

**Approachable, precise, quiet.**

Voice: plain and direct. Labels say what things are (`Split`, `Export`, `Import media`), not what they aspire to be. No exclamation marks, no encouragement, no personality in microcopy — the user is not a customer being onboarded, they are an operator who already knows the domain.

Emotional goal: **composure.** Opening the app should feel like sitting down at a clean desk, not like booting a flight simulator. The interface should feel like it is waiting, not demanding.

**Reference:** Microsoft Clipchamp — specifically its willingness to be legible. Preview-forward layout, a timeline that reads at a glance on first open, panel chrome that stays quiet instead of competing with the footage. Taking the approachability and the calm, **not** the template-and-asset-store framing or the consumer upsell surface.

## Anti-references

- **Muddy gray Electron chrome.** The default desktop-app look — flat `#2b2b2b` panels on `#1e1e1e` shells, undifferentiated surfaces, everything the same low-contrast slab. It's what an app looks like when nobody decided anything. Surfaces must be deliberately distinguished, and the shell must never read as tired.
- **The wall-of-controls first impression.** DaVinci Resolve / Avid on launch: every panel, every scope, every inspector visible at once, before the user has imported a single file. Depth is required; shouting all of it on open is not.
- **Modal-first flows.** A dialog asking for project settings, resolution, or frame rate before the first frame is on screen. Sensible defaults, inferred from the first clip imported, corrected inline later.
- **Any "dashboard" grammar.** Stat tiles, card grids, sidebar-of-nav-links. This is an instrument, not an analytics page.

## Design Principles

1. **The frame is the product.** The preview is the largest and highest-contrast element on screen. Every other panel is chrome, and chrome yields — in size, in saturation, and in visual weight — to the footage being edited.

2. **Depth on demand.** Full capability lives in the app, but the default screen shows only the editing loop: media in, timeline, preview, export. Advanced controls surface in context (on selection, on hover-intent, behind a named disclosure) rather than being permanently resident. Progressive disclosure is the mechanism; a calm first screen is the goal. Launch is the one deliberate exception, and it is the author's call rather than a consequence of this principle. A start-up splash carrying the version is drawn on every launch and held briefly so it can be read; the editor waits for it. That wait is the only place in the app where anything is held open to be looked at, it is bounded, and it costs a fraction of a second — but it is a cost, and it is stated here rather than hidden.

3. **The keyboard is the primary instrument.** Direct manipulation for spatial work (dragging clips, scrubbing, trimming edges); keyboard for everything else. Every core action has a shortcut, shortcuts follow NLE convention where one exists, and the UI teaches them passively — shortcut hints live on the controls themselves, not in a help page nobody opens.

4. **Legible under load.** The design target is a timeline with forty clips across six tracks at 2 a.m., not a marketing screenshot with three. Clip identity, track state, and selection must survive density. Meaning is carried by contrast, position, shape, and label — hue is reinforcement, never the sole signal.

5. **Answers to one person.** No accounts, no onboarding funnel, no upgrade prompts, no telemetry consent, no empty state selling a feature. Every pixel of surface earns its place by serving the edit. If a control exists only to explain the product, it doesn't belong.

## Accessibility & Inclusion

- **WCAG 2.2 AA as the floor.** Body and label text ≥4.5:1 against its own surface; large text ≥3:1. This is enforced on *panel* backgrounds, not just the darkest shell color — a muted label on a raised toolbar is the case that usually fails. Non-text UI (track boundaries, clip edges, focus rings, control borders) ≥3:1.
- **Keyboard operability is a correctness requirement, not an enhancement.** Every action reachable without a mouse. Visible, high-contrast focus indication on every interactive element, including timeline clips and track headers. No keyboard traps in the timeline or in any panel. Logical, predictable tab order across panel regions.
- **Color-blind safe throughout.** Clip type, track state (muted / locked / soloed / hidden), selection, and any error or warning state must be distinguishable without color: icon, label, pattern, border weight, or position. Deuteranopia is the primary check; red/green as the only differentiator is disqualifying.
- **Reduced motion honored.** `prefers-reduced-motion: reduce` gets a real alternative (instant state change or crossfade) on every transition. Nothing essential — playhead position, selection, panel state — may depend on an animation completing.
- **Sustained-session comfort.** Long editing sessions are the norm. No pure-white large surfaces, no high-frequency motion at rest, no elements that pulse or shimmer while idle.
