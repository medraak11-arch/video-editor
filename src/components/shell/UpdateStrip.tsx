/* ---------------------------------------------------------------------------
   UpdateStrip — the auto-update affordance. docs/RELEASE.md §1.6, §1.7.

   A second instance of the recovery strip's shape, and identically styled for a
   reason that is not laziness: these two rows are the same KIND of thing — a
   fact about the session the app is telling you, with two actions, that you may
   ignore. Two appearances would encode a difference that does not exist.

   IT RENDERS NOTHING unless a feed is configured. `getEditorAPI().update` is
   absent under dev:web and in every build that ships without a publish target,
   which is how it ships today, so this component returns null before it
   subscribes to anything.

   THREE THINGS THIS COMPONENT DOES THAT LOOK OPTIONAL AND ARE NOT:

   1. It holds TWO phases — the one it has been told about, and the one it has
      committed to the DOM — and promotes the first to the second only at an
      idle instant. Inserting or removing a 32px row above the editor body moves
      the timeline, the preview and every clip 32px. Mid-drag that pulls the
      clip out from under the pointer; mid-trim the edge lands somewhere the
      user did not choose. That is a data-destroying interruption, not a
      cosmetic one, and REMOVAL IS THE SAME SHIFT AS INSERTION — which is the
      half an implementation forgets, because tidying up does not feel like an
      edit to the layout. It is one.

   2. The download percentage lives in this component's own state and never in
      the store. `download-progress` fires many times a second; a store write at
      that rate would run every subscriber in the application, including
      useUiPersistence's comparison, on every tick (PLAN §1.3 rule 1).

   3. It never renders `failed`. Failures go through the notice channel, and the
      `checking` / `current` / `failed` phases can only ever have come from an
      explicit press, because main does not push them for an automatic check
      (RELEASE.md §1.5). There is no rule here to enforce.
--------------------------------------------------------------------------- */

import './shell.css';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ArrowDownToLine, Check, RefreshCw, RotateCcw } from 'lucide-react';
import type { UpdatePhase } from '../../types/api';
import { getEditorAPI } from '../../lib/editorApi';
import { readStore, useEditorStore } from '../../state/store';
import { Button } from '../ui';

/** How long the `current` row — the answer to a manual check that found
 *  nothing — stays before it asks to be removed. It is the one transient state
 *  in the strip, and its removal goes through the same commit gate an insert
 *  does: a bare timer would move the timeline eight seconds after a press, by
 *  which time the user's hands are back on it. */
const CURRENT_DISMISS_MS = 8000;

const IDLE: UpdatePhase = { kind: 'idle' };

/** Whether this phase draws the 32px row at all. Every row is the same height,
 *  so a change between two of them moves nothing; only crossing this predicate
 *  is an insert or a removal, and only those wait for an idle instant. */
const hasRow = (p: UpdatePhase): boolean => p.kind !== 'idle' && p.kind !== 'failed';

/** The closed table of §1.6. `retryable` is carried by the phase and is not
 *  spent here: nothing in this strip retries, and the menu item is the retry. */
function noticeFor(p: Extract<UpdatePhase, { kind: 'failed' }>): {
  title: string;
  message: string;
} {
  return {
    title: p.at === 'check' ? 'Check failed' : 'Download failed',
    message: p.message,
  };
}

export function UpdateStrip(): ReactElement | null {
  const update = getEditorAPI().update;
  const exportDialogOpen = useEditorStore((s) => s.exportDialogOpen);
  const shortcutOverlayOpen = useEditorStore((s) => s.shortcutOverlayOpen);

  /** What main has told us. */
  const [intended, setIntended] = useState<UpdatePhase>(IDLE);
  /** What is on screen. */
  const [committed, setCommitted] = useState<UpdatePhase>(IDLE);
  /** Document-level pointer latch. Deliberately NOT a store field: the
   *  timeline's interaction state lives in useTimelineInteraction, a hook with
   *  local state, and reaching into it would be a new cross-slice dependency
   *  for a boolean this component can observe directly. */
  const [pointerDown, setPointerDown] = useState(false);

  useEffect(() => {
    if (!update) return;
    let alive = true;
    void update.current().then((p) => {
      if (alive) setIntended(p);
    });
    const stop = update.onPhase((p) => setIntended(p));
    return () => {
      alive = false;
      stop();
    };
  }, [update]);

  useEffect(() => {
    if (!update) return;
    const down = () => setPointerDown(true);
    const up = () => setPointerDown(false);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
    };
  }, [update]);

  // A failure is reported ONCE, through the notice channel, with tone
  // 'warning': nothing was lost and nothing is broken. It is never a row —
  // where it leaves the row is the block below.
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (intended.kind !== 'failed') {
      reported.current = null;
      return;
    }
    const key = `${intended.at}:${intended.message}`;
    if (reported.current === key) return;
    reported.current = key;
    readStore().setNotice({ tone: 'warning', ...noticeFor(intended) });
  }, [intended]);

  /* ---- where a failure leaves the row ------------------------------------
     `failed` is never a row, but it still has to say what the row becomes, or
     a failed check leaves 'Checking for updates.' on screen forever — which is
     a lie about a thing that finished. A CHECK that failed is over, so the row
     goes; a DOWNLOAD that failed leaves the update still available and
     Download still pressable, so the row returns to the offer it came from. */

  const lastOffer = useRef<Extract<UpdatePhase, { kind: 'available' }> | null>(null);
  useEffect(() => {
    if (intended.kind === 'available') lastOffer.current = intended;
  }, [intended]);

  /* ---- the commit gate (§1.7) ------------------------------------------- */

  useEffect(() => {
    const next =
      intended.kind === 'failed'
        ? intended.at === 'download' && lastOffer.current
          ? lastOffer.current
          : IDLE
        : intended;
    if (next === committed) return;
    // One 32px row becoming a different 32px row moves nothing: commit at once.
    if (hasRow(next) && hasRow(committed)) {
      setCommitted(next);
      return;
    }
    // An insert or a removal. Both wait for an idle instant, and the retry is
    // this effect re-running when any of the three conditions changes.
    if (pointerDown || exportDialogOpen || shortcutOverlayOpen) return;
    setCommitted(next);
  }, [intended, committed, pointerDown, exportDialogOpen, shortcutOverlayOpen]);

  /* ---- the eight-second self-dismiss ------------------------------------ */

  useEffect(() => {
    if (!update) return;
    if (committed.kind !== 'current') return;
    const timer = setTimeout(() => update.dismiss(), CURRENT_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [update, committed]);

  if (!update) return null;
  if (!hasRow(committed)) return null;

  const body = rowFor(committed, update);

  return (
    <section className="shell-titlebar-update" role="status" aria-label="Application update">
      {body.icon}
      <p className="shell-titlebar-update-text type-body">{body.text}</p>
      <div className="shell-titlebar-update-actions">{body.actions}</div>
    </section>
  );
}

/** The version number, as a link when the feed supplied release notes and as
 *  plain text when it did not. The link goes through main's existing
 *  setWindowOpenHandler, which is the whole of the release-notes story: a 32px
 *  strip cannot render markdown, and growing it to fit would make it the modal
 *  this design refuses. */
function version(value: string, notesUrl: string | null): ReactNode {
  const numerals = <span className="type-numeric">{value}</span>;
  if (notesUrl === null) return numerals;
  return (
    <a
      className="shell-titlebar-update-link"
      href={notesUrl}
      target="_blank"
      rel="noreferrer"
      title="Release notes"
    >
      {numerals}
    </a>
  );
}

function rowFor(
  p: UpdatePhase,
  update: NonNullable<ReturnType<typeof getEditorAPI>['update']>,
): { icon: ReactNode; text: ReactNode; actions: ReactNode } {
  const icon = (node: ReactNode): ReactNode => (
    <span className="shell-titlebar-update-icon" aria-hidden="true">
      {node}
    </span>
  );
  switch (p.kind) {
    case 'checking':
      return {
        icon: icon(<RefreshCw size={14} strokeWidth={1.75} />),
        text: 'Checking for updates.',
        actions: null,
      };
    case 'current':
      return {
        icon: icon(<Check size={14} strokeWidth={1.75} />),
        text: <>Version {version(p.version, null)} is the newest release.</>,
        actions: (
          <Button variant="ghost" size="sm" onClick={() => update.dismiss()}>
            Dismiss
          </Button>
        ),
      };
    case 'available':
      return {
        icon: icon(<ArrowDownToLine size={14} strokeWidth={1.75} />),
        text: <>Version {version(p.version, p.notesUrl)} is available.</>,
        actions: (
          <>
            <Button variant="secondary" size="sm" onClick={() => update.download()}>
              Download
            </Button>
            <Button variant="ghost" size="sm" onClick={() => update.dismiss()}>
              Not now
            </Button>
          </>
        ),
      };
    case 'downloading':
      return {
        icon: icon(<ArrowDownToLine size={14} strokeWidth={1.75} />),
        text: (
          <>
            Downloading version {version(p.version, null)} —{' '}
            {/* The row is a live region, and main pushes a new percentage twice
                a second. `aria-live="off"` on the changing node itself is what
                stops a screen reader reading a number aloud forty times during
                one download; the transition INTO this row still announces once,
                because the rest of the sentence changes with it. */}
            <span className="shell-titlebar-update-pct type-numeric" aria-live="off">
              {p.percent}
            </span>{' '}
            %
          </>
        ),
        actions: (
          <Button variant="ghost" size="sm" onClick={() => update.cancelDownload()}>
            Cancel
          </Button>
        ),
      };
    case 'ready':
      return {
        icon: icon(<RotateCcw size={14} strokeWidth={1.75} />),
        text: <>Version {version(p.version, p.notesUrl)} is ready to install.</>,
        actions: (
          <>
            <Button variant="secondary" size="sm" onClick={() => update.installAndRestart()}>
              Restart and install
            </Button>
            <Button variant="ghost" size="sm" onClick={() => update.dismiss()}>
              Later
            </Button>
          </>
        ),
      };
    default:
      return { icon: null, text: null, actions: null };
  }
}
