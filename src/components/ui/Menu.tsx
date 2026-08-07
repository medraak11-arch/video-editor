/* ---------------------------------------------------------------------------
   Menu — PLAN §5. The titlebar overflow and any context menu.

   Popover shadow (menus really have left the plane), roving tabindex, Escape
   closes and stops propagation so it never also clears the timeline selection
   (rung a of PLAN §8.10's ladder).

   MenuItem ships all seven states too. `checked` renders a Check icon in the
   leading icon slot — never a colour change, so it survives deuteranopia and
   does not spend accent.
--------------------------------------------------------------------------- */

import './ui.css';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';

export type MenuItem =
  | {
      kind: 'item';
      id: string;
      label: string;
      icon?: ReactNode;
      shortcut?: ReactNode;
      checked?: boolean;
      disabled?: boolean;
      disabledReason?: string;
      onSelect(): void;
    }
  | { kind: 'submenu'; id: string; label: string; items: MenuItem[] }
  | { kind: 'separator'; id: string }
  | { kind: 'label'; id: string; label: string };

export interface MenuProps {
  trigger: ReactElement;
  items: MenuItem[];
  align?: 'start' | 'end';
}

const GAP = 4;

const isFocusable = (item: MenuItem): boolean => item.kind === 'item' || item.kind === 'submenu';

/** `restoreFocus: false` for a dismissal that is itself a focus move. */
export interface MenuCloseOptions {
  restoreFocus?: boolean;
}

interface ListProps {
  items: MenuItem[];
  top: number;
  left: number;
  onClose(options?: MenuCloseOptions): void;
  align: 'start' | 'end';
  /** The trigger. Focus landing back on it is a click that will toggle us shut. */
  anchorRef?: RefObject<HTMLElement | null>;
}

function MenuList({ items, top, left, onClose, align, anchorRef }: ListProps): ReactElement {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(() => items.findIndex(isFocusable));
  const [openSub, setOpenSub] = useState<{ id: string; top: number; left: number } | null>(null);
  const [point, setPoint] = useState({ top, left });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 4;
    const nextLeft = Math.min(
      Math.max(margin, align === 'end' ? left - rect.width : left),
      window.innerWidth - rect.width - margin,
    );
    const nextTop = Math.min(Math.max(margin, top), window.innerHeight - rect.height - margin);
    setPoint({ top: nextTop, left: nextLeft });
  }, [top, left, align, items]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`);
    target?.focus();
  }, [focusIndex]);

  const move = useCallback(
    (delta: number) => {
      setFocusIndex((current) => {
        const n = items.length;
        for (let step = 1; step <= n; step += 1) {
          const next = (current + delta * step + n * n) % n;
          if (isFocusable(items[next])) return next;
        }
        return current;
      });
    },
    [items],
  );

  return (
    <div
      ref={listRef}
      role="menu"
      className="ve-menu"
      style={{ top: point.top, left: point.left }}
      /* Escape is the primary dismissal, but it is a keydown on this container
         and so only reaches us while focus is inside. Tab moves focus out of a
         portaled menu without the browser telling anyone, which used to leave
         the popover on screen and unclosable. Focus leaving the subtree is a
         dismissal too — without restoring focus, because the whole point is
         that focus has already gone somewhere the user chose. */
      onBlur={(event) => {
        const next = event.relatedTarget as Element | null;
        if (next) {
          if (next.closest('.ve-menu')) return;
          // Landing on the trigger means a click that is about to toggle us
          // shut; closing here would let that toggle re-open the menu.
          if (anchorRef?.current?.contains(next)) return;
        }
        onClose({ restoreFocus: false });
      }}
      onKeyDown={(event) => {
        // A submenu is portaled to <body> but is still this list's React child,
        // so its key events bubble here. Without this the roving index of BOTH
        // lists moves on one ArrowDown and focus lands back in the parent.
        if ((event.target as Element).closest('.ve-menu') !== listRef.current) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          setFocusIndex(items.findIndex(isFocusable));
        } else if (event.key === 'End') {
          event.preventDefault();
          setFocusIndex(items.length - 1 - [...items].reverse().findIndex(isFocusable));
        }
      }}
    >
      {items.map((item, index) => {
        if (item.kind === 'separator') {
          return <div key={item.id} className="ve-menu-separator" role="separator" />;
        }
        if (item.kind === 'label') {
          return (
            <div key={item.id} className="ve-menu-label type-label">
              {item.label}
            </div>
          );
        }
        if (item.kind === 'submenu') {
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="ve-menu-item"
              data-index={index}
              tabIndex={focusIndex === index ? 0 : -1}
              aria-haspopup="menu"
              aria-expanded={openSub?.id === item.id}
              onFocus={() => setFocusIndex(index)}
              onPointerEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setOpenSub({ id: item.id, top: rect.top, left: rect.right + GAP });
              }}
              onKeyDown={(event) => {
                // Same portal boundary: an Enter on an item INSIDE the submenu
                // bubbles to this button, and preventDefault here would swallow
                // the activation of the item the user actually chose.
                if (event.target !== event.currentTarget) return;
                if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setOpenSub({ id: item.id, top: rect.top, left: rect.right + GAP });
                }
              }}
            >
              <span className="ve-menu-item-lead" aria-hidden="true" />
              <span className="ve-menu-item-label">{item.label}</span>
              <span className="ve-menu-item-shortcut ve-icon-slot" aria-hidden="true">
                <ChevronRight size={14} strokeWidth={1.75} />
              </span>
              {openSub?.id === item.id
                ? createPortal(
                    <MenuList
                      items={item.items}
                      top={openSub.top}
                      left={openSub.left}
                      align="start"
                      onClose={onClose}
                    />,
                    document.body,
                  )
                : null}
            </button>
          );
        }

        const disabled = item.disabled === true;
        return (
          <button
            key={item.id}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            aria-disabled={disabled || undefined}
            title={disabled ? item.disabledReason : undefined}
            className="ve-menu-item"
            data-index={index}
            data-disabled={disabled || undefined}
            tabIndex={focusIndex === index ? 0 : -1}
            onFocus={() => setFocusIndex(index)}
            onPointerEnter={() => setOpenSub(null)}
            onClick={() => {
              if (disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            <span className="ve-menu-item-lead" aria-hidden="true">
              {item.checked ? (
                <Check size={14} strokeWidth={1.75} />
              ) : (
                (item.icon ?? null)
              )}
            </span>
            <span className="ve-menu-item-label">{item.label}</span>
            {item.shortcut ? (
              <span className="ve-menu-item-shortcut type-label">{item.shortcut}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function Menu({ trigger, items, align = 'start' }: MenuProps): ReactElement {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  const close = useCallback((options?: MenuCloseOptions) => {
    setOpen(false);
    if (options?.restoreFocus === false) return;
    anchorRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (anchorRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.ve-menu')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  if (!isValidElement(trigger)) return trigger;

  const triggerProps = trigger.props as Record<string, unknown>;

  const clone = cloneElement(trigger as ReactElement<Record<string, unknown>>, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    onClick: (event: unknown) => {
      const handler = triggerProps.onClick;
      if (typeof handler === 'function') (handler as (e: unknown) => void)(event);
      const node = anchorRef.current;
      if (node) {
        const rect = node.getBoundingClientRect();
        setAnchor({ top: rect.bottom + GAP, left: align === 'end' ? rect.right : rect.left });
      }
      setOpen((v) => !v);
    },
  });

  return (
    <>
      {clone}
      {open
        ? createPortal(
            <MenuList
              items={items}
              top={anchor.top}
              left={anchor.left}
              align={align}
              anchorRef={anchorRef}
              onClose={close}
            />,
            document.body,
          )
        : null}
    </>
  );
}
