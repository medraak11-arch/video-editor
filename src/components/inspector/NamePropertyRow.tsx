/* ---------------------------------------------------------------------------
   NamePropertyRow — the inspector's `Name` field. RENAME.md §Inspector.

   The one inspector row that is not a NumericField, so the work here is making
   it read as part of the same rhythm rather than as a visitor: it goes through
   `PropertyRow`, so the label sits in the same 84px column, the control fills
   the same track, and the row keeps the same minimum height. The extension
   beside the field occupies the position a NumericField's suffix occupies, which
   is why `%`, `°` and `.mp4` all land on the same optical column.

   It renames the FILE, not the clip. `Clip.name` is a separate, display-only
   string; a field that changed both would make one gesture do two things, only
   one of which is undoable.

   Multi-selection is a disabled state, not a hidden one: RENAME.md asks for a
   `disabledReason` there, and a field that vanishes cannot carry one. Two clips
   cut from the SAME file are still one file, so they stay renameable — the rule
   is one media item at a time, not one clip.

   A TITLE CLIP TAKES THE OTHER BRANCH ENTIRELY. CREATIVE §5.1: a title carries
   `mediaId: ''`, and every media lookup must SKIP title clips rather than
   resolve an empty id. This row is a media lookup — the one in the inspector —
   and without the guard a title falls through to `items['']`, comes back
   undefined and renders `Missing` with "that clip no longer has a media file",
   which is a fabricated error about a clip that never had one. §9.4 names this
   exact bug shape as having burned the project before.

   So a title renames its CLIP through `renameClip`, which is the right target
   anyway: `Clip.name` is what the timeline paints and what the panel heading
   reads, and a title has no file behind it whose name could mean anything else.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useCallback, useEffect, useId, useMemo } from 'react';
import type { ReactElement } from 'react';
import type { Clip, MediaId } from '../../types/model';
import { clipIsTitle } from '../../types/model';
import { readStore, useEditorStore } from '../../state/store';
import { MediaNameField } from '../media/MediaNameField';
import { TextField } from '../ui';
import { PropertyRow } from './PropertyRow';

/** RENAME.md §Scope: one item at a time. */
const MULTI_REASON = 'The selection covers more than one file';
/** The clip outlived its media row — Remove from project does not delete clips. */
const GONE_REASON = 'That clip no longer has a media file in this project';

export interface NamePropertyRowProps {
  /** The current selection. Never empty when this row is rendered. */
  clips: readonly Clip[];
}

export function NamePropertyRow({ clips }: NamePropertyRowProps): ReactElement {
  const fieldId = useId();

  // Rename is blocked while an export is running; this is what maintains that
  // flag when the media rail is collapsed and never mounted.
  useEffect(() => {
    readStore().watchExportActivity();
  }, []);

  /** Title clips contribute no mediaId — `''` is not an id to look up. */
  const mediaIds = useMemo<MediaId[]>(() => {
    const seen: MediaId[] = [];
    for (const clip of clips) {
      if (clipIsTitle(clip)) continue;
      if (!seen.includes(clip.mediaId)) seen.push(clip.mediaId);
    }
    return seen;
  }, [clips]);

  /** Exactly one clip, and it is a title: rename the clip, not a file. */
  const titleClip = clips.length === 1 && clips[0] && clipIsTitle(clips[0]) ? clips[0] : null;

  const candidate = mediaIds.length === 1 ? mediaIds[0] : null;
  // A clip whose media was removed still holds its mediaId. The row keeps its
  // label bound to a real control rather than rendering an empty column.
  const present = useEditorStore(
    useCallback((s) => candidate !== null && s.items[candidate] !== undefined, [candidate]),
  );
  const only = present ? candidate : null;

  return (
    <PropertyRow label="Name" htmlFor={fieldId}>
      {titleClip !== null ? (
        <TextField
          id={fieldId}
          value={titleClip.name}
          label="Name"
          onChange={() => undefined}
          onCommit={(next) => {
            const trimmed = next.trim();
            // An empty name would leave the clip and the panel heading blank
            // with nothing to click back into. Reverting is the store's own
            // behaviour for a rename it will not take.
            if (trimmed === '' || trimmed === titleClip.name) return;
            readStore().beginHistory('Rename clip');
            readStore().renameClip(titleClip.id, trimmed);
            readStore().commitHistory();
          }}
        />
      ) : only !== null ? (
        <MediaNameField id={only} inputId={fieldId} label="Name" />
      ) : (
        // The same word NumericField uses for a selection that disagrees, so a
        // mixed row reads the same whatever kind of control is in it.
        <TextField
          id={fieldId}
          value={candidate === null ? 'Mixed' : 'Missing'}
          label="Name"
          disabled
          disabledReason={candidate === null ? MULTI_REASON : GONE_REASON}
          onChange={() => undefined}
          onCommit={() => undefined}
        />
      )}
    </PropertyRow>
  );
}
