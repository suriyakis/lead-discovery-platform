'use server';

// Form actions for the review detail page (/review/[id]).
//
// These used to be inline closures in page.tsx with no error handling, so
// a viewer clicking Approve, a stale tab approving an item someone else
// archived, or Generate draft on an empty token wallet all crashed into
// Next's generic error page (I078). They live at module scope now — the
// page binds the item id — and every expected service error becomes a
// readable flash on the page:
//
//   permission_denied / invalid_input / insufficient_tokens → ?error=
//   conflict (item archived in the meantime)               → ?message= on the item
//   not_found (item deleted in the meantime)               → ?message= on /review
//
// Unexpected errors still propagate to app/error.tsx.

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { describeActionError, withFlash } from '@/lib/action-errors';
import type { WorkspaceContext } from '@/lib/services/context';
import { OutreachServiceError, generateOutreachDraft } from '@/lib/services/outreach';
import {
  ReviewServiceError,
  approveReviewItem,
  archiveReviewItem,
  commentOnReviewItem,
  flagForReview,
  ignoreReviewItem,
  rejectReviewItem,
} from '@/lib/services/review';
import { TokenError } from '@/lib/services/token-ledger';

const ITEM_GONE = 'That review item no longer exists — it may have been deleted.';
const READ_ONLY =
  "Your role in this workspace is read-only, so you can't change review items. Ask a workspace admin if you need edit access.";

type Transition = 'approve' | 'reject' | 'ignore' | 'flag';

const TRANSITION_PAST: Record<Transition, string> = {
  approve: 'approved',
  reject: 'rejected',
  ignore: 'ignored',
  flag: 'flagged for review',
};

function parseItemId(raw: unknown): bigint | null {
  return typeof raw === 'string' && /^\d{1,19}$/.test(raw) ? BigInt(raw) : null;
}

function itemPath(id: bigint): string {
  return `/review/${id}`;
}

function reasonFrom(formData: FormData): string | null {
  return String(formData.get('reason') ?? '').trim().slice(0, 500) || null;
}

/** Route a described review failure to the right page and flash. */
function redirectForFailure(id: bigint, failure: { code: string; message: string }): never {
  if (failure.code === 'not_found') redirect(withFlash('/review', { message: ITEM_GONE }));
  if (failure.code === 'conflict') redirect(withFlash(itemPath(id), { message: failure.message }));
  redirect(withFlash(itemPath(id), { error: failure.message }));
}

async function runTransition(
  rawId: unknown,
  kind: Transition,
  apply: (ctx: WorkspaceContext, id: bigint) => Promise<unknown>,
): Promise<never> {
  const id = parseItemId(rawId);
  if (id === null) redirect('/review');
  const ctx = await requireActionContext('/review');
  try {
    await apply(ctx, id);
  } catch (err) {
    redirectForFailure(
      id,
      describeActionError(err, [ReviewServiceError], {
        permission_denied: READ_ONLY,
        // The only terminal review state is 'archived' — and the buttons
        // are hidden once an item is archived — so a conflict means another
        // tab or person archived it after this page was rendered.
        conflict: `This item was archived in the meantime, so it can no longer be ${TRANSITION_PAST[kind]}. Nothing was changed.`,
      }),
    );
  }
  redirect(itemPath(id));
}

export async function approveReviewItemAction(rawId: string, formData: FormData): Promise<void> {
  const reason = reasonFrom(formData);
  await runTransition(rawId, 'approve', (ctx, id) => approveReviewItem(ctx, id, reason));
}

export async function rejectReviewItemAction(rawId: string, formData: FormData): Promise<void> {
  const reason = reasonFrom(formData);
  await runTransition(rawId, 'reject', (ctx, id) => rejectReviewItem(ctx, id, reason));
}

export async function ignoreReviewItemAction(rawId: string): Promise<void> {
  await runTransition(rawId, 'ignore', (ctx, id) => ignoreReviewItem(ctx, id));
}

export async function flagReviewItemAction(rawId: string): Promise<void> {
  await runTransition(rawId, 'flag', (ctx, id) => flagForReview(ctx, id));
}

export async function archiveReviewItemAction(rawId: string): Promise<void> {
  const id = parseItemId(rawId);
  if (id === null) redirect('/review');
  const ctx = await requireActionContext('/review');
  try {
    await archiveReviewItem(ctx, id);
  } catch (err) {
    redirectForFailure(
      id,
      describeActionError(err, [ReviewServiceError], {
        permission_denied: 'Only workspace admins can archive review items.',
      }),
    );
  }
  redirect('/review');
}

export async function commentOnReviewItemAction(rawId: string, formData: FormData): Promise<void> {
  const id = parseItemId(rawId);
  if (id === null) redirect('/review');
  const text = String(formData.get('comment') ?? '').trim();
  if (!text) redirect(withFlash(itemPath(id), { error: 'Write a comment before posting it.' }));
  const ctx = await requireActionContext('/review');
  try {
    await commentOnReviewItem(ctx, id, text);
  } catch (err) {
    redirectForFailure(
      id,
      describeActionError(err, [ReviewServiceError], {
        permission_denied:
          "Your role in this workspace is read-only, so you can't comment. Ask a workspace admin if you need edit access.",
      }),
    );
  }
  redirect(itemPath(id));
}

export async function generateDraftAction(rawId: string, formData: FormData): Promise<void> {
  const id = parseItemId(rawId);
  if (id === null) redirect('/review');
  const productId = parseItemId(String(formData.get('productId') ?? ''));
  if (productId === null) {
    redirect(withFlash(itemPath(id), { error: 'Pick a product to write the draft for.' }));
  }
  const methodRaw = String(formData.get('method') ?? 'rules');
  const method = methodRaw === 'ai' || methodRaw === 'hybrid' ? methodRaw : 'rules';
  const ctx = await requireActionContext('/review');

  let draftId: bigint;
  try {
    const created = await generateOutreachDraft(ctx, {
      reviewItemId: id,
      productProfileId: productId,
      method,
    });
    draftId = created.id;
  } catch (err) {
    const failure = describeActionError(err, [OutreachServiceError, TokenError], {
      permission_denied:
        "Your role in this workspace is read-only, so you can't generate drafts. Ask a workspace admin if you need edit access.",
      not_found:
        'That review item or product no longer exists, so no draft was generated.',
    });
    // Unlike a state change, a missing product does not mean the item is
    // gone — stay on the item and explain.
    redirect(
      withFlash(
        itemPath(id),
        failure.code === 'not_found' ? { message: failure.message } : { error: failure.message },
      ),
    );
  }
  redirect(`/drafts/${draftId}`);
}
