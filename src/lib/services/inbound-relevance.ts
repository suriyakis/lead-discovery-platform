// Inbound relevance gate — DB side (flow:F-01, X1 / I161 / I165).
//
// lib/mail/relevance.ts decides from signals + facts; this module looks up
// the facts (is a referenced Message-ID one of OURS? did we mail this DSN's
// recipient? is the sender a lead we have mailed? is it our own mailbox?),
// guards the automatic suppression paths, and backfills relevance onto
// inbound rows synced before F-01.
//
// Callers:
//   - mail.persistInbound: assessInboundRelevance() before the insert; only
//     prospect_reply / auto_reply / bounce go on to the reply pipeline.
//   - reply-classifier.applyAutoActions and the outreach reply handler's
//     close_and_suppress branch: autoSuppressionRefusal() before any
//     suppression a classification would cause.
//   - remediation (flow:F-06): backfillInboundRelevance(), dry run first.

import { and, asc, eq, gt, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  mailboxes,
  type MailMessage,
  type MailOutreachRelevance,
  type MailStatus,
} from '@/lib/db/schema/mailing';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import {
  OUTREACH_RELEVANCE_VALUES,
  bulkSignals,
  classifyInboundRelevance,
  extractRelevanceSignals,
  isDeliveryReport,
  isOutreachLinked,
  messageIdKey,
  type InboundRelevanceSignals,
  type OutreachRelevance,
  type RelevanceFacts,
  type RelevanceVerdict,
} from '@/lib/mail/relevance';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, type WorkspaceContext } from './context';

// The DB enum (schema/mailing.ts) and the lib type must name the same set.
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ENUM_MATCHES_LIB: SameSet<MailOutreachRelevance, OutreachRelevance> = true;
void ENUM_MATCHES_LIB;

export class InboundRelevanceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'InboundRelevanceError';
    this.code = code;
  }
}

/** Outbound rows that count as "mail we sent" for reference / DSN matching. */
const OUR_SENT_STATUSES: MailStatus[] = ['sent', 'delivered', 'bounced'];
/** Outbound rows that count as "we have mailed this address" for a lead. */
const DELIVERED_STATUSES: MailStatus[] = ['sent', 'delivered'];
/** A DSN without a usable Message-ID is ours when we mailed its recipient
 *  this recently (before the report arrived). */
export const DSN_RECENT_RECIPIENT_DAYS = 30;

export interface RelevanceEvidence extends RelevanceVerdict {
  references_our_outbound: boolean | null;
  dsn_matches_our_outbound: boolean | null;
  sender_is_contacted_lead: boolean | null;
  sender_is_own_mailbox: boolean | null;
  /** Our Message-IDs (lower-cased) the message points at. */
  matched_message_ids: string[];
}

/** Shape of mail_messages.relevance_signals. */
export type StoredRelevanceSignals = InboundRelevanceSignals & { evidence: RelevanceEvidence };

export interface RelevanceInput {
  fromAddress: string;
  inReplyTo: string | null;
  references: ReadonlyArray<string>;
  receivedAt: Date | null;
  signals: InboundRelevanceSignals;
}

export interface RelevanceAssessment {
  relevance: OutreachRelevance;
  reason: string;
  signals: StoredRelevanceSignals;
}

// ---- facts -------------------------------------------------------------

/** `direction = 'outbound'` as a literal so the planner can use the partial
 *  lower(message_id) index whatever plan it caches. */
const isOutbound = sql`${mailMessages.direction} = 'outbound'`;

/** Which of `keys` (lower-cased Message-IDs) are our sent outbound messages. */
async function ourOutboundIds(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  keys: ReadonlyArray<string>,
): Promise<string[]> {
  if (keys.length === 0) return [];
  const lowered = sql<string>`lower(${mailMessages.messageId})`;
  const rows = await db
    .select({ key: lowered })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        isOutbound,
        inArray(lowered, [...keys]),
        inArray(mailMessages.status, OUR_SENT_STATUSES),
      ),
    );
  return Array.from(new Set(rows.map((r) => r.key)));
}

/** `address` (lower-cased) is among an outbound row's To/Cc recipients.
 *  Raw SQL: drizzle has no builder for "element of a text[] column,
 *  case-insensitively"; the address binds as one string parameter. */
function sentToAddress(address: string): SQL {
  return sql`exists (select 1 from unnest(${mailMessages.toAddresses} || ${mailMessages.ccAddresses}) as rcpt(addr) where lower(rcpt.addr) = ${address})`;
}

async function mailedRecently(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  recipients: ReadonlyArray<string>,
  before: Date,
): Promise<boolean> {
  const addresses = Array.from(new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean)));
  if (addresses.length === 0) return false;
  const since = new Date(before.getTime() - DSN_RECENT_RECIPIENT_DAYS * 86_400_000);
  const rows = await db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        isOutbound,
        inArray(mailMessages.status, OUR_SENT_STATUSES),
        gte(mailMessages.sentAt, since),
        or(...addresses.map(sentToAddress)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function isOwnMailbox(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  sender: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        sql`lower(${mailboxes.fromAddress}) = ${sender}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Sender is the contact address of a qualified lead (on the lead row or
 *  via a contact associated with it) AND we have mailed that address. */
async function isContactedLeadAddress(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  sender: string,
): Promise<boolean> {
  const onLead = await db
    .select({ id: qualifiedLeads.id })
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        or(
          sql`lower(${qualifiedLeads.contactEmail}) = ${sender}`,
          sql`lower(${qualifiedLeads.currentContactEmail}) = ${sender}`,
        ),
      ),
    )
    .limit(1);
  let isLeadAddress = onLead.length > 0;
  if (!isLeadAddress) {
    const viaContact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .innerJoin(
        contactAssociations,
        and(
          eq(contactAssociations.contactId, contacts.id),
          eq(contactAssociations.workspaceId, contacts.workspaceId),
          eq(contactAssociations.entityType, 'qualified_lead'),
        ),
      )
      .where(and(eq(contacts.workspaceId, ctx.workspaceId), eq(contacts.email, sender)))
      .limit(1);
    isLeadAddress = viaContact.length > 0;
  }
  if (!isLeadAddress) return false;
  const sent = await db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        isOutbound,
        inArray(mailMessages.status, DELIVERED_STATUSES),
        sentToAddress(sender),
      ),
    )
    .limit(1);
  return sent.length > 0;
}

// ---- assessment ----------------------------------------------------------

/**
 * Decide an inbound message's relevance to our outreach. Facts whose answer
 * cannot change the verdict are not queried (they stay null in evidence).
 */
export async function assessInboundRelevance(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  input: RelevanceInput,
): Promise<RelevanceAssessment> {
  const sender = input.fromAddress.trim().toLowerCase();
  const facts: RelevanceFacts = {
    referencesOurOutbound: null,
    dsnMatchesOurOutbound: null,
    senderIsContactedLead: null,
    senderIsOwnMailbox: null,
  };

  const refKeys = Array.from(
    new Set(
      [input.inReplyTo, ...input.references]
        .map(messageIdKey)
        .filter((k): k is string => k !== null),
    ),
  );
  const matchedRefs = await ourOutboundIds(ctx, refKeys);
  facts.referencesOurOutbound = matchedRefs.length > 0;
  let matched = matchedRefs;

  if (isDeliveryReport(input.signals)) {
    const dsnKey = messageIdKey(input.signals.dsn?.original_message_id);
    if (dsnKey && !matched.includes(dsnKey)) {
      matched = [...matched, ...(await ourOutboundIds(ctx, [dsnKey]))];
    }
    let recentRecipient = false;
    const recipients = input.signals.dsn?.recipients ?? [];
    if (matched.length === 0 && recipients.length > 0) {
      recentRecipient = await mailedRecently(
        ctx,
        recipients.map((r) => r.final_recipient),
        input.receivedAt ?? new Date(),
      );
    }
    facts.dsnMatchesOurOutbound = matched.length > 0 || recentRecipient;
  } else {
    facts.senderIsOwnMailbox = await isOwnMailbox(ctx, sender);
    if (
      !facts.senderIsOwnMailbox &&
      !facts.referencesOurOutbound &&
      bulkSignals(input.signals).length === 0
    ) {
      facts.senderIsContactedLead = await isContactedLeadAddress(ctx, sender);
    }
  }

  const verdict = classifyInboundRelevance(input.signals, facts);
  return {
    relevance: verdict.relevance,
    reason: verdict.reason,
    signals: {
      ...input.signals,
      evidence: {
        ...verdict,
        references_our_outbound: facts.referencesOurOutbound,
        dsn_matches_our_outbound: facts.dsnMatchesOurOutbound,
        sender_is_contacted_lead: facts.senderIsContactedLead,
        sender_is_own_mailbox: facts.senderIsOwnMailbox,
        matched_message_ids: matched,
      },
    },
  };
}

// ---- auto-suppression guard -------------------------------------------

export type AutoSuppressionTrigger = 'unsubscribe' | 'bounce';

/**
 * Why an automatic suppression caused by this message must NOT happen, or
 * null when it may. Both auto-suppression call sites (reply-classifier
 * applyAutoActions, outreach-reply-handler close_and_suppress) ask this
 * after their workspace switch says yes:
 *  - only a proven prospect reply can opt its own sender out;
 *  - bounce auto-suppression stays off until bounces are handled from the
 *    parsed delivery report (F-32): today the "sender" of a bounce is the
 *    mailer daemon, and the classifier's bounce label is a keyword match.
 */
export function autoSuppressionRefusal(
  msg: Pick<MailMessage, 'outreachRelevance'>,
  trigger: AutoSuppressionTrigger,
): string | null {
  if (trigger === 'bounce') {
    return 'bounce auto-suppression is off until delivery reports are matched to our sends (F-32)';
  }
  if (msg.outreachRelevance !== 'prospect_reply') {
    return `message is not a reply to our outreach (relevance: ${msg.outreachRelevance ?? 'unassessed'})`;
  }
  return null;
}

/** Audit a refused automatic suppression (the switch was on, the guard said no). */
export async function recordAutoSuppressionRefused(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  msg: Pick<MailMessage, 'id' | 'outreachRelevance'>,
  input: { trigger: AutoSuppressionTrigger; reason: string; path: 'reply_classifier' | 'outreach_reply_handler' },
): Promise<void> {
  try {
    await recordAuditEvent(ctx, {
      kind: 'reply.auto_suppress_refused',
      entityType: 'mail_message',
      entityId: msg.id,
      payload: {
        trigger: input.trigger,
        relevance: msg.outreachRelevance ?? null,
        reason: input.reason,
        path: input.path,
      },
    });
  } catch (err) {
    console.error('[inbound-relevance] refusal audit failed:', err);
  }
}

// ---- backfill ------------------------------------------------------------

export interface RelevanceBackfillOptions {
  /** Report only (default). Pass false to write. */
  dryRun?: boolean;
  /** Re-assess rows that already carry a relevance (default: only NULL rows). */
  recompute?: boolean;
  batchSize?: number;
}

export interface RelevanceBackfillReport {
  dryRun: boolean;
  scanned: number;
  /** Rows written (0 on a dry run). */
  updated: number;
  byRelevance: Record<OutreachRelevance, number>;
  byReason: Record<string, number>;
  /** Rows labelled prospect_reply / auto_reply / bounce — the ones the
   *  reply pipeline would treat as ours; listed for owner review. */
  outreachLinkedIds: string[];
}

function storedParserSignals(value: unknown): InboundRelevanceSignals | null {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Partial<StoredRelevanceSignals>;
  if (stored.source !== 'parser') return null;
  const { evidence: _evidence, ...signals } = stored as StoredRelevanceSignals;
  void _evidence;
  return signals;
}

/**
 * Label existing inbound messages with their outreach relevance. Uses only
 * what survived on the row: stored headers (mailparser's folded 'list' key,
 * the Precedence / Auto-Submitted strings, ESP header names), the sender
 * (mailer-daemon / postmaster / no-reply) and In-Reply-To / References
 * matches against our outbound. Rows synced after F-01 keep their
 * parse-time signals when recomputed.
 *
 * Dry run by default; workspace admins only. A write is idempotent (only
 * NULL rows are touched unless `recompute`) and writes one
 * 'mail.relevance_backfill' audit event. Does not touch updated_at or any
 * classification label — clearing those is the remediation's job (F-06).
 */
export async function backfillInboundRelevance(
  ctx: WorkspaceContext,
  options: RelevanceBackfillOptions = {},
): Promise<RelevanceBackfillReport> {
  if (!canAdminWorkspace(ctx)) {
    throw new InboundRelevanceError(
      'Permission denied: mail.relevance_backfill',
      'permission_denied',
    );
  }
  const dryRun = options.dryRun ?? true;
  const recompute = options.recompute ?? false;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 1000));

  const byRelevance = Object.fromEntries(
    OUTREACH_RELEVANCE_VALUES.map((v) => [v, 0]),
  ) as Record<OutreachRelevance, number>;
  const byReason: Record<string, number> = {};
  const outreachLinkedIds: string[] = [];
  let scanned = 0;
  let updated = 0;
  let lastId = 0n;

  for (;;) {
    const rows = await db
      .select({
        id: mailMessages.id,
        fromAddress: mailMessages.fromAddress,
        inReplyTo: mailMessages.inReplyTo,
        references: mailMessages.references,
        headers: mailMessages.headers,
        receivedAt: mailMessages.receivedAt,
        relevanceSignals: mailMessages.relevanceSignals,
      })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, ctx.workspaceId),
          eq(mailMessages.direction, 'inbound'),
          gt(mailMessages.id, lastId),
          recompute ? undefined : isNull(mailMessages.outreachRelevance),
        ),
      )
      .orderBy(asc(mailMessages.id))
      .limit(batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      scanned++;
      const signals =
        storedParserSignals(row.relevanceSignals) ??
        extractRelevanceSignals({
          headers: (row.headers ?? {}) as Record<string, unknown>,
          fromAddress: row.fromAddress,
          source: 'stored_headers',
        });
      const assessment = await assessInboundRelevance(ctx, {
        fromAddress: row.fromAddress,
        inReplyTo: row.inReplyTo,
        references: row.references,
        receivedAt: row.receivedAt,
        signals,
      });
      byRelevance[assessment.relevance]++;
      byReason[assessment.reason] = (byReason[assessment.reason] ?? 0) + 1;
      if (isOutreachLinked(assessment.relevance)) outreachLinkedIds.push(row.id.toString());

      if (!dryRun) {
        const written = await db
          .update(mailMessages)
          .set({
            outreachRelevance: assessment.relevance,
            relevanceSignals: assessment.signals,
          })
          .where(
            and(
              eq(mailMessages.workspaceId, ctx.workspaceId),
              eq(mailMessages.id, row.id),
              recompute ? undefined : isNull(mailMessages.outreachRelevance),
            ),
          )
          .returning({ id: mailMessages.id });
        updated += written.length;
      }
    }
  }

  const report: RelevanceBackfillReport = {
    dryRun,
    scanned,
    updated,
    byRelevance,
    byReason,
    outreachLinkedIds,
  };
  if (!dryRun) {
    await recordAuditEvent(ctx, {
      kind: 'mail.relevance_backfill',
      entityType: 'workspace',
      entityId: ctx.workspaceId,
      payload: { scanned, updated, recompute, byRelevance, outreachLinkedIds },
    });
  }
  return report;
}
