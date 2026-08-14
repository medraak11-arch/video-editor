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
import {
  AudioLines,
  BetweenHorizontalStart,
  Blend,
  Eraser,
  Link2,
  Scissors,
  Sunrise,
  Sunset,
  Trash2,
  Unlink2,
  X,
} from 'lucide-react';
import type { Clip, ClipId } from '../../types/model';
import { DEFAULT_TRANSITION_FRAMES, clipEnd } from '../../types/model';
import { readStore } from '../../state/store';
import {
  detachRefusal,
  linkRefusal,
  planInsert,
  selectDetachableClipIds,
  selectLinkedClosure,
} from '../../state/timelineSlice';
import { insertSelectionAtPlayhead, selectionInsert } from './insertCommand';
import { refusalLabel } from './refusalLabel';
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

const anyLocked = (s: StoreState, ids: readonly ClipId[]): boolean =>
  ids.some((id) => {
    const clip = s.clips[id];
    return clip !== undefined && s.tracks[clip.trackId]?.locked === true;
  });

const anySplittable = (s: StoreState, ids: readonly ClipId[]): boolean =>
  ids.some((id) => {
    const clip = s.clips[id];
    return clip !== undefined && s.playhead > clip.start && s.playhead < clipEnd(clip);
  });

/* ------------------------------------------------------- transitions (§4.4)

   Everything below is decided over `effectiveIds` like every other item here,
   and every predicate is an ANY rather than an EVERY: the actions apply to the
   subset they can, exactly as `splitAtPlayhead` already does, so a mixed
   selection offers the command and honours it where it is legal instead of
   greying out because one member of forty could not take it.                 */

/**
 * The clip on the same track that ends EXACTLY where `clip` starts, or null.
 *
 * Exactly, not "within a frame": a cross-dissolve is built by extending the
 * outgoing clip's tail under the incoming one (CREATIVE §4.3), and a one-frame
 * gap between them is a one-frame hole in the programme that the dissolve would
 * paint over instead of revealing. `clipsByTrack` is already in ascending
 * `start` order, so this is the neighbour immediately before it.
 */
function previousAdjacent(s: StoreState, clip: Clip): Clip | null {
  const ids = s.clipsByTrack[clip.trackId] ?? [];
  const at = ids.indexOf(clip.id);
  if (at <= 0) return null;
  const previous = s.clips[ids[at - 1]];
  return previous && clipEnd(previous) === clip.start ? previous : null;
}

/**
 * CREATIVE §4.4's default: 12 frames, clamped to a third of the SHORTER clip.
 * `shorterDuration` is the clip's own length for a fade and the lesser of the
 * two for a dissolve. 0 means the clip cannot carry a transition at all — the
 * store's own clamp is 1..⌊duration/3⌋, and a two-frame clip has no ⌊/3⌋.
 */
const defaultTransitionFrames = (shorterDuration: number): number =>
  Math.min(DEFAULT_TRANSITION_FRAMES, Math.floor(shorterDuration / 3));

const anyFadeable = (s: StoreState, ids: readonly ClipId[]): boolean =>
  ids.some((id) => {
    const clip = s.clips[id];
    return clip !== undefined && defaultTransitionFrames(clip.duration) >= 1;
  });

const anyDissolvable = (s: StoreState, ids: readonly ClipId[]): boolean =>
  ids.some((id) => {
    const clip = s.clips[id];
    if (!clip) return false;
    const previous = previousAdjacent(s, clip);
    return previous !== null && defaultTransitionFrames(Math.min(clip.duration, previous.duration)) >= 1;
  });

const anyTransitioned = (s: StoreState, ids: readonly ClipId[]): boolean =>
  ids.some((id) => {
    const clip = s.clips[id];
    return clip !== undefined && (clip.transitionIn !== undefined || clip.transitionOut !== undefined);
  });

/**
 * ONE history entry for the whole selection. `beginHistory` is a no-op when a
 * transaction is already open and `commitHistory` a no-op when none is, so this
 * is correct whether or not `setClipTransition` opens one of its own — it can
 * only ever reduce the number of entries, never leave one dangling.
 */
function writeTransitions(label: string, write: (s: StoreState) => void): void {
  const store = readStore();
  store.beginHistory(label);
  write(readStore());
  readStore().commitHistory();
}

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

    // Decided over the same `effectiveIds` every other item uses, and over the
    // same closure `linkClips` takes (docs/LINKING.md §8.6). Both items are
    // enabled or disabled, never hidden: PLAN preamble S4's "do not render an
    // inapplicable control" governs controls that are IRRELEVANT to the
    // selection, and these two are always relevant to a clip.
    const closure = selectLinkedClosure(s, ids);
    const linkable = closure.length >= 2 && !anyLocked(s, closure);
    const unlinkable = ids.some((id) => s.clips[id]?.linkId !== undefined);

    // CREATIVE §12. Enablement is a DRY RUN of the same planner the command
    // runs, over the same delta the command computes — `selectionInsert` is
    // shared rather than reimplemented here, so the item cannot offer an insert
    // that then refuses, or grey out one that would have worked. The refusal
    // sentence is the planner's own, so the menu and the keystroke word it
    // identically.
    const wanted = selectionInsert(s);
    const insertPlan = wanted
      ? planInsert(s, wanted.ids, wanted.delta, 0, wanted.primaryTrackId)
      : null;
    const insertable = insertPlan?.ok === true;

    const fadeable = !lockedAll && anyFadeable(s, ids);
    const dissolvable = !lockedAll && anyDissolvable(s, ids);
    const removable = !lockedAll && anyTransitioned(s, ids);
    /** Locked outranks everything: it is why the item is off, whatever else is. */
    const tooShort = 'Clip is too short — a transition is at most a third of it';

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
      {
        kind: 'item',
        id: 'link',
        label: 'Link',
        icon: <Link2 size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="edit.link" />,
        disabled: !linkable,
        // §4.1's own table, reused verbatim, so the menu and the keystroke cannot
        // explain themselves differently.
        disabledReason: linkable ? undefined : linkRefusal(s, ids).message,
        onSelect: () => readStore().linkClips(),
      },
      {
        kind: 'item',
        id: 'unlink',
        label: 'Unlink',
        icon: <Unlink2 size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="edit.unlink" />,
        disabled: !unlinkable,
        disabledReason: unlinkable ? undefined : 'Select a linked clip first',
        onSelect: () => readStore().unlinkClips(),
      },
      {
        kind: 'item',
        id: 'insert-at-playhead',
        label: 'Insert at playhead',
        icon: <BetweenHorizontalStart size={14} strokeWidth={1.75} />,
        shortcut: <ShortcutHint id="edit.insertAtPlayhead" />,
        disabled: !insertable,
        disabledReason: insertable
          ? undefined
          : insertPlan === null || insertPlan.ok
            ? 'Select a clip first'
            : refusalLabel(s, insertPlan.reason, insertPlan.blockingClipId),
        onSelect: () => insertSelectionAtPlayhead(),
      },
      { kind: 'separator', id: 'sep-transitions' },
      {
        kind: 'item',
        id: 'fade-in',
        label: 'Fade in',
        icon: <Sunrise size={14} strokeWidth={1.75} />,
        disabled: !fadeable,
        disabledReason: fadeable ? undefined : lockedAll ? 'Track is locked' : tooShort,
        onSelect: () =>
          writeTransitions('Fade in', (s) => {
            for (const clipId of ids) {
              const clip = s.clips[clipId];
              if (!clip) continue;
              const frames = defaultTransitionFrames(clip.duration);
              if (frames >= 1) s.setClipTransition(clipId, 'in', { kind: 'fade', frames });
            }
          }),
      },
      {
        kind: 'item',
        id: 'fade-out',
        label: 'Fade out',
        icon: <Sunset size={14} strokeWidth={1.75} />,
        disabled: !fadeable,
        disabledReason: fadeable ? undefined : lockedAll ? 'Track is locked' : tooShort,
        onSelect: () =>
          writeTransitions('Fade out', (s) => {
            for (const clipId of ids) {
              const clip = s.clips[clipId];
              if (!clip) continue;
              const frames = defaultTransitionFrames(clip.duration);
              if (frames >= 1) s.setClipTransition(clipId, 'out', { kind: 'fade', frames });
            }
          }),
      },
      {
        kind: 'item',
        id: 'cross-dissolve',
        label: 'Cross dissolve',
        icon: <Blend size={14} strokeWidth={1.75} />,
        disabled: !dissolvable,
        // A dissolve is owned by the INCOMING clip (CREATIVE §4.3) and is built
        // by extending the outgoing clip's tail underneath it, so it needs a
        // clip to cross WITH. Naming that requirement is the whole point of the
        // disabled state: "Cross dissolve" greyed out with no sentence beside it
        // reads as "not implemented".
        disabledReason: dissolvable
          ? undefined
          : lockedAll
            ? 'Track is locked'
            : 'Needs a clip ending exactly where this one starts, on the same track',
        onSelect: () =>
          writeTransitions('Cross dissolve', (s) => {
            for (const clipId of ids) {
              const clip = s.clips[clipId];
              if (!clip) continue;
              const previous = previousAdjacent(s, clip);
              if (!previous) continue;
              const frames = defaultTransitionFrames(Math.min(clip.duration, previous.duration));
              if (frames >= 1) s.setClipTransition(clipId, 'in', { kind: 'dissolve', frames });
            }
          }),
      },
      {
        kind: 'item',
        id: 'remove-transitions',
        label: 'Remove transitions',
        icon: <Eraser size={14} strokeWidth={1.75} />,
        disabled: !removable,
        disabledReason: removable
          ? undefined
          : lockedAll
            ? 'Track is locked'
            : 'Nothing selected has a transition',
        onSelect: () =>
          writeTransitions('Remove transitions', (s) => {
            for (const clipId of ids) {
              s.setClipTransition(clipId, 'in', null);
              s.setClipTransition(clipId, 'out', null);
            }
          }),
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
