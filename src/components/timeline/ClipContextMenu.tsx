/* ---------------------------------------------------------------------------
   ClipContextMenu — the timeline's right-click menu (AUDIO-FEATURES §1.9).

   It follows the media rail's menu (MediaItem.tsx) rather than reinventing it:
   the `Menu` primitive supplies the popover, the roving tabindex, the seven
   states, the `disabledReason` and the shortcut slot, and the trigger is a
   zero-size button parked at the pointer. No new primitive, and no resident
   chrome — a kebab on all forty clips is the wall-of-controls anti-reference.

   EVERY item is decided over `effectiveIds`, the same set its action will act
   on. All four actions already operate on the whole selection, so deciding
   `disabled` from the single clip under the pointer would produce both failure
   directions: greyed items beside a keystroke that works, or an enabled item
   that silently spares a locked member. The items still invoke their actions
   with no arguments, and that is correct rather than sloppy — the right-press
   has already guaranteed `effectiveIds` IS the selection.
--------------------------------------------------------------------------- */

import './timeline.css';
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { AudioLines, Scissors, Trash2, X } from 'lucide-react';
import type { ClipId } from '../../types/model';
import { clipEnd } from '../../types/model';
import { readStore } from '../../state/store';
import { detachRefusal, selectDetachableClipIds } from '../../state/timelineSlice';
import type { StoreState } from '../../state/types';
import { ShortcutHint } from '../../keyboard/ShortcutHint';
import { Menu } from '../ui';
import type { MenuItem as MenuItemSpec } from '../ui';

export interface ClipContextMenuHandle {
  /** `top` / `left` are VIEWPORT coordinates — the pointer, or a focused clip's corner. */
  openAt(clipId: ClipId, top: number, left: number): void;
}

interface Point {
  top: number;
  left: number;
}

/** The clips a menu opened on `id` acts over: the selection, or `id` alone. */
function effectiveClipIds(s: StoreState, id: ClipId): ClipId[] {
  return s.selection.size > 0 ? [...s.selection] : [id];
}

const allLocked = (s: StoreState, ids: readonly ClipId[]): boolean =>
  ids.every((id) => {
    const clip = s.clips[id];
    return clip ? s.tracks[clip.trackId]?.locked === true : true;
  });

const anySplittable = (s: StoreState, ids: readonly ClipId[]): boolean =>
  ids.some((id) => {
    const clip = s.clips[id];
    return clip !== undefined && s.playhead > clip.start && s.playhead < clipEnd(clip);
  });

export const ClipContextMenu = forwardRef<ClipContextMenuHandle>(function ClipContextMenu(
  _props,
  ref,
): ReactElement {
  const [target, setTarget] = useState<{ id: ClipId; point: Point } | null>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const openWanted = useRef(false);

  // `Menu` clones its trigger and takes the ref for itself, so the button is
  // reached through the host rather than through a ref of ours.
  const anchor = (): HTMLButtonElement | null =>
    hostRef.current?.querySelector<HTMLButtonElement>('.tl-clip-menu-anchor') ?? null;

  // The Menu primitive reads its trigger's rect on click, so the trigger has to
  // be at the pointer BEFORE the click. Position lands in a committed layout,
  // then the click opens the popover exactly there.
  useLayoutEffect(() => {
    if (!openWanted.current || target === null) return;
    openWanted.current = false;
    anchor()?.click();
  }, [target]);

  useImperativeHandle(
    ref,
    () => ({
      openAt(clipId, top, left) {
        openWanted.current = true;
        setTarget({ id: clipId, point: { top, left } });
      },
    }),
    [],
  );

  const buildItems = useCallback((id: ClipId): MenuItemSpec[] => {
    const s = readStore();
    const ids = effectiveClipIds(s, id);

    const detachable = selectDetachableClipIds(s, ids).length > 0;
    const lockedAll = allLocked(s, ids);
    const splittable = anySplittable(s, ids);

    return [
      {
        kind: 'item',
        id: 'detach-audio',
        label: 'Detach audio',
        icon: <AudioLines size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="edit.detachAudio" />,
        disabled: !detachable,
        // §1.4's own four sentences, reused verbatim rather than re-worded for
        // the menu: one copy of the copy, living in the action.
        disabledReason: detachable ? undefined : detachRefusal(s, ids).message,
        onSelect: () => readStore().detachAudio(),
      },
      { kind: 'separator', id: 'sep' },
      {
        kind: 'item',
        id: 'split',
        label: 'Split at playhead',
        icon: <Scissors size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="edit.split" />,
        disabled: !splittable,
        disabledReason: splittable ? undefined : 'Park the playhead over a selected clip first',
        onSelect: () => readStore().splitAtPlayhead(),
      },
      {
        kind: 'item',
        id: 'lift',
        label: 'Lift',
        icon: <X size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="edit.lift" />,
        disabled: lockedAll,
        disabledReason: lockedAll ? 'Track is locked' : undefined,
        onSelect: () => readStore().deleteSelection(),
      },
      {
        kind: 'item',
        id: 'ripple',
        label: 'Ripple delete',
        icon: <Trash2 size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="edit.ripple" />,
        disabled: lockedAll,
        disabledReason: lockedAll ? 'Track is locked' : undefined,
        onSelect: () => readStore().rippleDelete(),
      },
    ];
  }, []);

  return (
    /* Zero-size, parked at the pointer, out of the tab order. It paints nothing
       and takes no space, so it is not resident chrome. Menu restores focus to
       it when the popover closes, and it hands that focus straight back to the
       clip the menu opened on — which is where the keyboard was. */
    <span className="tl-clip-menu-host" ref={hostRef}>
      <Menu
        items={target ? buildItems(target.id) : []}
        trigger={
          <button
            type="button"
            className="tl-clip-menu-anchor"
            tabIndex={-1}
            aria-hidden="true"
            style={{ top: target?.point.top ?? 0, left: target?.point.left ?? 0 }}
            onFocus={() => {
              const id = target?.id;
              if (!id) return;
              document
                .querySelector<HTMLElement>(`.tl-lane-content [data-clip-id="${id}"]`)
                ?.focus({ preventScroll: true });
            }}
          />
        }
      />
    </span>
  );
});
