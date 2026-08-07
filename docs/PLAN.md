# Implementation plan — Video Editor

**Status:** normative. This document is the integration contract between five parallel slices.
Where this plan and a slice brief disagree on a *name, type, or channel*, this plan wins — report
the conflict rather than diverging. Where they disagree on *visual behaviour*, `DESIGN.md` wins.

Read order for every agent: `PRODUCT.md` → `DESIGN.md` → this file → your own slice brief.

---

## 0. File ownership map

Nobody creates, edits or deletes a file outside their own list. If you need a change elsewhere,
report it as a required integration change in your final message.

| Owner | Files |
|---|---|
| **scaffold** | `package.json`, `tsconfig*.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/styles/tokens.css`, `src/styles/base.css`, `src/types/model.ts`, `src/types/api.ts`, `src/lib/**`, `src/state/store.ts`, `src/state/types.ts`, `src/components/ui/**`, `src/dev/fixtures.ts`, `electron/main.ts`, `electron/preload.ts` |
| **shell** | `src/App.tsx`, `src/components/shell/**`, `src/state/uiSlice.ts` |
| **media** | `src/components/media/**`, `src/state/mediaSlice.ts`, `electron/ipc/media.ts` |
| **preview** | `src/components/preview/**`, `src/state/playbackSlice.ts` |
| **timeline** | `src/components/timeline/**`, `src/state/timelineSlice.ts` |
| **inspector** | `src/components/inspector/**`, `src/components/export/**`, `src/keyboard/**`, `electron/ipc/project.ts` |

Global conventions, no exceptions:

- **Named exports only.** No `export default` anywhere. Cross-slice imports resolve by name.
- **`import type`** for every type-only import (the store types are deliberately circular).
- One component per file, file name equals component name.
- Every `.tsx` file that renders a surface imports no colour literal, ever. `grep -nE
  '#[0-9a-fA-F]{3,8}|rgba?\(|oklch\(|hsl\(' src/` must return zero hits outside
  `src/styles/tokens.css`.

---

## 1. Architecture

### 1.1 Process model

```
electron/main.ts        main process. BrowserWindow({ frame: false, titleBarStyle: 'hidden',
                        webPreferences: { preload, contextIsolation: true, nodeIntegration: false,
                        sandbox: false } }). Calls registerMediaIpc(ipcMain) and
                        registerProjectIpc(ipcMain) at startup. Owns the only child_process spawn.
electron/preload.ts     contextBridge.exposeInMainWorld('editorAPI', api). The api object is a
                        thin, typed wrapper over ipcRenderer.invoke / .on. No logic, no fs, no
                        child_process. Implements src/types/api.ts exactly.
src/**                  renderer. Plain React 18 + Vite. Runs headless-of-Electron under
                        `npm run dev:web`.
electron/ipc/*.ts       main-process handlers. May use node builtins freely.
```

**The absolute rule:** a renderer module never references `window.editorAPI` directly, never
imports from `electron`, and never imports anything from `electron/`. It calls
`getEditorAPI()` from `src/lib/editorApi.ts`, which returns the real bridge or the fixture
bridge. A component that touches `window.` for anything except `localStorage`,
`matchMedia`, `requestAnimationFrame` and DOM APIs is a bug.

```ts
// src/lib/editorApi.ts  (scaffold)
import type { EditorAPI } from '../types/api';
import { fixtureAPI } from '../dev/fixtures';

export function isElectron(): boolean {
  return typeof window !== 'undefined' && window.editorAPI !== undefined;
}
export function getEditorAPI(): EditorAPI {
  return (typeof window !== 'undefined' && window.editorAPI) || fixtureAPI;
}
```

`fixtureAPI` satisfies the *same* `EditorAPI` interface. Nothing branches on `isElectron()`
except (a) titlebar window controls, which hide in the browser, and (b) `VideoSurface`'s
playable-source check (§4.4).

### 1.2 Build / scripts

```
npm run dev:web    vite                       renderer only, http://localhost:5173
npm run dev        vite + electron (concurrently), ELECTRON=1
npm run build      tsc -b && vite build && tsc -p tsconfig.electron.json
```

Dependencies (scaffold installs; no slice adds one without reporting it):
`react`, `react-dom`, `zustand@^5`, `lucide-react`, `@fontsource/inter`,
`@fontsource-variable/jetbrains-mono`, `electron`, `vite`, `@vitejs/plugin-react`,
`typescript`, `concurrently`. Fonts are bundled, never fetched from a CDN.

### 1.3 State

One zustand store, composed from four slice creators, one file per domain. There is no context
provider for state, no second store, no reducer, no `useReducer` in a component that holds
domain state.

```ts
// src/state/types.ts  (scaffold)
import type { StateCreator } from 'zustand';
import type { UiSlice } from './uiSlice';
import type { MediaSlice } from './mediaSlice';
import type { PlaybackSlice } from './playbackSlice';
import type { TimelineSlice } from './timelineSlice';

export type StoreState = UiSlice & MediaSlice & PlaybackSlice & TimelineSlice;

/** Every slice file exports `create<Name>Slice: SliceCreator<NameSlice>`. */
export type SliceCreator<T> = StateCreator<
  StoreState,
  [['zustand/subscribeWithSelector', never]],
  [],
  T
>;
```

```ts
// src/state/store.ts  (scaffold)
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { StoreState } from './types';
import { createUiSlice } from './uiSlice';
import { createMediaSlice } from './mediaSlice';
import { createPlaybackSlice } from './playbackSlice';
import { createTimelineSlice } from './timelineSlice';

export const useEditorStore = create<StoreState>()(
  subscribeWithSelector((...a) => ({
    ...createUiSlice(...a),
    ...createMediaSlice(...a),
    ...createPlaybackSlice(...a),
    ...createTimelineSlice(...a),
  })),
);

/** Non-reactive read, for pointer handlers and rAF loops. */
export const readStore = () => useEditorStore.getState();
```

Because it is one store, a slice creator's `get()` returns the **whole** `StoreState`. That is
the sanctioned cross-slice read mechanism. Slice files may import *selectors and types* from one
another (`import { selectTimelineDurationFrames } from './timelineSlice'`), but must never
mutate another slice's state directly — call that slice's action.

**Subscription discipline (this is what keeps 40×6 smooth):**

- Components subscribe to the narrowest **primitive** possible.
  `useEditorStore(s => s.selection.has(id))` — not `s.selection`.
- Never select a freshly-allocated object/array in a component without `useShallow`.
  `useEditorStore(useShallow(s => s.trackOrder))` is fine; `s.trackOrder.map(...)` inside the
  selector is not.
- Anything that changes at pointer/frame rate (drag offsets, playhead pixels, scrub previews)
  is **not** React state. Use `useEditorStore.subscribe(selector, cb)` writing to
  `element.style.transform`, or a ref. Commit to the store on `pointerup` only.
- `useSyncExternalStore` is already inside zustand; do not add a second subscription layer.

---

## 2. The shared data model

`src/types/model.ts` (scaffold). Reproduced here verbatim — this is the file's contents.

### 2.1 Time

**Time is stored in whole frames, as integers, everywhere in the store, without exception.**
Seconds and timecode exist only at the edges: the `<video>` element, ffprobe output, and text
the user reads. There is exactly one conversion point, `state.fps` (the project frame rate).

```ts
/** Whole frames at the project fps. Always an integer. Never negative for a timeline position. */
export type Frames = number;
/** Real seconds. Only ever at an edge: <video>.currentTime, ffprobe, export duration. */
export type Seconds = number;
/** Timeline pixels per frame. The single zoom unit. */
export type PxPerFrame = number;
```

Helpers live in `src/lib/time.ts` (scaffold). These signatures are final:

```ts
export function framesToSeconds(frames: Frames, fps: number): Seconds;
export function secondsToFrames(seconds: Seconds, fps: number): Frames;   // Math.round
export function framesToTimecode(frames: Frames, fps: number): string;    // "HH:MM:SS:FF"
export function timecodeToFrames(tc: string, fps: number): Frames | null; // null = invalid
export function framesToDuration(frames: Frames, fps: number): string;    // "1:23" / "1:02:03"
export function clampFrames(f: Frames, min: Frames, max: Frames): Frames;
export function framesToPx(frames: Frames, zoom: PxPerFrame): number;
export function pxToFrames(px: number, zoom: PxPerFrame): Frames;         // Math.round
export function snapToFrame(f: number): Frames;                           // Math.round, >= 0
```

`timecodeToFrames` accepts `HH:MM:SS:FF`, `MM:SS:FF`, `SS:FF` and bare `FF`, tolerates `.` or
`;` as the frame separator, and returns `null` (not `NaN`, not `0`) on anything else. Fields
`MM`/`SS` ≥ 60 and `FF` ≥ fps are invalid, not wrapped. Frame rates are stored as the exact
decimal (`23.976`, `29.97`); timecode is non-drop-frame — `FF` counts `0 … ceil(fps)-1`.

### 2.2 Ids

```ts
export type MediaId = string;   // 'm_' + nanoid
export type ClipId = string;    // 'c_' + nanoid
export type TrackId = string;   // 't_' + nanoid
export type MarkerId = string;  // 'k_' + nanoid
```
`src/lib/id.ts` exports `newId(prefix: 'm' | 'c' | 't' | 'k'): string`. Never derive an id from
an index or a path.

### 2.3 Media

```ts
export type MediaKind = 'video' | 'audio';
export type MediaStatus = 'probing' | 'ready' | 'error';

export type MediaErrorCode =
  | 'not-found'          // file disappeared or path unreadable
  | 'unsupported-codec'  // probed fine, we cannot decode it
  | 'probe-failed'       // ffprobe returned non-zero / unparseable
  | 'ffmpeg-missing'     // binary not on PATH
  | 'cancelled';

export interface MediaError {
  code: MediaErrorCode;
  /** One sentence, sentence case, no trailing period, safe to show verbatim. */
  message: string;
}

export interface MediaItem {
  id: MediaId;
  /** Absolute filesystem path. In the browser fixture, a plausible pseudo-path. */
  path: string;
  /** Playable source for <video src>. Empty string = not playable (see §4.4). */
  url: string;
  /** Basename including extension. */
  name: string;
  kind: MediaKind;
  status: MediaStatus;
  error: MediaError | null;
  /** 0..1, meaningful only while status === 'probing'. */
  progress: number;
  /** Source duration converted to project frames. 0 until ready. */
  durationFrames: Frames;
  /** Native duration in seconds, as probed. */
  durationSeconds: Seconds;
  /** Native pixel dimensions. 0 for audio-only. */
  width: number;
  height: number;
  /** Native frame rate. 0 for audio-only. */
  fps: number;
  codec: string;
  hasAudio: boolean;
  /** file:// url or data: url. null when none could be extracted. */
  thumbnailUrl: string | null;
  addedAt: number;   // Date.now()
}
```

`durationFrames` is recomputed from `durationSeconds` whenever the project fps changes. The
recompute lives in `mediaSlice` as `recomputeMediaDurations(fps)`, and `playbackSlice` is the
caller: `setProjectFps` and `adoptSourceFormat` both invoke `get().recomputeMediaDurations(fps)`
after writing the new rate. No subscription, no effect — an explicit call, so the ordering is
readable (§3.2, §3.3).

### 2.4 Clips, tracks, markers

```ts
export interface ClipProperties {
  scale: number;      // 1 = 100%
  positionX: number;  // px in project-resolution space, 0 = centred
  positionY: number;
  rotation: number;   // degrees, -180..180
  opacity: number;    // 0..1
  speed: number;      // 1 = 100%, 0.1..8, never 0
  volume: number;     // 0..2, 1 = unity
}

export const DEFAULT_CLIP_PROPERTIES: ClipProperties = {
  scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1, speed: 1, volume: 1,
};

export interface Clip {
  id: ClipId;
  mediaId: MediaId;
  trackId: TrackId;
  /** Timeline frame of this clip's first frame. Inclusive. >= 0. */
  start: Frames;
  /** Length on the timeline. >= 1. */
  duration: Frames;
  /** Offset into the source media of this clip's first frame. >= 0. */
  mediaIn: Frames;
  /** Display name. Defaults to the media name; user-renameable later. */
  name: string;
  properties: ClipProperties;
}

/** Exclusive end. There is no `end` field — derive it, always, with this helper. */
export const clipEnd = (c: Clip): Frames => c.start + c.duration;

export interface Track {
  id: TrackId;
  kind: MediaKind;
  /** 1-based within kind. Drives the label. */
  index: number;
  /** 'V1' | 'A2'. The ONLY uppercase strings in the UI. */
  label: string;
  height: number;      // px
  muted: boolean;
  locked: boolean;
  visible: boolean;
}

export interface Marker {
  id: MarkerId;
  frame: Frames;
  label: string;   // may be ''
}
```

No `color` on `Marker` and no `color` on `Clip`. Hue is not a user-assignable dimension in this
build; adding one would break the three-uses rule.

**Track order** is `trackOrder: TrackId[]`, index 0 = topmost lane. Video tracks sort above audio
tracks; `addTrack` inserts a video track directly above the first audio track and an audio track
at the end. `V1` is the *bottom-most* video track (NLE convention): higher video index composites
on top, so `trackOrder` for `V2, V1, A1, A2` is exactly that.

### 2.5 Selection

```ts
/** Immutable. Every mutation allocates a new Set so referential equality means "unchanged". */
export type Selection = ReadonlySet<ClipId>;
export const EMPTY_SELECTION: Selection = new Set<ClipId>();
```

Selection contains clip ids only. Media-rail row highlight is **not** selection and must not use
the accent — it uses `--surface-raised`.

### 2.6 Project file

```ts
export interface ProjectFile {
  version: 1;
  name: string;
  fps: number;
  width: number;
  height: number;
  media: MediaItem[];
  tracks: Track[];
  trackOrder: TrackId[];
  clips: Clip[];
  markers: Marker[];
  savedAt: string;   // ISO 8601
}
```

Extension `.veproj`, JSON, 2-space indent. View state (zoom, scroll, selection, panel sizes,
theme) is **not** in the project file — it lives in `localStorage`.

`src/lib/project.ts` (scaffold) is the only module that crosses all four slices:

```ts
export function serializeProject(s: StoreState): ProjectFile;
export function applyProject(p: ProjectFile): void;  // calls the four hydrate actions in order:
                                                     // hydrateUi, hydratePlayback, hydrateMedia,
                                                     // hydrateTimeline
export function migrateProject(raw: unknown): ProjectFile | null;  // null = not a project file
```

---

## 3. The store contract

Each slice file exports: its state interface, its actions interface, the union `XSlice`,
the creator `createXSlice`, and its selectors. Selectors are plain
`(s: StoreState, ...args) => T` functions — never hooks — so they compose and can be called from
pointer handlers via `readStore()`.

### 3.1 `uiSlice.ts` — owner: **shell**

```ts
export type ThemeName = 'signal' | 'instrument' | 'daylight';

export interface UiState {
  theme: ThemeName;
  /** Media rail width in px, RAIL_MIN..RAIL_MAX. Retained while collapsed. */
  railWidth: number;
  railCollapsed: boolean;
  /** Timeline region as a fraction of the area under the titlebar. TIMELINE_MIN..MAX. */
  timelineHeightPct: number;
  /** Project identity — the titlebar reads these; the keyboard layer writes them. */
  projectName: string;
  projectPath: string | null;
  isDirty: boolean;
  /** Transient overlays. Owned here so any slice can open them without prop drilling. */
  exportDialogOpen: boolean;
  shortcutOverlayOpen: boolean;
}

export interface UiActions {
  setTheme(theme: ThemeName): void;
  setRailWidth(px: number): void;               // clamps to RAIL_MIN..RAIL_MAX
  setRailCollapsed(collapsed: boolean): void;
  toggleRail(): void;
  setTimelineHeightPct(pct: number): void;      // clamps to TIMELINE_MIN..MAX_PCT
  setProjectName(name: string): void;
  setProjectPath(path: string | null): void;
  markDirty(): void;
  markSaved(): void;
  setExportDialogOpen(open: boolean): void;
  setShortcutOverlayOpen(open: boolean): void;
  hydrateUi(p: Pick<ProjectFile, 'name'>): void;   // called by applyProject
}

export type UiSlice = UiState & UiActions;
export const createUiSlice: SliceCreator<UiSlice>;

export const selectInspectorVisible = (s: StoreState): boolean => s.selection.size > 0;
```

Persistence: shell subscribes to `{theme, railWidth, railCollapsed, timelineHeightPct}` and
writes `localStorage['ve.ui.v1']` debounced 200 ms. On load, parse inside `try/catch`, validate
every field's type **and range**, and fall back to the default for any field that fails. A
corrupt or partial blob must never prevent boot. No other slice reads or writes this key.

**Who calls `markDirty()`:** every timeline mutating action, every media add/remove, and
`setProjectName`. Since `timelineSlice` and `mediaSlice` cannot import `uiSlice` state directly,
they call `get().markDirty()` — the action exists on the merged store. This is the only
ui write those slices perform.

### 3.2 `mediaSlice.ts` — owner: **media**

```ts
export interface MediaState {
  items: Record<MediaId, MediaItem>;
  order: MediaId[];                 // insertion order, drives rail row order
  /** True while a file drag from the OS is over the window. Drives the drop affordance. */
  dropActive: boolean;
}

export interface MediaActions {
  /** Opens the native picker (or the fixture picker) and imports the result. */
  importFromPicker(): Promise<void>;
  /** Electron path: absolute fs paths. */
  importPaths(paths: string[]): Promise<void>;
  /** Browser/DnD path. Uses (file as any).path when Electron provides it, else object URLs. */
  importFiles(files: File[]): Promise<void>;
  addItem(item: MediaItem): void;
  updateItem(id: MediaId, patch: Partial<MediaItem>): void;
  removeItem(id: MediaId): void;          // also calls get().markClipsOffline(id)
  retryItem(id: MediaId): void;
  setDropActive(active: boolean): void;
  /** Re-derives durationFrames for every item after a project-fps change. */
  recomputeMediaDurations(fps: number): void;
  hydrateMedia(items: MediaItem[]): void;
}

export type MediaSlice = MediaState & MediaActions;
export const createMediaSlice: SliceCreator<MediaSlice>;

export const selectAllMedia = (s: StoreState): MediaItem[] => s.order.map(id => s.items[id]);
export const selectMediaItem = (s: StoreState, id: MediaId): MediaItem | undefined => s.items[id];
export const selectOfflineMedia = (s: StoreState): MediaItem[] =>
  selectAllMedia(s).filter(m => m.status === 'error');
export const selectIsImporting = (s: StoreState): boolean =>
  selectAllMedia(s).some(m => m.status === 'probing');
```

Import flow, exactly:

1. `addItem` immediately with `status: 'probing'`, `progress: 0`, a placeholder
   `durationFrames: 0`, and `name` from the basename. The row appears at once.
2. `await getEditorAPI().media.probe(path)` per file, **concurrency capped at 3**
   (`for await` over a small pool). Never `Promise.all` an unbounded list — probing 40 files must
   not stall the UI or the ffmpeg host.
3. On `{ ok: true }`, `updateItem(id, { status: 'ready', ...data, durationFrames:
   secondsToFrames(data.durationSeconds, readStore().fps) })`.
4. On `{ ok: false }`, `updateItem(id, { status: 'error', error })`. The row shows an icon, the
   message text, and a `--status-danger` 1px hairline. Never colour alone. Two ghost actions on
   the row: **Retry** and **Remove**.
5. After the *first* item reaches `ready`, call
   `get().adoptSourceFormat(item)` — this is how the project fps and resolution get set without
   a setup modal (PRODUCT.md anti-reference: modal-first flows). It is a no-op once
   `formatLocked` is true.
6. `get().markDirty()`.

`removeItem` does not delete clips. It calls `get().markClipsOffline(mediaId)`; those clips
render with the offline treatment and the project remains editable.

### 3.3 `playbackSlice.ts` — owner: **preview**

```ts
export interface PlaybackState {
  /** THE playhead. Single source of truth for the whole app. Integer frames. */
  playhead: Frames;
  isPlaying: boolean;
  /** Playback rate. 1 = normal. Negative = reverse shuttle. Never 0 (use pause). */
  rate: number;
  inPoint: Frames | null;
  outPoint: Frames | null;
  /** Project format. Adopted from the first ready media item, then locked. */
  fps: number;      // default 30
  width: number;    // default 1920
  height: number;   // default 1080
  formatLocked: boolean;
  volume: number;   // 0..1
  muted: boolean;
}

export interface PlaybackActions {
  play(): void;
  pause(): void;
  togglePlay(): void;
  /** Clamps to [0, selectTimelineDurationFrames(get())]. Rounds to an integer frame. */
  seek(frame: Frames): void;
  /** Relative seek. step(1) / step(-1) / step(fps) etc. */
  step(delta: Frames): void;
  /** J/K/L. dir -1 reverse, 0 stop, +1 forward; repeated calls in the same direction
      escalate the rate through SHUTTLE_RATES. */
  shuttle(dir: -1 | 0 | 1): void;
  setRate(rate: number): void;
  setInPoint(frame?: Frames): void;    // default: current playhead
  setOutPoint(frame?: Frames): void;
  clearInOut(): void;
  setProjectFps(fps: number): void;    // no-op if formatLocked; calls recomputeMediaDurations
  adoptSourceFormat(m: Pick<MediaItem, 'fps' | 'width' | 'height'>): void;
  setVolume(v: number): void;
  toggleMute(): void;
  hydratePlayback(p: Pick<ProjectFile, 'fps' | 'width' | 'height'>): void;
}

export type PlaybackSlice = PlaybackState & PlaybackActions;
export const createPlaybackSlice: SliceCreator<PlaybackSlice>;

export const SHUTTLE_RATES = [1, 2, 4, 8] as const;
export const selectTimecode = (s: StoreState): string => framesToTimecode(s.playhead, s.fps);
```

`adoptSourceFormat` rounds an odd source fps to the nearest known rate
(`[23.976, 24, 25, 29.97, 30, 50, 59.94, 60]`, tolerance 0.05) and sets `formatLocked = true`.
Changing fps later **never retimes existing clips** — frame values are literal. `setProjectFps`
refuses (no-op) when `formatLocked && Object.keys(get().clips).length > 0`.

### 3.4 `timelineSlice.ts` — owner: **timeline**

```ts
export interface TimelineViewState {
  zoom: PxPerFrame;   // ZOOM_MIN..ZOOM_MAX
  scrollX: number;    // px from timeline frame 0, >= 0
  scrollY: number;    // px, lane area vertical scroll
  snapEnabled: boolean;
}

export interface TimelineDoc {
  tracks: Record<TrackId, Track>;
  trackOrder: TrackId[];
  clips: Record<ClipId, Clip>;
  /** Invariant: every array is sorted ascending by clip.start and contains no overlaps. */
  clipsByTrack: Record<TrackId, ClipId[]>;
  markers: Record<MarkerId, Marker>;
  /** Clip ids whose media is missing/errored. Derived, but stored for O(1) render checks. */
  offlineClipIds: ReadonlySet<ClipId>;
}

export interface TimelineState extends TimelineDoc, TimelineViewState {
  selection: Selection;
  history: { past: TimelineDoc[]; future: TimelineDoc[] };
}

export type MoveFailure = 'overlap' | 'locked' | 'out-of-range' | 'no-track';
export type MutationResult = { ok: true } | { ok: false; reason: MoveFailure };

export interface AddClipInput {
  mediaId: MediaId;
  trackId: TrackId;
  start: Frames;
  duration?: Frames;   // defaults to the media's full durationFrames
  mediaIn?: Frames;    // defaults to 0
}

export interface TimelineActions {
  addClip(input: AddClipInput): ClipId | null;      // null when it would overlap or track locked
  /** Convenience used by media double-click and by drop: finds the first track of the right
      kind with room at `start`, adding a track if none has room. */
  insertMediaAt(mediaId: MediaId, start: Frames, preferredTrackId?: TrackId): ClipId | null;
  moveClip(id: ClipId, next: { trackId: TrackId; start: Frames }): MutationResult;
  /** Group move for a multi-selection. All-or-nothing: if any member fails, none move. */
  moveClips(ids: ClipId[], deltaFrames: Frames, deltaTrackIndex: number): MutationResult;
  trimClip(id: ClipId, edge: 'in' | 'out', nextFrame: Frames): MutationResult;
  splitAtPlayhead(): void;                 // splits every selected clip, or every clip under
                                           // the playhead when selection is empty
  deleteSelection(): void;                 // lift: leaves a gap
  rippleDelete(): void;                    // closes the gap on the affected tracks
  select(id: ClipId, mode: 'replace' | 'extend' | 'toggle'): void;
  selectMany(ids: ClipId[], mode: 'replace' | 'extend' | 'toggle'): void;
  clearSelection(): void;
  addTrack(kind: MediaKind): TrackId;
  removeTrack(id: TrackId): void;
  toggleMute(id: TrackId): void;
  toggleLock(id: TrackId): void;
  toggleVisible(id: TrackId): void;
  setZoom(zoom: PxPerFrame): void;
  /** anchorPx = pointer x relative to the lane viewport's left edge. Keeps the frame under the
      pointer stationary. This is the only zoom entry point wheel handlers may call. */
  zoomAround(nextZoom: PxPerFrame, anchorPx: number): void;
  zoomToFit(viewportPx: number): void;
  setScroll(x: number, y: number): void;
  setSnapEnabled(on: boolean): void;
  addMarker(frame?: Frames, label?: string): MarkerId;
  removeMarker(id: MarkerId): void;
  /** Called by mediaSlice.removeItem and by probe failure. */
  markClipsOffline(mediaId: MediaId): void;
  /** THE inspector's only write path. Applies to every id, wrapped in one history entry. */
  updateClipProperties(ids: ClipId[], patch: Partial<ClipProperties>): void;
  renameClip(id: ClipId, name: string): void;

  // --- history ---
  /** Open a transaction: snapshot now, suppress per-action snapshots until commit. */
  beginHistory(label: string): void;
  commitHistory(): void;
  /** Restore the open transaction's snapshot and close it. Used when a drag is cancelled. */
  abortHistory(): void;
  undo(): void;
  redo(): void;

  hydrateTimeline(p: Pick<ProjectFile, 'tracks' | 'trackOrder' | 'clips' | 'markers'>): void;
}

export type TimelineSlice = TimelineState & TimelineActions;
export const createTimelineSlice: SliceCreator<TimelineSlice>;
```

Selectors exported from `timelineSlice.ts` — these are the cross-slice read surface:

```ts
export const selectTimelineDurationFrames = (s: StoreState): Frames;   // max clipEnd, min 0
export const selectClipsInTrack = (s: StoreState, t: TrackId): Clip[];
export const selectSelectedClips = (s: StoreState): Clip[];
export const selectIsSelected = (s: StoreState, id: ClipId): boolean;  // primitive: safe in a hook
/** Topmost VISIBLE video clip whose [start, end) contains frame. null over empty timeline. */
export const selectVideoClipAtFrame = (s: StoreState, frame: Frames): Clip | null;
/** The clip that starts next after `frame` on any visible video track — preview preloads it. */
export const selectNextVideoClipAfter = (s: StoreState, frame: Frames): Clip | null;
export const selectAudioClipsAtFrame = (s: StoreState, frame: Frames): Clip[];
export const selectSnapTargets = (s: StoreState, excludeClipIds?: ReadonlySet<ClipId>): Frames[];
export const selectTrackAtY = (s: StoreState, y: number): Track | null;
export const selectLaneTop = (s: StoreState, trackId: TrackId): number;  // px from lane top
export const selectLaneHeight = (s: StoreState): number;                 // total px
export const selectCanUndo = (s: StoreState): boolean;
export const selectCanRedo = (s: StoreState): boolean;
```

History: snapshots of `TimelineDoc` only — never selection, zoom, scroll or the history stack
itself. `HISTORY_LIMIT = 100`, oldest dropped. Every mutating action calls the internal
`pushHistory(label)` *before* mutating, unless a transaction is open. Drags and scrubs open a
transaction on `pointerdown` and commit on `pointerup`, so one drag is one undo step.

**Overlap policy (must be visible, never silent):** `moveClip` and `trimClip` first try the
requested placement; if it collides with a clip on the target track, they return
`{ ok: false, reason: 'overlap' }` and change nothing. The interaction layer is responsible for
the feedback: the drag ghost stops at the last legal frame, the illegal region shows a
`--status-danger` 1px hairline on the blocking edge, and on `pointerup` the clip settles at the
last legal position with a 120 ms transition. Never snap silently back to origin, and never
overwrite the blocking clip.

---

## 4. `window.editorAPI`

`src/types/api.ts` (scaffold). Preload implements it; `fixtureAPI` implements the same interface
against in-memory data. Channel names are string constants exported from the same file so main
and preload cannot drift.

```ts
export const CH = {
  windowMinimize:    'window:minimize',
  windowMaximize:    'window:maximize-toggle',
  windowClose:       'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaxChanged:  'window:maximize-changed',   // main -> renderer
  mediaPick:         'media:pick',
  mediaProbe:        'media:probe',
  mediaProbeProgress:'media:probe-progress',      // main -> renderer
  projectSave:       'project:save',
  projectOpen:       'project:open',
  projectPickDir:    'project:pick-directory',
} as const;

export interface ProbeData {
  kind: MediaKind;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  hasAudio: boolean;
  /** file:// url to a temp png, or null. */
  thumbnailUrl: string | null;
}
export type ProbeResult = { ok: true; data: ProbeData } | { ok: false; error: MediaError };

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; error: { code: 'cancelled' | 'io-failed'; message: string } };
export type OpenResult =
  | { ok: true; path: string; project: ProjectFile }
  | { ok: false; error: { code: 'cancelled' | 'io-failed' | 'bad-format'; message: string } };

export interface ExportSettings {
  filename: string;      // without extension
  folder: string;
  width: number; height: number; fps: number;
  codec: 'h264' | 'h265' | 'prores';
  quality: 'draft' | 'good' | 'best';
  range: 'entire' | 'inout';
}
export interface ExportProgressEvent {
  jobId: string;
  phase: 'preparing' | 'encoding' | 'finalizing' | 'done' | 'cancelled' | 'error';
  progress: number;      // 0..1, monotonic within a phase
  framesDone: number;
  framesTotal: number;
  message?: string;
}
export interface ExportBridge {
  start(req: ExportSettings & { durationFrames: Frames }): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<void>;
  onProgress(cb: (e: ExportProgressEvent) => void): () => void;   // returns unsubscribe
}

export interface EditorAPI {
  platform: 'win32' | 'darwin' | 'linux';
  window: {
    minimize(): void;
    maximizeToggle(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizeChange(cb: (isMaximized: boolean) => void): () => void;
  };
  media: {
    pickFiles(): Promise<string[]>;                 // [] on cancel
    probe(path: string): Promise<ProbeResult>;      // never throws
    onProbeProgress(cb: (e: { path: string; progress: number }) => void): () => void;
  };
  project: {
    save(project: ProjectFile, opts?: { path?: string | null; saveAs?: boolean }): Promise<SaveResult>;
    open(): Promise<OpenResult>;
    pickDirectory(): Promise<string | null>;
  };
  /** ABSENT in this build. ExportDialog falls back to the local stub. See §8 risk 9. */
  export?: ExportBridge;
}

declare global {
  interface Window { editorAPI?: EditorAPI }
}
```

**Every `invoke` resolves; none reject.** Main-process handlers catch everything and return the
`{ ok: false, error }` branch. A renderer `try/catch` around an editorAPI call is a smell —
handle the discriminated union instead.

### 4.4 Fixture-provider fallback contract

`src/dev/fixtures.ts` (scaffold) exports:

```ts
export const fixtureAPI: EditorAPI;
export const FIXTURE_PROJECT: ProjectFile;   // 12 media items, 6 tracks (V3 V2 V1 A1 A2 A3),
                                             // 41 clips, 4 markers, fps 30, 1920x1080
export function bootstrapFixtures(): void;   // calls applyProject(FIXTURE_PROJECT)
```

`src/main.tsx` calls `bootstrapFixtures()` when `!isElectron()`, before the first render.
Guarantees the fixture data must satisfy:

- Clip widths span two orders of magnitude, including at least three clips narrower than 24 px at
  the default zoom, so the degrade-not-overflow path is visible on first load.
- At least two clips abut exactly (`a.start + a.duration === b.start`) so the 3 px radius decision
  can be judged.
- At least one media item has `status: 'error'` with `code: 'not-found'`, and at least one clip
  references it, so the offline treatment renders.
- At least one item is `status: 'probing'` with `progress: 0.4`.
- `fixtureAPI.media.pickFiles()` resolves with two synthetic paths and `probe()` resolves `ok`
  after a 600 ms delay with staged progress, so the import path is exercisable in a browser.

**Playability:** fixture media have `url: ''` and a data-URI `thumbnailUrl`. `MediaItem.url === ''`
means *not playable*. `VideoSurface` must handle it: instead of a `<video>`, render the clip's
thumbnail letterboxed on the well with the timecode drawn in `--text-on-well` mono, and drive the
playhead from the rAF wall clock (§8 risk 6). This is the only branch permitted on source
availability, and it is a property of the data, not of `isElectron()`.

---

## 5. Shared UI primitives

`src/components/ui/**` (scaffold), barrel `src/components/ui/index.ts`. **No slice defines its
own button, input, tooltip or dialog.** If a primitive lacks a prop you need, report it.

All seven states are implemented on the primitive, once. Slices get them for free and must not
re-implement hover/focus styling on top.

| State | Mechanism | Visual (all variants) |
|---|---|---|
| default | — | per variant below |
| hover | `:hover` | background moves one step lighter (`--surface-*-hover`), 120 ms |
| focus-visible | `:focus-visible` | `outline: var(--focus-ring-width) solid var(--accent); outline-offset: var(--focus-ring-offset)`. Never removed, never replaced by a box-shadow. |
| active | `:active` | background one further step, transform none (no scale bounce) |
| disabled | `[disabled]` / `aria-disabled` | 50 % opacity, `cursor: not-allowed`, `pointer-events` retained so a tooltip can explain. DESIGN.md says avoid disabling — prefer enabled + explain on use. |
| loading | `loading` prop | content stays in place at 60 % opacity, a 12 px spinner replaces the icon slot, `aria-busy="true"`, pointer events off. Under reduced motion the spinner becomes a static three-dot glyph. |
| error | `invalid` / `error` prop | 1 px `--status-danger` border **plus** an `AlertCircle` icon **plus** the message text. `aria-invalid="true"`, `aria-describedby` pointing at the message. Colour is never the only signal. |

```ts
// Button
export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'ghost';   // default 'secondary'
  size?: 'sm' | 'md';                            // 24px | 28px, default 'md'
  loading?: boolean;
  invalid?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  children: React.ReactNode;                     // sentence case, always
}

// IconButton — label is REQUIRED and becomes aria-label; there is no icon-only escape hatch.
export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: React.ReactNode;
  label: string;
  variant?: 'ghost' | 'secondary';               // default 'ghost'
  size?: 'sm' | 'md';                            // 24px | 28px square
  /** Toggle semantics. Sets aria-pressed and, when true, tints the icon with --accent. */
  pressed?: boolean;
  /** 'danger' turns the HOVER background danger — used only by the titlebar close button. */
  tone?: 'default' | 'danger';
  loading?: boolean;
  /** Rendered in the tooltip; pass <ShortcutHint id="..." />. */
  shortcut?: React.ReactNode;
}

// NumericField — the workhorse of the inspector, and the only numeric input in the app.
export interface NumericFieldProps {
  value: number | 'mixed';
  /** Fires continuously during scrub and typing. Cheap: does not open a history entry. */
  onChange(next: number): void;
  /** Fires on pointerup / Enter / blur. This is where you commit to the store. */
  onCommit?(next: number): void;
  label: string;                 // accessible name; PropertyRow renders the visible copy
  min?: number; max?: number;
  step?: number;                 // keyboard arrow increment, default 1
  precision?: number;            // decimals shown, default 0
  /** Units per pixel of horizontal drag. Default step. Shift = ×0.1, Ctrl = ×10. */
  scrubSensitivity?: number;
  suffix?: string;               // '%', '°', '×'
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  id?: string;
}
```

`value === 'mixed'` renders the literal text `Mixed` in `--text-muted`, keeps the field
editable, and typing replaces the value for the whole selection. It never renders blank.

```ts
// Panel — bounded region with a heading. NESTING IS FORBIDDEN and enforced.
export interface PanelProps {
  heading?: React.ReactNode;     // title type
  actions?: React.ReactNode;     // right-aligned in the heading row
  padded?: boolean;              // default true -> var(--space-lg)
  scroll?: boolean;              // default false
  className?: string;
  children: React.ReactNode;
}
```
`Panel` publishes a React context; a `Panel` rendered inside a `Panel` throws in development with
"Nested panels are forbidden (DESIGN.md §4)". Flatten instead.

```ts
// Tooltip — wraps exactly one focusable child. Opens on hover (400ms) and on focus-visible (0ms).
export interface TooltipProps {
  content: React.ReactNode;
  shortcut?: React.ReactNode;    // <ShortcutHint id="..." />
  placement?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactElement;
}

// Dialog — native <dialog>, focus trap, focus restore, Escape, scrim.
export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;                 // headline type; becomes the accessible name
  description?: string;
  footer?: React.ReactNode;      // action row, right-aligned, primary last
  initialFocusRef?: React.RefObject<HTMLElement>;
  width?: number;                // px, default 480
  children: React.ReactNode;
}

// Menu — the titlebar overflow and any context menu. Popover shadow, roving tabindex.
export interface MenuProps {
  trigger: React.ReactElement;
  items: MenuItem[];
  align?: 'start' | 'end';
}
export type MenuItem =
  | { kind: 'item'; id: string; label: string; icon?: React.ReactNode;
      shortcut?: React.ReactNode; checked?: boolean; onSelect(): void }
  | { kind: 'separator'; id: string }
  | { kind: 'label'; id: string; label: string };
```

**Keyboard-guard contract.** `NumericField`, `TimecodeField`, and every text input in the app set
`data-editor-text-input="true"` on the focusable element. `useShortcuts` ignores any event whose
`target` matches:

```
input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-editor-text-input="true"]
```
…**except** for `Escape`, which always reaches the global layer so a field can be reverted and
focus released. This is the single contract that stops "pressing S in a filename field splits the
clip". `TimecodeField` is owned by the preview slice; it is required to set the attribute.

**Icons:** `lucide-react`, size 14 (`sm`) / 16 (`md`), `strokeWidth={1.75}`, `aria-hidden="true"`.
Fixed assignments so the "distinct icon per state" rule holds:
mute `Volume2` / `VolumeX`; lock `LockOpen` / `Lock`; visibility `Eye` / `EyeOff`;
offline media `Unplug`; error `AlertCircle`; warning `TriangleAlert`; snap `Magnet`;
import `FolderInput`; export `Upload`; split `Scissors`; marker `Bookmark`;
transport `SkipBack` `ChevronLeft` `Play` `Pause` `ChevronRight` `SkipForward`.

---

## 6. Semantic z-index scale

Declared once in `src/styles/tokens.css`. **A numeric `z-index` literal anywhere in slice code is
a bug.** Always `z-index: var(--z-…)`.

```css
--z-base:              0;   /* lane background, track lanes */
--z-clip:             10;   /* resting clips */
--z-clip-dragging:    20;   /* the clip(s) under the pointer */
--z-snap-guide:       25;   /* the 1px accent snap line */
--z-playhead:         30;   /* above every clip, always */
--z-timeline-ruler:   40;   /* sticky top of the lane area */
--z-track-heads:      45;   /* sticky left column, above the ruler's left corner */
--z-marquee:          50;   /* selection rectangle */
--z-resizer:          60;   /* panel splitters */
--z-inspector:        70;   /* inspector when it overlays the preview under 1180px */
--z-titlebar:         80;
--z-drop-overlay:     90;   /* file-drop affordance over the whole window */
--z-menu:            100;   /* popovers, overflow menu, context menus */
--z-tooltip:         110;
--z-dialog-scrim:    120;
--z-dialog:          130;   /* export dialog, shortcut overlay */
```

Only `--z-menu` and above may carry a shadow (`--shadow-popover` / `--shadow-dialog`).
Everything below is in-flow and casts none.

---

## 7. Token names

`src/styles/tokens.css` (scaffold) is the only file containing a colour literal. Every value below
is derived from `DESIGN.md`; **the names are normative — five agents must type the same string.**

### 7.1 Colour (theme-swapped)

```
--surface-well            --surface-chrome            --surface-panel            --surface-raised
--surface-well-hover      --surface-chrome-hover      --surface-panel-hover      --surface-raised-hover
--text-ink                --text-muted                --text-on-well             --text-on-accent
--accent                  --accent-hover
--status-danger           --status-danger-hover       --status-warning
--border-hairline         --border-hairline-strong
--scrim
```

Structure of the file:

```css
:root, :root[data-theme='signal'] {
  --surface-well:  oklch(0.10 0.008 265);
  --surface-chrome: oklch(0.215 0.014 265);
  --surface-panel: oklch(0.255 0.016 265);
  --surface-raised: oklch(0.31 0.018 265);
  /* hover = +0.04 lightness on the same hue/chroma, per DESIGN.md §5 */
  --surface-chrome-hover: oklch(0.255 0.014 265);
  --surface-panel-hover:  oklch(0.295 0.016 265);
  --surface-raised-hover: oklch(0.35 0.018 265);
  --surface-well-hover:   oklch(0.14 0.008 265);
  --text-ink:     oklch(0.96 0.004 265);
  --text-muted:   oklch(0.72 0.012 265);
  --text-on-well: oklch(0.96 0.004 265);
  --text-on-accent: oklch(0.17 0.03 68);
  --accent:        oklch(0.75 0.15 68);
  --accent-hover:  oklch(0.79 0.15 68);
  --status-danger:       oklch(0.66 0.19 22);
  --status-danger-hover: oklch(0.70 0.19 22);
  --status-warning:      oklch(0.90 0.15 100);
  --border-hairline:        oklch(1 0 0 / 0.08);
  --border-hairline-strong: oklch(1 0 0 / 0.16);
  --scrim: oklch(0 0 0 / 0.56);
}
:root[data-theme='instrument'] { /* DESIGN.md §2 alternate table, chroma 0 neutrals */ }
:root[data-theme='daylight']   { /* DESIGN.md §2 alternate table; hairlines invert to
                                    oklch(0 0 0 / 0.10) and 0.18; --scrim unchanged */ }
```

`ThemeProvider` sets `document.documentElement.dataset.theme`. Nothing else touches it. There is
no `prefers-color-scheme` branch — the theme is an explicit user choice with `signal` as default.

### 7.2 Type

```
--font-sans   Inter, system-ui, sans-serif
--font-mono   'JetBrains Mono', ui-monospace, monospace

--type-headline-size 18px  --type-headline-weight 600  --type-headline-line 1.3   --type-headline-track -0.01em
--type-title-size    15px  --type-title-weight    600  --type-title-line    1.35  --type-title-track    -0.005em
--type-body-size     13px  --type-body-weight     400  --type-body-line     1.45  --type-body-track     normal
--type-label-size    11px  --type-label-weight    500  --type-label-line    1.3   --type-label-track    0.005em
--type-numeric-size  12px  --type-numeric-weight  400  --type-numeric-line  1.2   --type-numeric-track  normal
```

`base.css` ships five utility classes; **use these rather than re-declaring the five properties**:
`.type-headline`, `.type-title`, `.type-body`, `.type-label`, `.type-numeric`.
`.type-numeric` additionally sets `font-family: var(--font-mono); font-variant-numeric:
tabular-nums; font-feature-settings: 'tnum' 1, 'zero' 1;`.

**The tabular rule, operationally:** every timecode, duration, frame count, percentage, dimension,
bitrate, file size, and every value inside a `NumericField` carries `.type-numeric`. If a number
can change while the app is running and it is not in `.type-numeric`, that is a bug.

### 7.3 Radius, space, motion, layout

```
--radius-clip 3px   --radius-sm 4px   --radius-md 6px   --radius-lg 10px

--space-hair 2px  --space-xs 4px  --space-sm 6px  --space-md 8px
--space-lg 12px   --space-xl 16px --space-xxl 24px

--dur-feedback   120ms   /* hover, focus, toggle */
--dur-transition 180ms   /* the default; DESIGN.md band is 150-250 */
--dur-panel      200ms   /* inspector mount/unmount, rail collapse */
--dur-snap        90ms   /* timeline snap settle */
--ease-out cubic-bezier(0.22, 1, 0.36, 1);

--shadow-popover 0 8px 24px oklch(0 0 0 / 0.44), 0 2px 6px oklch(0 0 0 / 0.32);
--shadow-dialog  0 24px 64px oklch(0 0 0 / 0.56);

--focus-ring-width 2px   --focus-ring-offset 2px

--titlebar-height 36px
--rail-width-default 260px
--inspector-width 280px
--track-head-width 88px
--ruler-height 28px
--track-height-video 56px
--track-height-audio 40px
--resizer-hit 5px
```

Reduced motion, declared once in `base.css`:

```css
@media (prefers-reduced-motion: reduce) {
  :root { --dur-feedback: 1ms; --dur-transition: 1ms; --dur-panel: 1ms; --dur-snap: 1ms; }
  *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
}
```
That global is a floor, not a substitute. Any component whose *logic* depends on motion (timeline
inertia, momentum scrub, snap settle) must read
`window.matchMedia('(prefers-reduced-motion: reduce)').matches` via the scaffold hook
`useReducedMotion(): boolean` and take the instant path. Nothing may be gated on a `transitionend`.

The same numbers exist as TypeScript in `src/lib/constants.ts` (scaffold) for layout maths:

```ts
export const TITLEBAR_HEIGHT = 36;
export const RAIL_DEFAULT = 260, RAIL_MIN = 200, RAIL_MAX = 420;
export const INSPECTOR_WIDTH = 280;
export const INSPECTOR_OVERLAY_BREAKPOINT = 1180;
export const MIN_WINDOW = { width: 1024, height: 640 };
export const TIMELINE_DEFAULT_PCT = 0.38, TIMELINE_MIN_PCT = 0.22, TIMELINE_MAX_PCT = 0.65;
export const TRACK_HEAD_WIDTH = 88, RULER_HEIGHT = 28;
export const TRACK_HEIGHT_VIDEO = 56, TRACK_HEIGHT_AUDIO = 40;
export const MEDIA_ROW_HEIGHT = 44, MEDIA_THUMB = { width: 32, height: 18 };
export const CLIP_MIN_LABEL_WIDTH = 24;   // below this, drop the name
export const CLIP_RADIUS = 3;
export const SNAP_THRESHOLD_PX = 8;       // SCREEN px, constant across zoom
export const ZOOM_MIN = 0.002, ZOOM_MAX = 40, ZOOM_STEP = 1.25;  // px per frame
export const RESIZER_HIT = 5, RESIZER_KEY_STEP = 16;
export const HISTORY_LIMIT = 100;
export const DND_MEDIA_MIME = 'application/x-editor-media';   // payload: MediaId
export const DND_CLIP_MIME  = 'application/x-editor-clip';    // reserved; NOT used (see §8.5)
export const LS_UI_KEY = 've.ui.v1';
```

### 7.4 The accent budget — closed list

The accent may appear on these and nothing else. A use not on this list is a bug; report it
rather than adding one.

1. The timeline playhead line and its ruler head.
2. The snap guide line (same family as the playhead — it is a time indicator).
3. The selection outline on timeline clips (1.5 px, `outline-offset: -1.5px`).
4. The `:focus-visible` ring, anywhere (focus is selection).
5. Active track-head toggles (mute / lock / visibility), explicitly permitted by DESIGN.md §5.
6. The one primary action per view — in this build that is the **Export** button inside
   `ExportDialog`, and nothing else. The media rail's Import button is `secondary`.
7. The transient file-drop target border and its label, while a drag is over the window.

Not permitted: the play button, panel headings, the media-rail row highlight, the dirty dot
(use `--text-muted`), progress bars (use `--text-ink` on `--surface-well`), track labels, hover
states, the titlebar.

---

## 8. Integration risks and the contracts that prevent them

### 8.1 Composition — what `App.tsx` renders

The shell slice writes `App.tsx`; the other slices must export exactly these names from exactly
these paths, all taking **no props** and reading the store themselves:

```tsx
import { MediaRail }       from './components/media/MediaRail';        // media
import { PreviewWell }     from './components/preview/PreviewWell';    // preview
import { Timeline }        from './components/timeline/Timeline';      // timeline
import { Inspector }       from './components/inspector/Inspector';    // inspector
import { ExportDialog }    from './components/export/ExportDialog';    // inspector
import { ShortcutOverlay } from './keyboard/ShortcutOverlay';          // inspector
import { useShortcuts }    from './keyboard/useShortcuts';             // inspector
```

`App.tsx` calls `useShortcuts()` once at the root and renders `<ExportDialog />` and
`<ShortcutOverlay />` unconditionally at the end of the tree — they read `ui.exportDialogOpen` /
`ui.shortcutOverlayOpen` and render `null` when closed. The shell does **not** conditionally mount
them and does **not** pass them open/close props.

`<Inspector />` is the exception: the shell mounts it only when `selectInspectorVisible(s)` is
true and owns the 200 ms transform/opacity entry animation and the `280px` sizing. `Inspector`
itself renders at `width: 100%; height: 100%` with no animation, no width, and no mount
condition of its own. Two animations here would double up; one owner only.

Risk if violated: the inspector never appears, or appears with a doubled transition. Contract:
**mounting is the shell's, contents are the inspector's.**

### 8.2 Token drift — the highest-risk item in the build

Five agents inventing `--color-panel`, `--bg-panel`, `--panel-bg` produces an app that looks
half-dead and nobody notices until integration. Contract: §7 is the complete list. No slice adds
a custom property to `:root`. A slice may define a **locally scoped** variable on its own root
element (`--clip-x`, `--rail-w`) for layout maths; it may not define a colour. Before finishing,
each agent greps their own files for colour literals and for `--` names not in §7.

### 8.3 The playhead has exactly one owner

`playbackSlice.playhead` is the only playhead. The timeline reads it
(`useEditorStore(s => s.playhead)`) and writes it via `seek()` when scrubbing the ruler or
dragging the head. The timeline must not keep a shadow copy, must not store a scrub position, and
must not advance it during playback. The preview owns advancement.

Symmetrically, the preview never reads `zoom` or `scrollX` and never writes to `timelineSlice`.

Risk: two sources of truth drift by a frame and the playhead visibly desynchronises from the
image. Contract: **frames, one field, `seek()` is the only writer besides the clock.**

### 8.4 One rAF loop

`PreviewWell` mounts `usePlaybackClock()`, and it is the only `requestAnimationFrame` loop that
advances the playhead in the app. Rules:

- When a playable `<video>` exists, the loop reads `video.currentTime` each frame and derives
  `secondsToFrames(currentTime - clipStartSeconds) + clip.start`; it does **not** integrate
  wall-clock time. This is what keeps hour-long playback accurate.
- When the source is not playable (`url === ''`, the fixture case), it integrates
  `performance.now()` deltas at `rate * fps` against a stored anchor, and re-anchors on every
  `seek`.
- It writes with `readStore().seek(frame)` and only when the integer frame actually changed
  (guard: `if (next !== readStore().playhead)`), so a paused editor performs zero renders.
- `cancelAnimationFrame` in the effect cleanup, and a `pause()` on unmount. No `setInterval`.

The timeline may run its own rAF for *drag rendering* (transform writes), but that loop must never
touch the store.

### 8.5 Two drag systems in one region

The timeline is both an HTML5 drop target and a pointer-events manipulation surface. They must not
see each other.

- **File drop (OS → app):** HTML5 `dragenter`/`dragover`/`drop` on the window. Handler runs only
  when `event.dataTransfer.types.includes('Files')`. Media slice owns the window-level listeners
  and `dropActive`.
- **Media rail → timeline:** HTML5 drag with `dataTransfer.setData(DND_MEDIA_MIME, mediaId)` plus
  a custom drag image. The timeline's drop handler runs only when
  `types.includes(DND_MEDIA_MIME)`, and calls `insertMediaAt(mediaId, frameAtPointer, trackAtPointer)`.
- **Clip manipulation inside the timeline:** `pointerdown` / `setPointerCapture` /
  `pointermove` / `pointerup` **only**. It must never call `draggable`, never set
  `dataTransfer`, and must `preventDefault()` on `dragstart` within the lane area. `DND_CLIP_MIME`
  is declared but deliberately unused — internal clip drags do not use HTML5 DnD at all.
- `dropActive` is set on `dragenter` with `Files` and cleared on `dragleave` **counted with a
  depth counter** (dragleave fires on every child), on `drop`, and on `dragend`.

Risk: dragging a clip lights up "Drop video files here" across the whole window. Contract: the
`Files` type check plus pointer-events-only internal drags.

### 8.6 Frames vs pixels vs seconds

Every renderer that draws on the timeline uses the same expression, no local variants:

```ts
const x = framesToPx(frame, zoom) - scrollX;      // px in the lane viewport
const frame = pxToFrames(clientX - laneRect.left + scrollX, zoom);
```
`zoom` is **pixels per frame**, always. Not px/second, not a zoom "level", not a log scale.
`scrollX` is px and is stored, not read from `element.scrollLeft` at draw time (the ruler,
lanes and playhead must agree within one frame; reading the DOM in three places will not).
`SNAP_THRESHOLD_PX` is converted to frames per-evaluation: `threshold = SNAP_THRESHOLD_PX / zoom`.

### 8.7 Selection identity and re-render cost

`selection` is a `ReadonlySet` replaced wholesale on every change. A `Clip` component subscribes
with `useEditorStore(s => s.selection.has(clip.id))` — a boolean, so only clips whose selection
actually changed re-render. Never `useEditorStore(s => s.selection)` in a leaf. Never
`Array.from(selection)` inside a selector.

`Clip` is `React.memo` and must not receive a new object/array/function prop on every parent
render — hoist handlers to the `Track` level and pass ids through `data-clip-id` + event
delegation on the lane. At 40 clips × 6 tracks, a pointermove must cause zero React renders.

### 8.8 History scope

Undo covers `TimelineDoc` only. Consequences the other slices must respect:

- Inspector property edits go through `updateClipProperties`, which opens its own history entry.
  A drag-scrub in a `NumericField` calls `beginHistory('Adjust opacity')` on `pointerdown` (via
  `onChange` first fire) and `commitHistory()` on `onCommit` — one undo step per gesture,
  not one per pixel.
- Media import, theme change, panel resize, zoom, scroll and selection are **not** undoable.
- Undo does not move the playhead.

### 8.9 The export stub boundary

`getEditorAPI().export` is `undefined` in this build. `ExportDialog` resolves its bridge once:

```ts
// src/components/export/exportStub.ts   (inspector-owned)
// TODO(export): replace with the real ffmpeg-backed bridge in electron/ipc/export.ts.
// This stub reports genuine progress for a simulated encode; the UI below it is final and
// must not change when the real bridge lands.
export const exportStub: ExportBridge;
```
```ts
const bridge = getEditorAPI().export ?? exportStub;
```
The dialog drives its determinate progress bar, its frame counter and its cancel button purely
from `ExportProgressEvent`. It never runs its own timer, never interpolates, and never displays a
percentage the bridge did not report. `cancel()` must actually stop the stub and land the UI in
the `cancelled` phase.

Estimated size is computed, not guessed, from a fixed table so the number is reproducible:

```ts
const BITRATE_KBPS = {
  h264:   { draft: 4000,  good: 12000, best: 24000 },
  h265:   { draft: 2500,  good:  8000, best: 16000 },
  prores: { draft: 45000, good: 82000, best: 122000 },
};
bytes = (BITRATE_KBPS[codec][quality] * 1000 / 8) * framesToSeconds(durationFrames, fps)
        * (width * height) / (1920 * 1080);
```

### 8.10 Shortcuts as the single source of truth

`src/keyboard/shortcuts.ts` exports the registry and its ids; **tooltips read from it**, so a
label can never drift from its binding.

```ts
export type ShortcutScope = 'global' | 'timeline' | 'preview' | 'media' | 'dialog';
export interface ShortcutDef {
  id: ShortcutId;
  /** Normalised combos, e.g. 'Space', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Shift+ArrowLeft'.
      'Ctrl' means Cmd on darwin — resolved at render time by ShortcutHint. */
  keys: string[];
  label: string;          // sentence case, imperative: 'Split at playhead'
  scope: ShortcutScope;
  handler: ShortcutHandlerName;
}
export const SHORTCUTS: readonly ShortcutDef[];
export const SHORTCUT_BY_ID: Record<ShortcutId, ShortcutDef>;
export type ShortcutId =
  | 'play.toggle' | 'shuttle.back' | 'shuttle.stop' | 'shuttle.forward'
  | 'mark.in' | 'mark.out' | 'edit.split' | 'nav.stepBack' | 'nav.stepForward'
  | 'nav.secondBack' | 'nav.secondForward' | 'nav.start' | 'nav.end'
  | 'edit.lift' | 'edit.ripple' | 'edit.undo' | 'edit.redo'
  | 'file.import' | 'file.save' | 'view.zoomIn' | 'view.zoomOut' | 'view.zoomFit'
  | 'edit.marker' | 'edit.clearSelection' | 'help.shortcuts';
```

`ShortcutHint` (inspector-owned) renders the platform-correct glyphs
(`⌘ ⇧ ⌥ ⌃` on darwin, `Ctrl Shift Alt` elsewhere) from `getEditorAPI().platform`. Other slices
pass `shortcut={<ShortcutHint id="edit.split" />}` into `Tooltip`/`IconButton` — they never
hardcode a key string in a tooltip. If a slice needs a hint for an action it owns, the shortcut id
must already exist in the registry; if it does not, report it rather than inventing a local label.

`useShortcuts()` is mounted once, in `App.tsx`. It attaches one `keydown` listener on `document`,
applies the text-input guard from §5, resolves the combo, and dispatches through
`readStore()`. It must not be mounted a second time by any slice.

### 8.11 Sub-1180px inspector overlay

Below `INSPECTOR_OVERLAY_BREAKPOINT`, the shell positions the inspector
`position: absolute; right: 0; top: 0; bottom: 0; z-index: var(--z-inspector)` over the preview
rather than adding a grid column. `Inspector` is width-agnostic and must not assume 280 px; it
fills its container. `PreviewWell` must letterbox against its measured box (`ResizeObserver`), not
a computed "available width" — so it stays correct whether the inspector displaces or overlays.

### 8.12 IPC registration and channel names

`electron/main.ts` (scaffold) contains exactly:

```ts
import { registerMediaIpc } from './ipc/media';
import { registerProjectIpc } from './ipc/project';
registerMediaIpc(ipcMain);
registerProjectIpc(ipcMain);
```
Both must export `export function registerXIpc(ipcMain: IpcMain): void` and register **only** the
channels named in §4's `CH`. A handler registered under a name the preload does not call is dead
code; a preload call to a name no handler registered hangs forever. Import `CH` from
`../../src/types/api` in both — never retype the string.

`media:probe` must resolve `{ ok: false, error: { code: 'ffmpeg-missing' } }` when `spawn` emits
`ENOENT`, resolve `not-found` when `fs.access` fails, and never leave a temp thumbnail behind on
failure. It must never `throw` across the bridge and never resolve `ok` with partial data.

### 8.13 Track structure must exist before a drop lands

A brand-new project has no tracks, so a first drop has nowhere to go. Contract: `hydrateTimeline`
with an empty clip list still creates the default track set — `V2, V1, A1, A2` — and
`insertMediaAt` adds a track when every track of the right kind is occupied or locked at the
target frame. The timeline's "media exists, nothing placed" state therefore always has lanes to
show, which is exactly the affordance the brief asks for.

### 8.14 Empty-state ownership

Only one empty state exists in the app, and it is the media rail's. The preview well shows the
bare surface (no icon, no text) when nothing is loaded; the timeline shows its lane structure plus
one muted line. Neither may add a heading, an illustration, or a call to action. If two slices
each ship an empty state, the first screen becomes a sales page, which PRODUCT.md principle 5
forbids outright.

---

## 9. Definition of done, per slice

- No colour literal, no `z-index` number, no custom property outside §7.
- Every interactive element: all seven states, an accessible name, and a visible focus ring.
- Every live numeral: `.type-numeric`.
- Every transition: 120/180/200 ms with `var(--ease-out)`, and a reduced-motion path.
- Sentence case; uppercase only in `Track.label`.
- Runs under `npm run dev:web` with `bootstrapFixtures()` and renders fully populated.
- `tsc --noEmit` clean against the other four slices' declared exports.
- Keyboard-only walkthrough of the slice completes without a trap.
