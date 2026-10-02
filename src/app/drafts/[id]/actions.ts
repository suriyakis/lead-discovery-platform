'use server';

// Form actions for the draft detail page (/drafts/[id]). They used to be
// inline closures in page.tsx; they live at module scope now (the page
// binds the draft id) so that the ones that send, spend or decide can be
// guarded (MOB-06): Approve, Reject, Enqueue for send, Regenerate,
// Archive and Show translation run only in the workspace the page was
// rendered for — after a switch in another tab they are refused before
// anything changes (src/lib/workspace-guard). Saving edits stays
// unguarded: it only rewrites this draft's own text.
//
// Each resolves the context outside its try block and turns an expected
// service refusal into a flash on the page (?error=) instead of the error
// boundary; anything unexpected still reaches app/error.tsx.

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { describeActionError, withFlash } from '@/lib/action-errors';
import { getLanguageName } from '@/lib/i18n/language';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  OutreachServiceError,
  approveOutreachDraft,
  archiveOutreachDraft,
  editOutreachDraft,
  generateDraftTranslation,
  generateOutreachDraft,
  getOutreachDraft,
  rejectOutreachDraft,
  saveDraftTranslation,
} from '@/lib/services/outreach';
import { enqueueDraft } from '@/lib/services/outreach-queue';
import { TokenError } from '@/lib/services/token-ledger';
import { withWorkspaceGuard } from '@/lib/workspace-guard/server';

function parseDraftId(raw: unknown): bigint | null {
  return typeof raw === 'string' && /^\d{1,19}$/.test(raw) ? BigInt(raw) : null;
}

const draftPath = (id: bigint) => `/drafts/${id}`;

/** An expected refusal as a flash on the draft; anything else rethrows. */
function failBack(id: bigint, err: unknown): never {
  const failure = describeActionError(err, [OutreachServiceError, TokenError]);
  if (failure.code === 'not_found') redirect(withFlash('/drafts', { error: failure.message }));
  redirect(withFlash(draftPath(id), { error: failure.message }));
}

export async function saveDraftEditsAction(rawId: string, formData: FormData): Promise<void> {
  const id = parseDraftId(rawId);
  if (id === null) redirect('/drafts');
  const ctx = await requireActionContext('/drafts');
  const subject = String(formData.get('subject') ?? '').trim() || null;
  const body = String(formData.get('body') ?? '');
  try {
    await editOutreachDraft(ctx, id, { subject, body });
  } catch (err) {
    failBack(id, err);
  }
  redirect(draftPath(id));
}

async function enqueueDraftForm(rawId: string, formData: FormData): Promise<void> {
  const id = parseDraftId(rawId);
  if (id === null) redirect('/drafts');
  const ctx = await requireActionContext('/drafts');
  const mailboxIdRaw = String(formData.get('mailboxId') ?? '');
  if (!/^\d{1,19}$/.test(mailboxIdRaw)) {
    redirect(withFlash(draftPath(id), { error: 'Pick a mailbox to send from.' }));
  }
  const delayRaw = String(formData.get('delayMode') ?? 'random');
  const delayMode = delayRaw === 'immediate' || delayRaw === 'fixed' ? delayRaw : 'random';
  try {
    await enqueueDraft(ctx, { draftId: id, mailboxId: BigInt(mailboxIdRaw), delayMode });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    const m = err instanceof Error ? err.message : 'failed';
    redirect(withFlash(draftPath(id), { error: m }));
  }
  redirect('/mailbox/queue?message=Enqueued');
}
export const enqueueDraftAction = withWorkspaceGuard('draft.enqueue', enqueueDraftForm);

async function approveDraftForm(rawId: string, _formData?: FormData): Promise<void> {
  const id = parseDraftId(rawId);
  if (id === null) redirect('/drafts');
  const ctx = await requireActionContext('/drafts');
  try {
    await approveOutreachDraft(ctx, id);
  } catch (err) {
    failBack(id, err);
  }
  redirect(draftPath(id));
}
export const approveDraftAction = withWorkspaceGuard('draft.approve', approveDraftForm);

async function rejectDraftForm(rawId: string, formData: FormData): Promise<void> {
  const id = parseDraftId(rawId);
  if (id === null) redirect('/drafts');
  const ctx = await requireActionContext('/drafts');
  const reason = String(formData.get('reason') ?? '').trim() || null;
  try {
    await rejectOutreachDraft(ctx, id, reason);
  } catch (err) {
    failBack(id, err);
  }
  redirect(draftPath(id));
}
export const rejectDraftAction = withWorkspaceGuard('draft.reject', rejectDraftForm);

/** A fresh draft for the same lead + product (spends tokens for ai / hybrid). */
async function regenerateDraftForm(rawId: string, formData: FormData): Promise<void> {
  const id = parseDraftId(rawId);
  if (id === null) redirect('/drafts');
  const ctx = await requireActionContext('/drafts');
  const methodRaw = String(formData.get('method') ?? 'rules');
  const method = methodRaw === 'ai' || methodRaw === 'hybrid' ? methodRaw : 'rules';
  let createdId: bigint;
  try {
    // Read the pair from the draft itself, never from the form.
    const { product, reviewItem } = await getOutreachDraft(ctx, id);
    const created = await generateOutreachDraft(ctx, {
      reviewItemId: reviewItem.id,
      productProfileId: product.id,
      method,
    });
    createdId = created.id;
  } catch (err) {
    failBack(id, err);
  }
  redirect(draftPath(createdId));
}
export const regenerateDraftAction = withWorkspaceGuard('draft.regenerate', regenerateDraftForm);

async function archiveDraftForm(rawId: string, _formData?: FormData): Promise<void> {
  const id = parseDraftId(rawId);
  if (id === null) redirect('/drafts');
  const ctx = await requireActionContext('/drafts');
  try {
    await archiveOutreachDraft(ctx, id);
  } catch (err) {
    failBack(id, err);
  }
  redirect('/drafts');
}
export const archiveDraftAction = withWorkspaceGuard('draft.archive', archiveDraftForm);

/** Phase 63: generate the reviewed translation (spends tokens). */
async function translateDraftForm(rawId: string, _formData?: FormData): Promise<void> {
  const id = parseDraftId(rawId);
  if (id === null) redirect('/drafts');
  const ctx = await requireActionContext('/drafts');
  let message: string;
  try {
    const d = await generateDraftTranslation(ctx, id);
    message = d.targetLanguage
      ? `Translation generated (${getLanguageName(d.targetLanguage)}) — review/edit below.`
      : 'Recipient language matches your draft — nothing to translate.';
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    const m = err instanceof OutreachServiceError ? err.message : 'translate failed';
    redirect(withFlash(draftPath(id), { error: m }));
  }
  redirect(withFlash(draftPath(id), { message }));
}
export const translateDraftAction = withWorkspaceGuard('draft.translate', translateDraftForm);

export async function saveDraftTranslationAction(rawId: string, formData: FormData): Promise<void> {
  const id = parseDraftId(rawId);
  if (id === null) redirect('/drafts');
  const ctx = await requireActionContext('/drafts');
  try {
    await saveDraftTranslation(ctx, id, {
      subject: String(formData.get('subjectTranslated') ?? '').trim() || null,
      body: String(formData.get('bodyTranslated') ?? ''),
    });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    const m = err instanceof OutreachServiceError ? err.message : 'save failed';
    redirect(withFlash(draftPath(id), { error: m }));
  }
  redirect(withFlash(draftPath(id), { message: 'Translation saved' }));
}
