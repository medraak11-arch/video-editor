/* ---------------------------------------------------------------------------
   electron/ffmpeg.ts — OWNER: packaging. The one place that decides WHERE the
   ffmpeg and ffprobe binaries come from.

   Before this file existed, electron/ipc/media.ts and electron/ipc/export.ts
   each spawned the bare names 'ffprobe' and 'ffmpeg' and got whatever PATH
   happened to hold. That is correct on a machine with ffmpeg installed and
   broken on every other machine, which is not a property a shipped installer
   may have. Both modules now ask this module instead, so there is exactly one
   answer to "which ffmpeg?" and it is stated once.

   Resolution order, first hit wins:

     1. process.env.VE_FFMPEG_DIR   — an explicit override, for running a build
        against a specific ffmpeg without reinstalling anything. It is also how
        the packaged resolution path gets exercised in development.
     2. <resources>/ffmpeg/         — the bundled copy, PACKAGED BUILDS ONLY.
        electron-builder's `extraResources` places scripts/../build/ffmpeg there;
        see electron-builder.yml and scripts/stage-ffmpeg.mjs.
     3. the bare name                — PATH, which is what a `npm run dev` build
        has always used and still uses.

   Step 3 is not dead code in a packaged build: it is what keeps the app working
   if the bundled resource is ever missing (a partial install, an antivirus
   quarantine, someone assembling a build by hand). A missing binary therefore
   stays a REACHABLE, meaningful error — MediaErrorCode / ExportErrorCode
   'ffmpeg-missing' — rather than something bundling is assumed to have made
   impossible.

   Resolution is cached per tool. It reads the filesystem once and the answer
   cannot change while the app runs.
--------------------------------------------------------------------------- */

import { app } from 'electron';
import { accessSync, constants as FS } from 'node:fs';
import path from 'node:path';

export type FfmpegTool = 'ffmpeg' | 'ffprobe';

/** Where the resolved command came from. 'path' means "spawn the bare name". */
export type FfmpegOrigin = 'override' | 'bundled' | 'path';

export interface FfmpegResolution {
  tool: FfmpegTool;
  /** The first argument to `spawn`. An absolute path, or the bare tool name. */
  command: string;
  origin: FfmpegOrigin;
}

/** win32 needs the extension; POSIX must not have one. */
const SUFFIX = process.platform === 'win32' ? '.exe' : '';

/**
 * The folder name inside `resources/`. It is duplicated in electron-builder.yml
 * (`extraResources.to`) and in scripts/stage-ffmpeg.mjs; all three must agree,
 * which is why each of them names this file in a comment.
 */
const BUNDLE_FOLDER = 'ffmpeg';

const cache = new Map<FfmpegTool, FfmpegResolution>();

const executableIn = (dir: string, tool: FfmpegTool): string =>
  path.join(dir, `${tool}${SUFFIX}`);

/**
 * X_OK is not meaningful on win32 — Node reports it for any readable file — so
 * this is an existence check there and a real permission check on POSIX. Either
 * way a false answer means "keep looking", never "throw".
 */
function isRunnable(file: string): boolean {
  try {
    accessSync(file, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bundled directory, or null when this build cannot have one.
 *
 * `process.resourcesPath` exists in development too, but it points at the
 * Electron install's own resources — nothing this project controls — so the
 * bundled lookup is deliberately gated on `app.isPackaged`. Development
 * resolves through PATH, exactly as it always has.
 */
function bundleDir(): string | null {
  if (!app.isPackaged) return null;
  return path.join(process.resourcesPath, BUNDLE_FOLDER);
}

function resolve(tool: FfmpegTool): FfmpegResolution {
  const override = process.env.VE_FFMPEG_DIR;
  if (override && override.trim() !== '') {
    const candidate = executableIn(override.trim(), tool);
    if (isRunnable(candidate)) return { tool, command: candidate, origin: 'override' };
  }

  const bundled = bundleDir();
  if (bundled) {
    const candidate = executableIn(bundled, tool);
    if (isRunnable(candidate)) return { tool, command: candidate, origin: 'bundled' };
  }

  return { tool, command: tool, origin: 'path' };
}

/** The resolution for one tool, computed once. */
export function ffmpegResolution(tool: FfmpegTool): FfmpegResolution {
  const hit = cache.get(tool);
  if (hit) return hit;
  const found = resolve(tool);
  cache.set(tool, found);
  return found;
}

/**
 * What to hand `spawn`. Callers pass this straight through as argv[0] and keep
 * treating ENOENT as 'ffmpeg-missing' — the contract on either side is unchanged,
 * only the lookup moved.
 */
export function ffmpegCommand(tool: FfmpegTool): string {
  return ffmpegResolution(tool).command;
}

/**
 * One line, written to the main-process log at startup. Packaged builds have no
 * terminal, so when someone reports "it cannot read my files" this is the first
 * thing worth knowing and the only place it is recorded.
 */
export function describeFfmpegResolution(): string {
  return (['ffmpeg', 'ffprobe'] as const)
    .map((tool) => {
      const r = ffmpegResolution(tool);
      return r.origin === 'path' ? `${tool}=PATH` : `${tool}=${r.origin}:${r.command}`;
    })
    .join(' ');
}
