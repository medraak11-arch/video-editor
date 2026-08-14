/* ---------------------------------------------------------------------------
   shortcuts.ts — PLAN §8.10. THE single source of truth for every binding.

   Tooltips, the timeline toolbar and the shortcut overlay all read this
   registry, so a label can never drift from its keys. Nothing in the app types
   a key string into a tooltip.

   A combo is normalised as `[Ctrl+][Shift+][Alt+]<Key>`, in that order.
   'Ctrl' is the platform accelerator: Cmd on darwin, Ctrl everywhere else —
   resolved at match time by `comboFromEvent` and at render time by
   `ShortcutHint`.
--------------------------------------------------------------------------- */

import { getEditorAPI } from '../lib/editorApi';

export type Platform = 'win32' | 'darwin' | 'linux';

export type ShortcutScope = 'global' | 'timeline' | 'preview' | 'media' | 'dialog';

export type ShortcutId =
  | 'play.toggle'
  | 'shuttle.back'
  | 'shuttle.stop'
  | 'shuttle.forward'
  | 'mark.in'
  | 'mark.out'
  | 'edit.split'
  | 'nav.stepBack'
  | 'nav.stepForward'
  | 'nav.secondBack'
  | 'nav.secondForward'
  | 'nav.start'
  | 'nav.end'
  | 'edit.lift'
  | 'edit.ripple'
  | 'edit.undo'
  | 'edit.redo'
  | 'file.import'
  | 'file.save'
  // Added by this slice, beyond the union printed in PLAN §8.10. Without it the
  // 'project:open' channel and the whole migrateProject guard path have no
  // entry point in the UI, and the slice spec requires open to work. Purely
  // additive: SHORTCUT_BY_ID stays total, so no consumer changes.
  | 'file.open'
  // Export is the one terminal action in the app and PRODUCT.md principle 3
  // makes the keyboard the primary instrument, so it cannot be menu-only.
  // Additive in the same way as 'file.open' above.
  | 'file.export'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomFit'
  | 'edit.marker'
  | 'edit.clearSelection'
  // AUDIO-FEATURES §7.4. The clip context menu renders <ShortcutHint
  // id="edit.detachAudio" />, which resolves through SHORTCUT_BY_ID and returns
  // null for an unknown id — so without this row the menu would silently
  // promise a key that does not exist.
  | 'edit.detachAudio'
  // docs/LINKING.md §7.1. The clip context menu renders <ShortcutHint> for both,
  // and the shortcut overlay lists them, so the two commands are discoverable
  // from the application rather than only from the README.
  | 'edit.link'
  | 'edit.unlink'
  // CREATIVE §5. The timeline toolbar button and the track context menu both
  // render <ShortcutHint id="edit.addTitle" />, and PRODUCT.md principle 3 puts
  // the binding on the control rather than in a help page — so the row has to
  // exist here for either of them to be able to teach it.
  | 'edit.addTitle'
  // CREATIVE §6.6. Subtitle authoring is a typing loop, so the one thing it
  // cannot afford is a reach for the mouse between every line. The row is here
  // for the same reason `edit.addTitle` is: the subtitles group renders
  // <ShortcutHint id="subtitle.addCue" />, and a key taught by a control it is
  // not registered against is the drift this file exists to prevent.
  | 'subtitle.addCue'
  // CREATIVE §12. The keyboard half of insert. The clip context menu renders
  // <ShortcutHint id="edit.insertAtPlayhead" />, so the row is what lets that
  // item teach its key instead of the key being folklore.
  | 'edit.insertAtPlayhead'
  | 'help.shortcuts';

/** The name of the function `useShortcuts` dispatches to. One per registry row. */
export type ShortcutHandlerName =
  | 'togglePlay'
  | 'shuttleBack'
  | 'shuttleStop'
  | 'shuttleForward'
  | 'markIn'
  | 'markOut'
  | 'splitAtPlayhead'
  | 'stepBack'
  | 'stepForward'
  | 'secondBack'
  | 'secondForward'
  | 'goToStart'
  | 'goToEnd'
  | 'lift'
  | 'rippleDelete'
  | 'undo'
  | 'redo'
  | 'importMedia'
  | 'saveProject'
  | 'openProject'
  | 'openExportDialog'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomToFit'
  | 'addMarker'
  | 'clearSelection'
  | 'detachAudio'
  | 'linkClips'
  | 'unlinkClips'
  | 'toggleShortcutOverlay';

export interface ShortcutDef {
  id: ShortcutId;
  /** Normalised combos, e.g. 'Space', 'Ctrl+Z', 'Shift+ArrowLeft'. */
  keys: string[];
  /** Sentence case, imperative: 'Split at playhead'. */
  label: string;
  scope: ShortcutScope;
  /**
   * ABSENT when the row's own REGION dispatches it instead of the global
   * table — see `edit.addTitle`.
   *
   * There is already one shape of this in the build: `onPlayheadKeyDown`
   * consumes `nav.stepBack` / `nav.stepForward` and calls `preventDefault` so
   * the global binding does not double-fire. The difference here is that the
   * region is the ONLY dispatcher, because the command needs state that the
   * global dispatcher deliberately does not read — which clip inside the
   * timeline holds focus.
   *
   * The registry still carries the row, and that is the point: it is what
   * `ShortcutHint` reads, so the toolbar button and the context-menu item teach
   * the key (PRODUCT.md principle 3), and it is what the shortcut overlay
   * lists. A key taught by a control it is not registered against is exactly
   * the drift this file exists to prevent.
   */
  handler?: ShortcutHandlerName;
}

/**
 * A row the GLOBAL listener dispatches. `SHORTCUTS_BY_COMBO` holds only these,
 * so `useShortcuts` reads a non-optional `handler` and the HANDLERS table stays
 * exhaustive over `ShortcutHandlerName` — a region-dispatched row cannot leave
 * a hole in it.
 */
export type DispatchableShortcutDef = ShortcutDef & { handler: ShortcutHandlerName };

/* ------------------------------------------------------------------ registry
   Scope is focus containment, not hover (PLAN §8.10): a non-global row fires
   only while focus sits inside the region whose container carries the matching
   `data-shortcut-scope`. Transport, navigation and file actions are global
   because they read state that belongs to no single region; the destructive
   and view-shaping edits are timeline-scoped so Delete in the media rail can
   never remove a clip from the timeline. */

export const SHORTCUTS: readonly ShortcutDef[] = [
  // --- transport ----------------------------------------------------------
  { id: 'play.toggle', keys: ['Space'], label: 'Play or pause', scope: 'global', handler: 'togglePlay' },
  { id: 'shuttle.back', keys: ['J'], label: 'Shuttle backward', scope: 'global', handler: 'shuttleBack' },
  { id: 'shuttle.stop', keys: ['K'], label: 'Stop shuttle', scope: 'global', handler: 'shuttleStop' },
  { id: 'shuttle.forward', keys: ['L'], label: 'Shuttle forward', scope: 'global', handler: 'shuttleForward' },

  // --- navigation ---------------------------------------------------------
  { id: 'nav.stepBack', keys: ['ArrowLeft'], label: 'Step back one frame', scope: 'global', handler: 'stepBack' },
  { id: 'nav.stepForward', keys: ['ArrowRight'], label: 'Step forward one frame', scope: 'global', handler: 'stepForward' },
  { id: 'nav.secondBack', keys: ['Shift+ArrowLeft'], label: 'Step back one second', scope: 'global', handler: 'secondBack' },
  { id: 'nav.secondForward', keys: ['Shift+ArrowRight'], label: 'Step forward one second', scope: 'global', handler: 'secondForward' },
  { id: 'nav.start', keys: ['Home'], label: 'Go to start', scope: 'global', handler: 'goToStart' },
  { id: 'nav.end', keys: ['End'], label: 'Go to end', scope: 'global', handler: 'goToEnd' },

  // --- marking ------------------------------------------------------------
  { id: 'mark.in', keys: ['I'], label: 'Mark in', scope: 'global', handler: 'markIn' },
  { id: 'mark.out', keys: ['O'], label: 'Mark out', scope: 'global', handler: 'markOut' },

  // --- editing ------------------------------------------------------------
  { id: 'edit.split', keys: ['S'], label: 'Split at playhead', scope: 'timeline', handler: 'splitAtPlayhead' },
  { id: 'edit.lift', keys: ['Delete'], label: 'Lift selection', scope: 'timeline', handler: 'lift' },
  { id: 'edit.ripple', keys: ['Shift+Delete'], label: 'Ripple delete selection', scope: 'timeline', handler: 'rippleDelete' },
  { id: 'edit.marker', keys: ['M'], label: 'Add marker at playhead', scope: 'timeline', handler: 'addMarker' },
  // Timeline-scoped like the other destructive-ish edits: Shift+D in the media
  // rail must never restructure the timeline. Not repeatable — see below.
  { id: 'edit.detachAudio', keys: ['Shift+D'], label: 'Detach audio', scope: 'timeline', handler: 'detachAudio' },
  // docs/LINKING.md §7. Ctrl+L is the Link binding in Premiere and in Final Cut,
  // and it is unclaimed here: the bare `L` that shuttles forward normalises to
  // the combo string 'L', which is not 'Ctrl+L', so the two can never match the
  // same event. Ctrl+Shift+L is the paired inverse, in the shape Ctrl+Z /
  // Ctrl+Shift+Z already establishes for an operation and its opposite.
  //
  // Timeline-scoped like every other structural edit: Ctrl+L with focus in the
  // media rail must not restructure the timeline. Neither is repeatable — holding
  // Ctrl+L must not mint a new LinkId sixty times a second.
  { id: 'edit.link', keys: ['Ctrl+L'], label: 'Link selected clips', scope: 'timeline', handler: 'linkClips' },
  { id: 'edit.unlink', keys: ['Ctrl+Shift+L'], label: 'Unlink selected clips', scope: 'timeline', handler: 'unlinkClips' },
  // CREATIVE §5. A bare `T`, not the Ctrl+T that Premiere uses for a new title:
  // Ctrl+T is "new tab" in Chromium and cannot be preventDefault-ed in the
  // browser fixture the timeline is developed against, so it would be a binding
  // that works only in the packaged app. `T` is unclaimed — the registry's other
  // alpha keys are J/K/L, I/O, S and M — and it is timeline-scoped like every
  // other structural edit, so `T` in a filename field or the media rail cannot
  // put a title on the timeline.
  //
  // NOT repeatable: holding T must not stack sixty titles at the playhead.
  //
  // DISPATCH: region, not global — it carries no `handler`, and the timeline
  // dispatches it from `useRegionShortcuts` on `.tl-root`. It is region-owned
  // because the target track is decided from which clip inside the timeline
  // holds focus, and focus WITHIN a region is the one thing the global
  // dispatcher deliberately does not read.
  { id: 'edit.addTitle', keys: ['T'], label: 'Add title at playhead', scope: 'timeline' },
  // CREATIVE §6.6. Region-dispatched, the second row to be (see `handler`).
  //
  // `C` for cue, and it is free: the registry's other alpha keys are J/K/L,
  // I/O, S, M and T, and `Ctrl+C` normalises to a different combo string, so
  // copy can never collide with it.
  //
  // Timeline-scoped rather than global because it reads the playhead and writes
  // a cue against it — that is a timeline act, and `C` typed into a filename
  // field or the media rail must not add one. NOT repeatable, and that one is
  // load-bearing: holding C must not lay sixty cues on one frame.
  { id: 'subtitle.addCue', keys: ['C'], label: 'Add subtitle cue at playhead', scope: 'timeline' },
  // CREATIVE §12. Region-dispatched, the third row to be.
  //
  // `V` is Avid's SPLICE-IN, which is this operation exactly — place the clip
  // here and push what follows to the right — and it is the closest convention
  // available. Premiere's insert is `,`, and `,` is spoken for: it is half of
  // the nudge pair, which stays an ordinary move on purpose (§12.2 spent a
  // section making sure the most casual key in the app cannot rearrange the
  // timeline). Final Cut's `W` was the other candidate; `V` wins on the term
  // matching the behaviour including the push. Premiere's own `V` is the
  // selection tool, which this app has no equivalent of, so no muscle memory is
  // being overwritten.
  //
  // NOT repeatable: holding V must not insert the selection over and over, each
  // time pushing the track further right.
  { id: 'edit.insertAtPlayhead', keys: ['V'], label: 'Insert selection at playhead', scope: 'timeline' },
  { id: 'edit.undo', keys: ['Ctrl+Z'], label: 'Undo', scope: 'global', handler: 'undo' },
  { id: 'edit.redo', keys: ['Ctrl+Shift+Z'], label: 'Redo', scope: 'global', handler: 'redo' },
  { id: 'edit.clearSelection', keys: ['Escape'], label: 'Clear selection', scope: 'global', handler: 'clearSelection' },

  // --- view ---------------------------------------------------------------
  { id: 'view.zoomIn', keys: ['+', '='], label: 'Zoom in', scope: 'timeline', handler: 'zoomIn' },
  { id: 'view.zoomOut', keys: ['-'], label: 'Zoom out', scope: 'timeline', handler: 'zoomOut' },
  { id: 'view.zoomFit', keys: ['Shift+Z'], label: 'Zoom to fit', scope: 'timeline', handler: 'zoomToFit' },

  // --- file ---------------------------------------------------------------
  { id: 'file.import', keys: ['Ctrl+I'], label: 'Import media', scope: 'global', handler: 'importMedia' },
  { id: 'file.save', keys: ['Ctrl+S'], label: 'Save project', scope: 'global', handler: 'saveProject' },
  { id: 'file.open', keys: ['Ctrl+O'], label: 'Open project', scope: 'global', handler: 'openProject' },
  // Global, not 'dialog': it opens the export dialog, it does not act inside it.
  // Once the dialog is up `selectOverlayOpen` gates every non-dialog row out, so
  // Ctrl+E cannot re-fire against an export that is already on screen.
  // 'Export', not 'Export video': the dialog now writes AAC, MP3 and WAV too
  // (AUDIO-FEATURES §2.4). The dialog's own title already reads 'Export'.
  { id: 'file.export', keys: ['Ctrl+E'], label: 'Export', scope: 'global', handler: 'openExportDialog' },

  // --- help ---------------------------------------------------------------
  { id: 'help.shortcuts', keys: ['?'], label: 'Show keyboard shortcuts', scope: 'global', handler: 'toggleShortcutOverlay' },
];

export const SHORTCUT_BY_ID: Record<ShortcutId, ShortcutDef> = SHORTCUTS.reduce(
  (acc, def) => {
    acc[def.id] = def;
    return acc;
  },
  {} as Record<ShortcutId, ShortcutDef>,
);

/** Every combo the registry binds AT ALL, mapped to the rows that claim it.
 *
 *  This is the map to reach for when the question is "is this combo taken" —
 *  a region-dispatched row claims its keys just as hard as a global one does,
 *  and a clash with `T` is a clash whether or not the global listener is the
 *  one that would have fired it. */
export const SHORTCUT_COMBOS: ReadonlyMap<string, readonly ShortcutDef[]> = (() => {
  const map = new Map<string, ShortcutDef[]>();
  for (const def of SHORTCUTS) {
    for (const combo of def.keys) {
      const list = map.get(combo);
      if (list) list.push(def);
      else map.set(combo, [def]);
    }
  }
  return map;
})();

/**
 * The GLOBAL listener's dispatch table: the same map, restricted to the rows
 * that name a handler. A region-dispatched row is absent on purpose — its
 * region has already consumed the keystroke and called `preventDefault`, so
 * listing it here would be a second dispatcher for one command.
 */
export const SHORTCUTS_BY_COMBO: ReadonlyMap<string, readonly DispatchableShortcutDef[]> = (() => {
  const map = new Map<string, DispatchableShortcutDef[]>();
  for (const def of SHORTCUTS) {
    if (def.handler === undefined) continue;
    const dispatchable = def as DispatchableShortcutDef;
    for (const combo of def.keys) {
      const list = map.get(combo);
      if (list) list.push(dispatchable);
      else map.set(combo, [dispatchable]);
    }
  }
  return map;
})();

/** Overlay section order and copy. Sentence case, like everything else. */
export const SCOPE_ORDER: readonly ShortcutScope[] = [
  'global',
  'timeline',
  'preview',
  'media',
  'dialog',
];

export const SCOPE_LABEL: Record<ShortcutScope, string> = {
  global: 'Anywhere',
  timeline: 'Timeline',
  preview: 'Preview',
  media: 'Media',
  dialog: 'Dialogs',
};

/**
 * Rows that may repeat while the key is held. Everything else ignores
 * `event.repeat`, so holding J does not escalate the shuttle to 8× and holding
 * Delete does not eat the timeline.
 */
export const REPEATABLE_SHORTCUTS: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  'nav.stepBack',
  'nav.stepForward',
  'nav.secondBack',
  'nav.secondForward',
  'view.zoomIn',
  'view.zoomOut',
]);

/**
 * PLAN §5's keyboard-guard contract, stated once. Every scaffold field sets
 * `data-editor-text-input`; the first three cover any native control a slice
 * introduces. This is the single line that stops "pressing S in a filename
 * field splits the clip".
 */
export const TEXT_INPUT_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-editor-text-input="true"]';

/**
 * The second half of the guard. A field owns its keystrokes; a *button* owns
 * Space and Enter, because the browser dispatches its activation click from
 * those keys and `preventDefault()` on the keydown silently suppresses it.
 * Without this, Space on a focused IconButton toggles playback instead of
 * pressing the button — PRODUCT.md makes keyboard operability a correctness
 * requirement, and Space is the primary activation key on every button.
 *
 * Kept beside TEXT_INPUT_SELECTOR so both halves of the guard have one home.
 */
export const ACTIVATABLE_SELECTOR =
  'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [role="tab"], a[href], summary';

/** The combos a focused activatable control claims for itself. */
export const ACTIVATION_COMBOS: ReadonlySet<string> = new Set<string>(['Space', 'Enter']);

/* ---------------------------------------------------------------- matching */

export function shortcutPlatform(): Platform {
  return getEditorAPI().platform;
}

const isAlpha = (s: string): boolean => s.length === 1 && s >= 'A' && s <= 'Z';

/**
 * Normalises a keydown into a registry combo, or null when the event carries no
 * usable key (a bare modifier, a dead key, an IME candidate).
 *
 * Shift is only part of the combo for alphabetic and named keys. On a printable
 * symbol the shift key is what *produced* the character — '?' is '?', not
 * 'Shift+?' — which is why the help binding can be a plain '?'.
 */
export function comboFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  platform: Platform,
): string | null {
  const raw = event.key;
  if (!raw || raw === 'Dead' || raw === 'Unidentified') return null;
  if (raw === 'Control' || raw === 'Shift' || raw === 'Alt' || raw === 'Meta') return null;

  let base: string;
  if (raw === ' ' || raw === 'Spacebar') base = 'Space';
  else if (raw.length === 1) base = raw.toUpperCase();
  else base = raw;

  const accelerator = platform === 'darwin' ? event.metaKey : event.ctrlKey;
  const named = base.length > 1;
  const parts: string[] = [];
  if (accelerator) parts.push('Ctrl');
  if (event.shiftKey && (isAlpha(base) || named)) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(base);
  return parts.join('+');
}

/* ---------------------------------------------------------------- display */

const DARWIN_MODIFIER: Record<string, string> = {
  Ctrl: '⌘',
  Shift: '⇧',
  Alt: '⌥',
};

const KEY_GLYPH: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Delete: 'Del',
  Escape: 'Esc',
};

/** Spoken names, so a hint reads sensibly when it is announced. */
const KEY_SPOKEN: Record<string, string> = {
  ArrowLeft: 'Left arrow',
  ArrowRight: 'Right arrow',
  ArrowUp: 'Up arrow',
  ArrowDown: 'Down arrow',
  Delete: 'Delete',
  Escape: 'Escape',
  Space: 'Space',
};

/** The platform-correct tokens for one combo, e.g. ['⌘', '⇧', 'Z'] on darwin. */
export function comboTokens(combo: string, platform: Platform): string[] {
  return combo.split('+').map((part) => {
    if (part in DARWIN_MODIFIER) {
      return platform === 'darwin' ? (DARWIN_MODIFIER[part] as string) : part;
    }
    return KEY_GLYPH[part] ?? part;
  });
}

/** The same combo as words, for assistive technology. */
export function comboSpoken(combo: string, platform: Platform): string {
  return combo
    .split('+')
    .map((part) => {
      if (part === 'Ctrl') return platform === 'darwin' ? 'Command' : 'Control';
      if (part === 'Alt') return platform === 'darwin' ? 'Option' : 'Alt';
      return KEY_SPOKEN[part] ?? part;
    })
    .join(' plus ');
}
