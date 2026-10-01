'use server';

// P61-06 bulk actions for the /mailbox/[id] folder view (trash, restore,
// spam, not-spam, delete permanently, retry).
//
// They live in this "use server" module instead of inline in page.tsx.
// Next serialises an inline action's closure into the rendered page, and
// the inline versions closed over local helpers (parseIds, backToFolder,
// ...). Functions cannot be serialised, so the bulk Trash / Spam buttons
// failed with "Functions cannot be passed directly to Client Components"
// (audit X4, deliverable flow:F-02). /communication hit the same bug and
// got the same fix (src/app/communication/actions.ts, P61-24).
//
// The page binds each action to its mailbox id:
//   formAction={trashMailboxMessages.bind(null, mailbox.id.toString())}
// Bound arguments travel through the client unencrypted, so the id is
// re-validated here before it is used to build the redirect. The folder
// and search the operator acted from come back in the form, so the
// redirect lands on the same view.

import { redirect } from 'next/navigation';
import type { WorkspaceContext } from '@/lib/services/context';
import { requireActionContext } from '@/lib/action-context';
import {
  markAsSpam,
  moveToTrash,
  permanentlyDelete,
  restoreFromTrash,
  retrySend,
  unmarkSpam,
} from '@/lib/services/mail';
import { MAIL_FOLDERS, type MailFolder } from '@/lib/services/mail-folders';
import { isNextRedirectError } from '@/lib/server-redirect';

export async function trashMailboxMessages(
  mailboxId: string,
  formData: FormData,
): Promise<void> {
  await runBulkAction(mailboxId, formData, 'trash failed', async (ctx, ids) => {
    const r = await moveToTrash(ctx, ids);
    return affectedNote('moved to trash', r.affected);
  });
}

export async function restoreMailboxMessages(
  mailboxId: string,
  formData: FormData,
): Promise<void> {
  await runBulkAction(mailboxId, formData, 'restore failed', async (ctx, ids) => {
    const r = await restoreFromTrash(ctx, ids);
    return affectedNote('restored', r.affected);
  });
}

export async function spamMailboxMessages(
  mailboxId: string,
  formData: FormData,
): Promise<void> {
  await runBulkAction(mailboxId, formData, 'mark-spam failed', async (ctx, ids) => {
    const r = await markAsSpam(ctx, ids, 'manual');
    return affectedNote('flagged as spam', r.affected);
  });
}

export async function unspamMailboxMessages(
  mailboxId: string,
  formData: FormData,
): Promise<void> {
  await runBulkAction(mailboxId, formData, 'unmark failed', async (ctx, ids) => {
    const r = await unmarkSpam(ctx, ids);
    return affectedNote('un-flagged', r.affected);
  });
}

export async function deleteMailboxMessages(
  mailboxId: string,
  formData: FormData,
): Promise<void> {
  await runBulkAction(mailboxId, formData, 'delete failed', async (ctx, ids) => {
    const r = await permanentlyDelete(ctx, ids);
    return affectedNote('permanently deleted', r.affected);
  });
}

export async function retryMailboxMessages(
  mailboxId: string,
  formData: FormData,
): Promise<void> {
  await runBulkAction(mailboxId, formData, 'retry failed', async (ctx, ids) => {
    const r = await retrySend(ctx, ids);
    const parts: string[] = [];
    if (r.retried.length > 0) {
      parts.push(
        r.retried.length === 1 ? '1 message resent' : `${r.retried.length} messages resent`,
      );
    }
    if (r.skippedHardBounce.length > 0) {
      parts.push(`${r.skippedHardBounce.length} hard-bounced (skipped)`);
    }
    if (r.skippedIneligible.length > 0) {
      parts.push(`${r.skippedIneligible.length} ineligible`);
    }
    if (r.errors.length > 0) parts.push(`${r.errors.length} failed`);
    return parts.length > 0 ? parts.join(', ') + '.' : 'Nothing to retry.';
  });
}

// ---- helpers (module scope: never captured by an action's closure) ----

/**
 * Resolve the workspace, parse the selected ids, run `act`, and redirect
 * back to the folder view with its result (or its error) as a flash.
 * The redirect happens outside the try so a NEXT_REDIRECT is never
 * mistaken for a failure.
 */
async function runBulkAction(
  mailboxId: string,
  formData: FormData,
  fallbackError: string,
  act: (ctx: WorkspaceContext, ids: bigint[]) => Promise<string>,
): Promise<void> {
  if (!/^\d+$/.test(mailboxId)) redirect('/mailbox');
  const ctx = await requireActionContext();
  const ids = parseIds(formData);
  let message: string;
  try {
    message = await act(ctx, ids);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToFolder(mailboxId, formData, 'error', err instanceof Error ? err.message : fallbackError);
  }
  backToFolder(mailboxId, formData, 'message', message);
}

function backToFolder(
  mailboxId: string,
  formData: FormData,
  flash: 'message' | 'error',
  text: string,
): never {
  const rawFolder = String(formData.get('folder') ?? '');
  const folder: MailFolder = (MAIL_FOLDERS as readonly string[]).includes(rawFolder)
    ? (rawFolder as MailFolder)
    : 'inbox';
  const params = new URLSearchParams({ folder });
  const q = String(formData.get('q') ?? '');
  if (q) params.set('q', q);
  params.set(flash, text);
  redirect(`/mailbox/${mailboxId}?${params.toString()}`);
}

/** Selected message ids from the checkbox list; anything that is not a
 *  plain positive integer is ignored. */
function parseIds(formData: FormData): bigint[] {
  const out: bigint[] = [];
  for (const raw of formData.getAll('ids')) {
    const s = String(raw);
    if (/^\d+$/.test(s)) out.push(BigInt(s));
  }
  return out;
}

function affectedNote(verb: string, n: number): string {
  if (n === 0) return `No messages ${verb} (nothing was selected or eligible).`;
  if (n === 1) return `1 message ${verb}.`;
  return `${n} messages ${verb}.`;
}
