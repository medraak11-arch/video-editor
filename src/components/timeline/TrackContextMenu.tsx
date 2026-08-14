/* ---------------------------------------------------------------------------
   TrackContextMenu — one menu, two entry points (CREATIVE §1.4, §5).

   It opens from a track HEAD (right-press, ContextMenu, Shift+F10) and from
   EMPTY LANE SPACE, because the two ask the same questions of the same track.
   The only thing the entry point changes is the frame a title lands on: the
   playhead from the head, where there is no x to read, and the frame under the
   pointer from the lane.

   It follows ClipContextMenu rather than reinventing it: the `Menu` primitive
   supplies the popover, the roving tabindex, the seven states, the
   `disabledReason` and the shortcut slot, and the trigger is a zero-size button
   parked at the pointer.

   THE VOLUME SUBMENU is the reason this component is not optional. The fader in
   the head is hidden below DENSE_HEIGHT, and a control that disappears at 40px
   of track height with no other route to its value is a value the user cannot
   reach — the audio tracks seed at 40px, so that is the DEFAULT state of every
   A lane. The submenu is a radio set rather than a pair of nudge items because
   `Menu` closes on select: seven presets is one open and one choice, where
   "louder / quieter" would be one open per decibel.
--------------------------------------------------------------------------- */

import './timeline.css';
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { Eye, EyeOff, Lock, LockOpen, Type, Volume2, VolumeX } from 'lucide-react';
import type { ClipId, Frames, TrackId } from '../../types/model';
import { trackVolume } from '../../types/model';
import { readStore } from '../../state/store';
import { ShortcutHint } from '../../keyboard/ShortcutHint';
import { Menu } from '../ui';
import type { MenuItem as MenuItemSpec } from '../ui';

export interface TrackContextMenuHandle {
  /** `top` / `left` are VIEWPORT coordinates — the pointer, or a head's corner. */
  openAt(trackId: TrackId, frame: Frames, top: number, left: number): void;
}

interface Target {
  trackId: TrackId;
  frame: Frames;
  point: { top: number; left: number };
}

/* ------------------------------------------------------------------ decibels

   The fader's own `aria-valuetext` is in dB (CREATIVE §1.4) and so is this
   menu, because dB is what the number means: 0..2 linear is the storage unit,
   not the unit anybody mixes in. −12 / −6 / −3 / unity / +3 / +6 is the ladder
   every mixer prints on its own faceplate, and +6 dB is exactly the 2.0 ceiling
   the model allows, so the ladder ends where the range does rather than short
   of it.                                                                     */

/** null is silence, which has no decibel value — log(0) is not −∞ in a menu. */
const PRESET_DB: readonly (number | null)[] = [null, -12, -6, -3, 0, 3, 6];

const gainForDb = (db: number | null): number =>
  db === null ? 0 : Math.min(2, 10 ** (db / 20));

/** Sentence case, U+2212 for the minus so it aligns with the numerals beside it. */
function formatGain(gain: number): string {
  if (gain <= 0.001) return 'Silent';
  const db = 20 * Math.log10(gain);
  if (Math.abs(db) < 0.05) return 'Unity';
  return `${db > 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB`;
}

/** Which preset the stored value IS, or -1 when it sits between two of them. */
function presetIndex(gain: number): number {
  return PRESET_DB.findIndex((db) => Math.abs(gainForDb(db) - gain) < 0.005);
}

export const TrackContextMenu = forwardRef<TrackContextMenuHandle>(function TrackContextMenu(
  _props,
  ref,
): ReactElement {
  const [target, setTarget] = useState<Target | null>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const openWanted = useRef(false);
  /**
   * Set by `Add title` so the focus `Menu` restores on close lands on the clip
   * that was just created rather than back on the track head. The store write
   * is flushed synchronously first, so the element exists by the time focus
   * arrives.
   */
  const focusClipOnClose = useRef<ClipId | null>(null);

  const anchor = (): HTMLButtonElement | null =>
    hostRef.current?.querySelector<HTMLButtonElement>('.tl-track-menu-anchor') ?? null;

  // Same two-step as ClipContextMenu: `Menu` reads its trigger's rect on click,
  // so the trigger has to be at the pointer in a COMMITTED layout first.
  useLayoutEffect(() => {
    if (!openWanted.current || target === null) return;
    openWanted.current = false;
    anchor()?.click();
  }, [target]);

  useImperativeHandle(
    ref,
    () => ({
      openAt(trackId, frame, top, left) {
        openWanted.current = true;
        focusClipOnClose.current = null;
        setTarget({ trackId, frame, point: { top, left } });
      },
    }),
    [],
  );

  const buildItems = useCallback((t: Target): MenuItemSpec[] => {
    const s = readStore();
    const track = s.tracks[t.trackId];
    if (!track) return [];

    // A title belongs on a video track, above the footage (CREATIVE §5.1), and
    // `addTitleClip` refuses anywhere else. Stating the refusal here rather than
    // hiding the item keeps the menu the same shape on every track: PLAN
    // preamble S4 hides a control that is IRRELEVANT, and "can this lane hold a
    // title" is exactly the question the user opened the menu to have answered.
    const titleable = track.kind === 'video' && !track.locked;
    const titleReason = track.locked
      ? 'Track is locked'
      : 'Titles go on a video track, above the footage';

    const gain = trackVolume(track);
    const at = presetIndex(gain);

    return [
      {
        kind: 'item',
        id: 'add-title',
        label: 'Add title',
        icon: <Type size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="edit.addTitle" />,
        disabled: !titleable,
        disabledReason: titleable ? undefined : titleReason,
        onSelect: () => {
          // Flushed, so the clip's element exists before `Menu` restores focus
          // to the anchor and the anchor hands that focus on to the clip. The
          // id is carried out through an object rather than a `let`, because a
          // `let` assigned only inside the callback keeps its initialiser's
          // narrowing and the null test below would be typed as unreachable.
          const created: { id: ClipId | null } = { id: null };
          flushSync(() => {
            created.id = readStore().addTitleClip(t.trackId, Math.max(0, Math.round(t.frame)));
          });
          const id = created.id;
          if (id === null) return;
          readStore().select(id, 'replace');
          focusClipOnClose.current = id;
        },
      },
      { kind: 'separator', id: 'sep-state' },
      {
        kind: 'item',
        id: 'mute',
        label: track.muted ? 'Unmute' : 'Mute',
        icon: track.muted ? (
          <Volume2 size={14} strokeWidth={1.75} />
        ) : (
          <VolumeX size={14} strokeWidth={1.75} />
        ),
        onSelect: () => readStore().toggleMute(t.trackId),
      },
      {
        kind: 'item',
        id: 'lock',
        label: track.locked ? 'Unlock' : 'Lock',
        icon: track.locked ? (
          <LockOpen size={14} strokeWidth={1.75} />
        ) : (
          <Lock size={14} strokeWidth={1.75} />
        ),
        onSelect: () => readStore().toggleLock(t.trackId),
      },
      {
        kind: 'item',
        id: 'visible',
        label: track.visible ? 'Hide' : 'Show',
        icon: track.visible ? (
          <EyeOff size={14} strokeWidth={1.75} />
        ) : (
          <Eye size={14} strokeWidth={1.75} />
        ),
        onSelect: () => readStore().toggleVisible(t.trackId),
      },
      { kind: 'separator', id: 'sep-mix' },
      {
        kind: 'submenu',
        id: 'volume',
        // The value is on the SUBMENU LABEL, not only inside it: a fader hidden
        // by density must still be readable without opening anything.
        label: `Volume — ${formatGain(gain)}`,
        items: PRESET_DB.map((db, index) => ({
          kind: 'item' as const,
          id: `vol-${index}`,
          label: db === null ? 'Silent' : formatGain(gainForDb(db)),
          // Radio, not check: exactly one gain holds. Announcing seven
          // independent checkboxes would tell a screen-reader user they can
          // have none of them, or all seven.
          checked: index === at,
          selection: 'radio' as const,
          onSelect: () => readStore().setTrackVolume(t.trackId, gainForDb(db)),
        })),
      },
    ];
  }, []);

  return (
    /* Zero-size, parked at the pointer, out of the tab order — it paints nothing
       and takes no space, so it is not resident chrome. It is mounted OUTSIDE
       `.tl-heads-content` and `.tl-lane-content` on purpose: both carry
       `will-change: transform`, which makes them the containing block for a
       `position: fixed` descendant and would resolve these viewport
       coordinates against a scrolled element instead. */
    <span className="tl-track-menu-host" ref={hostRef}>
      <Menu
        items={target ? buildItems(target) : []}
        trigger={
          <button
            type="button"
            className="tl-track-menu-anchor"
            tabIndex={-1}
            aria-hidden="true"
            style={{ top: target?.point.top ?? 0, left: target?.point.left ?? 0 }}
            onFocus={() => {
              const clipId = focusClipOnClose.current;
              focusClipOnClose.current = null;
              const selector = clipId
                ? `.tl-lane-content [data-clip-id="${clipId}"]`
                : `.tl-heads-content [data-track-id="${target?.trackId ?? ''}"]`;
              document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
            }}
          />
        }
      />
    </span>
  );
});
