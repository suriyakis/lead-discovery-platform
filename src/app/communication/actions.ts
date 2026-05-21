'use server';

// P61-24: server actions for the /communication folder UI. Living in
// their own module file (with the file-level "use server" directive)
// instead of inline in page.tsx, because the page-tsx nested-inline
// form was crashing the RSC serializer with
// "Functions cannot be passed directly to Client Components".
// Each action reads `folder / q / mailboxId / source / productId /
// from / to / page / perPage` from the posted FormData and bounces
// back to /communication preserving the filter context.

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { listMailboxes } from '@/lib/services/mailbox';
import {
  markAsSpam,
  moveToTrash,
  permanentlyDelete,
  restoreFromTrash,
  retrySend,
  safeSyncOne,
  unmarkSpam,
} from '@/lib/services/mail';
import { isNextRedirectError } from '@/lib/server-redirect';

const FILTER_KEYS = [
  'folder',
  'q',
  'mailboxId',
  'source',
  'productId',
  'from',
  'to',
  'page',
  'perPage',
] as const;

function makeRedirectParams(formData: FormData): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const v = String(formData.get(key) ?? '');
    if (v) params.set(key, v);
  }
  if (!params.get('folder')) params.set('folder', 'inbox');
  return params;
}

function backToFolder(formData: FormData, msg: string): never {
  const params = makeRedirectParams(formData);
  params.set('message', msg);
  redirect(`/communication?${params.toString()}`);
}

function backToFolderError(formData: FormData, msg: string): never {
  const params = makeRedirectParams(formData);
  params.set('error', msg);
  redirect(`/communication?${params.toString()}`);
}

function parseIds(formData: FormData): bigint[] {
  const out: bigint[] = [];
  for (const raw of formData.getAll('ids')) {
    const s = String(raw);
    if (!/^\d+$/.test(s)) continue;
    try {
      out.push(BigInt(s));
    } catch {
      // skip
    }
  }
  return out;
}

function affectedNote(verb: string, n: number): string {
  if (n === 0) return `No messages ${verb} (nothing was selected or eligible).`;
  if (n === 1) return `1 message ${verb}.`;
  return `${n} messages ${verb}.`;
}

export async function trashSelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  try {
    const r = await moveToTrash(c, ids);
    backToFolder(formData, affectedNote('moved to trash', r.affected));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToFolderError(
      formData,
      err instanceof Error ? err.message : 'trash failed',
    );
  }
}

export async function restoreSelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  try {
    const r = await restoreFromTrash(c, ids);
    backToFolder(formData, affectedNote('restored', r.affected));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToFolderError(
      formData,
      err instanceof Error ? err.message : 'restore failed',
    );
  }
}

export async function spamSelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  try {
    const r = await markAsSpam(c, ids, 'manual');
    backToFolder(formData, affectedNote('flagged as spam', r.affected));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToFolderError(
      formData,
      err instanceof Error ? err.message : 'mark-spam failed',
    );
  }
}

export async function unspamSelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  try {
    const r = await unmarkSpam(c, ids);
    backToFolder(formData, affectedNote('un-flagged', r.affected));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToFolderError(
      formData,
      err instanceof Error ? err.message : 'unmark failed',
    );
  }
}

export async function deleteSelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  try {
    const r = await permanentlyDelete(c, ids);
    backToFolder(formData, affectedNote('permanently deleted', r.affected));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToFolderError(
      formData,
      err instanceof Error ? err.message : 'delete failed',
    );
  }
}

export async function retrySelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  try {
    const r = await retrySend(c, ids);
    const parts: string[] = [];
    if (r.retried.length > 0)
      parts.push(
        r.retried.length === 1
          ? '1 message resent'
          : `${r.retried.length} messages resent`,
      );
    if (r.skippedHardBounce.length > 0)
      parts.push(`${r.skippedHardBounce.length} hard-bounced (skipped)`);
    if (r.skippedIneligible.length > 0)
      parts.push(`${r.skippedIneligible.length} ineligible`);
    if (r.errors.length > 0) parts.push(`${r.errors.length} failed`);
    backToFolder(
      formData,
      parts.length > 0 ? parts.join(', ') + '.' : 'Nothing to retry.',
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToFolderError(
      formData,
      err instanceof Error ? err.message : 'retry failed',
    );
  }
}

export async function syncMailbox(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const all = await listMailboxes(c);
  const filterIdRaw = formData.get('mailboxId');
  const filterId =
    typeof filterIdRaw === 'string' && /^\d+$/.test(filterIdRaw)
      ? BigInt(filterIdRaw)
      : null;
  const targets = filterId
    ? all.filter(
        (mb) => mb.id === filterId && mb.imapHost && mb.status !== 'archived',
      )
    : all.filter(
        (mb) => mb.status === 'active' && mb.imapHost,
      );
  if (targets.length === 0) {
    backToFolderError(
      formData,
      filterId
        ? 'Selected mailbox has no IMAP configured or is archived.'
        : 'No active IMAP-enabled mailbox to sync.',
    );
  }

  let synced = 0;
  let totalFetched = 0;
  let totalInserted = 0;
  const failures: string[] = [];
  const paused: string[] = [];
  for (const mb of targets) {
    const outcome = await safeSyncOne(c, mb);
    if (outcome.kind === 'synced') {
      synced++;
      totalFetched += outcome.fetched;
      totalInserted += outcome.inserted;
    } else if (outcome.kind === 'auth_failed') {
      paused.push(`${mb.name} (paused: ${truncate(outcome.message)})`);
    } else {
      failures.push(
        `${mb.name} (will back off: ${truncate(outcome.message)})`,
      );
    }
  }

  // Build a single sentence that reports both wins and losses so a
  // partial-success batch reads as a partial success, not a failure.
  const parts: string[] = [];
  if (synced > 0) {
    parts.push(
      synced === 1
        ? `Synced ${targets.find((t) => true)?.name ?? '1 mailbox'} — fetched ${totalFetched}, new ${totalInserted}`
        : `Synced ${synced} mailbox(es) — fetched ${totalFetched}, new ${totalInserted}`,
    );
  }
  if (paused.length > 0) parts.push(`auto-paused: ${paused.join('; ')}`);
  if (failures.length > 0) parts.push(`failed: ${failures.join('; ')}`);

  if (synced === 0) {
    backToFolderError(
      formData,
      parts.length > 0 ? parts.join(' · ') : 'Nothing to sync.',
    );
  } else {
    backToFolder(formData, parts.join(' · ') + '.');
  }
}

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
