/* ---------------------------------------------------------------------------
   useRegionShortcuts — the REGION half of the dispatch model.

   `shortcuts.ts` allows a row to carry no `handler`, meaning its own region
   dispatches it instead of the global table in `useShortcuts`. This is the
   thing that does that dispatching for the timeline, and it exists so the two
   region rows so far — `edit.addTitle` and `subtitle.addCue` — are not each
   hand-rolled into whichever keydown handler happened to be nearby. The first
   of them lived in `onLaneKeyDown`, which quietly meant it only worked while
   focus was inside the lane viewport: pressing T with focus on a track head or
   the toolbar did nothing, even though the row is scoped to the whole timeline.

   IT MIRRORS `useShortcuts`'S GUARD STACK, in the same order, from the same
   exported primitives — not a reimplementation of them. A region row that
   skipped the text-input guard would put a title on the timeline when the user
   typed "t" into a clip's name field, which is the single bug PLAN §5's guard
   exists to prevent, and it must not come back through a side door.

   SCOPE IS STRUCTURAL HERE, which is the one place this differs from the global
   listener. `useShortcuts` resolves scope by walking up from `document.
   activeElement` to the nearest `data-shortcut-scope`. This listener is bound
   ON the region, so an event that reaches it is inside the region by
   construction — containment is the DOM, not a lookup. That is strictly
   stronger, and it is why there is no scope check below.

   The listener is NATIVE and bound to `.tl-root`, deliberately. React attaches
   its handlers at the root container and `useShortcuts` listens on `document`,
   both of which are ancestors, so a native listener here runs first during the
   bubble and its `preventDefault` is visible to both — which is what stops one
   keystroke being dispatched twice.
--------------------------------------------------------------------------- */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { readStore } from '../../state/store';
import { selectOverlayOpen } from '../../state/uiSlice';
import {
  ACTIVATABLE_SELECTOR,
  ACTIVATION_COMBOS,
  REPEATABLE_SHORTCUTS,
  SHORTCUTS,
  TEXT_INPUT_SELECTOR,
  comboFromEvent,
  shortcutPlatform,
} from '../../keyboard/shortcuts';
import type { ShortcutDef, ShortcutId } from '../../keyboard/shortcuts';

/**
 * The rows this region dispatches. Listed rather than derived so the dispatcher
 * map below can be `Record<RegionShortcutId, …>` and therefore EXHAUSTIVE — the
 * same guarantee `HANDLERS` gives the global table. A registry row that names
 * no handler and no dispatcher would otherwise be a key that is taught on a
 * control, listed in the overlay, and does nothing.
 */
export const REGION_SHORTCUT_IDS = [
  'edit.addTitle',
  'subtitle.addCue',
  'edit.insertAtPlayhead',
] as const satisfies readonly ShortcutId[];

export type RegionShortcutId = (typeof REGION_SHORTCUT_IDS)[number];

/** One entry per `RegionShortcutId`. `tsc` enumerates a missing one. */
export type RegionDispatchers = Record<RegionShortcutId, () => void>;

const isInTextInput = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(TEXT_INPUT_SELECTOR) !== null;

const isOnActivatableControl = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(ACTIVATABLE_SELECTOR) !== null;

export function useRegionShortcuts(
  rootRef: RefObject<HTMLElement | null>,
  dispatchers: RegionDispatchers,
): void {
  // Held in a ref so a caller passing a fresh object every render — which
  // Timeline does, because the dispatchers are module functions in a literal —
  // does not tear the listener down and rebind it on every render.
  const latest = useRef(dispatchers);
  latest.current = dispatchers;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const platform = shortcutPlatform();

    // Built from the REGISTRY, not from a second list of keys: `C` and `T` are
    // written down once, in `shortcuts.ts`, and this reads them back. A binding
    // typed a second time here is the drift that file exists to prevent.
    const byCombo = new Map<string, ShortcutDef>();
    for (const def of SHORTCUTS) {
      if (def.handler !== undefined) continue;
      if (def.scope !== 'timeline') continue;
      for (const combo of def.keys) byCombo.set(combo, def);
    }

    if (import.meta.env.DEV) {
      const covered = new Set<string>(REGION_SHORTCUT_IDS);
      for (const def of byCombo.values()) {
        if (!covered.has(def.id)) {
          throw new Error(
            `useRegionShortcuts: '${def.id}' names no handler and no region dispatcher, ` +
              `so its keys (${def.keys.join(', ')}) are taught but dead. ` +
              `Add it to REGION_SHORTCUT_IDS.`,
          );
        }
      }
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      // Same first gate as the global listener: a gesture that already consumed
      // Escape, or an IME mid-composition, owns the keystroke.
      if (event.defaultPrevented || event.isComposing) return;

      const combo = comboFromEvent(event, platform);
      if (!combo) return;

      const def = byCombo.get(combo);
      if (!def) return;

      // A field owns its own keystrokes — PLAN §5's single line, applied here
      // too. Without it, `C` typed into a clip's name field would add a cue.
      if (isInTextInput(event.target)) return;

      // The other half of the guard. A focused button owns Space and Enter,
      // because the browser dispatches its activation click from those keys.
      // Neither region row binds one today; the check is here because the table
      // is generic and the next row might.
      if (ACTIVATION_COMBOS.has(combo) && isOnActivatableControl(event.target)) return;

      // An overlay swallows the keyboard. No region row is `scope: 'dialog'`, so
      // an open export dialog or shortcut sheet gates all of them out — the same
      // outcome the global listener reaches through its own `overlayOpen` branch.
      if (selectOverlayOpen(readStore())) return;

      // Repeat suppression. `subtitle.addCue` and `edit.addTitle` are both
      // absent from REPEATABLE_SHORTCUTS, so holding the key lays exactly one
      // cue and one title — structurally, out of the registry, rather than by a
      // guard written at the call site and forgotten at the next one.
      if (event.repeat && !REPEATABLE_SHORTCUTS.has(def.id)) return;

      // Resolved BEFORE `preventDefault`, so a row with no dispatcher falls
      // through to whatever else would have handled the key instead of being
      // swallowed by a listener that then throws. The DEV assertion above turns
      // that case into a loud failure during development; this is what keeps it
      // survivable in a build where the assertion is compiled out.
      const dispatch = latest.current[def.id as RegionShortcutId];
      if (typeof dispatch !== 'function') return;

      event.preventDefault();
      dispatch();
    };

    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [rootRef]);
}
