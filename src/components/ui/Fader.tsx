/* ---------------------------------------------------------------------------
   Fader — a gain control, 0..2 amplitude with 1 at unity. CREATIVE §1.4, §9.1.

   INVENTORY NOTE (PLAN §5 / §0.2). The primitive list was closed at nine and
   extended to eleven for TextField and Select. This is the twelfth, and it is
   here for the same reason those two were: nothing in the list holds a
   continuous bounded value by direct manipulation. NumericField is the closest
   and it is the wrong control — a fader lives in an 88px track head where there
   is no room for a numeric recess, and the gesture wanted there is "push it
   down until it sits right", which is a position, not a typed number. The
   numeric route to the same value still exists in the inspector.

   WHY dB IS THE READ-OUT AND 0..2 IS NOT. The stored number is an amplitude
   multiplier because that is what the mixer multiplies (CREATIVE §1.2) — but
   "0.5" read aloud means nothing to anyone, and it is not half as loud. −6.0 dB
   is what the number MEANS, so `aria-valuetext` carries dB and the keyboard
   steps in dB. `aria-valuenow` stays in the stored 0..2 domain because
   valuemin/valuemax must agree with it, and the silent end of a dB scale is
   −Infinity, which is not a number a range can end at.

   THE VALUE IS NEVER CARRIED BY HUE. The fill uses --accent, and it is the
   third signal, not the first: the handle's POSITION along the track is the
   value, the unity tick is drawn on the track so unity is locatable without
   reading a colour, and the accessible name plus `aria-valuetext` state it in
   words. Under deuteranopia the fill and the groove still separate on lightness
   alone, and removing the fill entirely would lose nothing but polish.

   GEOMETRY IS LINEAR IN AMPLITUDE, not in dB. Unity therefore sits at exactly
   the midpoint, which is what puts the tick somewhere the eye can find without
   measuring, and what makes "half way down" mean the same thing on every track.
   A dB-linear travel would push unity to 78% of a 56px track and bunch the
   whole useful range into the last 12px.
--------------------------------------------------------------------------- */

import './ui.css';
import './fader.css';
import { useCallback, useRef } from 'react';
import type { KeyboardEvent, PointerEvent, ReactElement } from 'react';

export interface FaderProps {
  /** 0..2, 1 = unity. */
  value: number;
  onChange(next: number): void;
  /** Names the thing being faded: "track V1", "master". Becomes the accessible name. */
  label: string;
  /** Below this the control is not rendered at all — the caller decides, not the Fader. */
  disabled?: boolean;
}

/** Amplitude bounds. 2 is +6.02 dB, which is what `End` lands on. */
const MIN_VALUE = 0;
const MAX_VALUE = 2;
const UNITY = 1;

/**
 * The bottom of the dB ladder. Amplitude 0 is −Infinity dB, so an arrow key
 * pressed at silence has nowhere to step to; it steps to here instead. −60 dB
 * is the conventional fader floor and is inaudible in any mix, so treating
 * anything at or below it as `0` loses no signal and keeps `silent` reachable
 * by a single key rather than by sixty of them (that is what `Home` is for).
 */
const FLOOR_DB = -60;
const FLOOR_AMP = 10 ** (FLOOR_DB / 20);

/** Snap radius around unity, in amplitude. Shift suppresses it. */
const SNAP_AMP = 0.03;

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** Amplitude -> dB. Silence has no dB, so the floor stands in for it. */
const toDb = (amp: number): number => (amp <= FLOOR_AMP ? FLOOR_DB : 20 * Math.log10(amp));
/** dB -> amplitude, collapsing everything at or under the floor to true silence. */
const fromDb = (db: number): number => (db <= FLOOR_DB ? 0 : clamp(10 ** (db / 20), MIN_VALUE, MAX_VALUE));

/** Amplitudes are stored to 4 places; anything finer is below one pixel of travel. */
const quantize = (amp: number): number => Math.round(clamp(amp, MIN_VALUE, MAX_VALUE) * 1e4) / 1e4;

/**
 * The spoken value. Three cases, because two of them are words rather than
 * numbers: at 0 there is no dB figure to read, and at unity "0.0 dB" is a
 * number the user has to decode into the fact they actually want.
 *
 * U+2212 MINUS, not a hyphen — screen readers say "minus" for one and "dash"
 * for the other, and this string exists to be read aloud.
 */
export function faderValueText(amp: number): string {
  if (amp <= 0) return 'silent';
  if (Math.abs(amp - UNITY) < 5e-4) return 'unity';
  const db = toDb(amp);
  if (db <= FLOOR_DB) return 'silent';
  const sign = db < 0 ? '−' : '+';
  return `${sign}${Math.abs(db).toFixed(1)} dB`;
}

export function Fader({ value, onChange, label, disabled = false }: FaderProps): ReactElement {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const current = clamp(Number.isFinite(value) ? value : UNITY, MIN_VALUE, MAX_VALUE);
  const fraction = current / MAX_VALUE;

  /** Pointer x -> amplitude, with a magnetic unity unless Shift asks for fine. */
  const valueAt = useCallback((clientX: number, fine: boolean): number => {
    const track = trackRef.current;
    if (!track) return UNITY;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return UNITY;
    const raw = clamp((clientX - rect.left) / rect.width, 0, 1) * MAX_VALUE;
    if (!fine && Math.abs(raw - UNITY) < SNAP_AMP) return UNITY;
    return quantize(raw);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled || event.button !== 0) return;
    // Capture on the slider itself, so a drag that leaves the 56px track — which
    // it will, constantly, at this size — keeps feeding this control instead of
    // being handed to whatever the pointer wandered over.
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    dragging.current = true;
    event.currentTarget.focus();
    onChange(valueAt(event.clientX, event.shiftKey));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    onChange(valueAt(event.clientX, event.shiftKey));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;

    // Steps are in dB because that is the unit the control is read in. A step in
    // amplitude would be 1 dB near silence and 0.1 dB near unity — the same key
    // doing different amounts of work depending on where the handle already is.
    const step = event.shiftKey ? 0.1 : 1;
    let next: number | null = null;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = fromDb(toDb(current) + step);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        // Stepping down off the floor is silence, not a hard stop at −60.
        next = toDb(current) - step <= FLOOR_DB ? 0 : fromDb(toDb(current) - step);
        break;
      case 'PageUp':
        next = fromDb(toDb(current) + 6);
        break;
      case 'PageDown':
        next = toDb(current) - 6 <= FLOOR_DB ? 0 : fromDb(toDb(current) - 6);
        break;
      case 'Home':
        next = MIN_VALUE;
        break;
      case 'End':
        next = MAX_VALUE;
        break;
      case '0':
        next = UNITY;
        break;
      default:
        return;
    }

    // Swallowed in both directions: preventDefault stops Home/End/arrows
    // scrolling the track list, and stopPropagation stops `0` reaching the
    // global shortcut layer, which has no text-input selector to catch a div.
    event.preventDefault();
    event.stopPropagation();
    if (next !== null) onChange(quantize(next));
  };

  const valueText = faderValueText(current);

  return (
    <div
      ref={trackRef}
      className="ve-fader"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={MIN_VALUE}
      aria-valuemax={MAX_VALUE}
      aria-valuenow={current}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      aria-orientation="horizontal"
      data-disabled={disabled || undefined}
      data-unity={Math.abs(current - UNITY) < 5e-4 || undefined}
      /* The value in words on hover, so it is legible without a screen reader
         and without the fill's colour. */
      title={`${label} — ${valueText}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        if (!disabled) onChange(UNITY);
      }}
      onKeyDown={onKeyDown}
    >
      <div className="ve-fader-groove" aria-hidden="true">
        <div className="ve-fader-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      {/* Unity is a fixed landmark on the track, not a state of the handle: it
          must be findable when the handle is nowhere near it.

          OUTSIDE the groove, deliberately — a sibling, not a child. Inside, its
          backdrop alternates between the well and the accent fill depending on
          the current value, and no single colour clears 3:1 against both a
          near-black groove and a light accent. Sitting under the groove it has
          ONE backdrop, the track head, in every theme and at every value. */}
      <div className="ve-fader-tick" aria-hidden="true" />
      <div className="ve-fader-handle" style={{ left: `${fraction * 100}%` }} aria-hidden="true" />
    </div>
  );
}
