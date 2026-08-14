/* ---------------------------------------------------------------------------
   SubtitleLayer — the active cue(s) over the frame. CREATIVE §6.

   Cues are PROJECT-level, not clips (CREATIVE §6.1): they are on screen because
   the playhead is inside them, regardless of what clip is underneath, and they
   survive re-cutting the footage. So this layer sits above every clip layer and
   reads nothing from the clip — which is also where the burn-in goes, appended
   to the TERMINAL video chain after the last overlay, so no clip's grade touches
   it (CREATIVE §6.3).

   THIS IS AN APPROXIMATION AND IS DOCUMENTED AS ONE. The file is burned in by
   libass, which shapes and positions text with its own layout engine; this is
   Chromium laying out a `<div>`. Size, margin and outline are computed from the
   same `SubtitleStyle` numbers on the same fractions of frame height, so the two
   agree on where a cue sits and roughly how big it is — they do not agree on
   line breaking, on the exact outline join, or on shaping. A cue is a caption,
   not a title: the disagreement is at the scale of a pixel or two of stroke,
   which is why §5's rasteriser exists for titles and does not exist here.

   Colour comes from the STYLE, which is user data, and that is the one place in
   this app a colour is not a token. The outline is --frame-matte, the black the
   export actually writes, because libass's default outline colour is black and
   the burn-in has no field to say otherwise.
--------------------------------------------------------------------------- */

import { useCallback } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { SubtitleCue } from '../../types/model';
import type { StoreState } from '../../state/types';
import { useEditorStore } from '../../state/store';

/**
 * `SubtitleStyle.outline` is px at 1080 and scales with the output height
 * (CREATIVE §6.3), so the preview scales it by the STAGE height for the same
 * reason: a 2px outline at a 480px-tall preview would be four times the weight
 * it is in the file.
 */
const OUTLINE_REFERENCE_HEIGHT = 1080;

/**
 * `sizePct` is CAP height as a fraction of frame height (model.ts), and CSS
 * `font-size` is the em size. titleRaster measures the real ratio for the family
 * it resolves; a `<div>` cannot, so this is the same 0.72 fallback that file
 * uses when the measurement is unavailable. It is the largest single source of
 * the size disagreement with the burn-in, and it is a few percent.
 */
const CAP_HEIGHT_RATIO = 0.72;

/**
 * The cues covering `frame`, flattened to ONE string.
 *
 * A string and not an array, because this runs on every store notification and a
 * fresh array would fail the identity check and re-render the preview at frame
 * rate whether or not the cue changed. A string changes value only when the
 * visible text does — which is exactly when a re-render is owed.
 */
export function selectActiveCueText(s: StoreState, frame: number): string {
  // `for…in` over the record rather than Object.values: this runs on every store
  // notification, and at 400 cues an array per notification is an allocation per
  // frame of playback for a result that is almost always one cue or none.
  let active: SubtitleCue[] | null = null;
  for (const id in s.subtitles) {
    const cue = s.subtitles[id];
    if (!cue || frame < cue.start || frame >= cue.end) continue;
    (active ??= []).push(cue);
  }
  if (active === null) return '';
  if (active.length === 1) return active[0].text;
  // Overlapping cues are legal in SRT and the burn-in stacks them in time order.
  active.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  return active.map((cue) => cue.text).join('\n');
}

export interface SubtitleLayerProps {
  /** Stage size in CSS px. Every dimension below is a fraction of the height. */
  stageHeight: number;
}

export function SubtitleLayer({ stageHeight }: SubtitleLayerProps): ReactElement | null {
  const text = useEditorStore(useCallback((s: StoreState) => selectActiveCueText(s, s.playhead), []));
  // [stable] one object on the doc, reallocated only by setSubtitleStyle.
  const style = useEditorStore((s) => s.subtitleStyle);

  if (text === '' || !(stageHeight > 0)) return null;

  const fontSize = (style.sizePct * stageHeight) / CAP_HEIGHT_RATIO;
  const stroke = (style.outline * stageHeight) / OUTLINE_REFERENCE_HEIGHT;

  const cssStyle: CSSProperties = {
    bottom: `${style.marginPct * stageHeight}px`,
    fontSize: `${fontSize.toFixed(2)}px`,
    lineHeight: 1.25,
    color: style.color,
    // Width only. The stroke COLOUR and the paint order are in preview.css,
    // where --frame-matte can be referenced as a token rather than smuggled
    // through a style object.
    WebkitTextStrokeWidth: `${stroke.toFixed(2)}px`,
  };

  return (
    <div className="ve-video-subtitles" aria-hidden="true" style={cssStyle}>
      {text}
    </div>
  );
}
