/* ---------------------------------------------------------------------------
   MediaEmptyState — the first-run experience, and the only empty state in the
   application (PLAN §8.14).

   It teaches, it does not sell. A drop target and the keyboard route; no
   heading, no illustration, no feature list, no call to action. PRODUCT.md
   principle 5: "no empty state selling a feature".

   The key is rendered by ShortcutHint from the registry id, never typed as a
   string (PLAN §8.10). Rebinding file.import must not leave the first screen
   teaching a key that no longer works.
--------------------------------------------------------------------------- */

import './media.css';
import type { ReactElement } from 'react';
import { ShortcutHint } from '../../keyboard/ShortcutHint';

export interface MediaEmptyStateProps {
  /** True while a file drag from the OS is over the window. */
  dropActive: boolean;
}

export function MediaEmptyState({ dropActive }: MediaEmptyStateProps): ReactElement {
  return (
    <div className="media-empty" data-drop-active={dropActive || undefined}>
      <div className="media-empty-target">
        <p className="media-empty-title type-body">Drop video files here</p>
        <p className="media-empty-hint type-label">
          or press <ShortcutHint id="file.import" /> to import
        </p>
      </div>
    </div>
  );
}
