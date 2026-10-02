// flow:F-05 (I012) — the public unsubscribe flow behind
// /api/unsubscribe/<token>.
//
// A link in an email is opened by machines too: B2B gateways (Defender,
// Mimecast, Proofpoint …) fetch every URL to scan it. So reading the link
// (GET / HEAD) never changes anything — resolveUnsubscribeToken only looks
// the token up for the confirmation page. Only an explicit POST (the
// page's button, or a mail client's RFC 8058 one-click POST) calls
// confirmUnsubscribe, which:
//   1. suppresses every recipient of the message (source unsubscribe_link,
//      the non-downgrading F-03 merge — recordUnsubscribeByToken);
//   2. cancels queued sends to those addresses;
//   3. cancels their pending / awaiting-approval follow-ups;
//   4. closes the open (legacy pipeline) leads that target them.
// The suppression is the obligation and runs first; 2–4 are best-effort
// clean-up so nothing keeps composing mail that can no longer be sent.
// The actor is the anonymous recipient: every audit row has a null user.

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { mailMessages, mailboxes } from '@/lib/db/schema/mailing';
import { recordUnsubscribeByToken } from './suppression';
import { cancelQueuedForRecipient } from './outreach-queue';
import { cancelFollowUpsForRecipient } from './follow-up';
import { closeLeadsForRecipient } from './pipeline';

const TOKEN_RE = /^[a-f0-9]{16,64}$/i;

export interface UnsubscribeTarget {
  workspaceId: bigint;
  messageId: bigint;
  threadId: bigint | null;
  /** Recipients the token covers, lower-cased. */
  addresses: string[];
  /** The email's language (its target language), for the page copy. */
  language: string | null;
  subject: string;
  /** Where "Wrong person? Tell us who" goes — the mailbox's reply address. */
  replyAddress: string;
}

/** Read-only token lookup for the confirmation page. Never writes. */
export async function resolveUnsubscribeToken(
  token: string,
): Promise<UnsubscribeTarget | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select({
      id: mailMessages.id,
      workspaceId: mailMessages.workspaceId,
      threadId: mailMessages.threadId,
      toAddresses: mailMessages.toAddresses,
      targetLanguage: mailMessages.targetLanguage,
      subject: mailMessages.subject,
      fromAddress: mailMessages.fromAddress,
      replyTo: mailboxes.replyTo,
      mailboxFrom: mailboxes.fromAddress,
    })
    .from(mailMessages)
    .leftJoin(
      mailboxes,
      and(
        eq(mailboxes.workspaceId, mailMessages.workspaceId),
        eq(mailboxes.id, mailMessages.mailboxId),
      ),
    )
    .where(and(eq(mailMessages.trackingToken, token), eq(mailMessages.direction, 'outbound')))
    .limit(1);
  if (!row) return null;
  return {
    workspaceId: row.workspaceId,
    messageId: row.id,
    threadId: row.threadId ?? null,
    addresses: normalizeAddresses(row.toAddresses),
    language: row.targetLanguage ?? null,
    subject: row.subject,
    replyAddress: row.replyTo ?? row.mailboxFrom ?? row.fromAddress,
  };
}

export interface UnsubscribeOutcome {
  workspaceId: bigint | null;
  /** Addresses now suppressed (empty for an unknown token). */
  addresses: string[];
  cancelledQueueIds: bigint[];
  cancelledFollowUpIds: bigint[];
  closedLeadIds: bigint[];
}

/** The explicit opt-out (POST only). Idempotent. */
export async function confirmUnsubscribe(token: string): Promise<UnsubscribeOutcome> {
  const target = await resolveUnsubscribeToken(token);
  const empty: UnsubscribeOutcome = {
    workspaceId: null,
    addresses: [],
    cancelledQueueIds: [],
    cancelledFollowUpIds: [],
    closedLeadIds: [],
  };
  if (!target) return empty;

  const suppressed = await recordUnsubscribeByToken(token);
  if (suppressed.workspaceId === null || suppressed.addresses.length === 0) {
    return { ...empty, workspaceId: suppressed.workspaceId };
  }

  const ctx = { workspaceId: suppressed.workspaceId };
  const outcome: UnsubscribeOutcome = {
    workspaceId: suppressed.workspaceId,
    addresses: suppressed.addresses,
    cancelledQueueIds: [],
    cancelledFollowUpIds: [],
    closedLeadIds: [],
  };
  const sourceRef = `mail_message:${target.messageId}`;

  for (const address of suppressed.addresses) {
    try {
      outcome.cancelledQueueIds.push(
        ...(await cancelQueuedForRecipient(
          ctx,
          address,
          'cancelled: the recipient unsubscribed (unsubscribe link)',
        )),
      );
    } catch (err) {
      console.error('[unsubscribe] queue cancel failed:', err);
    }
    try {
      outcome.cancelledFollowUpIds.push(
        ...(await cancelFollowUpsForRecipient(
          ctx,
          { address, threadId: target.threadId },
          'unsubscribed',
        )),
      );
    } catch (err) {
      console.error('[unsubscribe] follow-up cancel failed:', err);
    }
    try {
      outcome.closedLeadIds.push(
        ...(await closeLeadsForRecipient(ctx, address, {
          // Same reason the reply handler uses for an unsubscribe reply.
          closeReason: 'no_response',
          closeNote: 'The contact unsubscribed with the link in our email.',
          payload: { source: 'unsubscribe_link', sourceRef },
        })),
      );
    } catch (err) {
      console.error('[unsubscribe] lead close failed:', err);
    }
  }

  outcome.cancelledQueueIds = uniqueIds(outcome.cancelledQueueIds);
  outcome.cancelledFollowUpIds = uniqueIds(outcome.cancelledFollowUpIds);
  outcome.closedLeadIds = uniqueIds(outcome.closedLeadIds);

  if (
    outcome.cancelledQueueIds.length +
      outcome.cancelledFollowUpIds.length +
      outcome.closedLeadIds.length >
    0
  ) {
    try {
      await db.insert(auditLog).values({
        workspaceId: suppressed.workspaceId,
        userId: null,
        kind: 'unsubscribe.outreach_stopped',
        entityType: 'mail_message',
        entityId: target.messageId.toString(),
        payload: {
          source: 'unsubscribe_link',
          addresses: outcome.addresses,
          cancelledQueueIds: outcome.cancelledQueueIds.map(String),
          cancelledFollowUpIds: outcome.cancelledFollowUpIds.map(String),
          closedLeadIds: outcome.closedLeadIds.map(String),
        },
      });
    } catch (err) {
      console.error('[unsubscribe] audit log insert failed:', err);
    }
  }

  return outcome;
}

function normalizeAddresses(raw: ReadonlyArray<string | null> | null): string[] {
  const out = new Set<string>();
  for (const a of raw ?? []) {
    const v = (a ?? '').trim().toLowerCase();
    if (v) out.add(v);
  }
  return Array.from(out);
}

function uniqueIds(ids: bigint[]): bigint[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const k = id.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
