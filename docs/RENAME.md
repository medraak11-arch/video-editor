# Rename media files from the app

Rename the real file on disk, from the media rail context menu and from a name field in the
inspector. Decided with the user; this document is the contract.

## Why this is small

`Clip.mediaId` references media by id — `path`, `url` and `name` exist only on `MediaItem`
(`src/types/model.ts`). One `MediaItem` update therefore fixes every clip on the timeline, every
thumbnail strip and the preview source at once. There is no path stored anywhere else, and
nothing needs to walk the timeline.

The hard parts are not the model. They are: the file may be open, the name may be illegal on
Windows, and the operation is not undoable.

## Scope

- Renames the **base name only**. The extension is preserved and is not editable — the container
  and codec are bound to it, and letting someone turn `.mp4` into `.mov` would produce a file
  that lies about itself.
- Same directory only. Moving a file is a different feature.
- One item at a time. With a multi-selection the inspector field is disabled with a
  `disabledReason`; the context menu acts on the row it was opened on.

## IPC contract

Add to `src/types/api.ts`, following the existing `CH` pattern:

```ts
mediaRename: 'media:rename',
```

```ts
export type RenameError =
  | { code: 'invalid-name';  message: string }
  | { code: 'name-taken';    message: string }
  | { code: 'not-found';     message: string }
  | { code: 'permission';    message: string }
  | { code: 'file-in-use';   message: string }
  | { code: 'io-failed';     message: string };

export type RenameResult =
  | { ok: true; path: string; url: string; name: string }
  | { ok: false; error: RenameError };

// on EditorAPI.media:
/** Renames the file on disk. `baseName` excludes the extension. Never throws. */
rename(path: string, baseName: string): Promise<RenameResult>;
```

The main process returns the new `url` rather than letting the renderer rebuild it, so the
`ve-media://` encoding stays owned by one place.

## Validation, in the main process

The renderer validates for immediate feedback; the main process validates again because it is the
trust boundary. Both read one shared predicate.

Reject, with `invalid-name`:

- empty, or only whitespace
- contains any of `< > : " / \ | ? *` or a control character (0x00–0x1F)
- is a reserved Windows device name, case-insensitively, with or without an extension:
  `CON PRN AUX NUL COM1-9 LPT1-9`
- ends in a dot or a space — Windows silently strips these, so the file would not have the name
  the user asked for
- base name longer than 200 characters, or a resulting full path over 255

Reject with `name-taken` if the target already exists — **never overwrite.** Compare
case-insensitively on Windows, but allow a rename that differs only in case (`clip.mp4` →
`Clip.mp4`), which `fs.rename` handles correctly on NTFS.

If the new base name equals the current one, succeed as a no-op without touching the disk.

## The file-lock problem

The preview holds the current clip in a `<video>` element, and on Windows an open handle can make
`fs.rename` fail with `EBUSY` or `EPERM`. Renaming is usually permitted where deleting is not,
but "usually" is not a contract.

Protocol, driven by the renderer:

1. Set the media item's status to `renaming` so the row shows a spinner and the field is busy.
2. Detach the source: clear `src` on any `<video>` in the pool currently pointing at this media
   and call `load()`, then await a microtask so the handle is released.
3. Call `editorAPI.media.rename(...)`.
4. On success, update the `MediaItem` (`path`, `url`, `name`) — the pool re-attaches from the new
   url on the next render, and playback resumes at the same playhead frame.
5. On failure, re-attach the original url and surface the error on the row. The playhead must not
   move and playback state must not change.

If the rename fails specifically with `EBUSY`/`EPERM` after detaching, report `file-in-use` with
"Another program is using that file. Close it and try again." — this is the honest message; do
not retry in a loop.

## Undo

**A disk rename is not part of timeline history, deliberately.** `history` is a stack of
`TimelineDoc` snapshots (PLAN §3.4). Putting a filesystem side effect in it means a later Ctrl+Z,
issued to undo an unrelated trim, would silently rename a file back on disk. That is a surprise
with real consequences outside the app.

So: rename does not push a history entry, and Ctrl+Z never reverses it. The safety is that the
action is explicit — a context-menu item or a deliberate field commit, never an accidental
inline edit — and that failures are non-destructive. The rename does mark the project dirty,
because the stored path changed.

## UI

### Media rail context menu

Right-click a media row, or press the Menu key / Shift+F10 with a row focused. Uses the existing
`Menu` primitive — no new chrome.

- `Rename file…` — opens the rename affordance on that row
- `Reveal in folder` — existing shell integration
- separator
- `Remove from project` — existing

The menu must be keyboard-navigable and must restore focus to the row it was opened from.

### Rename affordance

Inline on the row rather than a dialog: a modal for renaming one string is the "modal as first
thought" that PRODUCT.md rules out. The row swaps its name for a `TextField` containing the base
name, with the extension rendered adjacent as static `--text-muted` so it reads as
`interview_wide_a` + `.mp4` and cannot be edited.

- Enter commits, Escape reverts (the ladder in `TextField` already behaves correctly).
- Invalid input surfaces the error inline via the field's `error` prop: icon + sentence, never
  colour alone. The commit is blocked while invalid.
- While renaming, the row shows the busy state; the rest of the app stays interactive.

### Inspector

A `Name` field at the top of the inspector, above `Transform`, when exactly one clip is selected.
Same `TextField`, same extension suffix, same validation and errors. Disabled with a
`disabledReason` when the selection covers more than one media item.

This is the one inspector field that is not a `NumericField`, so it must still read as part of the
same `PropertyRow` rhythm: label left, control right, identical row height.

## Edge cases

- **Offline media** (`status: 'not-found'`): rename is disabled with the reason "That file could
  not be found on disk."
- **Still probing**: disabled until probing finishes; renaming underneath a running ffprobe is a
  race with no upside.
- **Two media items pointing at the same file**: after rename, both must update. Key the store
  update by resolved path, not only by id.
- **The project file references the old path**: it holds `MediaItem.path`, so saving after a
  rename writes the new path. A project saved *before* the rename and opened after will report
  the media as offline — which is the existing, correct behaviour for a moved file.
- **Rename during export**: the export engine reads source paths when it builds the filter graph.
  Block rename while an export is running, with the reason "Not while an export is running."

## Definition of done

- Renaming from the context menu and from the inspector both rename the real file on disk,
  verified by listing the directory before and after.
- Every clip on the timeline that used the file still plays, and the preview resumes at the same
  frame.
- Each of the six error codes is reachable and shows a human sentence with an icon.
- An illegal Windows name and a colliding name are both refused without touching the disk.
- Renaming the file currently open in the preview succeeds.
- `npm run typecheck`, `npm run build` and `node scripts/check-contract.mjs` all pass.
