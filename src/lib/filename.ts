/* ---------------------------------------------------------------------------
   filename.ts — the ONE rule for a legal media base name. RENAME.md §Validation.

   Imported by BOTH halves of the rename feature: the renderer, which validates
   while the field is being typed so the error appears before Enter, and the main
   process, which validates again because it is the trust boundary and may never
   assume the renderer checked. A second copy of this rule would drift the first
   time either side was edited, and the drift would be silent — the field would
   accept a name that the rename then refuses, or worse, the reverse.

   Pure string work: no node, no DOM, no React. It is compiled into the renderer
   bundle AND into dist-electron, exactly like src/types/api.ts (PLAN §1.2), so it
   must import nothing that only one of them has.

   These are Windows' rules and they are applied on every platform. The app ships
   as a Windows installer; accepting a name here that Windows refuses would only
   move the failure to the moment the user is least able to act on it.
--------------------------------------------------------------------------- */

/** RENAME.md: base name longer than this is refused. */
export const MAX_BASE_NAME_LENGTH = 200;
/** RENAME.md: resulting full path longer than this is refused. */
export const MAX_FULL_PATH_LENGTH = 255;

export type BaseNameProblem =
  | 'empty'
  | 'illegal-character'
  | 'trailing-dot-or-space'
  | 'reserved-name'
  | 'name-too-long'
  | 'path-too-long';

export type BaseNameCheck =
  | { ok: true }
  | {
      ok: false;
      problem: BaseNameProblem;
      /** One sentence, sentence case, no trailing period. Safe to show verbatim. */
      message: string;
    };

/* `< > : " / \ | ? *` — every one of them means something to the Windows shell
   or to path parsing, so none of them can appear in a name. */
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*]/;
/* 0x00–0x1F. Not typeable, but pasteable — and a name carrying one is unopenable.
   Written as a scan rather than a regex so no control character has to appear
   literally in this source file. */
const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
};
/* CON PRN AUX NUL COM1-9 LPT1-9, case-insensitively. Windows resolves these to
   devices no matter what extension follows, so `CON.mp4` is reserved too. */
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export interface SplitPath {
  /** Everything up to and including the last separator. '' when there is none. */
  dir: string;
  /** File name without its extension. */
  base: string;
  /** Extension INCLUDING the leading dot, or '' when the name has none. */
  ext: string;
}

/**
 * Splits an absolute path without node's `path`, because the renderer half of
 * this rule has no node. The original separator is kept in `dir` rather than
 * normalised, so `renamedPath` can rebuild the path byte-for-byte apart from the
 * base name — a rename must not quietly rewrite the rest of the path.
 *
 * A leading dot is part of the name, never an extension: `.env` splits to
 * base '.env', ext ''.
 */
export function splitMediaPath(filePath: string): SplitPath {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dir = cut >= 0 ? filePath.slice(0, cut + 1) : '';
  const file = filePath.slice(cut + 1);
  const dot = file.lastIndexOf('.');
  const hasExtension = dot > 0;
  return {
    dir,
    base: hasExtension ? file.slice(0, dot) : file,
    ext: hasExtension ? file.slice(dot) : '',
  };
}

/** The path `filePath` would have if only its base name changed. Same directory. */
export function renamedPath(filePath: string, baseName: string): string {
  const { dir, ext } = splitMediaPath(filePath);
  return `${dir}${baseName}${ext}`;
}

/** Basename including extension — what `MediaItem.name` holds. */
export function renamedFileName(filePath: string, baseName: string): string {
  return `${baseName}${splitMediaPath(filePath).ext}`;
}

const bad = (problem: BaseNameProblem, message: string): BaseNameCheck => ({
  ok: false,
  problem,
  message,
});

/**
 * The rule. `filePath` is the file being renamed — passing it enables the
 * full-path length check, which cannot be done from the base name alone.
 *
 * Nothing here trims: a trailing space is REPORTED rather than silently removed,
 * because Windows would strip it too and the user would end up with a name they
 * did not ask for (RENAME.md §Validation).
 */
export function checkBaseName(baseName: string, filePath?: string): BaseNameCheck {
  if (baseName.trim().length === 0) {
    return bad('empty', 'A file name cannot be empty');
  }
  if (ILLEGAL_CHARACTERS.test(baseName) || hasControlCharacter(baseName)) {
    return bad('illegal-character', 'A file name cannot contain < > : " / \\ | ? *');
  }
  if (baseName.endsWith('.') || baseName.endsWith(' ')) {
    return bad('trailing-dot-or-space', 'A file name cannot end in a dot or a space');
  }
  // Both the whole base name and the part before its first dot: `CON` and
  // `CON.backup` are equally a device once an extension is appended.
  const firstSegment = baseName.split('.')[0] ?? '';
  if (RESERVED_DEVICE.test(baseName) || RESERVED_DEVICE.test(firstSegment)) {
    return bad('reserved-name', 'That name is reserved by Windows');
  }
  if (baseName.length > MAX_BASE_NAME_LENGTH) {
    return bad('name-too-long', `A file name must be ${MAX_BASE_NAME_LENGTH} characters or fewer`);
  }
  if (filePath !== undefined && renamedPath(filePath, baseName).length > MAX_FULL_PATH_LENGTH) {
    return bad(
      'path-too-long',
      `That name makes the full path longer than ${MAX_FULL_PATH_LENGTH} characters`,
    );
  }
  return { ok: true };
}

/** The predicate, for callers that only need to gate a commit. */
export function isValidBaseName(baseName: string, filePath?: string): boolean {
  return checkBaseName(baseName, filePath).ok;
}

/**
 * True when the two names are the same file on a case-insensitive volume but
 * spelled differently — `clip` -> `Clip`. This is a real rename that must be
 * allowed to proceed, and it is the one case where the target "already existing"
 * is the source itself rather than a collision (RENAME.md §Validation).
 */
export function isCaseOnlyRename(currentBase: string, nextBase: string): boolean {
  return currentBase !== nextBase && currentBase.toLowerCase() === nextBase.toLowerCase();
}
