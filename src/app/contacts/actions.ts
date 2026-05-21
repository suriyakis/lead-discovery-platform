'use server';

// P61-26: server actions for the contacts list bulk operations.

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  ContactServiceError,
  bulkAddTag,
  bulkArchiveContacts,
  bulkRemoveTag,
  bulkUnarchiveContacts,
} from '@/lib/services/contacts';
import { isNextRedirectError } from '@/lib/server-redirect';

const FILTER_KEYS = ['q', 'company', 'status', 'tag', 'page', 'perPage'] as const;

function backTo(formData: FormData, msg: string): never {
  const params = makeRedirectParams(formData);
  params.set('message', msg);
  redirect(`/contacts?${params.toString()}`);
}
function backToError(formData: FormData, msg: string): never {
  const params = makeRedirectParams(formData);
  params.set('error', msg);
  redirect(`/contacts?${params.toString()}`);
}
function makeRedirectParams(formData: FormData): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const v = String(formData.get(key) ?? '');
    if (v) params.set(key, v);
  }
  return params;
}
function parseIds(formData: FormData): bigint[] {
  const out: bigint[] = [];
  for (const raw of formData.getAll('ids')) {
    const s = String(raw);
    if (!/^\d+$/.test(s)) continue;
    try { out.push(BigInt(s)); } catch {}
  }
  return out;
}
function note(verb: string, n: number): string {
  if (n === 0) return `No contacts ${verb} (nothing was selected or eligible).`;
  if (n === 1) return `1 contact ${verb}.`;
  return `${n} contacts ${verb}.`;
}

export async function archiveSelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  try {
    const r = await bulkArchiveContacts(c, ids);
    backTo(formData, note('archived', r.affected));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToError(formData, err instanceof Error ? err.message : 'archive failed');
  }
}

export async function unarchiveSelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  try {
    const r = await bulkUnarchiveContacts(c, ids);
    backTo(formData, note('restored', r.affected));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToError(formData, err instanceof Error ? err.message : 'restore failed');
  }
}

export async function addTagSelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  const tag = String(formData.get('tag') ?? '').trim();
  if (!tag) backToError(formData, 'Tag value is empty.');
  try {
    const r = await bulkAddTag(c, ids, tag);
    backTo(formData, note(`tagged "${tag}"`, r.affected));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToError(
      formData,
      err instanceof ContactServiceError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'tag-add failed',
    );
  }
}

export async function removeTagSelected(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const ids = parseIds(formData);
  const tag = String(formData.get('tag') ?? '').trim();
  if (!tag) backToError(formData, 'Tag value is empty.');
  try {
    const r = await bulkRemoveTag(c, ids, tag);
    backTo(formData, note(`untagged "${tag}" from`, r.affected));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backToError(
      formData,
      err instanceof ContactServiceError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'tag-remove failed',
    );
  }
}
