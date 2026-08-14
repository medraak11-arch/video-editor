/* ---------------------------------------------------------------------------
   uiSlice.ts — OWNER: shell. PLAN §3.1.

   Theme, panel geometry, project identity, the transient overlay flags, and the
   app's single notice slot.

   Persistence (PLAN §3.1): exactly five fields reach localStorage under
   LS_UI_KEY — theme, railWidth, railCollapsed, timelineHeightPct,
   inspectorGroups. `inspectorPinned`, `notice` and both dialog flags are
   session-only. Reading is total: a corrupt, partial or hostile blob can never
   prevent boot, because every field is range-checked individually and any field
   that fails falls back to its default on its own.

   The debounced writer lives in src/components/shell/useUiPersistence.ts —
   this module must not import the store (store.ts imports this file).
--------------------------------------------------------------------------- */

import type { RecoveryOffer } from '../types/api';
import type { CueId, ProjectFile } from '../types/model';
import type { SliceCreator, StoreState } from './types';
import {
  LS_UI_KEY,
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  TIMELINE_DEFAULT_PCT,
  TIMELINE_MAX_PCT,
  TIMELINE_MIN_PCT,
} from '../lib/constants';

export type ThemeName = 'signal' | 'instrument' | 'daylight';

/** Ordered for the titlebar Theme submenu. `signal` is the committed default. */
export const THEME_NAMES = ['signal', 'instrument', 'daylight'] as const;

/** Sentence case, per DESIGN.md's Sentence Case Rule. */
export const THEME_LABELS: Record<ThemeName, string> = {
  signal: 'Signal',
  instrument: 'Instrument',
  daylight: 'Daylight',
};

/** Collapsible groups in the inspector. Persisted. See PLAN §8.15, CREATIVE §2–§6. */
export type InspectorGroupId =
  | 'project'
  | 'transform'
  | 'blend'
  | 'timeAndSound'
  | 'grade'
  | 'effects'
  | 'transitions'
  | 'title'
  | 'subtitles';

export const INSPECTOR_GROUP_IDS = [
  'project',
  'transform',
  'blend',
  'timeAndSound',
  'grade',
  'effects',
  'transitions',
  'title',
  'subtitles',
] as const;

/** The app's single notification channel. One at a time, never stacked. */
export interface Notice {
  tone: 'danger' | 'warning';
  /** Two or three words, sentence case: 'Save failed'. */
  title: string;
  /** One sentence, sentence case, no trailing period. */
  message: string;
}

export interface UiState {
  theme: ThemeName;
  /** Media rail width in px, RAIL_MIN..RAIL_MAX. Retained while collapsed. */
  railWidth: number;
  railCollapsed: boolean;
  /** Timeline region as a fraction of the area under the titlebar. TIMELINE_MIN..MAX. */
  timelineHeightPct: number;
  /** Keeps the inspector mounted with an empty selection so project format can be corrected. */
  inspectorPinned: boolean;
  /** true = open. Persisted. Defaults: transform open, everything else closed. */
  inspectorGroups: Record<InspectorGroupId, boolean>;
  /** Project identity — the titlebar reads these; the keyboard layer writes them. */
  projectName: string;
  projectPath: string | null;
  isDirty: boolean;
  /** Transient overlays. Owned here so any slice can open them without prop drilling. */
  exportDialogOpen: boolean;
  shortcutOverlayOpen: boolean;
  /** The titlebar notice slot. null = nothing to say. */
  notice: Notice | null;
  /**
   * CREATIVE §6.6. The cue whose text field is being ASKED to take focus, or
   * null when nothing is pending. A REQUEST, not a record of where focus is —
   * the DOM owns that, and this field never tries to mirror it.
   *
   * It lives on the UI slice, not in `TimelineDoc`, and that placement is the
   * whole point: history snapshots `TimelineDoc`, and a focus request is not an
   * undoable edit. In the doc, Ctrl+Z would start moving the caret — the user
   * asks for their last typing back and gets a jumping text cursor instead.
   * Session-only for the same reason it is not persisted (see `PersistedUi`):
   * a caret position is not worth restoring across a relaunch.
   *
   * PROTOCOL, and both halves are load-bearing:
   *  · Producer (`C`, timeline) calls `requestCueFocus` and never clears.
   *  · CONSUMER (the inspector row) clears with `clearCueFocus` the moment it
   *    takes focus. Clearing is the consumer's job because only the consumer
   *    knows the focus actually landed — a producer that cleared on a timer
   *    would race a row that had not mounted yet.
   *
   * The consumer clearing on focus is also what stops a stale value re-stealing
   * focus on the next unrelated render: the steady state is null, so a row that
   * re-renders for any other reason matches nothing and does not touch the DOM.
   * There is deliberately no "most recently focused cue" retained anywhere.
   */
  focusCueId: CueId | null;
  /* ---- autosave status (SAFETY.md §3). Session-only, never persisted. ---- */
  /** Date.now() of the last successful snapshot, or null if none this session. */
  autosaveAt: number | null;
  /** Consecutive autosave failures. 0 = healthy. Drives the §2.9 escalation. */
  autosaveFailures: number;
  /** The launch-time recovery offer, or null once answered. */
  recovery: RecoveryOffer | null;
}

export interface UiActions {
  setTheme(theme: ThemeName): void;
  /** Clamps to RAIL_MIN..RAIL_MAX. */
  setRailWidth(px: number): void;
  setRailCollapsed(collapsed: boolean): void;
  toggleRail(): void;
  /** Clamps to TIMELINE_MIN..MAX_PCT. */
  setTimelineHeightPct(pct: number): void;
  setInspectorPinned(pinned: boolean): void;
  setInspectorGroup(id: InspectorGroupId, open: boolean): void;
  setProjectName(name: string): void;
  setProjectPath(path: string | null): void;
  markDirty(): void;
  markSaved(): void;
  setExportDialogOpen(open: boolean): void;
  setShortcutOverlayOpen(open: boolean): void;
  /** Replaces whatever notice is showing. Any slice may call it. */
  setNotice(n: Notice | null): void;
  /**
   * CREATIVE §6.6. Ask the row for `id` to focus its text field. One-way: this
   * only ever SETS. Explicitly NOT dirty and explicitly not undoable — asking
   * for a caret is not a change to the project.
   */
  requestCueFocus(id: CueId): void;
  /**
   * Release the pending request. THE CONSUMER calls this, immediately on taking
   * focus — see `focusCueId`. Idempotent, and a no-op when nothing is pending,
   * so a row that clears defensively costs nothing.
   */
  clearCueFocus(): void;
  /* ---- autosave status. All four are explicitly NOT dirty (PLAN §3.1). ---- */
  /** Sets autosaveAt and resets autosaveFailures to 0. */
  noteAutosaveWritten(at: number): void;
  /** Increments autosaveFailures. NEVER raises the notice itself — that is §2.9's caller. */
  noteAutosaveFailed(): void;
  setRecoveryOffer(offer: RecoveryOffer): void;
  clearRecoveryOffer(): void;
  /** Called by applyProject. */
  hydrateUi(p: Pick<ProjectFile, 'name'>): void;
}

export type UiSlice = UiState & UiActions;

/**
 * The seed encodes one rule: the group carrying the selection's PRIMARY editing
 * surface starts open, everything else starts closed. PRODUCT principle 2 — the
 * default screen shows only the editing loop — and five more groups opened on
 * first selection is precisely the Resolve/Avid wall-of-controls the
 * anti-references name.
 *
 * `title` is the one CREATIVE group that ships open, and it is not an
 * inconsistency: a title clip's primary surface is its TEXT, which has no other
 * route in the UI. A collapsed `title` group means selecting a title card shows
 * nothing about the title. `grade`, `effects`, `transitions` and `subtitles` all
 * refine something already visible, so they wait to be asked for.
 *
 * This is a SEED, not a policy: the record is persisted, so whatever the user
 * opens stays open.
 */
export const INITIAL_INSPECTOR_GROUPS: Record<InspectorGroupId, boolean> = {
  project: true,
  transform: true,
  blend: false,
  timeAndSound: false,
  grade: false,
  effects: false,
  transitions: false,
  title: true,
  subtitles: false,
};

/* ----------------------------------------------------------- persistence */

/** The exact shape written to localStorage. Nothing else is persisted. */
export interface PersistedUi {
  theme: ThemeName;
  railWidth: number;
  railCollapsed: boolean;
  timelineHeightPct: number;
  inspectorGroups: Record<InspectorGroupId, boolean>;
}

const defaultPersistedUi = (): PersistedUi => ({
  theme: 'signal',
  railWidth: RAIL_DEFAULT,
  railCollapsed: false,
  timelineHeightPct: TIMELINE_DEFAULT_PCT,
  inspectorGroups: { ...INITIAL_INSPECTOR_GROUPS },
});

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

const isThemeName = (v: unknown): v is ThemeName =>
  typeof v === 'string' && (THEME_NAMES as readonly string[]).includes(v);

/** Returns the value only when it is a real, finite number inside the range. */
const inRange = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

/**
 * Reads the persisted view state. Never throws, never returns a partial object:
 * every field either validates or falls back to its own default, so a blob that
 * is corrupt in one field still restores the other four.
 */
export function readPersistedUi(): PersistedUi {
  const out = defaultPersistedUi();

  let raw: string | null = null;
  try {
    raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LS_UI_KEY);
  } catch {
    return out; // storage disabled (private mode, blocked origin) — defaults are fine
  }
  if (!raw) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;

  const blob = parsed as Record<string, unknown>;

  if (isThemeName(blob.theme)) out.theme = blob.theme;

  const width = inRange(blob.railWidth, RAIL_MIN, RAIL_MAX);
  if (width !== null) out.railWidth = Math.round(width);

  if (typeof blob.railCollapsed === 'boolean') out.railCollapsed = blob.railCollapsed;

  const pct = inRange(blob.timelineHeightPct, TIMELINE_MIN_PCT, TIMELINE_MAX_PCT);
  if (pct !== null) out.timelineHeightPct = pct;

  const groups = blob.inspectorGroups;
  if (typeof groups === 'object' && groups !== null && !Array.isArray(groups)) {
    const record = groups as Record<string, unknown>;
    for (const id of INSPECTOR_GROUP_IDS) {
      const value = record[id];
      if (typeof value === 'boolean') out.inspectorGroups[id] = value;
    }
  }

  return out;
}

/** Best effort. A full quota is not a reason to interrupt an edit. */
export function writePersistedUi(next: PersistedUi): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LS_UI_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable or full — panel geometry is not worth failing a session over */
  }
}

/* ----------------------------------------------------------------- slice */

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => {
  const persisted = readPersistedUi();

  return {
    theme: persisted.theme,
    railWidth: persisted.railWidth,
    railCollapsed: persisted.railCollapsed,
    timelineHeightPct: persisted.timelineHeightPct,
    inspectorPinned: false,
    inspectorGroups: { ...persisted.inspectorGroups },
    projectName: 'Untitled',
    projectPath: null,
    isDirty: false,
    exportDialogOpen: false,
    shortcutOverlayOpen: false,
    notice: null,
    focusCueId: null,
    autosaveAt: null,
    autosaveFailures: 0,
    recovery: null,

    setTheme: (theme) => {
      if (get().theme === theme) return;
      set({ theme });
    },

    setRailWidth: (px) => {
      const next = clamp(Math.round(px), RAIL_MIN, RAIL_MAX);
      if (get().railWidth === next) return;
      set({ railWidth: next });
    },

    setRailCollapsed: (railCollapsed) => {
      if (get().railCollapsed === railCollapsed) return;
      set({ railCollapsed });
    },

    toggleRail: () => set({ railCollapsed: !get().railCollapsed }),

    setTimelineHeightPct: (pct) => {
      const next = clamp(pct, TIMELINE_MIN_PCT, TIMELINE_MAX_PCT);
      if (get().timelineHeightPct === next) return;
      set({ timelineHeightPct: next });
    },

    setInspectorPinned: (inspectorPinned) => {
      if (get().inspectorPinned === inspectorPinned) return;
      set({ inspectorPinned });
    },

    setInspectorGroup: (id, open) => {
      const current = get().inspectorGroups;
      if (current[id] === open) return;
      const inspectorGroups: Record<InspectorGroupId, boolean> = { ...current };
      inspectorGroups[id] = open;
      set({ inspectorGroups });
    },

    setProjectName: (name) => {
      if (get().projectName === name) return;
      set({ projectName: name });
      get().markDirty();
    },

    setProjectPath: (projectPath) => {
      if (get().projectPath === projectPath) return;
      set({ projectPath });
    },

    // Panel resize, zoom, scroll, selection and setTheme are explicitly NOT dirty
    // (PLAN §3.1) — scrolling the timeline must never light the unsaved dot.
    markDirty: () => {
      if (get().isDirty) return;
      set({ isDirty: true });
    },

    markSaved: () => {
      if (!get().isDirty) return;
      set({ isDirty: false });
    },

    setExportDialogOpen: (exportDialogOpen) => {
      if (get().exportDialogOpen === exportDialogOpen) return;
      set({ exportDialogOpen });
    },

    setShortcutOverlayOpen: (shortcutOverlayOpen) => {
      if (get().shortcutOverlayOpen === shortcutOverlayOpen) return;
      set({ shortcutOverlayOpen });
    },

    setNotice: (notice) => set({ notice }),

    // NO equality early-return, unlike every other setter in this file. Those
    // guard a value; this carries a request, and a request that collapses
    // because it names the cue the field already holds is a request that
    // silently does nothing. The guard would only ever fire when the consumer
    // failed to clear, which is exactly the case that must stay recoverable.
    //
    // Not on the markDirty caller list (PLAN §3.1): asking for a caret is not an
    // edit, and lighting the unsaved dot for one would be a lie about the file.
    requestCueFocus: (id) => set({ focusCueId: id }),

    // The guard here is real: this runs on every row that takes focus, and
    // writing null over null would notify every subscriber for nothing.
    clearCueFocus: () => {
      if (get().focusCueId === null) return;
      set({ focusCueId: null });
    },

    // Writing a snapshot is not saving: none of these four touches isDirty,
    // projectPath or projectName, and none is on the markDirty caller list
    // (PLAN §3.1, SAFETY §2.10).
    noteAutosaveWritten: (at) => {
      if (get().autosaveAt === at && get().autosaveFailures === 0) return;
      set({ autosaveAt: at, autosaveFailures: 0 });
    },

    noteAutosaveFailed: () => set({ autosaveFailures: get().autosaveFailures + 1 }),

    setRecoveryOffer: (recovery) => set({ recovery }),

    clearRecoveryOffer: () => {
      if (get().recovery === null) return;
      set({ recovery: null });
    },

    // `focusCueId` is cleared for the same reason `notice` is: it names a cue in
    // the project being REPLACED. Left standing it could never be consumed —
    // no row will ever mount for that id again — so it would sit forever and
    // break the "steady state is null" property the never-re-steal rule rests on.
    hydrateUi: (p) =>
      set({ projectName: p.name, isDirty: false, notice: null, focusCueId: null }),
  };
};

/* ------------------------------------------------------------- selectors */

/**
 * [stable] CREATIVE §6.6.3a.
 *
 * The third disjunct exists because subtitles are the one thing in the inspector
 * that is NOT a property of the selection: §6.1 makes them a property of the
 * programme, so the panel that edits them cannot be gated on a clip being
 * selected. Without it `C` creates a cue, opens a group that is not rendered,
 * and leaves `focusCueId` non-null with no consumer alive to clear it.
 *
 * It is the group's OPEN FLAG and deliberately not `focusCueId !== null`. The
 * focus request is a one-shot that the consuming row clears the instant it takes
 * focus, so gating visibility on it would unmount the panel at the exact moment
 * of success — the caret would land and the surface holding it would vanish in
 * the same commit. The open flag is the durable signal, and it is persisted, so
 * a user who was writing subtitles finds the panel where they left it.
 */
export const selectInspectorVisible = (s: StoreState): boolean =>
  s.selection.size > 0 || s.inspectorPinned || s.inspectorGroups.subtitles;

/** [stable] Any overlay that swallows the keyboard. Drives PLAN §8.10 scope gating. */
export const selectOverlayOpen = (s: StoreState): boolean =>
  s.exportDialogOpen || s.shortcutOverlayOpen;

/** [stable] */
export const selectAutosaveHealthy = (s: StoreState): boolean => s.autosaveFailures === 0;

/** [stable] */
export const selectHasRecovery = (s: StoreState): boolean => s.recovery !== null;
