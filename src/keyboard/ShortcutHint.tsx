/* ---------------------------------------------------------------------------
   ShortcutHint — PLAN §8.10. Renders the platform-correct key combination for
   a registered shortcut, and nothing else.

   Every tooltip and every toolbar control passes an id; none of them types a
   key string. That is what keeps a label and its binding from drifting apart —
   change the registry and every hint in the app follows.
--------------------------------------------------------------------------- */

import './keyboard.css';
import type { ReactElement } from 'react';
import { SHORTCUT_BY_ID, comboSpoken, comboTokens, shortcutPlatform } from './shortcuts';
import type { ShortcutId } from './shortcuts';

export interface ShortcutHintProps {
  id: ShortcutId;
  /**
   * Which of the registry's combos to show, when a row binds more than one
   * (zoom in is bound to both `+` and `=`). Defaults to the first.
   */
  index?: number;
}

export function ShortcutHint({ id, index = 0 }: ShortcutHintProps): ReactElement | null {
  const def = SHORTCUT_BY_ID[id];
  const combo = def?.keys[index];
  if (!combo) return null;

  const platform = shortcutPlatform();
  const tokens = comboTokens(combo, platform);

  return (
    <span className="ve-shortcut-hint">
      <span className="sr-only">{comboSpoken(combo, platform)}</span>
      <span className="ve-shortcut-keys" aria-hidden="true">
        {tokens.map((token, i) => (
          <kbd key={`${token}-${i}`} className="ve-kbd type-label">
            {token}
          </kbd>
        ))}
      </span>
    </span>
  );
}
