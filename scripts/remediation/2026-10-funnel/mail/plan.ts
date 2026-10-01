// Remediation 2026-10-funnel, mail module (flow:F-06) — the plan.
//
// Read-only. Computes, per workspace, exactly what an apply would change
// (R0–R4, R7, R8) plus the checks and decision sheets (R5, R6, R7). The
// same function runs for the dry run and again inside --apply, which
// refuses unless the recomputed plan hash equals the reviewed one.
//
// Selectors (proposal §17):
//   R0  inbound rows with no outreach_relevance yet (synced before F-01) get
//       the F-01 label, computed exactly like backfillInboundRelevance.
//   R1  every non-revoked suppression with reason unsubscribe / bounce_*:
//       its history is rebuilt from audit_log. An add is automatic when it
//       says source 'reply' (post-F-03), or — legacy adds, which carry no
//       source — when a 'reply.classify' unsubscribe/bounce event for a
//       message FROM that address precedes it by ≤120 s in the same
//       workspace. R1a = every add automatic and every source message bulk
//       or unrelated → revoke. Anything else (a manual / link / import /
//       smtp add, no trail, a prospect message) is R1b → keep by default.
//       The legacy note is only a cross-check.
//   R2  bulk / unrelated inbound rows carrying reply labels → clear them.
//   R3  active contacts whose only associations are mail_thread links of
//       relation inbound_sender (the old sync's sender contacts) and/or
//       redirect_target (the old auto-redirect's contacts extracted from
//       message text), never an outbound recipient, no lead, empty notes
//       and tags, and whose evidence is all bulk / unrelated: the mail FROM
//       them and, per redirect_target thread, every inbound message on it
//       → archive + tag 'inbound-auto'; own-domain colleagues default to
//       keep.
//   R4  lead.replied notifications on threads with no outbound → delete.

import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog, usageLog } from '@/lib/db/schema/audit';
import { users } from '@/lib/db/schema/auth';
import { featureFlags } from '@/lib/db/schema/admin';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { learningEvents } from '@/lib/db/schema/learning';
import {
  mailMessages,
  mailboxes,
  suppressionList,
  type SuppressionEntry,
} from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { outreachDrafts, outreachQueue, outreachThreadState } from '@/lib/db/schema/outreach';
import { pipelineEvents, qualifiedLeads } from '@/lib/db/schema/pipeline';
import { tokenTransactions } from '@/lib/db/schema/tokens';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import { adviseConnectionFailure, parseStoredMailboxError } from '@/lib/mail/connection-errors';
import type { OutreachRelevance } from '@/lib/mail/relevance';
import { assessStoredInbound } from '@/lib/services/inbound-relevance';
import {
  RemediationError,
  canonicalJson,
  databaseTarget,
  maskAddresses,
  newBatchId,
  sha256,
} from '../../lib/report-io';
import {
  CLASSIFY_WINDOW_MS,
  F01_SETTLE_HOURS,
  INBOUND_AUTO_TAG,
  MAIL_PLAN_VERSION,
  MODULE,
  NON_PROSPECT,
  SCRIPT,
  TRANSLATION_WINDOW_MS,
  type FlagRow,
  type MailChecks,
  type MailPlan,
  type MailPlanInternals,
  type MailPlanOptions,
  type MailPreconditions,
  type OwnDomain,
  type R0Row,
  type R1Row,
  type R2Row,
  type R3Origin,
  type R3Row,
  type R4Row,
  type R7Row,
  type R8Estimate,
  type TrailEvent,
  type TrailKind,
  type WorkspaceMailPlan,
  type ZeroImpactChecks,
} from './types';

// ---- own domains -------------------------------------------------------------

/** Webmail domains are never "own", even when a member signs in with one. */
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'wp.pl',
  'o2.pl',
  'onet.pl',
  'interia.pl',
  'op.pl',
  'yandex.ru',
  'mail.ru',
]);

/** Second-level labels under which the brand sits one label further left
 *  (example.co.uk, example.com.pl). */
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ltd', 'plc']);

export function domainOf(addressOrDomain: string): string {
  const v = addressOrDomain.trim().toLowerCase();
  const at = v.lastIndexOf('@');
  return (at >= 0 ? v.slice(at + 1) : v).replace(/\.$/, '');
}

/** Words too common to tie two domains to one brand (other-co.pl and
 *  other.de are not the same company). */
const GENERIC_STEMS = new Set([
  'mail',
  'email',
  'info',
  'shop',
  'store',
  'sales',
  'office',
  'group',
  'global',
  'online',
  'contact',
  'service',
  'services',
  'support',
  'team',
  'news',
  'home',
  'post',
  'cloud',
  'other',
  'site',
  'data',
  'tech',
  'digital',
  'media',
  'company',
  'business',
]);

/** Brand stem of a domain: ecobeton-uk.ro → ecobeton, nulife.co.uk → nulife.
 *  Null for short or generic labels. Only used to list a probable
 *  colleague first and to default an R3 row to keep — both safe if wrong. */
export function brandStem(domain: string): string | null {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  let label = labels[labels.length - 2]!;
  if (labels.length >= 3 && SECOND_LEVEL_LABELS.has(label)) label = labels[labels.length - 3]!;
  const stem = label.split('-')[0] ?? '';
  return stem.length >= 4 && !GENERIC_STEMS.has(stem) ? stem : null;
}

export interface OwnDomainMatcher {
  list: OwnDomain[];
  /** Why `addressOrDomain` belongs to the workspace, or null. */
  match(addressOrDomain: string): string | null;
}

export function ownDomainMatcher(list: OwnDomain[]): OwnDomainMatcher {
  const exact = new Map(list.map((d) => [d.domain, d.why]));
  const stems = new Map<string, string>();
  for (const d of list) {
    const stem = brandStem(d.domain);
    if (stem && !stems.has(stem)) stems.set(stem, d.domain);
  }
  return {
    list,
    match(addressOrDomain) {
      const domain = domainOf(addressOrDomain);
      if (!domain) return null;
      for (const [own, why] of exact) {
        if (domain === own || domain.endsWith(`.${own}`)) return `${own} (${why})`;
      }
      const stem = brandStem(domain);
      if (stem && !PUBLIC_MAIL_DOMAINS.has(domain) && stems.has(stem)) {
        return `same brand as ${stems.get(stem)}`;
      }
      return null;
    },
  };
}

async function ownDomainsFor(wsId: bigint, extra: string[]): Promise<OwnDomainMatcher> {
  const found = new Map<string, string>();
  const add = (domain: string, why: string) => {
    const d = domainOf(domain);
    if (!d || !d.includes('.') || PUBLIC_MAIL_DOMAINS.has(d) || found.has(d)) return;
    found.set(d, why);
  };
  const boxes = await db
    .select({ from: mailboxes.fromAddress })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, wsId));
  for (const b of boxes) add(b.from, 'mailbox');
  const members = await db
    .select({ email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, wsId));
  for (const m of members) add(m.email, 'member');
  for (const entry of extra) {
    const m = /^(\d+):(.+)$/.exec(entry.trim());
    if (m) {
      if (m[1] === wsId.toString()) add(m[2]!, 'given');
    } else {
      add(entry, 'given');
    }
  }
  return ownDomainMatcher(
    [...found.entries()]
      .map(([domain, why]) => ({ domain, why }))
      .sort((a, b) => a.domain.localeCompare(b.domain)),
  );
}

// ---- helpers ---------------------------------------------------------------------

const DIGITS = /^\d+$/;

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function lowerSet(...lists: ReadonlyArray<ReadonlyArray<string | null | undefined>>): Set<string> {
  const out = new Set<string>();
  for (const list of lists) {
    for (const v of list) {
      const t = (v ?? '').trim().toLowerCase();
      if (t) out.add(t);
    }
  }
  return out;
}

function countBy<T extends string>(values: ReadonlyArray<T>): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function describeCounts(counts: Partial<Record<string, number>>): string {
  return Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
}

/** Thread id a lead.replied notification points at. */
export function notificationThreadId(n: {
  dedupeKey: string | null;
  href: string | null;
}): string | null {
  const byKey = /^lead\.replied:(\d+)$/.exec(n.dedupeKey ?? '');
  if (byKey) return byKey[1]!;
  const byHref = /^\/communication\/(\d+)(?:[/?#]|$)/.exec(n.href ?? '');
  return byHref ? byHref[1]! : null;
}

const LEGACY_NOTE_RE = /^auto-suppressed (?:by outreach handler )?from message (\d+)$/;

/** reply.classify type an add with this reason would follow. */
function classifyTypeFor(reason: unknown): 'unsubscribe' | 'bounce' | null {
  if (reason === 'unsubscribe') return 'unsubscribe';
  if (reason === 'bounce_hard' || reason === 'bounce_soft') return 'bounce';
  return null;
}

const SOURCE_KIND: Record<string, TrailKind> = {
  reply: 'auto',
  manual: 'manual',
  import: 'import',
  unsubscribe_link: 'link',
  smtp: 'smtp',
  dsn: 'dsn',
};

const AUTO_ROW_SOURCES = new Set(['reply', 'legacy_auto', 'legacy_unknown']);

// ---- per-workspace sections ---------------------------------------------------

interface WsContext {
  id: bigint;
  own: OwnDomainMatcher;
  /** message id → effective relevance (stored, or assessed for R0). */
  relevance: Map<string, OutreachRelevance | null>;
  outboundThreads: Set<string>;
}

async function planR0(ws: WsContext, internals: MailPlanInternals): Promise<R0Row[]> {
  const stored = await db
    .select({ id: mailMessages.id, relevance: mailMessages.outreachRelevance })
    .from(mailMessages)
    .where(and(eq(mailMessages.workspaceId, ws.id), eq(mailMessages.direction, 'inbound')));
  for (const r of stored) ws.relevance.set(r.id.toString(), r.relevance);

  const out: R0Row[] = [];
  let lastId = 0n;
  for (;;) {
    const batch = await db
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
          eq(mailMessages.workspaceId, ws.id),
          eq(mailMessages.direction, 'inbound'),
          isNull(mailMessages.outreachRelevance),
          gt(mailMessages.id, lastId),
        ),
      )
      .orderBy(asc(mailMessages.id))
      .limit(200);
    if (batch.length === 0) break;
    for (const row of batch) {
      lastId = row.id;
      const assessment = await assessStoredInbound({ workspaceId: ws.id }, row);
      const id = row.id.toString();
      ws.relevance.set(id, assessment.relevance);
      internals.assessments.set(id, { workspaceId: ws.id, signals: assessment.signals });
      out.push({ messageId: id, relevance: assessment.relevance, reason: assessment.reason });
    }
  }
  return out;
}

async function planR1(ws: WsContext): Promise<R1Row[]> {
  const rows = await db
    .select()
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ws.id),
        isNull(suppressionList.revokedAt),
        inArray(suppressionList.reason, ['unsubscribe', 'bounce_hard', 'bounce_soft']),
      ),
    )
    .orderBy(asc(suppressionList.id));
  if (rows.length === 0) return [];

  const addEvents = await db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      entityId: auditLog.entityId,
      payload: auditLog.payload,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, ws.id),
        eq(auditLog.kind, 'suppression.add'),
        eq(auditLog.entityType, 'suppression_entry'),
        inArray(
          auditLog.entityId,
          rows.map((r) => r.id.toString()),
        ),
      ),
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
  const addsByRow = new Map<string, typeof addEvents>();
  for (const e of addEvents) {
    const key = e.entityId ?? '';
    addsByRow.set(key, [...(addsByRow.get(key) ?? []), e]);
  }

  const tokenEvents = await db
    .select({ id: auditLog.id, createdAt: auditLog.createdAt, payload: auditLog.payload })
    .from(auditLog)
    .where(
      and(eq(auditLog.workspaceId, ws.id), eq(auditLog.kind, 'suppression.unsubscribe_via_token')),
    );

  const classifyEvents = await db
    .select({
      createdAt: auditLog.createdAt,
      entityId: auditLog.entityId,
      type: sql<string>`${auditLog.payload}->>'type'`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, ws.id),
        eq(auditLog.kind, 'reply.classify'),
        eq(auditLog.entityType, 'mail_message'),
        inArray(sql`${auditLog.payload}->>'type'`, ['unsubscribe', 'bounce']),
      ),
    );
  const classifiedIds = Array.from(
    new Set(
      classifyEvents
        .map((e) => e.entityId ?? '')
        .filter((id) => DIGITS.test(id))
        .map((id) => BigInt(id)),
    ),
  );
  const senders = new Map<string, string>();
  for (let i = 0; i < classifiedIds.length; i += 500) {
    const chunk = classifiedIds.slice(i, i + 500);
    const found = await db
      .select({ id: mailMessages.id, from: mailMessages.fromAddress })
      .from(mailMessages)
      .where(and(eq(mailMessages.workspaceId, ws.id), inArray(mailMessages.id, chunk)));
    for (const m of found) senders.set(m.id.toString(), m.from.trim().toLowerCase());
  }
  const classifyByFrom = new Map<string, Array<{ at: Date; messageId: string; type: string }>>();
  for (const e of classifyEvents) {
    const messageId = e.entityId ?? '';
    const from = senders.get(messageId);
    if (!from) continue;
    classifyByFrom.set(from, [
      ...(classifyByFrom.get(from) ?? []),
      { at: e.createdAt, messageId, type: e.type },
    ]);
  }

  const out = rows.map((row) =>
    classifyR1Row(ws, row, {
      adds: addsByRow.get(row.id.toString()) ?? [],
      tokenEvents,
      classifyByFrom,
    }),
  );
  return out.sort(
    (a, b) =>
      Number(a.ownDomain === null) - Number(b.ownDomain === null) ||
      a.class.localeCompare(b.class) ||
      a.value.localeCompare(b.value) ||
      Number(BigInt(a.suppressionId) - BigInt(b.suppressionId)),
  );
}

function classifyR1Row(
  ws: WsContext,
  row: SuppressionEntry,
  input: {
    adds: Array<{ id: bigint; createdAt: Date; payload: unknown }>;
    tokenEvents: Array<{ id: bigint; createdAt: Date; payload: unknown }>;
    classifyByFrom: Map<string, Array<{ at: Date; messageId: string; type: string }>>;
  },
): R1Row {
  const value = row.value || row.address;
  const trail: TrailEvent[] = [];

  for (const ev of input.adds) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (typeof p.source === 'string') {
      // Post-F-03 adds declare their provenance.
      const kind = SOURCE_KIND[p.source] ?? 'unknown';
      const ref = typeof p.sourceRef === 'string' ? /^mail_message:(\d+)$/.exec(p.sourceRef) : null;
      trail.push({
        auditId: ev.id.toString(),
        at: ev.createdAt.toISOString(),
        kind,
        sourceMessageId: kind === 'auto' ? (ref?.[1] ?? null) : null,
        detail: `${p.source} add (${typeof p.outcome === 'string' ? p.outcome : 'outcome not recorded'})`,
      });
      continue;
    }
    // Legacy add: automatic only if the classifier labelled a message from
    // this very address unsubscribe/bounce just before it.
    const wanted = classifyTypeFor(p.reason);
    const windowStart = ev.createdAt.getTime() - CLASSIFY_WINDOW_MS;
    const candidates =
      row.kind === 'email'
        ? (input.classifyByFrom.get(value) ?? []).filter(
            (c) =>
              c.at.getTime() >= windowStart &&
              c.at.getTime() <= ev.createdAt.getTime() &&
              (wanted === null || c.type === wanted),
          )
        : [];
    const match = candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    trail.push(
      match
        ? {
            auditId: ev.id.toString(),
            at: ev.createdAt.toISOString(),
            kind: 'auto',
            sourceMessageId: match.messageId,
            detail: `legacy add ${Math.round((ev.createdAt.getTime() - match.at.getTime()) / 1000)} s after reply.classify ${match.type} of message ${match.messageId}`,
          }
        : {
            auditId: ev.id.toString(),
            at: ev.createdAt.toISOString(),
            kind: 'manual',
            sourceMessageId: null,
            detail: 'legacy add with no reply.classify event for this address within 120 s',
          },
    );
  }
  for (const ev of input.tokenEvents) {
    const addresses = ((ev.payload ?? {}) as { addresses?: unknown }).addresses;
    if (Array.isArray(addresses) && addresses.some((a) => String(a).toLowerCase() === value)) {
      trail.push({
        auditId: ev.id.toString(),
        at: ev.createdAt.toISOString(),
        kind: 'link',
        sourceMessageId: null,
        detail: 'unsubscribe link (pre-F-03 token event)',
      });
    }
  }
  trail.sort((a, b) => a.at.localeCompare(b.at) || a.auditId.localeCompare(b.auditId));

  const sourceIds = Array.from(
    new Set(trail.filter((e) => e.kind === 'auto').map((e) => e.sourceMessageId)),
  );
  const sourceMessages = sourceIds.map((id) => ({
    id,
    relevance: id ? (ws.relevance.get(id) ?? null) : null,
  }));
  const nonAuto = trail.filter((e) => e.kind !== 'auto');

  let cls: R1Row['class'] = 'R1b';
  let why: string;
  if (trail.length === 0) {
    why = 'no audit trail';
  } else if (nonAuto.length > 0) {
    why = `not only automatic: ${describeCounts(countBy(nonAuto.map((e) => e.kind)))} add(s)`;
  } else if (!AUTO_ROW_SOURCES.has(row.source)) {
    why = `current provenance is ${row.source}`;
  } else if (sourceMessages.some((m) => m.relevance === null)) {
    why = 'a source message is missing or unassessed';
  } else if (sourceMessages.some((m) => !NON_PROSPECT.has(m.relevance!))) {
    const odd = sourceMessages.find((m) => !NON_PROSPECT.has(m.relevance!))!;
    why = `source message ${odd.id} is ${odd.relevance}`;
  } else {
    cls = 'R1a';
    why = `${trail.length} automatic add(s) from ${describeCounts(
      countBy(sourceMessages.map((m) => m.relevance!)),
    )} mail`;
  }

  const warnings: string[] = [];
  const note = LEGACY_NOTE_RE.exec((row.note ?? '').trim());
  if (note) {
    if (!sourceIds.includes(note[1]!)) {
      warnings.push(
        `note names message ${note[1]}; the audit trail ${
          sourceIds.length > 0 ? `names ${sourceIds.join(', ')}` : 'has no automatic add'
        }`,
      );
    }
  } else if (cls === 'R1a') {
    warnings.push('note does not carry the auto-suppression pattern');
  }

  return {
    suppressionId: row.id.toString(),
    kind: row.kind,
    value,
    reason: row.reason,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    ownDomain: row.kind === 'company' ? null : ws.own.match(value),
    class: cls,
    why,
    defaultDecision: cls === 'R1a' ? 'revoke' : 'keep',
    trail,
    sourceMessages,
    warnings,
  };
}

async function planR2(ws: WsContext): Promise<R2Row[]> {
  const labelled = await db
    .select({ id: mailMessages.id, label: mailMessages.replyClassification })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ws.id),
        eq(mailMessages.direction, 'inbound'),
        or(
          isNotNull(mailMessages.replyClassification),
          isNotNull(mailMessages.replyClassificationConfidence),
          isNotNull(mailMessages.replyClassifiedAt),
          sql`cardinality(${mailMessages.extractedEmails}) > 0`,
        ),
      ),
    )
    .orderBy(asc(mailMessages.id));
  const out: R2Row[] = [];
  for (const m of labelled) {
    const relevance = ws.relevance.get(m.id.toString()) ?? null;
    if (relevance && NON_PROSPECT.has(relevance)) {
      out.push({ messageId: m.id.toString(), relevance, label: m.label });
    }
  }
  return out;
}

async function outboundFacts(wsId: bigint): Promise<{
  recipients: Set<string>;
  contactIds: Set<string>;
  threads: Set<string>;
}> {
  const sent = await db
    .select({
      to: mailMessages.toAddresses,
      cc: mailMessages.ccAddresses,
      bcc: mailMessages.bccAddresses,
      contactId: mailMessages.contactId,
      threadId: mailMessages.threadId,
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.workspaceId, wsId), eq(mailMessages.direction, 'outbound')));
  const queued = await db
    .select({
      to: outreachQueue.toAddresses,
      cc: outreachQueue.ccAddresses,
      bcc: outreachQueue.bccAddresses,
    })
    .from(outreachQueue)
    .where(eq(outreachQueue.workspaceId, wsId));
  return {
    recipients: lowerSet(
      ...sent.flatMap((m) => [m.to, m.cc, m.bcc]),
      ...queued.flatMap((q) => [q.to, q.cc, q.bcc]),
    ),
    contactIds: new Set(
      sent.filter((m) => m.contactId !== null).map((m) => m.contactId!.toString()),
    ),
    threads: new Set(sent.filter((m) => m.threadId !== null).map((m) => m.threadId!.toString())),
  };
}

async function planR3(
  ws: WsContext,
  outbound: { recipients: Set<string>; contactIds: Set<string> },
): Promise<R3Row[]> {
  const leads = await db
    .select({ a: qualifiedLeads.contactEmail, b: qualifiedLeads.currentContactEmail })
    .from(qualifiedLeads)
    .where(eq(qualifiedLeads.workspaceId, ws.id));
  const leadEmails = lowerSet(
    leads.map((l) => l.a),
    leads.map((l) => l.b),
  );

  const assoc = await db
    .select({
      contactId: contactAssociations.contactId,
      entityType: contactAssociations.entityType,
      entityId: contactAssociations.entityId,
      relation: contactAssociations.relation,
    })
    .from(contactAssociations)
    .where(eq(contactAssociations.workspaceId, ws.id))
    .orderBy(asc(contactAssociations.id));
  type Link = { entityType: string; entityId: string; relation: string | null };
  const byContact = new Map<string, Link[]>();
  for (const a of assoc) {
    const key = a.contactId.toString();
    byContact.set(key, [...(byContact.get(key) ?? []), a]);
  }

  const inbound = await db
    .select({
      id: mailMessages.id,
      from: sql<string>`lower(${mailMessages.fromAddress})`,
      threadId: mailMessages.threadId,
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.workspaceId, ws.id), eq(mailMessages.direction, 'inbound')));
  const bySender = new Map<string, string[]>();
  const byThread = new Map<string, string[]>();
  for (const m of inbound) {
    const id = m.id.toString();
    bySender.set(m.from, [...(bySender.get(m.from) ?? []), id]);
    if (m.threadId !== null) {
      const t = m.threadId.toString();
      byThread.set(t, [...(byThread.get(t) ?? []), id]);
    }
  }

  const candidates = await db
    .select({ id: contacts.id, email: contacts.email, notes: contacts.notes, tags: contacts.tags })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, ws.id), eq(contacts.status, 'active')))
    .orderBy(asc(contacts.id));

  const isSenderLink = (a: Link) =>
    a.entityType === 'mail_thread' && a.relation === 'inbound_sender';
  const isRedirectLink = (a: Link) =>
    a.entityType === 'mail_thread' && a.relation === 'redirect_target';

  const out: R3Row[] = [];
  for (const c of candidates) {
    const id = c.id.toString();
    const email = c.email.trim().toLowerCase();
    const links = byContact.get(id) ?? [];
    if (links.length === 0 || !links.every((a) => isSenderLink(a) || isRedirectLink(a))) continue;
    if ((c.notes ?? '').trim() !== '' || c.tags.length > 0) continue;
    if (outbound.recipients.has(email) || outbound.contactIds.has(id) || leadEmails.has(email))
      continue;

    // Evidence. A sender link needs mail FROM the contact; a redirect link
    // needs inbound mail on its thread (the message it was extracted
    // from). Missing evidence keeps the contact off the list.
    const fromSender = links.some(isSenderLink) ? (bySender.get(email) ?? []) : [];
    if (links.some(isSenderLink) && fromSender.length === 0) continue;
    const redirectThreads = links.filter(isRedirectLink).map((a) => a.entityId);
    if (redirectThreads.some((t) => (byThread.get(t) ?? []).length === 0)) continue;
    const messages = [
      ...new Set([...fromSender, ...redirectThreads.flatMap((t) => byThread.get(t) ?? [])]),
    ];
    if (messages.length === 0) continue;
    const rel = messages.map((m) => ws.relevance.get(m) ?? null);
    if (rel.some((r) => r === null || !NON_PROSPECT.has(r))) continue;

    const origin: R3Origin =
      fromSender.length > 0 && redirectThreads.length > 0
        ? 'both'
        : redirectThreads.length > 0
          ? 'redirect_target'
          : 'inbound_sender';
    const own = ws.own.match(email);
    const counts = countBy(rel as OutreachRelevance[]);
    const source =
      origin === 'inbound_sender'
        ? `inbound-only sender of ${describeCounts(counts)} mail`
        : origin === 'redirect_target'
          ? `auto-extracted (redirect) from ${describeCounts(counts)} mail`
          : `sender of / auto-extracted from ${describeCounts(counts)} mail`;
    out.push({
      contactId: id,
      email,
      ownDomain: own,
      origin,
      inboundMessages: messages.length,
      relevance: counts,
      defaultDecision: own ? 'keep' : 'archive',
      why: own ? `own domain: ${own}` : source,
    });
  }
  return out.sort(
    (a, b) =>
      Number(a.ownDomain === null) - Number(b.ownDomain === null) || a.email.localeCompare(b.email),
  );
}

async function planR4(ws: WsContext): Promise<{ rows: R4Row[]; unparsed: number }> {
  const found = await db
    .select({
      id: notifications.id,
      dedupeKey: notifications.dedupeKey,
      href: notifications.href,
      readAt: notifications.readAt,
    })
    .from(notifications)
    .where(and(eq(notifications.workspaceId, ws.id), eq(notifications.kind, 'lead.replied')))
    .orderBy(asc(notifications.id));
  const rows: R4Row[] = [];
  let unparsed = 0;
  for (const n of found) {
    const threadId = notificationThreadId(n);
    if (!threadId) {
      unparsed++;
      continue;
    }
    if (!ws.outboundThreads.has(threadId)) {
      rows.push({ notificationId: n.id.toString(), threadId, read: n.readAt !== null });
    }
  }
  return { rows, unparsed };
}

/** Queued sends and due follow-ups addressed to any of `addresses`. */
export async function pendingSendsTo(
  wsId: bigint,
  addresses: ReadonlySet<string>,
): Promise<number> {
  if (addresses.size === 0) return 0;
  const queued = await db
    .select({
      to: outreachQueue.toAddresses,
      cc: outreachQueue.ccAddresses,
      bcc: outreachQueue.bccAddresses,
    })
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, wsId),
        inArray(outreachQueue.status, ['queued', 'sending']),
      ),
    );
  let count = queued.filter((q) =>
    [...q.to, ...q.cc, ...q.bcc].some((a) => addresses.has(a.trim().toLowerCase())),
  ).length;
  const followUps = await db
    .select({ a: qualifiedLeads.contactEmail, b: qualifiedLeads.currentContactEmail })
    .from(outreachFollowUps)
    .innerJoin(qualifiedLeads, eq(qualifiedLeads.id, outreachFollowUps.qualifiedLeadId))
    .where(
      and(
        eq(outreachFollowUps.workspaceId, wsId),
        inArray(outreachFollowUps.status, ['pending', 'awaiting_approval']),
      ),
    );
  count += followUps.filter((f) =>
    [f.a, f.b].some((a) => a !== null && addresses.has(a.trim().toLowerCase())),
  ).length;
  return count;
}

async function planR5(ws: WsContext, r1: R1Row[]): Promise<ZeroImpactChecks> {
  const states = await db
    .select({ threadId: outreachThreadState.threadId })
    .from(outreachThreadState)
    .where(eq(outreachThreadState.workspaceId, ws.id));
  const [closes] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pipelineEvents)
    .where(
      and(
        eq(pipelineEvents.workspaceId, ws.id),
        eq(pipelineEvents.toState, 'closed'),
        or(
          sql`${pipelineEvents.payload}->>'replyAutoAction' IS NOT NULL`,
          inArray(sql`${pipelineEvents.payload}->>'closeNote'`, ['unsubscribe', 'bounce']),
        ),
      ),
    );
  const learned = await db
    .select({ entityId: learningEvents.entityId })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, ws.id),
        eq(learningEvents.entityType, 'mail_message'),
        inArray(learningEvents.actionType, ['reply_positive', 'reply_negative']),
      ),
    );
  const drafts = await db
    .select({ messageId: outreachDrafts.triggeredByMessageId })
    .from(outreachDrafts)
    .where(
      and(eq(outreachDrafts.workspaceId, ws.id), isNotNull(outreachDrafts.triggeredByMessageId)),
    );
  const nonProspect = (id: string | null) => {
    const rel = id ? ws.relevance.get(id) : undefined;
    return rel === undefined || rel === null || NON_PROSPECT.has(rel);
  };
  const revokeTargets = new Set(
    r1.filter((r) => r.defaultDecision === 'revoke' && r.kind === 'email').map((r) => r.value),
  );
  return {
    threadStatesWithoutOutbound: states.filter(
      (s) => !ws.outboundThreads.has(s.threadId.toString()),
    ).length,
    pipelineAutoCloses: closes?.n ?? 0,
    learningEventsFromNonProspectMail: learned.filter((l) => nonProspect(l.entityId)).length,
    replyDraftsFromNonProspectMail: drafts.filter((d) =>
      nonProspect(d.messageId?.toString() ?? null),
    ).length,
    pendingSendsToRevokeTargets: await pendingSendsTo(ws.id, revokeTargets),
  };
}

async function planR6(ws: WsContext): Promise<FlagRow[]> {
  const flags = await db
    .select({ key: featureFlags.key, enabled: featureFlags.enabled, setAt: featureFlags.setAt })
    .from(featureFlags)
    .where(eq(featureFlags.workspaceId, ws.id))
    .orderBy(asc(featureFlags.key));
  const [active] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, ws.id), eq(mailboxes.status, 'active')));
  const activeMailboxes = active?.n ?? 0;
  const since = async (direction: 'inbound' | 'outbound', from: Date) => {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, ws.id),
          eq(mailMessages.direction, direction),
          gte(mailMessages.createdAt, from),
        ),
      );
    return r?.n ?? 0;
  };
  const out: FlagRow[] = [];
  for (const f of flags) {
    let effect = 'not enforced by F-07 (flag management is another workstream)';
    let observed: string | null = null;
    if (f.key === 'mailbox.imap_sync') {
      effect = f.enabled
        ? 'none: IMAP sync stays on'
        : `F-07 will STOP IMAP sync for this workspace (${activeMailboxes} active mailbox(es))`;
      if (!f.enabled)
        observed = `${await since('inbound', f.setAt)} inbound message(s) synced since the flag was set (the flag is not read today)`;
    } else if (f.key === 'outreach.send') {
      effect = f.enabled
        ? 'F-07: sending is allowed once the go-live hold is lifted'
        : 'F-07 keeps the workspace NOT live: no outbound mail';
      if (!f.enabled)
        observed = `${await since('outbound', f.setAt)} outbound message(s) since the flag was set`;
    }
    out.push({ key: f.key, enabled: f.enabled, setAt: f.setAt.toISOString(), effect, observed });
  }
  return out;
}

async function planR7(ws: WsContext): Promise<R7Row[]> {
  const failing = await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, ws.id), eq(mailboxes.status, 'failing')))
    .orderBy(asc(mailboxes.id));
  return failing.map((mb) => {
    const parsed = parseStoredMailboxError(mb.lastError);
    return {
      mailboxId: mb.id.toString(),
      name: maskAddresses(mb.name),
      failingSince: iso(mb.failingSince),
      lastErrorAt: iso(mb.lastErrorAt),
      consecutiveFailures: mb.imapConsecutiveFailures,
      nextCheckAt: iso(mb.imapNextSyncAfter),
      error: maskAddresses(mb.lastError ?? '(none recorded)'),
      advice: maskAddresses(
        adviseConnectionFailure(parsed.protocol, parsed.message, {
          smtpHost: mb.smtpHost,
          smtpPort: mb.smtpPort,
          imapHost: mb.imapHost,
          imapPort: mb.imapPort,
        }),
      ),
      defaultDecision: 'keep' as const,
    };
  });
}

/** Translation reaches only prospect replies and auto-replies since F-01. */
const TRANSLATABLE = new Set<OutreachRelevance>(['prospect_reply', 'auto_reply']);

async function planR8(ws: WsContext): Promise<R8Estimate> {
  const translated = await db
    .select({ id: mailMessages.id, at: mailMessages.translatedAt })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ws.id),
        eq(mailMessages.direction, 'inbound'),
        isNotNull(mailMessages.translatedAt),
      ),
    )
    .orderBy(asc(mailMessages.translatedAt), asc(mailMessages.id));
  const junk = translated.filter((m) => {
    const rel = ws.relevance.get(m.id.toString()) ?? null;
    return rel !== null && !TRANSLATABLE.has(rel);
  });
  if (junk.length === 0) {
    return { translatedMessages: 0, billedTranslations: 0, tokens: '0', usageLogIds: [] };
  }
  const first = new Date(junk[0]!.at!.getTime() - TRANSLATION_WINDOW_MS);
  const last = junk[junk.length - 1]!.at!;
  // Translations are metered as 'ai.generate' without a message id, so a
  // debit is attributed to the translation it immediately precedes.
  const usage = await db
    .select({ id: usageLog.id, at: usageLog.createdAt, delta: tokenTransactions.delta })
    .from(usageLog)
    .innerJoin(
      tokenTransactions,
      and(
        eq(tokenTransactions.workspaceId, usageLog.workspaceId),
        eq(tokenTransactions.kind, 'usage'),
        sql`${tokenTransactions.payload}->>'usageLogId' = ${usageLog.id}::text`,
      ),
    )
    .where(
      and(
        eq(usageLog.workspaceId, ws.id),
        eq(usageLog.kind, 'ai.generate'),
        gte(usageLog.createdAt, first),
        lte(usageLog.createdAt, last),
      ),
    )
    .orderBy(asc(usageLog.createdAt), asc(usageLog.id));
  const used = new Set<string>();
  let tokens = 0n;
  let billed = 0;
  for (const m of junk) {
    const at = m.at!.getTime();
    const hit = usage
      .filter(
        (u) =>
          !used.has(u.id.toString()) &&
          u.at.getTime() <= at &&
          u.at.getTime() >= at - TRANSLATION_WINDOW_MS,
      )
      .pop();
    if (!hit) continue;
    used.add(hit.id.toString());
    billed++;
    tokens += -hit.delta;
  }
  return {
    translatedMessages: junk.length,
    billedTranslations: billed,
    tokens: tokens.toString(),
    usageLogIds: [...used],
  };
}

async function checksFor(
  ws: WsContext,
  sections: {
    r0: R0Row[];
    r1: R1Row[];
    r2: R2Row[];
    r3: R3Row[];
    r4: R4Row[];
  },
): Promise<MailChecks> {
  const [visible] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, ws.id),
        eq(contacts.status, 'active'),
        sql`${INBOUND_AUTO_TAG}::text = ANY(${contacts.tags})`,
      ),
    );
  return {
    inboundWithoutRelevance: sections.r0.length,
    activeAutoSuppressionsFromNonProspectMail: sections.r1.filter((r) => r.class === 'R1a').length,
    labelledNonProspectInbound: sections.r2.length,
    inboundOnlyContacts: sections.r3.length,
    visibleInboundAutoContacts: visible?.n ?? 0,
    leadRepliedOnThreadsWithoutOutbound: sections.r4.length,
  };
}

async function planWorkspace(
  ws: { id: bigint; name: string; status: string },
  options: MailPlanOptions,
  internals: MailPlanInternals,
): Promise<WorkspaceMailPlan> {
  const own = await ownDomainsFor(ws.id, options.ownDomains);
  const outbound = await outboundFacts(ws.id);
  const ctx: WsContext = {
    id: ws.id,
    own,
    relevance: new Map(),
    outboundThreads: outbound.threads,
  };
  const r0 = await planR0(ctx, internals);
  const r1 = await planR1(ctx);
  const r2 = await planR2(ctx);
  const r3 = await planR3(ctx, outbound);
  const r4 = await planR4(ctx);
  return {
    workspaceId: ws.id.toString(),
    name: ws.name,
    status: ws.status,
    ownDomains: own.list,
    r0,
    r1,
    r2,
    r3,
    r4: r4.rows,
    r4Unparsed: r4.unparsed,
    r5: await planR5(ctx, r1),
    r6: await planR6(ctx),
    r7: await planR7(ctx),
    r8: await planR8(ctx),
    checks: await checksFor(ctx, { r0, r1, r2, r3, r4: r4.rows }),
  };
}

// ---- preconditions ----------------------------------------------------------------

async function preconditions(scope: bigint[], now: Date): Promise<MailPreconditions> {
  const notes: string[] = [];
  if (scope.length === 0) {
    return {
      f01LiveSince: null,
      hoursLive: null,
      nonProspectReplySuppressionsSinceF01: 0,
      ok: false,
      notes: ['no workspace in scope'],
    };
  }
  const [first] = await db
    .select({ at: sql<Date | null>`min(${mailMessages.createdAt})` })
    .from(mailMessages)
    .where(
      and(
        inArray(mailMessages.workspaceId, scope),
        eq(mailMessages.direction, 'inbound'),
        sql`${mailMessages.relevanceSignals}->>'source' = 'parser'`,
      ),
    );
  const since = first?.at ? new Date(first.at) : null;
  const hoursLive = since ? Math.floor((now.getTime() - since.getTime()) / 3_600_000) : null;

  let bad = 0;
  if (since) {
    const adds = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.workspaceId, scope),
          eq(auditLog.kind, 'suppression.add'),
          gte(auditLog.createdAt, since),
          sql`${auditLog.payload}->>'source' = 'reply'`,
        ),
      );
    const ids = adds
      .map((a) =>
        /^mail_message:(\d+)$/.exec(String((a.payload as { sourceRef?: unknown }).sourceRef ?? '')),
      )
      .map((m) => (m ? BigInt(m[1]!) : null));
    const known = ids.filter((id): id is bigint => id !== null);
    const relevance = new Map<string, string | null>();
    if (known.length > 0) {
      const found = await db
        .select({ id: mailMessages.id, relevance: mailMessages.outreachRelevance })
        .from(mailMessages)
        .where(and(inArray(mailMessages.workspaceId, scope), inArray(mailMessages.id, known)));
      for (const f of found) relevance.set(f.id.toString(), f.relevance);
    }
    bad = ids.filter(
      (id) => id === null || relevance.get(id.toString()) !== 'prospect_reply',
    ).length;
  } else {
    notes.push(
      'F-01 has not labelled any inbound message at sync time yet (not deployed, or no mail since).',
    );
  }
  if (hoursLive !== null && hoursLive < F01_SETTLE_HOURS) {
    notes.push(`F-01 has been live for ${hoursLive} h; wait until ${F01_SETTLE_HOURS} h.`);
  }
  if (bad > 0)
    notes.push(`${bad} reply-classifier suppression(s) since F-01 are not from a prospect reply.`);
  return {
    f01LiveSince: iso(since),
    hoursLive,
    nonProspectReplySuppressionsSinceF01: bad,
    ok: since !== null && hoursLive !== null && hoursLive >= F01_SETTLE_HOURS && bad === 0,
    notes,
  };
}

// ---- plan ------------------------------------------------------------------------

/** The part of a plan that the owner approves: what changes, and how. */
export function planHashInput(plan: Pick<MailPlan, 'version' | 'options' | 'workspaces'>): unknown {
  return {
    script: SCRIPT,
    module: MODULE,
    version: plan.version,
    options: plan.options,
    workspaces: plan.workspaces.map((w) => ({
      id: w.workspaceId,
      r0: w.r0.map((r) => [r.messageId, r.relevance]),
      r1: w.r1.map((r) => [
        r.suppressionId,
        r.class,
        r.defaultDecision,
        r.kind,
        r.value,
        r.reason,
        r.source,
      ]),
      r2: w.r2.map((r) => r.messageId),
      r3: w.r3.map((r) => [r.contactId, r.email, r.origin, r.defaultDecision]),
      r4: w.r4.map((r) => r.notificationId),
      r7: w.r7.map((r) => r.mailboxId),
      r8: w.r8.tokens,
    })),
  };
}

export function normalizeOptions(input: Partial<MailPlanOptions> = {}): MailPlanOptions {
  const own = Array.from(
    new Set((input.ownDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)),
  ).sort();
  for (const d of own) {
    if (!/^(\d+:)?[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
      throw new RemediationError(`invalid own domain ${d}`, 'invalid_option');
    }
  }
  const raw = input.workspaceIds
    ? Array.from(new Set(input.workspaceIds.map((w) => w.trim())))
    : null;
  for (const id of raw ?? []) {
    if (!DIGITS.test(id))
      throw new RemediationError(`invalid workspace id ${id}`, 'invalid_option');
  }
  const ids = raw ? raw.sort((a, b) => Number(BigInt(a) - BigInt(b))) : null;
  return { ownDomains: own, workspaceIds: ids };
}

/**
 * Compute the mail remediation plan. Read-only. `batchId` is reused by
 * --apply (it recomputes the plan of a reviewed report).
 */
export async function buildMailPlan(
  input: Partial<MailPlanOptions> = {},
  meta: { batchId?: string; now?: Date } = {},
): Promise<{ plan: MailPlan; internals: MailPlanInternals }> {
  const options = normalizeOptions(input);
  const now = meta.now ?? new Date();
  const internals: MailPlanInternals = { assessments: new Map() };
  const all = await db
    .select({ id: workspaces.id, name: workspaces.name, status: workspaces.status })
    .from(workspaces)
    .orderBy(asc(workspaces.id));
  const inScope = options.workspaceIds
    ? all.filter((w) => options.workspaceIds!.includes(w.id.toString()))
    : all;

  const sections: WorkspaceMailPlan[] = [];
  for (const ws of inScope) sections.push(await planWorkspace(ws, options, internals));

  const partial = { version: MAIL_PLAN_VERSION, options, workspaces: sections };
  const plan: MailPlan = {
    kind: 'remediation-plan',
    script: SCRIPT,
    module: MODULE,
    version: MAIL_PLAN_VERSION,
    batchId: meta.batchId ?? newBatchId(SCRIPT, MODULE, now),
    generatedAt: now.toISOString(),
    database: databaseTarget(),
    options,
    planHash: sha256(canonicalJson(planHashInput(partial))),
    preconditions: await preconditions(
      inScope.map((w) => w.id),
      now,
    ),
    workspaces: sections,
  };
  return { plan, internals };
}
