/* ---------------------------------------------------------------------------
   mediaSlice.ts — OWNER: media.

   The media library and the whole import path. PLAN §3.2.

   Import flow, exactly (PLAN §3.2):
     1. addItem immediately as 'probing' — the row appears at once.
     2. probe each path through a pool capped at PROBE_CONCURRENCY (never
        Promise.all an unbounded list: 40 files must not stall the UI or the
        ffmpeg host). The same pool serves hydrateMedia's re-probe on open.
     3. ok  -> status 'ready', ProbeData spread in (INCLUDING `url` — that is
              the assignment that makes real media playable), durationFrames
              derived from the PROJECT fps.
     4. err -> status 'error' + MediaError. The row renders icon + word +
              hairline and offers Retry / Remove (PLAN §7.6).
     5. the first ready video item adopts the project format — this is how fps
        and resolution get set without a setup modal.
     6. every later ready item is compared against the project format and
        carries a MediaWarning per mismatch. This is the sole owner of
        --status-warning in the build.
     7. markDirty — via addItem, which is on PLAN §3.1's dirty list.

   Browser (no window.editorAPI, no filesystem path): a dropped File is read
   through an object URL and a media element, so `npm run dev:web` exercises the
   real drop path rather than a stub. PLAN §3.2: never `(file as any).path`.
--------------------------------------------------------------------------- */

import type { ProbeResult } from '../types/api';
import type {
  MediaId,
  MediaItem,
  MediaKind,
  MediaStatus,
  MediaWarning,
  PersistedMediaItem,
} from '../types/model';
import type { SliceCreator, StoreState } from './types';
import { getEditorAPI } from '../lib/editorApi';
import { newId } from '../lib/id';
import { secondsToFrames } from '../lib/time';

/* ------------------------------------------------------------------- types */

export interface MediaState {
  items: Record<MediaId, MediaItem>;
  /** Insertion order, drives rail row order. */
  order: MediaId[];
  /** True while a file drag from the OS is over the window. Drives the drop affordance. */
  dropActive: boolean;
}

export interface MediaActions {
  /** Opens the native picker (or the fixture picker) and imports the result. */
  importFromPicker(): Promise<void>;
  /** Electron path: absolute fs paths. */
  importPaths(paths: string[]): Promise<void>;
  /** Browser/DnD path. Resolves each File to a path via the bridge. */
  importFiles(files: File[]): Promise<void>;
  addItem(item: MediaItem): void;
  updateItem(id: MediaId, patch: Partial<MediaItem>): void;
  /** Does not delete clips: calls get().markClipsOffline(id). */
  removeItem(id: MediaId): void;
  retryItem(id: MediaId): void;
  setDropActive(active: boolean): void;
  /** Re-derives durationFrames for every item after a project-fps change. */
  recomputeMediaDurations(fps: number): void;
  /** Inserts as 'probing', then re-probes by path. */
  hydrateMedia(items: PersistedMediaItem[]): void;
}

export type MediaSlice = MediaState & MediaActions;

/* --------------------------------------------------------------- constants */

/** PLAN §3.2 step 2. Probing 40 files must not stall the UI or the ffmpeg host. */
const PROBE_CONCURRENCY = 3;

/** Only used to guess `kind` for the optimistic row; the probe is authoritative. */
const AUDIO_EXTENSIONS = new Set([
  'wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'wma', 'caf', 'mka',
]);

/** How far apart two frame rates may sit before it is worth telling the user. */
const FPS_EPSILON = 0.05;

/* ----------------------------------------------------------------- helpers */

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : Number.isFinite(n) ? n : 0);

const basename = (p: string): string => {
  const parts = p.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : p;
};

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const guessKind = (name: string): MediaKind =>
  AUDIO_EXTENSIONS.has(extensionOf(name)) ? 'audio' : 'video';

/** 29.97 stays 29.97; 30.000 reads as 30. */
const formatFps = (fps: number): string => String(Number(fps.toFixed(3)));

const isObjectUrl = (url: string): boolean => url.startsWith('blob:');

/**
 * A browser-imported row's `path` is the bare File name — there is no
 * filesystem path to hand the bridge. An Electron path always carries a
 * separator, so this tells the two apart without a new field on MediaItem.
 */
const isProbeablePath = (p: string): boolean => p.length > 0 && /[\\/]/.test(p);

/**
 * Whether a row can be re-probed. A browser row cannot: re-probing it would
 * send a bare filename across the bridge, overwrite its live object URL with
 * whatever the bridge answered, and leak the blob. The rail hides Retry for
 * those rows rather than offering an action that would corrupt them.
 */
export const canRetryMedia = (item: MediaItem): boolean =>
  !isObjectUrl(item.url) && isProbeablePath(item.path);

function pendingItem(path: string, name: string, kind: MediaKind): MediaItem {
  return {
    id: newId('m'),
    path,
    url: '',
    name,
    kind,
    status: 'probing',
    error: null,
    warnings: [],
    progress: 0,
    durationFrames: 0,
    durationSeconds: 0,
    width: 0,
    height: 0,
    fps: 0,
    codec: '',
    hasAudio: false,
    thumbnailUrl: null,
    addedAt: Date.now(),
  };
}

/* ------------------------------------------------------------- the one gate
   ONE global semaphore, not a per-call pool. Every route that spawns a probe
   goes through it — the picker, a file drop, hydrateMedia's re-probe on open,
   and Retry. A per-call pool would let ten Retry clicks start ten concurrent
   ffprobe/ffmpeg pairs, which is exactly the ffmpeg-host stall the cap exists
   to prevent.                                                               */

let probesInFlight = 0;
const probeWaiters: Array<() => void> = [];

function acquireProbeSlot(): Promise<void> {
  if (probesInFlight < PROBE_CONCURRENCY) {
    probesInFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => probeWaiters.push(resolve));
}

function releaseProbeSlot(): void {
  const next = probeWaiters.shift();
  if (next) {
    next(); // the slot is handed straight over; probesInFlight is unchanged
    return;
  }
  probesInFlight -= 1;
}

/** Runs `worker` over `jobs` against the one global gate. Never rejects. */
async function pooled<T>(jobs: T[], worker: (job: T) => Promise<void>): Promise<void> {
  await Promise.all(
    jobs.map(async (job) => {
      await acquireProbeSlot();
      try {
        await worker(job);
      } catch {
        // One job must never take the others down: the remaining files would be
        // abandoned mid-import with their rows stuck on 'probing'. The row
        // itself already carries whatever error state it earned.
      } finally {
        releaseProbeSlot();
      }
    }),
  );
}

/* ------------------------------------------------- browser-only file reading
   `media.pathForFile` returns null outside Electron, so there is no path to
   probe. The file is still real, so read it the way the browser can: an object
   URL plus a media element for the metadata and one canvas frame for the
   thumbnail. Nothing here runs in the Electron path.                        */

function onceEvent(
  el: HTMLMediaElement,
  event: 'loadedmetadata' | 'seeked',
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener('error', bad);
    };
    const ok = (): void => {
      cleanup();
      resolve();
    };
    const bad = (): void => {
      cleanup();
      reject(new Error(`media element failed before ${event}`));
    };
    const timer = window.setTimeout(bad, timeoutMs);
    el.addEventListener(event, ok);
    el.addEventListener('error', bad);
  });
}

async function grabFrame(video: HTMLVideoElement): Promise<string | null> {
  try {
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    video.currentTime = Math.min(1, (video.duration || 0) / 2);
    await onceEvent(video, 'seeked', 6000);
    const width = 320;
    const height = Math.max(2, Math.round((video.videoHeight / video.videoWidth) * width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

interface BrowserProbe {
  kind: MediaKind;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  thumbnailUrl: string | null;
}

async function readBrowserFile(url: string, kind: MediaKind): Promise<BrowserProbe> {
  if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = url;
    await onceEvent(audio, 'loadedmetadata', 10000);
    const durationSeconds = Number.isFinite(audio.duration) ? audio.duration : 0;
    audio.src = '';
    return { kind: 'audio', durationSeconds, width: 0, height: 0, hasAudio: true, thumbnailUrl: null };
  }

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.src = url;
  await onceEvent(video, 'loadedmetadata', 10000);
  const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const thumbnailUrl = await grabFrame(video);
  video.src = '';
  return {
    kind: width > 0 ? 'video' : 'audio',
    durationSeconds,
    width,
    height,
    // The element cannot enumerate tracks; a video container is assumed to carry sound
    // unless it has no dimensions, in which case it is audio and certainly does.
    hasAudio: true,
    thumbnailUrl,
  };
}

/* ------------------------------------------------------------------- slice */

export const createMediaSlice: SliceCreator<MediaSlice> = (set, get) => {
  /** PLAN §3.2 step 6. Compares a ready item against the adopted project format. */
  const warningsFor = (item: {
    kind: MediaKind;
    fps: number;
    width: number;
    height: number;
  }): MediaWarning[] => {
    const s = get();
    const warnings: MediaWarning[] = [];
    if (item.fps > 0 && Math.abs(item.fps - s.fps) > FPS_EPSILON) {
      warnings.push({
        code: 'fps-mismatch',
        message: `Source runs at ${formatFps(item.fps)} fps, the project at ${formatFps(s.fps)}`,
      });
    }
    if (
      item.kind === 'video' &&
      item.width > 0 &&
      item.height > 0 &&
      (item.width !== s.width || item.height !== s.height)
    ) {
      warnings.push({
        code: 'resolution-mismatch',
        message: `Source is ${item.width}×${item.height}, the project is ${s.width}×${s.height}`,
      });
    }
    return warnings;
  };

  /** Lands a finished probe on a row. Steps 3–6. */
  const applyProbe = (id: MediaId, result: ProbeResult): void => {
    if (!get().items[id]) return; // removed while probing

    if (!result.ok) {
      get().updateItem(id, { status: 'error', error: result.error, progress: 1 });
      get().markClipsOffline(id);
      return;
    }

    const data = result.data;
    get().updateItem(id, {
      status: 'ready',
      error: null,
      progress: 1,
      kind: data.kind,
      url: data.url,
      thumbnailUrl: data.thumbnailUrl,
      durationSeconds: data.durationSeconds,
      durationFrames: secondsToFrames(data.durationSeconds, get().fps),
      width: data.width,
      height: data.height,
      fps: data.fps,
      codec: data.codec,
      hasAudio: data.hasAudio,
      warnings: [],
    });

    // Step 5: the first ready video item sets the project format. adoptSourceFormat
    // is a no-op once formatLocked, and it re-derives every duration itself.
    if (!get().formatLocked && data.kind === 'video' && data.fps > 0 && data.width > 0) {
      get().adoptSourceFormat({ fps: data.fps, width: data.width, height: data.height });
    }

    // Step 6: every item — including the one that just adopted — is measured against
    // the project format that is now in force.
    const warnings = warningsFor(data);
    if (warnings.length > 0) get().updateItem(id, { warnings });

    get().recomputeOfflineClips();
  };

  /** One row's probe, with the bridge's progress events wired to that row. */
  const probeRow = async (id: MediaId, path: string): Promise<void> => {
    const api = getEditorAPI();
    const off = api.media.onProbeProgress((e) => {
      if (e.path !== path) return;
      const item = get().items[id];
      if (!item || item.status !== 'probing') return;
      get().updateItem(id, { progress: clamp01(e.progress) });
    });
    try {
      applyProbe(id, await api.media.probe(path));
    } finally {
      off();
    }
  };

  const probeRows = (jobs: Array<{ id: MediaId; path: string }>): Promise<void> =>
    pooled(jobs, (job) => probeRow(job.id, job.path));

  /** The browser drop path: no filesystem path, so read the File itself. */
  const importBrowserFile = async (file: File): Promise<void> => {
    const kind: MediaKind = file.type.startsWith('audio/') ? 'audio' : guessKind(file.name);
    const item = pendingItem(file.name, file.name, kind);
    get().addItem(item);

    const url = URL.createObjectURL(file);
    try {
      const probed = await readBrowserFile(url, kind);
      if (!get().items[item.id]) {
        URL.revokeObjectURL(url);
        return;
      }
      get().updateItem(item.id, {
        status: 'ready',
        error: null,
        progress: 1,
        kind: probed.kind,
        url,
        thumbnailUrl: probed.thumbnailUrl,
        durationSeconds: probed.durationSeconds,
        durationFrames: secondsToFrames(probed.durationSeconds, get().fps),
        width: probed.width,
        height: probed.height,
        fps: 0, // the element cannot report a frame rate; 0 means "unknown", never used to convert
        codec: file.type,
        hasAudio: probed.hasAudio,
        warnings: [],
      });

      // Step 5 applies to this path too. Without it the very first import into
      // an empty project would be measured against the untouched 1920×1080
      // default and warn about a format the project was never given the chance
      // to adopt. The project fps is passed through unchanged — a media element
      // cannot report a frame rate — so only the dimensions are adopted, and
      // adoptSourceFormat itself refuses anything with fps <= 0 or width <= 0.
      if (!get().formatLocked && probed.kind === 'video' && probed.width > 0) {
        get().adoptSourceFormat({
          fps: get().fps,
          width: probed.width,
          height: probed.height,
        });
      }

      // Step 6, and only after the adoption above: the item is measured against
      // the project format that is now in force.
      const warnings = warningsFor({
        kind: probed.kind,
        fps: 0,
        width: probed.width,
        height: probed.height,
      });
      if (warnings.length > 0) get().updateItem(item.id, { warnings });
      get().recomputeOfflineClips();
    } catch {
      URL.revokeObjectURL(url);
      if (!get().items[item.id]) return;
      get().updateItem(item.id, {
        status: 'error',
        progress: 1,
        error: {
          code: 'unsupported-codec',
          message: 'This browser cannot decode the file',
        },
      });
      get().markClipsOffline(item.id);
    }
  };

  return {
    items: {},
    order: [],
    dropActive: false,

    /* ------------------------------------------------------------- import */

    importFromPicker: async () => {
      const paths = await getEditorAPI().media.pickFiles();
      if (paths.length === 0) return; // cancelled: not an error, nothing to say
      await get().importPaths(paths);
    },

    importPaths: async (paths) => {
      const clean = paths.filter((p) => typeof p === 'string' && p.length > 0);
      if (clean.length === 0) return;
      const jobs = clean.map((path) => {
        const name = basename(path);
        const item = pendingItem(path, name, guessKind(name));
        get().addItem(item); // step 1: the row appears before the probe starts
        return { id: item.id, path };
      });
      await probeRows(jobs);
    },

    importFiles: async (files) => {
      if (files.length === 0) return;
      const api = getEditorAPI();
      const paths: string[] = [];
      const browserFiles: File[] = [];
      for (const file of files) {
        const path = api.media.pathForFile(file);
        if (path) paths.push(path);
        else browserFiles.push(file);
      }
      await Promise.all([
        paths.length > 0 ? get().importPaths(paths) : Promise.resolve(),
        pooled(browserFiles, importBrowserFile),
      ]);
    },

    retryItem: (id) => {
      const item = get().items[id];
      if (!item || item.status === 'probing') return;
      // A browser row has no probeable path (canRetryMedia). Retrying it would
      // send a bare filename over the bridge and leak its object URL.
      if (!canRetryMedia(item)) return;
      get().updateItem(id, { status: 'probing', progress: 0, error: null, warnings: [] });
      // Through the pool, not around it: retrying ten failed rows must not launch
      // ten concurrent ffprobe/ffmpeg pairs at the host.
      void probeRows([{ id, path: item.path }]);
    },

    /* -------------------------------------------------------------- store */

    addItem: (item) => {
      set((s) => ({
        items: { ...s.items, [item.id]: item },
        order: s.order.includes(item.id) ? s.order : [...s.order, item.id],
      }));
      get().markDirty();
    },

    updateItem: (id, patch) =>
      set((s) => {
        const prev = s.items[id];
        if (!prev) return {};
        return { items: { ...s.items, [id]: { ...prev, ...patch } } };
      }),

    removeItem: (id) => {
      const item = get().items[id];
      if (!item) return;
      if (isObjectUrl(item.url)) URL.revokeObjectURL(item.url);
      set((s) => {
        const items = { ...s.items };
        delete items[id];
        return { items, order: s.order.filter((existing) => existing !== id) };
      });
      // Clips are NOT deleted: they go offline and the project stays editable.
      get().markClipsOffline(id);
      get().markDirty();
    },

    setDropActive: (active) =>
      set((s) => (s.dropActive === active ? {} : { dropActive: active })),

    recomputeMediaDurations: (fps) =>
      set((s) => {
        let changed = false;
        const items: Record<MediaId, MediaItem> = { ...s.items };
        for (const id of s.order) {
          const item = items[id];
          if (!item || item.durationSeconds <= 0) continue;
          const durationFrames = secondsToFrames(item.durationSeconds, fps);
          if (durationFrames === item.durationFrames) continue;
          items[id] = { ...item, durationFrames };
          changed = true;
        }
        return changed ? { items } : {};
      }),

    hydrateMedia: (items) => {
      // The outgoing set is replaced wholesale, so any live object URL in it
      // would be leaked. removeItem revokes on the single-row path; this is the
      // same obligation on the bulk path.
      const outgoing = get().items;
      for (const id of get().order) {
        const prev = outgoing[id];
        if (prev && isObjectUrl(prev.url)) URL.revokeObjectURL(prev.url);
      }

      const next: Record<MediaId, MediaItem> = {};
      const order: MediaId[] = [];
      for (const persisted of items) {
        next[persisted.id] = {
          ...persisted,
          url: '',
          status: 'probing',
          progress: 0,
          error: null,
          warnings: [],
          thumbnailUrl: null,
        };
        order.push(persisted.id);
      }
      set({ items: next, order });
      get().recomputeOfflineClips();
      // Re-probe every item by path through the same capped pool as an import. This is
      // also the only way a moved or deleted file is detected (PLAN §2.6).
      void probeRows(order.map((id) => ({ id, path: next[id].path })));
    },
  };
};

/* --------------------------------------------------------------- selectors */

/** [stable] */
export const selectMediaItem = (s: StoreState, id: MediaId): MediaItem | undefined => s.items[id];

/** [stable] The rail row list. `order` is only reallocated on add/remove. */
export const selectMediaOrder = (s: StoreState): readonly MediaId[] => s.order;

/** [stable] */
export const selectMediaStatus = (s: StoreState, id: MediaId): MediaStatus | undefined =>
  s.items[id]?.status;

/** [stable] Cheap scan over `order`, returns a boolean. Safe in a hook. */
export const selectIsImporting = (s: StoreState): boolean =>
  s.order.some((id) => s.items[id]?.status === 'probing');

/** [stable] */
export const selectOfflineMediaCount = (s: StoreState): number =>
  s.order.reduce((n, id) => n + (s.items[id]?.status === 'error' ? 1 : 0), 0);

/** [UNSTABLE REFERENCE] readStore() / useShallow only. */
export const selectAllMedia = (s: StoreState): MediaItem[] =>
  s.order.map((id) => s.items[id]).filter(Boolean);

/** [UNSTABLE REFERENCE] readStore() / useShallow only. */
export const selectOfflineMedia = (s: StoreState): MediaItem[] =>
  selectAllMedia(s).filter((m) => m.status === 'error');
