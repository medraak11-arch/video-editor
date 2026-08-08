/* ---------------------------------------------------------------------------
   useShortcuts — PLAN §8.10. Mounted exactly once, in App.tsx.

   One `keydown` listener on `document`. It applies, in order:

     1. the focus guard, in two halves — an event inside a field never reaches a
        binding (the bug every NLE ships and this one does not), and Space or
        Enter on a focused button belongs to that button, because the browser
        fires its activation click from those keys and a preventDefault() here
        would silently swallow it;
     2. overlay gating — while the export dialog or the shortcut overlay is
        open, only `scope: 'dialog'` rows dispatch, so Ctrl+Z cannot reach the
        timeline through an open dialog;
     3. scope resolution by focus containment, from the nearest ancestor
        carrying `data-shortcut-scope`;
     4. repeat suppression for everything that is not explicitly repeatable.

   It never holds state and never re-renders anything: dispatch goes through
   `readStore()`.
--------------------------------------------------------------------------- */

import { useEffect } from 'react';
import { readStore } from '../state/store';
import { selectOverlayOpen } from '../state/uiSlice';
import { selectDeletableClipIds, selectTimelineDurationFrames } from '../state/timelineSlice';
import { secondStepFrames } from '../lib/time';
import { TRACK_HEAD_WIDTH, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../lib/constants';
import { openProject, saveProject } from './projectActions';
import {
  ACTIVATABLE_SELECTOR,
  ACTIVATION_COMBOS,
  REPEATABLE_SHORTCUTS,
  SHORTCUTS_BY_COMBO,
  TEXT_INPUT_SELECTOR,
  comboFromEvent,
  shortcutPlatform,
} from './shortcuts';
import type { ShortcutHandlerName } from './shortcuts';

/**
 * The lane viewport width `zoomToFit` needs. The timeline owns that element;
 * this reads it rather than duplicating the timeline's layout maths, and falls
 * back down a chain that always yields a usable width.
 */
function laneViewportWidth(): number {
  const lane = document.querySelector<HTMLElement>('[data-lane-viewport]');
  if (lane && lane.clientWidth > 0) return lane.clientWidth;

  const region = document.querySelector<HTMLElement>('[data-shortcut-scope="timeline"]');
  if (region && region.clientWidth > TRACK_HEAD_WIDTH) {
    return region.clientWidth - TRACK_HEAD_WIDTH;
  }
  return Math.max(1, window.innerWidth - TRACK_HEAD_WIDTH);
}

const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/**
 * A destructive edit unmounts the clip that has focus, and React drops focus to
 * `<body>` when it does: `activeScope()` then reads null and every timeline- and
 * media-scoped row goes dead until the user clicks something. The unmount is a
 * later task, so there is nothing to recover *after* the dispatch — the fix is to
 * move focus off the doomed node BEFORE the store mutates, exactly as
 * `MediaRail.handleRemove` hands focus to the neighbouring row.
 *
 * The neighbour is the nearest clip in DOM order that the edit is not about to
 * remove; failing that it is the lane viewport, which is `tabIndex={-1}` inside
 * `data-shortcut-scope="timeline"` and therefore keeps the scope alive even when
 * the timeline empties. `preventScroll` because `.tl-lanes` scroll is store-owned
 * (PLAN §8.6).
 */
function handOffFocusBeforeDelete(): void {
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
    '[data-clip-id]',
  );
  if (!focused) return; // focus is not on a clip: nothing is about to vanish under it

  // What the edit will really remove — a selection a track lock protects is
  // refused, and moving focus off a clip that is going to stay is a wart.
  const doomed = new Set(selectDeletableClipIds(readStore()));
  if (!doomed.has(focused.dataset.clipId ?? '')) return;

  const clips = [...document.querySelectorAll<HTMLElement>('[data-clip-id]')];
  const at = clips.indexOf(focused);
  const survives = (el: HTMLElement): boolean => !doomed.has(el.dataset.clipId ?? '');

  let next: HTMLElement | undefined;
  for (let i = at + 1; i < clips.length && !next; i += 1) if (survives(clips[i])) next = clips[i];
  for (let i = at - 1; i >= 0 && !next; i -= 1) if (survives(clips[i])) next = clips[i];

  (next ?? document.querySelector<HTMLElement>('[data-lane-viewport]'))?.focus({
    preventScroll: true,
  });
}

/** One entry per `ShortcutHandlerName`. The registry cannot name a handler that is missing. */
const HANDLERS: Record<ShortcutHandlerName, () => void> = {
  togglePlay: () => readStore().togglePlay(),
  shuttleBack: () => readStore().shuttle(-1),
  shuttleStop: () => readStore().shuttle(0),
  shuttleForward: () => readStore().shuttle(1),

  markIn: () => readStore().setInPoint(),
  markOut: () => readStore().setOutPoint(),

  stepBack: () => readStore().step(-1),
  stepForward: () => readStore().step(1),
  secondBack: () => {
    const s = readStore();
    s.step(-secondStepFrames(s.fps));
  },
  secondForward: () => {
    const s = readStore();
    s.step(secondStepFrames(s.fps));
  },
  goToStart: () => readStore().seek(0),
  goToEnd: () => {
    const s = readStore();
    // clipEnd is exclusive, so the duration frame itself has no content (PLAN §3.3).
    s.seek(Math.max(0, selectTimelineDurationFrames(s) - 1));
  },

  splitAtPlayhead: () => readStore().splitAtPlayhead(),
  lift: () => {
    handOffFocusBeforeDelete();
    readStore().deleteSelection();
  },
  rippleDelete: () => {
    handOffFocusBeforeDelete();
    readStore().rippleDelete();
  },
  addMarker: () => {
    readStore().addMarker();
  },
  // No branch and no guard here: the action itself decides whether there is
  // anything to detach and raises its own notice when there is not
  // (AUDIO-FEATURES §7.4, §1.5). Unlike lift/rippleDelete it destroys no DOM
  // node that could be holding focus, so no hand-off is needed.
  detachAudio: () => readStore().detachAudio(),
  // Same shape, same reason (docs/LINKING.md §7.1): each action decides whether
  // it has anything to do and raises its own notice when it does not, and neither
  // destroys a DOM node that could be holding focus.
  linkClips: () => readStore().linkClips(),
  unlinkClips: () => readStore().unlinkClips(),
  undo: () => readStore().undo(),
  redo: () => readStore().redo(),
  clearSelection: () => readStore().clearSelection(),

  zoomIn: () => {
    const s = readStore();
    s.setZoom(clampZoom(s.zoom * ZOOM_STEP));
  },
  zoomOut: () => {
    const s = readStore();
    s.setZoom(clampZoom(s.zoom / ZOOM_STEP));
  },
  zoomToFit: () => readStore().zoomToFit(laneViewportWidth()),

  importMedia: () => {
    void readStore().importFromPicker();
  },
  saveProject: () => {
    void saveProject();
  },
  openProject: () => {
    void openProject();
  },
  // Open only, never toggle: the dialog owns Escape (and its own Cancel), and a
  // second Ctrl+E cannot reach here anyway while an overlay is up.
  openExportDialog: () => readStore().setExportDialogOpen(true),

  toggleShortcutOverlay: () => {
    const s = readStore();
    s.setShortcutOverlayOpen(!s.shortcutOverlayOpen);
  },
};

/** The region scope that currently owns the keyboard, or null when focus is on <body>. */
function activeScope(): string | null {
  const el = document.activeElement as HTMLElement | null;
  return el?.closest('[data-shortcut-scope]')?.getAttribute('data-shortcut-scope') ?? null;
}

function isInTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(TEXT_INPUT_SELECTOR) !== null;
}

/**
 * True when the event's target is a control the browser activates from the
 * keyboard itself. Space's click is dispatched on keyup, so preventing the
 * keydown here would cancel it — the button would look dead and playback would
 * toggle instead.
 */
function isOnActivatableControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(ACTIVATABLE_SELECTOR) !== null;
}

export function useShortcuts(): void {
  useEffect(() => {
    const platform = shortcutPlatform();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;

      const combo = comboFromEvent(event, platform);
      if (!combo) return;

      const candidates = SHORTCUTS_BY_COMBO.get(combo);
      if (!candidates || candidates.length === 0) return;

      // Rung (b) of the Escape ladder, and the guard for every other key: a
      // field owns its own keystrokes. Escape inside a field reverts it there.
      if (isInTextInput(event.target)) return;

      // The other half of the guard. A focused button owns Space and Enter; we
      // return before preventDefault so the activation click still fires. The
      // outcome is the same where it matters — Space on the focused play button
      // presses the play button.
      if (ACTIVATION_COMBOS.has(combo) && isOnActivatableControl(event.target)) return;

      const state = readStore();
      const overlayOpen = selectOverlayOpen(state);
      const scope = activeScope();

      const def = candidates.find((candidate) => {
        if (overlayOpen) {
          // An overlay swallows the keyboard: only dialog-scope rows reach
          // through it, so Ctrl+Z cannot edit the timeline underneath an open
          // export dialog. The one exception is the help toggle itself while
          // the shortcut sheet is all that is open — `?` closes what `?`
          // opened, and it can reach nothing else.
          return (
            candidate.scope === 'dialog' ||
            (candidate.id === 'help.shortcuts' && !state.exportDialogOpen)
          );
        }
        return candidate.scope === 'global' || candidate.scope === scope;
      });
      if (!def) return;

      if (event.repeat && !REPEATABLE_SHORTCUTS.has(def.id)) return;

      event.preventDefault();
      HANDLERS[def.handler]();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
