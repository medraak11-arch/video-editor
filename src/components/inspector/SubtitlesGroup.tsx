/* ---------------------------------------------------------------------------
   SubtitlesGroup — the cue list, the import, and the four style controls.
   CREATIVE §6.5, §6.6.

   WHERE IT LIVES, AND WHY THAT IS THE WHOLE DESIGN PROBLEM. Subtitles are
   project-level (§6.1): they are a property of the programme, not of any clip,
   and they survive re-cutting the footage underneath them. So this belongs in
   the inspector's PROJECT context — the one shown when nothing is selected —
   rather than appearing next to a clip's transform, where it would imply a
   relationship to that clip that the model explicitly does not have.

   AND IT IS CLOSED BY DEFAULT. This is the largest single surface in the
   inspector. Resident, it IS the wall-of-controls anti-reference, in the one
   panel PRODUCT.md's "depth on demand" was written about.

   ---- WINDOWED (§6.6.4) ----

   Four hundred cues is the design target, and mounted whole it is not a list,
   it is a stall: 1,200 inputs, ~53,000 px of scrollHeight in a 320 px viewport,
   and every keystroke in any cue reconciling all of them. So only the rows near
   the viewport exist. Three things make that safe rather than merely fast:

   · `CUE_ROW_H` is a CONSTANT and rows are absolutely positioned at
     `index * CUE_ROW_H`. Offsets are arithmetic, never measured, so the list
     cannot jump as it scrolls and a row's height can never depend on what has
     mounted inside it.
   · The spacer's height is `count * CUE_ROW_H`, so the scrollbar is honest
     about the whole set even though a dozen rows exist.
   · Rows subscribe to their own cue by id (CueRow) and take primitive props, so
     adding a cue re-renders the window, not four hundred rows.

   ---- FOLLOWING THE PLAYHEAD ----

   `activeCueId` is derived in the SELECTOR, so this component re-renders when
   the active cue CHANGES, not on every frame of playback. Subscribing to
   `playhead` here instead would re-render the panel sixty times a second to
   move a marker that changes every few seconds.

   Auto-scroll is deliberately conditional, and both conditions are correctness
   rather than taste:
   · Only while PLAYING. Scrolling the list out from under someone who is
     reading it is the classic auto-follow bug.
   · Never while focus is inside the list. In a WINDOWED list, scrolling away
     UNMOUNTS the focused row — so following the playhead while the user types
     would destroy the very field the §6.6.1 loop just put them in.

   ---- THE FOCUS SEAM (§6.6.3) ----

   `C` is dispatched by the timeline and the field it must focus is here, so the
   signal goes through `uiSlice` one way: producer calls `requestCueFocus`,
   consumer calls `clearCueFocus`. The clear happens in the ROW, the moment it
   takes focus — a request left standing re-steals focus on the next unrelated
   render, which is the classic form of this bug. This component's only job is
   to make sure the requested row is inside the window so it can mount at all,
   and to discharge a request naming a cue that no longer exists, which would
   otherwise sit forever.

   PLAYBACK NEVER STOPS anywhere in this file: nothing here pauses, and the only
   `seek` is the one a user asks for by clicking a cue. The keystrokes of the
   authoring loop are inert at the shortcut layer because they land in a
   `textarea`, which `TEXT_INPUT_SELECTOR` already covers.

   ---- IMPORT: NATIVE FIRST, BROWSER INPUT AS THE dev:web FALLBACK ----

   `project.importSubtitles` is feature-detected exactly as `AppMenu` detects
   `exportSubtitles` and `media.reveal`: present in Electron, absent under
   `dev:web`, where there is no preload and no shell to raise a picker. When it
   is there the user gets the same native dialog every other file operation in
   this app uses; a hidden browser file input in a desktop app is something the
   user can feel, and it was the one seam in this panel that did not match the
   rest. When it is absent the hidden input is still the only way to get bytes
   in, so it stays — rendered instead of, never as well as, so there is never
   one control that behaves two ways.

   `cancelled` IS AN ANSWER, NOT A FAILURE, and produces no notice — the same
   rule `exportSubtitlesFile` already follows for a cancelled save. Only
   `read-failed` is a thing that was asked for and did not happen.

   PARSING STAYS ON THIS SIDE and the BOM is deliberately not stripped in main:
   §6.2 documents and tests `parseSrt` as BOM-tolerant, so a second normaliser
   upstream would be an untested one in front of a tested one, and the two would
   drift. src/lib/srt.ts is scaffold-owned, pure, and already tolerant of BOM,
   CRLF, `,` vs `.`, non-sequential indices and a missing trailing newline.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { Plus, Upload } from 'lucide-react';
import { Button, Dialog, NumericField } from '../ui';
import { readStore, useEditorStore } from '../../state/store';
import { useReducedMotion } from '../../lib/useReducedMotion';
import { getEditorAPI } from '../../lib/editorApi';
import { parseSrt } from '../../lib/srt';
import type { CueId, SubtitleCue } from '../../types/model';
import { DEFAULT_SUBTITLE_STYLE } from '../../types/model';
import { ColorField } from './ColorField';
import { CUE_ROW_H, CueRow } from './CueRow';
import { PropertyRow } from './PropertyRow';

const toPercent = (stored: number): number => stored * 100;
const fromPercent = (shown: number): number => shown / 100;

/** Viewport height of the scroller. Mirrors `.ve-cues` max-height in the CSS. */
const VIEWPORT_H = 320;
/** Rows kept mounted beyond each edge, so a scroll does not reveal blank space. */
const OVERSCAN = 3;

/**
 * Last path segment, for the dialog's sentence. Splits on BOTH separators: the
 * bridge returns an OS-native absolute path, and this app's primary target is
 * Windows, where a forward-slash-only split would show the whole path.
 */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Pending import, held while the replace-or-append question is on screen. */
interface PendingImport {
  cues: SubtitleCue[];
  fileName: string;
}

/**
 * The cue under a frame, by id. Lives in the selector so a re-render costs a
 * changed ID rather than a changed frame. Linear over the cues: at 400 that is
 * 400 comparisons per store write, which is nothing next to the render it
 * replaces, and it needs no index to maintain and invalidate.
 *
 * `for…in` rather than `Object.values`, and that is not micro-tuning: a zustand
 * selector runs on EVERY store write from every slice, so during playback this
 * is called once a frame. `Object.values` would allocate a 400-element array
 * sixty times a second to read it once and throw it away — pure GC pressure on
 * the one surface §6.6 needs to stay smooth while the transport runs.
 */
function activeCueIdAt(cues: Record<CueId, SubtitleCue>, frame: number): CueId | null {
  for (const key in cues) {
    const cue = cues[key];
    if (cue !== undefined && frame >= cue.start && frame < cue.end) return cue.id;
  }
  return null;
}

export function SubtitlesGroup(): ReactElement {
  const base = useId();
  const cuesById = useEditorStore((s) => s.subtitles);
  const style = useEditorStore((s) => s.subtitleStyle);
  const activeCueId = useEditorStore((s) => activeCueIdAt(s.subtitles, s.playhead));
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const focusCueId = useEditorStore((s) => s.focusCueId);
  const reduced = useReducedMotion();
  /* Constant for the life of the process, so not store state — read once, the
     same way AppMenu reads `exportSubtitles`. Truthy in Electron, undefined
     under dev:web. */
  const nativeImport = getEditorAPI().project.importSubtitles;

  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  /* Sorted by start, because a cue list read out of order is unreadable and the
     store holds a Record, which has no order worth relying on. Ties break on id
     so the order is stable across renders rather than dependent on insertion. */
  const cues = useMemo<SubtitleCue[]>(() => {
    const list = Object.values(cuesById);
    list.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return list;
  }, [cuesById]);

  const indexOfId = useCallback(
    (target: CueId | null): number =>
      target === null ? -1 : cues.findIndex((c) => c.id === target),
    [cues],
  );

  const id = (suffix: string): string => `${base}-${suffix}`;

  /**
   * Brings a row inside the viewport, by index. Instant under reduced motion —
   * a real alternative rather than a disabled one (CLAUDE.md).
   *
   * IT MOVES THE WINDOW ITSELF rather than waiting to be told. `scrollTo` only
   * changes the element; the mounted range is React state, and if that state
   * were updated solely by the `scroll` EVENT then making a row mountable would
   * depend on when — or whether — that event was delivered. Measured: after a
   * programmatic scroll to row 300 the element sat at the right offset while
   * the window still held rows 1–6, so the requested row never mounted, never
   * focused, and never cleared `focusCueId`. §6.6.1 makes the focus jump the
   * feature, so it cannot ride on scroll-event timing. Setting both keeps the
   * two in lockstep; the event that follows re-sets the same number and React
   * bails on the identical value.
   */
  const scrollIndexIntoView = useCallback(
    (index: number, smooth: boolean): void => {
      const el = scrollerRef.current;
      if (!el || index < 0) return;
      const top = index * CUE_ROW_H;
      const bottom = top + CUE_ROW_H;
      if (top >= el.scrollTop && bottom <= el.scrollTop + el.clientHeight) return;
      // Centred, so the next cue and the previous one are both readable.
      const next = Math.max(0, top - (el.clientHeight - CUE_ROW_H) / 2);
      const animate = smooth && !reduced;
      el.scrollTo({ top: next, behavior: animate ? 'smooth' : 'auto' });
      // Instant only. An ANIMATED scroll emits a stream of scroll events that
      // walks the window across with it; jumping the window straight to the
      // destination would mount the rows at the far end while the element was
      // still travelling, and the user would watch blank space slide past.
      if (!animate) setScrollTop(next);
    },
    [reduced],
  );

  /* Follow the playhead. Guarded on both counts described in the header — and
     the focus guard is what keeps a windowed list from unmounting the field the
     user is typing into. */
  useEffect(() => {
    if (!isPlaying || activeCueId === null) return;
    const el = scrollerRef.current;
    if (el && el.contains(document.activeElement)) return;
    scrollIndexIntoView(indexOfId(activeCueId), true);
  }, [isPlaying, activeCueId, indexOfId, scrollIndexIntoView]);

  /* The focus request (§6.6.3). This makes the row MOUNTABLE; the row itself
     focuses and clears. Layout effect so the scroll lands before paint and the
     row is in the window on the very next render rather than a frame later. */
  useLayoutEffect(() => {
    if (focusCueId === null) return;
    const index = indexOfId(focusCueId);
    if (index < 0) {
      // Names a cue that no longer exists — discharge it, or it sits forever.
      readStore().clearCueFocus();
      return;
    }
    scrollIndexIntoView(index, false);
  }, [focusCueId, indexOfId, scrollIndexIntoView]);

  /** The row calls this once it has taken focus. Guarded inside the store, so
   *  calling it on every focus is cheap. */
  const onFocusHandled = useCallback(() => {
    readStore().clearCueFocus();
  }, []);

  /* The window. Arithmetic only — no measurement, no per-row refs. */
  const first = Math.max(0, Math.floor(scrollTop / CUE_ROW_H) - OVERSCAN);
  const last = Math.min(cues.length, Math.ceil((scrollTop + VIEWPORT_H) / CUE_ROW_H) + OVERSCAN);
  const visible = cues.slice(first, last);

  const addCue = (): void => {
    readStore().beginHistory('Add subtitle');
    readStore().addCue(readStore().playhead);
    readStore().commitHistory();
  };

  /**
   * The shared tail of BOTH import routes: parse, then ask §6.5's question.
   * Native and browser differ only in how the text was obtained, so they differ
   * only up to here — otherwise the two paths would be two chances to get the
   * replace-or-append rule wrong.
   */
  const ingest = useCallback((text: string, fileName: string): void => {
    setImportError(null);
    let parsed: SubtitleCue[];
    try {
      parsed = parseSrt(text, readStore().fps);
    } catch {
      setImportError('That file could not be read as SubRip');
      return;
    }
    if (parsed.length === 0) {
      // Not an error state with an icon and a border: a valid empty file is not
      // a failure, it just has nothing in it. Say so and stop.
      setImportError('No cues found in that file');
      return;
    }

    // The question is only worth asking when both answers do different things.
    if (Object.keys(readStore().subtitles).length === 0) {
      readStore().beginHistory('Import subtitles');
      readStore().replaceCues(parsed);
      readStore().commitHistory();
      return;
    }
    setPending({ cues: parsed, fileName });
  }, []);

  /** Electron. The same native picker every other file operation in this app uses. */
  const importNative = async (): Promise<void> => {
    if (!nativeImport) return;
    const result = await nativeImport();
    if (!result.ok) {
      // `cancelled` is an ANSWER. The user closed the dialog; nothing was asked
      // for and nothing failed, so there is nothing to announce. Only a read
      // that was requested and did not happen earns a message.
      if (result.reason === 'read-failed') {
        setImportError('That file could not be read');
      }
      return;
    }
    ingest(result.text, basename(result.path));
  };

  /** dev:web only — there is no preload and no shell to raise a picker. */
  const onFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // Cleared immediately so re-choosing the SAME file fires `change` again —
    // a browser file input is otherwise silent on a repeat pick, and
    // re-importing a file you just edited on disk is the common case.
    event.target.value = '';
    if (!file) return;
    ingest(await file.text(), file.name);
  };

  const resolveImport = (mode: 'replace' | 'append'): void => {
    const p = pending;
    setPending(null);
    if (!p) return;
    readStore().beginHistory(mode === 'replace' ? 'Replace subtitles' : 'Append subtitles');
    if (mode === 'replace') readStore().replaceCues(p.cues);
    else readStore().appendCues(p.cues);
    readStore().commitHistory();
  };

  const styleWrite = (patch: Partial<typeof style>, label: string): void => {
    readStore().beginHistory(label);
    readStore().setSubtitleStyle(patch);
    readStore().commitHistory();
  };

  return (
    <>
      {/* --- the list ------------------------------------------------------ */}
      <div className="ve-cues-bar">
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Plus size={14} strokeWidth={1.75} />}
          onClick={addCue}
        >
          Add at playhead
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Upload size={14} strokeWidth={1.75} />}
          onClick={() => {
            if (nativeImport) void importNative();
            else fileRef.current?.click();
          }}
        >
          Import .srt
        </Button>
        {/* dev:web ONLY, and mounted only there — one control must not have two
            behaviours sitting side by side. The input is never the control
            itself: a bare file input cannot be styled to the system and reads as
            a foreign object in a dark panel. It stays out of the tab order; the
            Button above is what is focusable, labelled and operable. */}
        {nativeImport ? null : (
          <input
            ref={fileRef}
            type="file"
            accept=".srt,text/plain"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              void onFile(event);
            }}
          />
        )}
      </div>

      {importError ? (
        <p className="ve-group-note ve-group-note-block type-label" role="alert">
          {importError}
        </p>
      ) : null}

      {cues.length === 0 ? (
        /* No illustration, no call to action, no feature pitch (PRODUCT
           principle 5). One sentence stating the fact; the two ways out are the
           buttons directly above it. */
        <p className="ve-group-note ve-group-note-block type-label">No subtitles yet.</p>
      ) : (
        <div
          ref={scrollerRef}
          className="ve-cues-scroller"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          {/* The spacer holds the FULL height so the scrollbar tells the truth
              about four hundred cues while a dozen rows exist. */}
          <ul
            className="ve-cues"
            style={{ height: cues.length * CUE_ROW_H }}
            aria-label="Subtitle cues"
          >
            {visible.map((cue, i) => (
              <CueRow
                key={cue.id}
                id={cue.id}
                index={first + i}
                active={cue.id === activeCueId}
                autoFocus={cue.id === focusCueId}
                onFocusHandled={onFocusHandled}
              />
            ))}
          </ul>
        </div>
      )}

      {/* --- style -------------------------------------------------------- */}
      <PropertyRow label="Size" htmlFor={id('size')}>
        <NumericField
          id={id('size')}
          label="Subtitle size"
          value={toPercent(style.sizePct)}
          min={2}
          max={20}
          step={0.5}
          precision={1}
          scrubSensitivity={0.25}
          suffix="%"
          onChange={() => undefined}
          onCommit={(next) => styleWrite({ sizePct: fromPercent(next) }, 'Adjust subtitle size')}
        />
      </PropertyRow>

      <PropertyRow label="Colour" htmlFor={id('color')}>
        <ColorField
          id={id('color')}
          label="Subtitle colour"
          value={style.color}
          fallback={DEFAULT_SUBTITLE_STYLE.color}
          onCommit={(next) => styleWrite({ color: next }, 'Change subtitle colour')}
        />
      </PropertyRow>

      <PropertyRow label="Outline" htmlFor={id('outline')}>
        <NumericField
          id={id('outline')}
          label="Subtitle outline"
          value={style.outline}
          min={0}
          max={4}
          step={0.5}
          precision={1}
          scrubSensitivity={0.05}
          suffix="px"
          onChange={() => undefined}
          onCommit={(next) => styleWrite({ outline: next }, 'Adjust subtitle outline')}
        />
      </PropertyRow>

      <PropertyRow label="Margin" htmlFor={id('margin')}>
        <NumericField
          id={id('margin')}
          label="Subtitle bottom margin"
          value={toPercent(style.marginPct)}
          min={0}
          max={40}
          step={0.5}
          precision={1}
          scrubSensitivity={0.25}
          suffix="%"
          onChange={() => undefined}
          onCommit={(next) => styleWrite({ marginPct: fromPercent(next) }, 'Adjust subtitle margin')}
        />
      </PropertyRow>

      {/* Outline is authored against 1080 and scaled to the output (§6.3). Said
          here because a `px` suffix otherwise implies output pixels. */}
      <p className="ve-group-note ve-group-note-block type-label">
        Size and margin are fractions of the frame height; outline is in pixels
        at 1080 and scales with the output.
      </p>

      {/* --- the one question -------------------------------------------- */}
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Import subtitles"
        description={
          pending
            ? `${pending.fileName} holds ${pending.cues.length} cues. This project already has ${cues.length}.`
            : undefined
        }
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            {/* Replace is the destructive answer, so it is NOT the primary
                action: the accent points at the choice that cannot lose work.
                Both are undoable, which is why replace can be offered at all
                rather than confirmed a second time. */}
            <Button onClick={() => resolveImport('replace')}>Replace</Button>
            <Button variant="primary" onClick={() => resolveImport('append')}>
              Append
            </Button>
          </>
        }
      >
        <p className="type-body">
          Replacing discards the cues already in this project. Both choices can
          be undone.
        </p>
      </Dialog>
    </>
  );
}
