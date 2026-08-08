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
import type { ProjectFile } from '../types/model';
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

/** Collapsible groups in the inspector. Persisted. See PLAN §8.15. */
export type InspectorGroupId = 'project' | 'transform' | 'blend' | 'timeAndSound';

export const INSPECTOR_GROUP_IDS = [
  'project',
  'transform',
  'blend',
  'timeAndSound',
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

export const INITIAL_INSPECTOR_GROUPS: Record<InspectorGroupId, boolean> = {
  project: true,
  transform: true,
  blend: false,
  timeAndSound: false,
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

    hydrateUi: (p) => set({ projectName: p.name, isDirty: false, notice: null }),
  };
};

/* ------------------------------------------------------------- selectors */

/** [stable] */
export const selectInspectorVisible = (s: StoreState): boolean =>
  s.selection.size > 0 || s.inspectorPinned;

/** [stable] Any overlay that swallows the keyboard. Drives PLAN §8.10 scope gating. */
export const selectOverlayOpen = (s: StoreState): boolean =>
  s.exportDialogOpen || s.shortcutOverlayOpen;

/** [stable] */
export const selectAutosaveHealthy = (s: StoreState): boolean => s.autosaveFailures === 0;

/** [stable] */
export const selectHasRecovery = (s: StoreState): boolean => s.recovery !== null;
