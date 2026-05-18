'use server';

// Server action for the Cmd-K palette. Resolves workspace context from
// the active session and returns a small entity index (products, leads,
// mailboxes, recent threads). Called by CommandPalette on first open.

import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  getCommandPaletteIndex,
  type CommandPaletteEntry,
} from '@/lib/services/command-palette';

export async function fetchCommandPaletteEntities(): Promise<CommandPaletteEntry[]> {
  try {
    const ctx = await getWorkspaceContext();
    return await getCommandPaletteIndex(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError || err instanceof NoWorkspaceError) {
      return [];
    }
    throw err;
  }
}
