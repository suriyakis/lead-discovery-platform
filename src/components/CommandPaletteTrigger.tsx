'use client';

// The visible way into Cmd-K (ia:F-10): a "Search" button in the header
// of the workspace app and of the Platform console. It asks the mounted
// CommandPalette to open through a window event, so the two can sit in
// different parts of the tree. On a narrow header it shows its icon only
// (CommandPalette.module.css), so its name is an aria-label rather than
// the label text a hidden span would drop. Tests find it by
// data-command-palette-trigger.

import { Search } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette';
import styles from './CommandPalette.module.css';

export function CommandPaletteTrigger() {
  return (
    <button
      type="button"
      className={cx('ghost-btn', styles.trigger)}
      data-command-palette-trigger=""
      aria-label="Search"
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
    >
      <Search className="lucide" aria-hidden="true" />
      <span className={styles.triggerLabel} aria-hidden="true">
        Search
      </span>
      <kbd className={styles.triggerKbd} aria-hidden="true">
        ⌘K
      </kbd>
    </button>
  );
}
