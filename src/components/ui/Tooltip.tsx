/* ---------------------------------------------------------------------------
   Tooltip — PLAN §5. Wraps exactly one focusable child.

   Opens on hover after 400ms and on focus-visible immediately. Renders into a
   portal at --z-tooltip so it is never clipped by a panel's overflow. Escape
   closes it, and it is the FIRST rung of the Escape ladder (PLAN §8.10) — it
   stops propagation so a tooltip dismissal never also clears the selection.
--------------------------------------------------------------------------- */

import './ui.css';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  content: ReactNode;
  /** <ShortcutHint id="..." /> */
  shortcut?: ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement;
}

const HOVER_DELAY_MS = 400;
const GAP = 8;

interface Point {
  top: number;
  left: number;
}

export function Tooltip({
  content,
  shortcut,
  placement = 'top',
  children,
}: TooltipProps): ReactElement {
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState<Point>({ top: 0, left: 0 });

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;

    const a = anchor.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    let top = 0;
    let left = 0;

    if (placement === 'top') {
      top = a.top - b.height - GAP;
      left = a.left + a.width / 2 - b.width / 2;
    } else if (placement === 'bottom') {
      top = a.bottom + GAP;
      left = a.left + a.width / 2 - b.width / 2;
    } else if (placement === 'left') {
      top = a.top + a.height / 2 - b.height / 2;
      left = a.left - b.width - GAP;
    } else {
      top = a.top + a.height / 2 - b.height / 2;
      left = a.right + GAP;
    }

    const margin = 4;
    left = Math.min(Math.max(margin, left), window.innerWidth - b.width - margin);
    top = Math.min(Math.max(margin, top), window.innerHeight - b.height - margin);
    setPoint({ top, left });
  }, [open, placement, content, shortcut]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => close();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  if (!isValidElement(children)) return children;

  const childProps = children.props as Record<string, unknown>;

  const call = (name: string, event: unknown) => {
    const handler = childProps[name];
    if (typeof handler === 'function') (handler as (e: unknown) => void)(event);
  };

  const clone = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      const originalRef = (children as unknown as { ref?: unknown }).ref;
      if (typeof originalRef === 'function') (originalRef as (n: unknown) => void)(node);
      else if (originalRef && typeof originalRef === 'object')
        (originalRef as { current: unknown }).current = node;
    },
    'aria-describedby': open ? id : undefined,
    onPointerEnter: (e: unknown) => {
      call('onPointerEnter', e);
      clearTimer();
      timer.current = window.setTimeout(() => setOpen(true), HOVER_DELAY_MS);
    },
    onPointerLeave: (e: unknown) => {
      call('onPointerLeave', e);
      close();
    },
    onPointerDown: (e: unknown) => {
      call('onPointerDown', e);
      close();
    },
    onFocus: (e: unknown) => {
      call('onFocus', e);
      const node = anchorRef.current;
      if (!node || node.matches(':focus-visible')) setOpen(true);
    },
    onBlur: (e: unknown) => {
      call('onBlur', e);
      close();
    },
    onKeyDown: (e: unknown) => {
      call('onKeyDown', e);
      const ke = e as ReactKeyboardEvent;
      if (ke.key === 'Escape' && open) {
        ke.stopPropagation();
        close();
      }
    },
  });

  return (
    <>
      {clone}
      {open
        ? createPortal(
            <div
              ref={bubbleRef}
              id={id}
              role="tooltip"
              className="ve-tooltip type-label"
              style={{ top: point.top, left: point.left }}
            >
              <span>{content}</span>
              {shortcut ? <span className="ve-tooltip-shortcut">{shortcut}</span> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
