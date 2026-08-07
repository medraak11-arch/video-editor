/* ---------------------------------------------------------------------------
   Resizer — PLAN §7.7. Shell-owned, and the only splitter in the app.

   Invisible at rest (the gutter is --surface-chrome); a 1 px
   --border-structural line down the centre of the 5 px hit target on hover, and
   the whole track lifts to --surface-raised while dragging. The accent is NOT
   spent here: PLAN §7.4 closes the budget at six uses and a splitter is not one
   of them. The focus ring — which IS use 4 — comes from base.css.

   Pointer-rate values are not store state (PLAN §1.3 rule 4): a drag writes the
   grid's CSS custom property imperatively through `onPreview` and commits to the
   store once, on pointerup. Dragging the rail therefore causes zero React
   renders until the gesture ends.

   States: default, hover, focus-visible, active (dragging) are all implemented.
   `disabled`, `loading` and `error` are not reachable for a separator — it runs
   no async work and is unmounted rather than disabled when its pane collapses —
   so no dead visual is shipped for them.
--------------------------------------------------------------------------- */

import './shell.css';
import { useCallback, useEffect, useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from 'react';
import { RESIZER_KEY_STEP } from '../../lib/constants';

export interface ResizerProps {
  /** 'vertical' separates left/right panes; 'horizontal' separates top/bottom. */
  orientation: 'vertical' | 'horizontal';
  /** Accessible name, e.g. 'Media rail width'. */
  label: string;
  value: number;
  min: number;
  max: number;
  /**
   * Value units gained per pixel of pointer travel along the axis, signed.
   * A function because the caller may need to measure a container first.
   */
  unitsPerPx(): number;
  /** Live preview during a drag. MUST be imperative — never a store write. */
  onPreview(next: number): void;
  /** The single store write, on pointerup, on a key press, or on cancel. */
  onCommit(next: number): void;
  /** Maps the value into the integer unit exposed to assistive technology. */
  toAriaValue(v: number): number;
  /** Spoken form of the current value, e.g. '260 pixels'. */
  toAriaText(v: number): string;
  className?: string;
}

interface DragState {
  origin: number;
  startValue: number;
  unitsPerPx: number;
  pointerId: number;
}

export function Resizer({
  orientation,
  label,
  value,
  min,
  max,
  unitsPerPx,
  onPreview,
  onCommit,
  toAriaValue,
  toAriaText,
  className,
}: ResizerProps): ReactElement {
  const drag = useRef<DragState | null>(null);
  const element = useRef<HTMLDivElement | null>(null);

  // A held arrow key can fire faster than React commits the new `value` prop.
  // `pending` carries the last value this component asked for so a burst of
  // keydowns steps by 16 px each time instead of collapsing onto one step; it
  // is dropped the moment the prop catches up, so the store stays authoritative
  // and a clamp upstream is never fought.
  //
  // The reconciliation is an effect, not a render-phase write: under concurrent
  // rendering a discarded render pass would otherwise leave these refs holding a
  // value that was never committed.
  const settled = useRef(value);
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (settled.current === value) return;
    settled.current = value;
    pending.current = null;
  }, [value]);
  const currentValue = (): number => pending.current ?? value;

  const commit = useCallback(
    (next: number): void => {
      pending.current = next;
      onCommit(next);
    },
    [onCommit],
  );

  const clamp = useCallback(
    (next: number): number => Math.min(Math.max(next, min), max),
    [min, max],
  );

  const axisPosition = useCallback(
    (event: { clientX: number; clientY: number }): number =>
      orientation === 'vertical' ? event.clientX : event.clientY,
    [orientation],
  );

  const stopDrag = useCallback((node: HTMLElement) => {
    const state = drag.current;
    drag.current = null;
    delete node.dataset.dragging;
    if (state && node.hasPointerCapture(state.pointerId)) {
      node.releasePointerCapture(state.pointerId);
    }
    return state;
  }, []);

  /**
   * A drag is imperative and commits once, on pointerup, so `value` — and with it
   * aria-valuenow / aria-valuetext — does not move for the whole gesture. Assistive
   * technology would announce the pre-drag size until the user let go. The DOM
   * attributes are therefore mirrored here, alongside the CSS custom-property write
   * onPreview already performs, which adds no React render.
   */
  const preview = useCallback(
    (next: number): void => {
      onPreview(next);
      const node = element.current;
      if (!node) return;
      node.setAttribute('aria-valuenow', String(toAriaValue(next)));
      node.setAttribute('aria-valuetext', toAriaText(next));
    },
    [onPreview, toAriaText, toAriaValue],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    const node = event.currentTarget;
    event.preventDefault();
    node.setPointerCapture(event.pointerId);
    node.dataset.dragging = 'true';
    node.focus();
    drag.current = {
      origin: axisPosition(event),
      startValue: currentValue(),
      unitsPerPx: unitsPerPx(),
      pointerId: event.pointerId,
    };
  };

  // Pointer capture only redirects the CAPTURED pointer. A second finger or pen that
  // lands on the splitter still dispatches move/up here, and without this check its
  // coordinates would be measured against the first pointer's origin — a stray tap
  // across the window would snap the pane to its maximum.
  const isDragPointer = (event: ReactPointerEvent<HTMLDivElement>): boolean =>
    drag.current !== null && event.pointerId === drag.current.pointerId;

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDragPointer(event)) return;
    const state = drag.current as DragState;
    preview(clamp(state.startValue + (axisPosition(event) - state.origin) * state.unitsPerPx));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDragPointer(event)) return;
    const state = stopDrag(event.currentTarget) as DragState;
    commit(clamp(state.startValue + (axisPosition(event) - state.origin) * state.unitsPerPx));
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDragPointer(event)) return;
    const state = stopDrag(event.currentTarget) as DragState;
    preview(state.startValue);
    commit(state.startValue);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Escape abandons an in-flight drag and restores the value it started at.
    if (event.key === 'Escape') {
      const state = stopDrag(event.currentTarget);
      if (!state) return;
      // Rung (c) of the Escape ladder (PLAN §8.10): a cancelled drag consumes
      // the key, so it never falls through to edit.clearSelection.
      event.preventDefault();
      event.stopPropagation();
      preview(state.startValue);
      commit(state.startValue);
      return;
    }

    const step = Math.abs(unitsPerPx()) * RESIZER_KEY_STEP;
    const from = currentValue();
    let next: number | null = null;

    if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    else if (orientation === 'vertical') {
      if (event.key === 'ArrowLeft') next = from - step;
      else if (event.key === 'ArrowRight') next = from + step;
    } else {
      // Dragging the divider up makes the region below it taller.
      if (event.key === 'ArrowUp') next = from + step;
      else if (event.key === 'ArrowDown') next = from - step;
    }

    if (next === null) return;
    event.preventDefault();
    const settledNext = clamp(next);
    preview(settledNext);
    commit(settledNext);
  };

  return (
    <div
      ref={element}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={toAriaValue(value)}
      aria-valuemin={toAriaValue(min)}
      aria-valuemax={toAriaValue(max)}
      aria-valuetext={toAriaText(value)}
      tabIndex={0}
      className={className ? `shell-resizer ${className}` : 'shell-resizer'}
      data-orientation={orientation}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onKeyDown={handleKeyDown}
    >
      <span className="shell-resizer-line" aria-hidden="true" />
    </div>
  );
}
