'use client';

// The visible way into Cmd-K (ia:F-10): a "Search" button in the header
// of the workspace app and of the Platform console. It asks the mounted
// CommandPalette to open through a window event, so the two can sit in
// different parts of the tree.

import { Search } from 'lucide-react';
import { OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette';

export function CommandPaletteTrigger() {
  return (
    <button
      type="button"
      className="ghost-btn cmdk-trigger"
      data-command-palette-trigger=""
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
    >
      <Search className="lucide" aria-hidden="true" />
      <span className="cmdk-trigger-label">Search</span>
      <kbd className="cmdk-trigger-kbd">⌘K</kbd>
    </button>
  );
}
