/* ---------------------------------------------------------------------------
   Clip — the signature component, designed for 40 of them across 6 tracks.

   It subscribes to primitives only (its own record, selected, offline, warned,
   the two transitions as encoded strings, the title text) and re-renders only
   when one of them changes. It receives no object, array or function prop, so
   React.memo actually holds: a pointermove causes zero renders here — the drag
   layer writes transforms straight to the DOM and commits to the store once, on
   pointerup (PLAN §8.7).

   The degrade order is fixed (PLAN §7.6): the name and the thumbnail strip drop
   below 24 px of width, the state icon below 16 px, and the texture never drops
   at all — it is the only signal that still reads at 8 px. The transition
   HANDLES drop first of all, below 34 px, because two 10 px corner targets plus
   two 6 px trim edges do not fit in a narrower clip; the RAMP they author keeps
   painting down to 12 px, because a state must not vanish just because the
   control that set it has.

   TITLE CLIPS carry `mediaId: ''`, so every media lookup here is gated on
   `clipUsesMedia` (CREATIVE §9.4). Resolving the empty id instead would make a
   title read as offline media — the exact failure that section names.
--------------------------------------------------------------------------- */

import './timeline.css';
import { memo } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import {
  AudioLines,
  EyeOff,
  Film,
  Lock,
  TriangleAlert,
  Type,
  Unplug,
  VolumeX,
} from 'lucide-react';
import type { ClipId, PxPerFrame, TransitionKind } from '../../types/model';
import { clipStreams, clipIsTitle, clipUsesMedia } from '../../types/model';
import { useEditorStore } from '../../state/store';
import { framesToDuration, framesToPx } from '../../lib/time';
import {
  CLIP_MIN_HIT_WIDTH,
  CLIP_MIN_LABEL_WIDTH,
  CLIP_MIN_RENDER_WIDTH,
} from '../../lib/constants';

/** Below this the state icon drops too. The texture is what survives (PLAN §7.6). */
const CLIP_MIN_ICON_WIDTH = 16;
const STRIP_MAX_HEIGHT = 14;
const STRIP_MIN_LANE_HEIGHT = 30;

/**
 * Below this the transition corner handles are not rendered. Two 6 px trim
 * edges and two 10 px handles are 32 px of chrome; under 34 px the handles would
 * cover the clip and the trim gesture would have nowhere left to land.
 */
export const CLIP_MIN_TRANSITION_WIDTH = 34;
/** Below this even the ramp stops painting — the same gate the trim edges use. */
const CLIP_MIN_RAMP_WIDTH = 12;

/* ---------------------------------------------------------- name truncation

   Middle truncation used to be two flex children — an ellipsising head and an
   unshrinkable tail. Under pressure the head collapsed to 0 px first and the
   clip rendered its tail alone: `Market, wide` became `t, wide`, and two clips
   on the same track could render the identical label. The head is the
   identifying part, so it is now reserved first and the string is cut here, in
   one text node, against the width the body actually has.

   The budget is analytic rather than measured: a per-clip DOM measurement would
   have to run on every zoom step for forty clips. The per-character figure is
   deliberately a shade wider than the 11 px label face measures (~5.5 px
   average), so the computed string under-fills its box; `.tl-clip-name` still
   carries `text-overflow: ellipsis` as the backstop for a name of unusually
   wide glyphs or a fallback font.                                            */

/** Average advance of one character at the 11 px label step, px. */
const LABEL_CHAR_PX = 6;
/** The ellipsis is roughly two characters wide, so it is reserved separately. */
const ELLIPSIS_PX = 10;
/** Clip chrome the name never gets: 1 px border + var(--space-xs) padding, both sides. */
const NAME_CHROME_PX = 10;
/** One 14 px state icon plus the var(--space-hair) gap that follows it. */
const ICON_SLOT_PX = 16;
/** Head characters held back before any tail is shown. Below this: head only. */
const MIN_HEAD_CHARS = 4;
/** A one- or two-character tail says nothing, so it is dropped rather than shown. */
const MIN_TAIL_CHARS = 3;
const MAX_TAIL_CHARS = 7;

/** The name as it fits in `textPx`, truncated from the middle. '' = no room at all. */
export function fitClipName(name: string, textPx: number): string {
  if (name.length * LABEL_CHAR_PX <= textPx) return name;
  const budget = Math.floor((textPx - ELLIPSIS_PX) / LABEL_CHAR_PX);
  if (budget < 1) return '';
  const tail = Math.min(MAX_TAIL_CHARS, budget - MIN_HEAD_CHARS);
  if (tail < MIN_TAIL_CHARS) return `${name.slice(0, budget)}…`;
  return `${name.slice(0, budget - tail)}…${name.slice(name.length - tail)}`;
}

/**
 * A title's label is its TEXT, so a lane full of titles is readable as content
 * rather than as six clips all called "Title". Newlines and runs of whitespace
 * collapse to one space: the clip is one 11 px line, and a raw '\n' there would
 * render as a gap the truncator has already paid for.
 */
export function titleLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat === '' ? 'Empty title' : flat;
}

/* ------------------------------------------------------------- transitions

   Each edge is subscribed as ONE encoded string rather than as a kind and a
   number, so `Clip` still takes only primitives from the store and React.memo
   still holds through a pointermove. `null` is "no transition on this edge".  */

interface ParsedTransition {
  kind: TransitionKind;
  frames: number;
}

export function encodeTransition(kind: TransitionKind, frames: number): string {
  return `${kind}:${frames}`;
}

function parseTransition(encoded: string | null): ParsedTransition | null {
  if (encoded === null) return null;
  const at = encoded.indexOf(':');
  if (at < 0) return null;
  const frames = Number.parseInt(encoded.slice(at + 1), 10);
  if (!Number.isFinite(frames) || frames <= 0) return null;
  return { kind: encoded.slice(0, at) as TransitionKind, frames };
}

export interface ClipProps {
  id: ClipId;
  zoom: PxPerFrame;
  laneHeight: number;
  trackLocked: boolean;
  trackMuted: boolean;
  /**
   * Track visibility is carried by an icon and a word rather than a fifth
   * texture: the encoding table in PLAN §7.6 closes at four, and inventing
   * another would collide with `muted` at a glance.
   */
  trackHidden: boolean;
  /** Roving tabindex: exactly one clip in the lane area is a tab stop. */
  focused: boolean;
}

export const Clip = memo(function Clip({
  id,
  zoom,
  laneHeight,
  trackLocked,
  trackMuted,
  trackHidden,
  focused,
}: ClipProps): ReactElement | null {
  const clip = useEditorStore((s) => s.clips[id]);
  const selected = useEditorStore((s) => s.selection.has(id));
  const offline = useEditorStore((s) => s.offlineClipIds.has(id));
  const fps = useEditorStore((s) => s.fps);
  // Both media lookups are gated on `clipUsesMedia`, not on a truthy mediaId:
  // a title carries '' and `items['']` is undefined, so the untidy version would
  // work by accident today and break the first time a lookup is given a default.
  const thumbnailUrl = useEditorStore((s) => {
    const c = s.clips[id];
    return c && clipUsesMedia(c) ? (s.items[c.mediaId]?.thumbnailUrl ?? null) : null;
  });
  const warned = useEditorStore((s) => {
    const c = s.clips[id];
    return c && clipUsesMedia(c) ? (s.items[c.mediaId]?.warnings.length ?? 0) > 0 : false;
  });
  // [stable] — a string primitive, so React.memo still holds and a pointermove
  // still causes zero renders here.
  const streams = useEditorStore((s) => {
    const c = s.clips[id];
    return c ? clipStreams(c) : 'av';
  });
  // [stable] — a boolean primitive, so React.memo still holds and a pointermove
  // still causes zero renders here. Deliberately NOT the LinkId itself: the id is
  // a string that changes on every re-link, and nothing here uses its value.
  const linked = useEditorStore((s) => s.clips[id]?.linkId !== undefined);
  // [stable] — a string primitive, and null on every media clip, so the whole
  // title feature costs an existing clip one referential comparison per store
  // write and nothing else.
  const titleText = useEditorStore((s) => {
    const c = s.clips[id];
    return c && clipIsTitle(c) ? (c.title?.text ?? '') : null;
  });
  const encodedIn = useEditorStore((s) => {
    const t = s.clips[id]?.transitionIn;
    return t ? encodeTransition(t.kind, t.frames) : null;
  });
  const encodedOut = useEditorStore((s) => {
    const t = s.clips[id]?.transitionOut;
    return t ? encodeTransition(t.kind, t.frames) : null;
  });

  if (!clip) return null;

  const isTitle = titleText !== null;
  const paintWidth = Math.max(CLIP_MIN_RENDER_WIDTH, framesToPx(clip.duration, zoom));
  const tiny = paintWidth < CLIP_MIN_HIT_WIDTH;
  const showIcons = paintWidth >= CLIP_MIN_ICON_WIDTH;
  const stripHeight = Math.min(STRIP_MAX_HEIGHT, Math.round(laneHeight * 0.4));
  // DESIGN.md §5: below 24px the NAME drops and the strip remains. It occupies
  // the top ~40% only, so the texture underneath still reads at 8px of width.
  // The strip is the MEDIA's thumbnail and the media is a video file, so an
  // audio-only clip would otherwise render video frames on an audio lane — the
  // interface asserting something false. Suppressing it is the third of §1.8's
  // four channels, and the widest one that is not the lane itself.
  const showStrip =
    thumbnailUrl !== null &&
    streams !== 'audio' &&
    laneHeight >= STRIP_MIN_LANE_HEIGHT &&
    stripHeight >= 8 &&
    paintWidth >= CLIP_MIN_HIT_WIDTH;

  // Texture first, icon second, hue third — and they stack when several apply.
  const textures: string[] = [];
  if (offline) textures.push('var(--texture-offline)');
  if (trackLocked) textures.push('var(--texture-locked)');
  if (trackMuted) textures.push('var(--texture-muted)');
  if (warned) textures.push('var(--texture-warning)');
  // A title's generated texture is deliberately NOT in this list. Every entry
  // here is a STATE from PLAN §7.6's four-row table, declared in tokens.css and
  // read across the file boundary — which is a pattern the contract gate can
  // check, because the declaration is in the token layer it knows. A title is a
  // clip TYPE, not a state; it has no row in that table and no business in the
  // theme token layer, so it paints from its own element and its own rule in
  // timeline.css instead. See `.tl-clip-generated`.

  const style: CSSProperties = {
    left: `${framesToPx(clip.start, zoom)}px`,
    width: `${paintWidth}px`,
  };
  if (textures.length > 0) style.backgroundImage = textures.join(', ');

  // `streams !== 'av'` is what makes §1.8's icon channel exist at all: a
  // detached clip on an unlocked, unmuted, visible track whose media is online
  // and warning-free satisfies none of the other five, which is the normal case
  // and the one this feature is for.
  const showStateIcons =
    showIcons &&
    (offline || warned || trackLocked || trackMuted || trackHidden || streams !== 'av' || isTitle);
  // Three slots at most: source-state, stream, track-state — counted in the
  // order they are rendered. The count is subtracted from fitClipName's budget
  // below, so an un-widened one is 16px too generous and truncates a name in the
  // middle instead of at its head.
  const iconSlots = showStateIcons
    ? (offline || warned ? 1 : 0) +
      (isTitle || streams !== 'av' ? 1 : 0) +
      (trackLocked || trackMuted || trackHidden ? 1 : 0)
    : 0;
  // CLIP_MIN_LABEL_WIDTH gates on the clip's paint width; the icons then take a
  // further 16 px each out of the body, which is what used to leave 38-50 px clips
  // rendering a 0 px head. Both gates apply.
  const source = isTitle ? titleLabel(titleText) : clip.name;
  const name =
    paintWidth >= CLIP_MIN_LABEL_WIDTH
      ? fitClipName(source, paintWidth - NAME_CHROME_PX - iconSlots * ICON_SLOT_PX)
      : '';
  const duration = framesToDuration(clip.duration, fps);

  const transitionIn = parseTransition(encodedIn);
  const transitionOut = parseTransition(encodedOut);
  const showRamps = paintWidth >= CLIP_MIN_RAMP_WIDTH;
  const showTransitionHandles = paintWidth >= CLIP_MIN_TRANSITION_WIDTH;

  const states: string[] = [];
  if (isTitle) states.push('title');
  if (offline) states.push('offline');
  if (trackLocked) states.push('track locked');
  if (trackMuted) states.push('track muted');
  if (trackHidden) states.push('track hidden');
  if (streams === 'audio') states.push('audio only');
  if (streams === 'video') states.push('video only');
  // The word arrives in the accessible name at the moment focus lands on the
  // clip — BEFORE the selection expands — which is the right moment for it, and
  // it is the one channel that survives to zero width (docs/LINKING.md §8.3).
  if (linked) states.push('linked');
  if (warned) states.push('format mismatch');
  // Transitions are authored by a pointer gesture on a 10px corner, so the
  // accessible name is where a keyboard user learns one is there at all. The
  // menu that sets them is the same menu the pointer user gets.
  if (transitionIn) {
    states.push(
      transitionIn.kind === 'dissolve'
        ? `cross dissolve in, ${transitionIn.frames} frames`
        : `fade in, ${transitionIn.frames} frames`,
    );
  }
  if (transitionOut) states.push(`fade out, ${transitionOut.frames} frames`);
  const label = `${source}, ${duration}${states.length > 0 ? `, ${states.join(', ')}` : ''}`;

  return (
    <div
      className="tl-clip"
      style={style}
      data-clip-id={id}
      data-selected={selected || undefined}
      data-offline={offline || undefined}
      data-kind={isTitle ? 'title' : undefined}
      data-streams={streams === 'av' ? undefined : streams}
      data-linked={linked || undefined}
      data-tiny={tiny || undefined}
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={focused ? 0 : -1}
    >
      {showStrip ? (
        <div
          className="tl-clip-strip"
          style={{ height: `${stripHeight}px`, backgroundImage: `url(${thumbnailUrl})` }}
          aria-hidden="true"
        />
      ) : null}

      {/* The generated-content lattice. Its own element rather than a fifth
          entry in `textures` above, because the inline `background-image` those
          write REPLACES any the stylesheet sets — a title on a locked track
          would otherwise have to choose between showing that it is a title and
          showing that it is locked. As a separate layer the two simply stack,
          and the pattern never leaves timeline.css. */}
      {isTitle ? <span className="tl-clip-generated" aria-hidden="true" /> : null}

      {/* THE RAMPS, between the strip and the body on purpose. They paint OVER
          the thumbnail, because that is what a fade does to the picture, and
          UNDER the name and the state icons, because a clip whose identity has
          been dimmed by its own transition fails "legible under load" — and it
          fails it worst on `daylight`, where the scrim is a dark wash over dark
          text. Same z-index as the body; DOM order decides, so the two cannot
          drift apart the way two literals would.

          Mounted at zero width even when there is no transition, so the drag
          layer always has an element to write `--tl-ramp-w` to and a gesture
          never allocates DOM at pointer rate. */}
      {showRamps ? (
        <>
          <span
            className="tl-clip-ramp"
            data-edge="in"
            data-kind={transitionIn?.kind ?? 'fade'}
            style={
              { '--tl-ramp-w': `${framesToPx(transitionIn?.frames ?? 0, zoom)}px` } as CSSProperties
            }
            aria-hidden="true"
          />
          <span
            className="tl-clip-ramp"
            data-edge="out"
            data-kind={transitionOut?.kind ?? 'fade'}
            style={
              { '--tl-ramp-w': `${framesToPx(transitionOut?.frames ?? 0, zoom)}px` } as CSSProperties
            }
            aria-hidden="true"
          />
        </>
      ) : null}

      {name !== '' || showStateIcons ? (
        <div className="tl-clip-body">
          {showStateIcons ? (
            <span className="tl-clip-icons" aria-hidden="true">
              {offline ? (
                <span data-tone="danger">
                  <Unplug size={14} strokeWidth={1.75} />
                </span>
              ) : null}
              {warned && !offline ? (
                <span data-tone="warning">
                  <TriangleAlert size={14} strokeWidth={1.75} />
                </span>
              ) : null}
              {/* Names what the clip CONTAINS, not what it lacks: a negative
                  glyph on a clip that is working normally reads as an error,
                  and VolumeX already means "track muted" in this same strip.
                  No data-tone — this is what the clip is, not a status. */}
              {isTitle ? <Type size={14} strokeWidth={1.75} /> : null}
              {!isTitle && streams === 'audio' ? (
                <AudioLines size={14} strokeWidth={1.75} />
              ) : null}
              {!isTitle && streams === 'video' ? <Film size={14} strokeWidth={1.75} /> : null}
              {trackLocked ? <Lock size={14} strokeWidth={1.75} /> : null}
              {trackMuted && !trackLocked ? <VolumeX size={14} strokeWidth={1.75} /> : null}
              {trackHidden && !trackLocked && !trackMuted ? (
                <EyeOff size={14} strokeWidth={1.75} />
              ) : null}
            </span>
          ) : null}
          {name !== '' ? (
            <span className="tl-clip-name type-label">{name}</span>
          ) : null}
        </div>
      ) : null}

      {paintWidth >= 12 ? (
        <>
          <span className="tl-clip-edge" data-edge="in" data-clip-edge={id} aria-hidden="true" />
          <span className="tl-clip-edge" data-edge="out" data-clip-edge={id} aria-hidden="true" />
        </>
      ) : null}

      {/* The transition handles sit INSIDE the trim edges — 6 px in from each
          end — so the two gestures never share a pixel and the hit test is
          decided by geometry rather than by handler order. Like the trim edges
          they are aria-hidden and take no tabindex: authoring a transition by
          dragging is direct manipulation, and its keyboard equivalent is the
          clip context menu, which every focused clip can open. */}
      {showTransitionHandles ? (
        <>
          <span
            className="tl-clip-transition-handle"
            data-edge="in"
            data-clip-transition={id}
            aria-hidden="true"
          />
          <span
            className="tl-clip-transition-handle"
            data-edge="out"
            data-clip-transition={id}
            aria-hidden="true"
          />
        </>
      ) : null}
    </div>
  );
});
