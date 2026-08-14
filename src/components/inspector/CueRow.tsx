/* ---------------------------------------------------------------------------
   CueRow — one subtitle cue. CREATIVE §6.6.4.

   SUBSCRIBED BY ID, memoised, and that is the load-bearing part. The row reads
   `s.subtitles[id]` for itself, exactly as the timeline subscribes per clip, so
   typing in one cue re-renders one row. The parent hands down an id and an
   index — two primitives — and never the cue object, because a parent that
   passed objects would re-render every mounted row on every keystroke in any of
   them and the memo would buy nothing.

   ABSOLUTELY POSITIONED AT A CONSTANT HEIGHT. The window computes each row's
   offset arithmetically from CUE_ROW_H, so a row whose height depended on its
   own content — two lines of text versus five, a resize handle the user
   dragged — would put every row below it at the wrong place. §6.6.4 states this
   as a requirement rather than an optimisation: the height must not depend on
   what has mounted inside it. The textarea is therefore fixed and unresizable,
   and long cue text scrolls WITHIN the field rather than growing the row.

   `Ctrl+Enter` CLOSES THE CUE AT THE PLAYHEAD (§6.6.1) and is handled by the
   field, not globally, so the cue being closed is always the cue whose field
   has focus. The playhead is read through `readStore()` at the moment the key
   lands rather than subscribed to: subscribing would re-render this row on
   every frame of playback, which is precisely the loop this feature exists to
   keep smooth. Nothing here pauses the transport — no seek, no pause, no
   play-state read — which is what makes §6.6's "playback does not stop" clause
   structurally true here rather than true by luck.
--------------------------------------------------------------------------- */

import './inspector.css';
import { memo, useCallback, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';
import { IconButton, TimecodeField } from '../ui';
import { readStore, useEditorStore } from '../../state/store';
import type { CueId, Frames, SubtitleCue } from '../../types/model';
import { MultilineField } from './MultilineField';

/** The row's fixed outer height in px, INCLUDING the gap beneath it. The window
 *  and the spacer both compute from this constant and nothing else. */
export const CUE_ROW_H = 132;

export interface CueRowProps {
  id: CueId;
  /** Position in the sorted list. A read-out only — never stored on the cue. */
  index: number;
  /** The cue currently under the playhead. */
  active: boolean;
  /** Take focus once, then tell the parent to forget it. */
  autoFocus: boolean;
  onFocusHandled(): void;
}

function CueRowImpl({ id, index, active, autoFocus, onFocusHandled }: CueRowProps): ReactElement | null {
  const cue = useEditorStore((s) => s.subtitles[id]) as SubtitleCue | undefined;
  const fps = useEditorStore((s) => s.fps);
  const textRef = useRef<HTMLTextAreaElement>(null);

  /* The focus jump IS the feature (§6.6.1) — a shortcut that only creates a row
     leaves the user reaching for the mouse. `onFocusHandled` fires in the same
     effect so the request is consumed exactly once and cannot re-fire on an
     unrelated render. */
  useEffect(() => {
    if (!autoFocus) return;
    textRef.current?.focus();
    textRef.current?.select();
    onFocusHandled();
  }, [autoFocus, onFocusHandled]);

  const edit = useCallback(
    (patch: Partial<Pick<SubtitleCue, 'start' | 'end' | 'text'>>, label: string) => {
      readStore().beginHistory(label);
      readStore().setCue(id, patch);
      readStore().commitHistory();
    },
    [id],
  );

  /** §6.6.1 step 3: end snaps to the playhead, focus leaves, playback runs on. */
  const closeAtPlayhead = useCallback(
    (currentText: string) => {
      const store = readStore();
      const self = store.subtitles[id];
      if (!self) return;
      // `setCue` refuses `end <= start` whole, so a Ctrl+Enter pressed before
      // the cue's own start would silently do nothing. The earliest legal close
      // is one frame, which at least always answers the key.
      const end: Frames = Math.max(store.playhead, self.start + 1);
      store.beginHistory('Close subtitle');
      store.setCue(id, { text: currentText, end });
      store.commitHistory();
      textRef.current?.blur();
    },
    [id],
  );

  // A cue removed while its row was mounted. Rendering the shell would leave a
  // row-shaped hole with dead controls in it.
  if (!cue) return null;

  return (
    <li
      className="ve-cue"
      style={{ top: index * CUE_ROW_H }}
      data-active={active || undefined}
      /* The cue the programme is currently on. `aria-current` is the state for a
         screen reader; the marker glyph and the raised surface carry it visually.
         Hue carries none of it (§6.6.4). */
      aria-current={active ? 'true' : undefined}
    >
      <div className="ve-cue-head">
        <span className="ve-cue-marker ve-icon-slot" aria-hidden="true">
          {active ? <ChevronRight size={12} strokeWidth={2.5} /> : null}
        </span>
        <span className="ve-cue-index type-numeric" aria-hidden="true">
          {index + 1}
        </span>
        <button
          type="button"
          className="ve-cue-seek type-label"
          onClick={() => readStore().seek(cue.start)}
        >
          Go to cue {index + 1}
          {active ? ' (current)' : ''}
        </button>
        <IconButton
          icon={<Trash2 size={14} strokeWidth={1.75} />}
          label={`Delete cue ${index + 1}`}
          size="sm"
          onClick={() => {
            readStore().beginHistory('Remove subtitle');
            readStore().removeCue(id);
            readStore().commitHistory();
          }}
        />
      </div>

      <div className="ve-cue-times">
        <TimecodeField
          label={`Cue ${index + 1} start`}
          value={cue.start}
          fps={fps}
          onCommit={(frames) => edit({ start: frames }, 'Adjust subtitle time')}
        />
        <span className="ve-cue-arrow type-label" aria-hidden="true">
          &rarr;
        </span>
        <TimecodeField
          label={`Cue ${index + 1} end`}
          value={cue.end}
          fps={fps}
          onCommit={(frames) => edit({ end: frames }, 'Adjust subtitle time')}
        />
      </div>

      <MultilineField
        label={`Cue ${index + 1} text`}
        value={cue.text}
        rows={2}
        resizable={false}
        inputRef={textRef}
        onCommit={(next) => edit({ text: next }, 'Edit subtitle')}
        onCtrlEnter={closeAtPlayhead}
      />
    </li>
  );
}

export const CueRow = memo(CueRowImpl);
