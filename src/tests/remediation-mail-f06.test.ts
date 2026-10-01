// flow:F-06 — production remediation A (mail): scripts/remediation/2026-10-funnel.
//
// A seeded fixture mirrors the prod picture (X1): legacy inbound mail with
// String()-ified headers and keyword labels, suppressions the reply
// classifier wrote from newsletters (with their audit trail), junk contacts,
// false lead.replied notifications, a failing mailbox, ignored flags and a
// billed translation of a newsletter. The script is exercised through its
// module API and its CLI against this fixture only — never against prod.

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { featureFlags } from '@/lib/db/schema/admin';
import { auditLog, usageLog } from '@/lib/db/schema/audit';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  suppressionList,
  type SuppressionEntry,
} from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { remediationLog, remediationRuns } from '@/lib/db/schema/remediation';
import { tokenTransactions } from '@/lib/db/schema/tokens';
import { workspaces } from '@/lib/db/schema/workspaces';
import { settleDetached } from '@/lib/detached';
import { makeWorkspaceContext } from '@/lib/services/context';
import { addSuppression } from '@/lib/services/suppression';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import {
  DECISIONS_HEADER,
  applyMailPlan,
  brandStem,
  buildMailPlan,
  notificationThreadId,
  ownDomainMatcher,
  renderDecisionsCsv,
  renderPlanMarkdown,
  resolveDecisions,
  type MailPlan,
} from '../../scripts/remediation/2026-10-funnel/mail';
import { main as cli } from '../../scripts/remediation/2026-10-funnel/cli';
import { resolveActor, revertRun, type Actor } from '../../scripts/remediation/lib/engine';
import {
  canonicalJson,
  formatCsv,
  maskAddresses,
  parseCsv,
  unguardCell,
} from '../../scripts/remediation/lib/report-io';

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);
const plusSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

const BODY_MARKER = 'BODY-MARKER-7f3a';
const SUBJECT_MARKER = 'SUBJECT-MARKER-9c1d';
const OUR_ID = '<our-opener-0001@ecobeton-uk.ro>';

interface Fx {
  admin: string;
  owner: string;
  ws: bigint;
  ws2: bigint;
  mailbox: bigint;
  failingMailbox: bigint;
  msg: Record<string, bigint>;
  thread: Record<string, bigint>;
  supp: Record<string, bigint>;
  contact: Record<string, bigint>;
  notif: Record<string, bigint>;
}

async function newThread(ws: bigint, mailbox: bigint, key: string): Promise<bigint> {
  const [t] = await db
    .insert(mailThreads)
    .values({
      workspaceId: ws,
      mailboxId: mailbox,
      subject: SUBJECT_MARKER,
      externalThreadKey: key,
    })
    .returning();
  return t!.id;
}

async function legacyInbound(input: {
  ws: bigint;
  mailbox: bigint;
  threadId: bigint;
  key: string;
  from: string;
  headers?: Record<string, unknown>;
  inReplyTo?: string;
  label?: 'unsubscribe' | 'bounce' | null;
  createdAt?: Date;
  translatedAt?: Date;
}): Promise<bigint> {
  const [m] = await db
    .insert(mailMessages)
    .values({
      workspaceId: input.ws,
      mailboxId: input.mailbox,
      threadId: input.threadId,
      direction: 'inbound',
      status: 'received',
      messageId: `<${input.key}@fixture.example>`,
      inReplyTo: input.inReplyTo ?? null,
      references: input.inReplyTo ? [input.inReplyTo] : [],
      fromAddress: input.from,
      toAddresses: ['office@ecobeton-uk.ro'],
      subject: SUBJECT_MARKER,
      bodyText: `${BODY_MARKER} … unsubscribe here`,
      headers: input.headers ?? {},
      receivedAt: input.createdAt ?? minutesAgo(1000),
      createdAt: input.createdAt ?? minutesAgo(1000),
      replyClassification: input.label ?? null,
      replyClassificationConfidence: input.label ? 70 : null,
      replyClassifiedAt: input.label ? (input.createdAt ?? minutesAgo(1000)) : null,
      translatedAt: input.translatedAt ?? null,
      bodyTextNative: input.translatedAt ? 'translated' : null,
    })
    .returning();
  return m!.id;
}

async function audit(input: {
  ws: bigint;
  userId: string;
  kind: string;
  entityType: string;
  entityId: bigint;
  payload: Record<string, unknown>;
  at: Date;
}): Promise<void> {
  await db.insert(auditLog).values({
    workspaceId: input.ws,
    userId: input.userId,
    kind: input.kind,
    entityType: input.entityType,
    entityId: input.entityId.toString(),
    payload: input.payload,
    createdAt: input.at,
  });
}

async function suppression(input: {
  ws: bigint;
  value: string;
  reason?: SuppressionEntry['reason'];
  source: SuppressionEntry['source'];
  note?: string | null;
  sourceRef?: string | null;
  createdBy: string;
  at: Date;
}): Promise<bigint> {
  const [s] = await db
    .insert(suppressionList)
    .values({
      workspaceId: input.ws,
      kind: 'email',
      address: input.value,
      value: input.value,
      reason: input.reason ?? 'unsubscribe',
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy,
      createdAt: input.at,
    })
    .returning();
  return s!.id;
}

/** A legacy auto-suppression: reply.classify, then the add 1 s later. */
async function legacyAutoAdd(
  fx: { ws: bigint; owner: string },
  suppressionId: bigint,
  value: string,
  messageId: bigint,
  at: Date,
  type: 'unsubscribe' | 'bounce' = 'unsubscribe',
): Promise<void> {
  await audit({
    ws: fx.ws,
    userId: fx.owner,
    kind: 'reply.classify',
    entityType: 'mail_message',
    entityId: messageId,
    payload: { type, confidence: 70 },
    at,
  });
  await audit({
    ws: fx.ws,
    userId: fx.owner,
    kind: 'suppression.add',
    entityType: 'suppression_entry',
    entityId: suppressionId,
    payload: { kind: 'email', value, reason: type === 'bounce' ? 'bounce_hard' : 'unsubscribe' },
    at: plusSeconds(at, 1),
  });
}

async function senderContact(
  ws: bigint,
  email: string,
  threadIds: bigint[],
  extra: { notes?: string; otherLink?: { entityType: string; entityId: string } } = {},
): Promise<bigint> {
  const [c] = await db
    .insert(contacts)
    .values({ workspaceId: ws, email, notes: extra.notes ?? null })
    .returning();
  for (const t of threadIds) {
    await db.insert(contactAssociations).values({
      workspaceId: ws,
      contactId: c!.id,
      entityType: 'mail_thread',
      entityId: t.toString(),
      relation: 'inbound_sender',
    });
  }
  if (extra.otherLink) {
    await db.insert(contactAssociations).values({
      workspaceId: ws,
      contactId: c!.id,
      ...extra.otherLink,
    });
  }
  return c!.id;
}

async function leadReplied(
  ws: bigint,
  input: { threadId?: bigint; href?: string; read?: boolean; kind?: string },
): Promise<bigint> {
  const [n] = await db
    .insert(notifications)
    .values({
      workspaceId: ws,
      kind: input.kind ?? 'lead.replied',
      title: `Reply from ${SUBJECT_MARKER}`,
      body: SUBJECT_MARKER,
      href: input.href ?? (input.threadId ? `/communication/${input.threadId}` : null),
      dedupeKey:
        input.threadId && !input.href ? `${input.kind ?? 'lead.replied'}:${input.threadId}` : null,
      readAt: input.read ? minutesAgo(10) : null,
      createdAt: minutesAgo(500),
    })
    .returning();
  return n!.id;
}

async function seedFixture(): Promise<Fx> {
  const admin = await seedUser({ email: 'ops@platform.test', role: 'super_admin' });
  const owner = await seedUser({ email: 'owner.ecobeton@gmail.com' });
  const owner2 = await seedUser({ email: 'owner.other@gmail.com' });
  const ws = await seedWorkspace({ name: 'Ecobeton', ownerUserId: owner });
  const ws2 = await seedWorkspace({ name: 'Other Co', ownerUserId: owner2 });
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId: ws,
      name: 'Office',
      fromAddress: 'office@ecobeton-uk.ro',
      smtpHost: 'mail.ecobeton-uk.ro',
      smtpUser: 'office@ecobeton-uk.ro',
      smtpPasswordSecretKey: 'mailbox.smtp_fixture',
      status: 'active',
      isDefault: true,
    })
    .returning();
  const [mb2] = await db
    .insert(mailboxes)
    .values({
      workspaceId: ws2,
      name: 'Sales · sales@acme-sales.example',
      fromAddress: 'sales@acme-sales.example',
      smtpHost: 'mail.acme-sales.example',
      smtpPort: 587,
      smtpUser: 'sales@acme-sales.example',
      smtpPasswordSecretKey: 'mailbox.smtp_fixture2',
      imapHost: 'mail.acme-sales.example',
      imapPort: 993,
      status: 'failing',
      lastError: 'SMTP connect ECONNREFUSED 51.89.234.14:587 (sales@acme-sales.example)',
      failingSince: minutesAgo(60 * 24 * 140),
      imapConsecutiveFailures: 13,
    })
    .returning();
  const mailbox = mb!.id;
  const fx: Fx = {
    admin,
    owner,
    ws,
    ws2,
    mailbox,
    failingMailbox: mb2!.id,
    msg: {},
    thread: {},
    supp: {},
    contact: {},
    notif: {},
  };

  // Our one outbound message (to a prospect) and the prospect's reply.
  fx.thread.out = await newThread(ws, mailbox, 'out');
  await db.insert(mailMessages).values({
    workspaceId: ws,
    mailboxId: mailbox,
    threadId: fx.thread.out,
    direction: 'outbound',
    status: 'sent',
    messageId: OUR_ID,
    fromAddress: 'office@ecobeton-uk.ro',
    toAddresses: ['anna@target.example'],
    subject: SUBJECT_MARKER,
    bodyText: BODY_MARKER,
    sentAt: minutesAgo(3000),
  });

  const inboundSpec: Array<
    [string, string, Record<string, unknown>, 'unsubscribe' | 'bounce' | null, string?]
  > = [
    ['nl', 'news@substack.example', { list: '[object Object]' }, 'unsubscribe'],
    ['li', 'no-reply@linkedin.example', {}, 'unsubscribe'],
    ['li2', 'no-reply@linkedin.example', {}, 'unsubscribe'],
    ['piotr', 'piotr@ecobeton-uk.ro', {}, 'bounce'],
    ['annaEco', 'anna@ecobeton.pl', {}, 'unsubscribe'],
    ['vendor', 'vendor@shop.example', { precedence: 'bulk' }, 'unsubscribe'],
    ['late', 'late@shop2.example', { list: '[object Object]' }, 'unsubscribe'],
    ['promo', 'promo@deals.example', { precedence: 'bulk' }, null],
    ['medium', 'digest@medium.example', { list: '[object Object]' }, 'unsubscribe'],
    ['curated', 'curated@deals2.example', { precedence: 'bulk' }, null],
    ['linked', 'linked@partner.example', {}, null],
  ];
  for (const [key, from, headers, label] of inboundSpec) {
    fx.thread[key] = await newThread(ws, mailbox, key);
    fx.msg[key] = await legacyInbound({
      ws,
      mailbox,
      threadId: fx.thread[key]!,
      key,
      from,
      headers,
      label,
      translatedAt: key === 'nl' ? minutesAgo(99) : undefined,
    });
  }
  fx.msg.prospect = await legacyInbound({
    ws,
    mailbox,
    threadId: fx.thread.out,
    key: 'prospect',
    from: 'anna@target.example',
    inReplyTo: OUR_ID,
    label: 'unsubscribe',
  });
  // A row F-01 labelled at sync time, 72 h ago (F-01 is live: precondition).
  fx.thread.parser = await newThread(ws, mailbox, 'parser');
  const [parsed] = await db
    .insert(mailMessages)
    .values({
      workspaceId: ws,
      mailboxId: mailbox,
      threadId: fx.thread.parser,
      direction: 'inbound',
      status: 'received',
      messageId: '<parser@news.example>',
      fromAddress: 'weekly@news.example',
      subject: SUBJECT_MARKER,
      bodyText: BODY_MARKER,
      outreachRelevance: 'bulk',
      relevanceSignals: { source: 'parser', list_headers: true },
      createdAt: minutesAgo(72 * 60),
    })
    .returning();
  fx.msg.parser = parsed!.id;

  // ws2: one newsletter auto-suppression of its own.
  const mb2Thread = await newThread(ws2, fx.failingMailbox, 'other');
  fx.thread.other = mb2Thread;
  fx.msg.other = await legacyInbound({
    ws: ws2,
    mailbox: fx.failingMailbox,
    threadId: mb2Thread,
    key: 'other',
    from: 'info@other.example',
    headers: { list: '[object Object]' },
    label: 'unsubscribe',
  });

  const legacyNote = (id: bigint) => `auto-suppressed from message ${id}`;
  const t0 = minutesAgo(900);

  // R1a: classifier on newsletters / colleagues.
  fx.supp.nl = await suppression({
    ws,
    value: 'news@substack.example',
    source: 'legacy_auto',
    note: legacyNote(fx.msg.nl!),
    sourceRef: `mail_message:${fx.msg.nl}`,
    createdBy: owner,
    at: plusSeconds(t0, 1),
  });
  await legacyAutoAdd(fx, fx.supp.nl, 'news@substack.example', fx.msg.nl!, t0);

  fx.supp.li = await suppression({
    ws,
    value: 'no-reply@linkedin.example',
    source: 'legacy_auto',
    note: legacyNote(fx.msg.li2!),
    sourceRef: `mail_message:${fx.msg.li2}`,
    createdBy: owner,
    at: plusSeconds(minutesAgo(880), 1),
  });
  await legacyAutoAdd(fx, fx.supp.li, 'no-reply@linkedin.example', fx.msg.li!, minutesAgo(880));
  await legacyAutoAdd(fx, fx.supp.li, 'no-reply@linkedin.example', fx.msg.li2!, minutesAgo(870));

  fx.supp.piotr = await suppression({
    ws,
    value: 'piotr@ecobeton-uk.ro',
    reason: 'bounce_hard',
    source: 'legacy_auto',
    note: legacyNote(fx.msg.piotr!),
    sourceRef: `mail_message:${fx.msg.piotr}`,
    createdBy: owner,
    at: plusSeconds(minutesAgo(860), 1),
  });
  await legacyAutoAdd(
    fx,
    fx.supp.piotr,
    'piotr@ecobeton-uk.ro',
    fx.msg.piotr!,
    minutesAgo(860),
    'bounce',
  );

  fx.supp.annaEco = await suppression({
    ws,
    value: 'anna@ecobeton.pl',
    source: 'legacy_auto',
    note: legacyNote(fx.msg.annaEco!),
    sourceRef: `mail_message:${fx.msg.annaEco}`,
    createdBy: owner,
    at: plusSeconds(minutesAgo(850), 1),
  });
  await legacyAutoAdd(fx, fx.supp.annaEco, 'anna@ecobeton.pl', fx.msg.annaEco!, minutesAgo(850));

  // Post-F-03 'reply' add (declares its source) from a newsletter.
  fx.supp.medium = await suppression({
    ws,
    value: 'digest@medium.example',
    source: 'reply',
    sourceRef: `mail_message:${fx.msg.medium}`,
    createdBy: owner,
    at: minutesAgo(6000),
  });
  await audit({
    ws,
    userId: owner,
    kind: 'suppression.add',
    entityType: 'suppression_entry',
    entityId: fx.supp.medium,
    payload: {
      kind: 'email',
      value: 'digest@medium.example',
      reason: 'unsubscribe',
      source: 'reply',
      sourceRef: `mail_message:${fx.msg.medium}`,
      outcome: 'created',
    },
    at: minutesAgo(6000),
  });

  // R1b: manually suppressed first, auto-touched later (the old upsert
  // overwrote the note with the auto pattern).
  fx.supp.vendor = await suppression({
    ws,
    value: 'vendor@shop.example',
    source: 'legacy_auto',
    note: legacyNote(fx.msg.vendor!),
    sourceRef: `mail_message:${fx.msg.vendor}`,
    createdBy: owner,
    at: minutesAgo(5000),
  });
  await audit({
    ws,
    userId: owner,
    kind: 'suppression.add',
    entityType: 'suppression_entry',
    entityId: fx.supp.vendor,
    payload: { kind: 'email', value: 'vendor@shop.example', reason: 'unsubscribe' },
    at: minutesAgo(5000),
  });
  await legacyAutoAdd(fx, fx.supp.vendor, 'vendor@shop.example', fx.msg.vendor!, minutesAgo(830));

  // R1b: a prospect's real reply.
  fx.supp.prospect = await suppression({
    ws,
    value: 'anna@target.example',
    source: 'legacy_auto',
    note: legacyNote(fx.msg.prospect!),
    sourceRef: `mail_message:${fx.msg.prospect}`,
    createdBy: owner,
    at: plusSeconds(minutesAgo(820), 1),
  });
  await legacyAutoAdd(
    fx,
    fx.supp.prospect,
    'anna@target.example',
    fx.msg.prospect!,
    minutesAgo(820),
  );

  // R1b: no audit trail at all.
  fx.supp.noTrail = await suppression({
    ws,
    value: 'ceo@client.example',
    source: 'legacy_unknown',
    note: 'asked by phone',
    createdBy: owner,
    at: minutesAgo(9000),
  });

  // R1b: the classify event is 300 s before the add — outside the window.
  fx.supp.late = await suppression({
    ws,
    value: 'late@shop2.example',
    source: 'legacy_unknown',
    createdBy: owner,
    at: minutesAgo(800),
  });
  await audit({
    ws,
    userId: owner,
    kind: 'reply.classify',
    entityType: 'mail_message',
    entityId: fx.msg.late!,
    payload: { type: 'unsubscribe' },
    at: minutesAgo(805),
  });
  await audit({
    ws,
    userId: owner,
    kind: 'suppression.add',
    entityType: 'suppression_entry',
    entityId: fx.supp.late,
    payload: { kind: 'email', value: 'late@shop2.example', reason: 'unsubscribe' },
    at: minutesAgo(800),
  });

  // Out of R1 scope (reason manual).
  fx.supp.manualReason = await suppression({
    ws,
    value: 'blocked@corp.example',
    reason: 'manual',
    source: 'manual',
    createdBy: owner,
    at: minutesAgo(700),
  });

  // ws2 R1a.
  fx.supp.other = await suppression({
    ws: ws2,
    value: 'info@other.example',
    source: 'legacy_auto',
    note: legacyNote(fx.msg.other!),
    createdBy: owner2,
    at: plusSeconds(minutesAgo(600), 1),
  });
  await legacyAutoAdd(
    { ws: ws2, owner: owner2 },
    fx.supp.other,
    'info@other.example',
    fx.msg.other!,
    minutesAgo(600),
  );

  // Contacts the old sync created for every sender.
  for (const key of ['nl', 'piotr', 'annaEco', 'vendor', 'late', 'promo', 'medium']) {
    const [row] = await db
      .select({ from: mailMessages.fromAddress })
      .from(mailMessages)
      .where(eq(mailMessages.id, fx.msg[key]!));
    fx.contact[key] = await senderContact(ws, row!.from, [fx.thread[key]!]);
  }
  fx.contact.li = await senderContact(ws, 'no-reply@linkedin.example', [
    fx.thread.li!,
    fx.thread.li2!,
  ]);
  fx.contact.prospect = await senderContact(ws, 'anna@target.example', [fx.thread.out!]);
  fx.contact.curated = await senderContact(ws, 'curated@deals2.example', [fx.thread.curated!], {
    notes: 'met at the fair',
  });
  fx.contact.linked = await senderContact(ws, 'linked@partner.example', [fx.thread.linked!], {
    otherLink: { entityType: 'qualified_lead', entityId: '999' },
  });
  fx.contact.other = await senderContact(ws2, 'info@other.example', [fx.thread.other!]);

  // Notifications.
  fx.notif.nl = await leadReplied(ws, { threadId: fx.thread.nl });
  fx.notif.li = await leadReplied(ws, { threadId: fx.thread.li, read: true });
  fx.notif.promoHref = await leadReplied(ws, { href: `/communication/${fx.thread.promo}` });
  fx.notif.out = await leadReplied(ws, { threadId: fx.thread.out });
  fx.notif.unparsed = await leadReplied(ws, { href: '/settings' });
  fx.notif.otherKind = await leadReplied(ws, { threadId: fx.thread.nl, kind: 'mailbox.failing' });
  fx.notif.ws2 = await leadReplied(ws2, { threadId: fx.thread.other });

  // R6: flags in ws2 that nobody reads today.
  await db.insert(featureFlags).values([
    { workspaceId: ws2, key: 'mailbox.imap_sync', enabled: false, setAt: minutesAgo(60 * 24 * 10) },
    { workspaceId: ws2, key: 'outreach.send', enabled: false, setAt: minutesAgo(60 * 24 * 10) },
    { workspaceId: ws2, key: 'connector.serpapi', enabled: false, setAt: minutesAgo(60 * 24 * 10) },
  ]);

  // R8: the newsletter translation was billed 3 tokens.
  const [usage] = await db
    .insert(usageLog)
    .values({
      workspaceId: ws,
      kind: 'ai.generate',
      provider: 'anthropic',
      units: 120n,
      costEstimateCents: 1,
      createdAt: plusSeconds(minutesAgo(99), -10),
    })
    .returning();
  await db.insert(tokenTransactions).values({
    workspaceId: ws,
    delta: -3n,
    balanceAfter: 997n,
    kind: 'usage',
    reason: 'ai.generate',
    payload: { usageLogId: usage!.id.toString() },
    createdAt: plusSeconds(minutesAgo(99), -10),
  });
  await db.update(workspaces).set({ tokenBalance: 997n }).where(eq(workspaces.id, ws));

  return fx;
}

async function actor(): Promise<Actor> {
  return resolveActor('ops@platform.test');
}

async function dryRun(): Promise<MailPlan> {
  return (await buildMailPlan()).plan;
}

function ws(plan: MailPlan, id: bigint) {
  const w = plan.workspaces.find((x) => x.workspaceId === id.toString());
  if (!w) throw new Error(`workspace ${id} not in plan`);
  return w;
}

/** Full rows (as jsonb text) of every table the remediation may touch. */
async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of [
    'mail_messages',
    'suppression_list',
    'contacts',
    'notifications',
    'mailboxes',
    'workspaces',
  ]) {
    const rows = await db.execute<{ j: string }>(
      sql.raw(`SELECT to_jsonb(t.*)::text AS j FROM "${t}" t ORDER BY id`),
    );
    out[t] = [...rows].map((r) => r.j);
  }
  return out;
}

function editDecision(
  csv: string,
  match: (cells: string[]) => boolean,
  decision: string | null,
): string {
  const rows = parseCsv(csv);
  const header = rows.shift()!;
  const kept: string[][] = [];
  for (const r of rows) {
    if (!match(r)) {
      kept.push(r);
    } else if (decision !== null) {
      kept.push([...r.slice(0, 8), decision]);
    }
  }
  return formatCsv(
    header,
    kept.map((r) => r.map(unguardCell)),
  );
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await settleDetached();
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ pure helpers ==========================================

describe('remediation helpers', () => {
  it('brand stems and own-domain matching', () => {
    expect(brandStem('ecobeton-uk.ro')).toBe('ecobeton');
    expect(brandStem('ecobeton.co.uk')).toBe('ecobeton');
    expect(brandStem('mail.ecobeton.pl')).toBe('ecobeton');
    expect(brandStem('x.io')).toBeNull();
    expect(brandStem('other-co.example')).toBeNull();
    expect(
      ownDomainMatcher([{ domain: 'other-co.example', why: 'mailbox' }]).match(
        'info@other.example',
      ),
    ).toBeNull();
    const own = ownDomainMatcher([{ domain: 'ecobeton-uk.ro', why: 'mailbox' }]);
    expect(own.match('piotr@ecobeton-uk.ro')).toBe('ecobeton-uk.ro (mailbox)');
    expect(own.match('a@sub.ecobeton-uk.ro')).toBe('ecobeton-uk.ro (mailbox)');
    expect(own.match('anna@ecobeton.pl')).toBe('same brand as ecobeton-uk.ro');
    expect(own.match('news@substack.example')).toBeNull();
  });

  it('reads the thread of a lead.replied notification from its key or link', () => {
    expect(notificationThreadId({ dedupeKey: 'lead.replied:42', href: null })).toBe('42');
    expect(notificationThreadId({ dedupeKey: null, href: '/communication/7?x=1' })).toBe('7');
    expect(notificationThreadId({ dedupeKey: null, href: '/communication/7abc' })).toBeNull();
    expect(notificationThreadId({ dedupeKey: null, href: '/settings' })).toBeNull();
  });

  it('CSV round-trips quotes, commas, new lines and formula-looking cells', () => {
    const csv = formatCsv(
      ['a', 'b'],
      [
        ['x,"y"', 'line\nbreak'],
        ['=cmd()', '-1'],
      ],
    );
    const parsed = parseCsv(csv).map((r) => r.map(unguardCell));
    expect(parsed).toEqual([
      ['a', 'b'],
      ['x,"y"', 'line\nbreak'],
      ['=cmd()', '-1'],
    ]);
    expect(csv).toContain(`'=cmd()`);
    // Saved by a spreadsheet app in a decimal-comma locale.
    expect(parseCsv('﻿a;b\r\n"1,5";x\r\n')).toEqual([
      ['a', 'b'],
      ['1,5', 'x'],
    ]);
  });

  it('canonical JSON sorts keys and masks addresses in free text', () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: [1] } })).toBe('{"a":{"c":[1],"d":"2"},"b":1}');
    expect(maskAddresses('refused for jb@x.pl: 550')).toBe('refused for <address>: 550');
  });
});

// ============ dry run ===============================================

describe('mail remediation: dry run', { timeout: 60000 }, () => {
  it('rebuilds suppression provenance from the audit trail; own-domain rows first', async () => {
    const fx = await seedFixture();
    const plan = await dryRun();
    const w = ws(plan, fx.ws);
    const byValue = new Map(w.r1.map((r) => [r.value, r]));

    for (const v of [
      'news@substack.example',
      'no-reply@linkedin.example',
      'piotr@ecobeton-uk.ro',
      'anna@ecobeton.pl',
      'digest@medium.example',
    ]) {
      expect(byValue.get(v), v).toMatchObject({ class: 'R1a', defaultDecision: 'revoke' });
    }
    expect(byValue.get('no-reply@linkedin.example')!.trail.map((t) => t.kind)).toEqual([
      'auto',
      'auto',
    ]);
    expect(byValue.get('piotr@ecobeton-uk.ro')!.ownDomain).toBe('ecobeton-uk.ro (mailbox)');
    expect(byValue.get('anna@ecobeton.pl')!.ownDomain).toBe('same brand as ecobeton-uk.ro');

    // Manual first, auto-touched later → R1b, kept by default.
    const vendor = byValue.get('vendor@shop.example')!;
    expect(vendor).toMatchObject({ class: 'R1b', defaultDecision: 'keep' });
    expect(vendor.trail.map((t) => t.kind)).toEqual(['manual', 'auto']);
    expect(vendor.why).toContain('manual');

    expect(byValue.get('anna@target.example')).toMatchObject({ class: 'R1b' });
    expect(byValue.get('anna@target.example')!.why).toContain('prospect_reply');
    expect(byValue.get('ceo@client.example')).toMatchObject({
      class: 'R1b',
      why: 'no audit trail',
    });
    expect(byValue.get('late@shop2.example')).toMatchObject({ class: 'R1b' });
    expect(byValue.get('late@shop2.example')!.trail[0]!.kind).toBe('manual');
    // Reason 'manual' is out of R1 scope.
    expect(byValue.has('blocked@corp.example')).toBe(false);

    // Note cross-check: a 'reply' row without the legacy note is flagged.
    expect(byValue.get('digest@medium.example')!.warnings).toEqual([
      'note does not carry the auto-suppression pattern',
    ]);
    expect(byValue.get('news@substack.example')!.warnings).toEqual([]);

    // Own-domain rows are listed first.
    const firstNonOwn = w.r1.findIndex((r) => r.ownDomain === null);
    expect(
      w.r1
        .slice(0, firstNonOwn)
        .map((r) => r.value)
        .sort(),
    ).toEqual(['anna@ecobeton.pl', 'piotr@ecobeton-uk.ro']);
    expect(w.r1.slice(firstNonOwn).every((r) => r.ownDomain === null)).toBe(true);

    // ws2 has its own section and its own R1a row.
    expect(ws(plan, fx.ws2).r1.map((r) => [r.value, r.class])).toEqual([
      ['info@other.example', 'R1a'],
    ]);
    expect(w.checks.activeAutoSuppressionsFromNonProspectMail).toBe(5);
  });

  it('selects R0, R2, R3, R4 and fills the R5–R8 sheets', async () => {
    const fx = await seedFixture();
    const plan = await dryRun();
    const w = ws(plan, fx.ws);

    // R0: every legacy inbound row gets an F-01 label; the parser row is done.
    expect(w.r0).toHaveLength(12);
    expect(w.r0.find((r) => r.messageId === fx.msg.prospect!.toString())!.relevance).toBe(
      'prospect_reply',
    );
    expect(w.r0.some((r) => r.messageId === fx.msg.parser!.toString())).toBe(false);

    // R2: labels on bulk/unrelated mail only — the prospect reply keeps its own.
    const r2 = new Set(w.r2.map((r) => r.messageId));
    expect(r2.has(fx.msg.nl!.toString())).toBe(true);
    expect(r2.has(fx.msg.piotr!.toString())).toBe(true);
    expect(r2.has(fx.msg.prospect!.toString())).toBe(false);
    expect(w.r2).toHaveLength(8);

    // R3: inbound-only junk contacts; colleagues kept; curated / linked /
    // prospect contacts are never listed.
    const r3 = new Map(w.r3.map((r) => [r.email, r]));
    expect([...r3.keys()].sort()).toEqual([
      'anna@ecobeton.pl',
      'digest@medium.example',
      'late@shop2.example',
      'news@substack.example',
      'no-reply@linkedin.example',
      'piotr@ecobeton-uk.ro',
      'promo@deals.example',
      'vendor@shop.example',
    ]);
    expect(r3.get('piotr@ecobeton-uk.ro')!.defaultDecision).toBe('keep');
    expect(r3.get('anna@ecobeton.pl')!.defaultDecision).toBe('keep');
    expect(r3.get('promo@deals.example')!.defaultDecision).toBe('archive');
    expect(w.r3[0]!.ownDomain).not.toBeNull();

    // R4: lead.replied on threads without outbound (by key or by link only).
    expect(w.r4.map((r) => r.notificationId).sort()).toEqual(
      [fx.notif.nl, fx.notif.li, fx.notif.promoHref].map(String).sort(),
    );
    expect(w.r4Unparsed).toBe(1);

    expect(w.r5).toEqual({
      threadStatesWithoutOutbound: 0,
      pipelineAutoCloses: 0,
      learningEventsFromNonProspectMail: 0,
      replyDraftsFromNonProspectMail: 0,
      pendingSendsToRevokeTargets: 0,
    });
    expect(w.r8).toMatchObject({ translatedMessages: 1, billedTranslations: 1, tokens: '3' });

    const w2 = ws(plan, fx.ws2);
    const imap = w2.r6.find((f) => f.key === 'mailbox.imap_sync')!;
    expect(imap.effect).toContain('STOP IMAP sync');
    expect(imap.observed).toContain('1 inbound');
    expect(w2.r6.find((f) => f.key === 'outreach.send')!.effect).toContain('NOT live');
    expect(w2.r7).toHaveLength(1);
    expect(w2.r7[0]).toMatchObject({ consecutiveFailures: 13, defaultDecision: 'keep' });
    expect(w2.r7[0]!.advice).toContain('465');
    expect(w2.r7[0]!.error).not.toContain('sales@acme-sales.example');
    expect(w2.r7[0]!.name).not.toContain('sales@acme-sales.example');

    expect(plan.preconditions).toMatchObject({ ok: true, nonProspectReplySuppressionsSinceF01: 0 });
    expect(plan.preconditions.hoursLive).toBeGreaterThanOrEqual(71);
  });

  it('is read-only and deterministic: two dry runs give the same plan hash', async () => {
    await seedFixture();
    const before = await snapshot();
    const a = await dryRun();
    const b = await dryRun();
    expect(a.planHash).toBe(b.planHash);
    expect(a.batchId).not.toBe(b.batchId);
    expect(await snapshot()).toEqual(before);
    const [runs] = await db.select({ n: sql<number>`count(*)::int` }).from(remediationRuns);
    expect(runs!.n).toBe(0);
  });

  it('reports never contain subjects or bodies; addresses only in R1/R3 rows', async () => {
    const fx = await seedFixture();
    const plan = await dryRun();
    const json = JSON.stringify(plan);
    const md = renderPlanMarkdown(plan, { report: 'r.json', decisions: 'd.csv' });
    const csv = renderDecisionsCsv(plan);
    for (const text of [json, md, csv]) {
      expect(text).not.toContain(BODY_MARKER);
      expect(text).not.toContain(SUBJECT_MARKER);
      expect(text).not.toContain('sales@acme-sales.example');
    }
    expect(md).toContain('news@substack.example');
    // Own-domain colleagues appear before everyone else in the R1 table.
    expect(md.indexOf('piotr@ecobeton-uk.ro')).toBeLessThan(md.indexOf('news@substack.example'));
    const header = parseCsv(csv)[0];
    expect(header).toEqual([...DECISIONS_HEADER]);
    expect(csv).toContain(`R3,${fx.ws},${fx.contact.piotr},`);
  });
});

// ============ apply / revert ========================================

describe('mail remediation: apply and revert', { timeout: 90000 }, () => {
  it('applies the decided rows with a before-image each; post checks read 0', async () => {
    const fx = await seedFixture();
    const plan = await dryRun();
    const result = await applyMailPlan({
      report: plan,
      decisionsCsv: renderDecisionsCsv(plan),
      actor: await actor(),
    });

    expect(result.status).toBe('applied');
    expect(result.categories).toMatchObject({
      R0: { changed: 13, skipped: 0 },
      R1: { changed: 6, skipped: 0 },
      R2: { changed: 9 },
      R3: { changed: 7 },
      R4: { changed: 4 },
      R7: { changed: 0 },
      R8: { changed: 0 },
    });
    expect(result.post).toEqual({
      inboundWithoutRelevance: 0,
      activeAutoSuppressionsFromNonProspectMail: 0,
      labelledNonProspectInbound: 0,
      inboundOnlyContacts: 2,
      visibleInboundAutoContacts: 0,
      leadRepliedOnThreadsWithoutOutbound: 0,
    });
    expect(result.keptByDecision).toEqual({ r1a: 0, r3: 2 });

    // Every changed row has a before-image in remediation_log.
    const log = await db
      .select()
      .from(remediationLog)
      .where(eq(remediationLog.runId, plan.batchId));
    expect(log).toHaveLength(result.totalChanged);
    expect(log.every((l) => l.before !== null)).toBe(true);

    // Suppressions: R1a revoked (never deleted), R1b untouched.
    const supp = new Map((await db.select().from(suppressionList)).map((s) => [s.value, s]));
    expect(supp.size).toBe(11);
    const revoked = supp.get('news@substack.example')!;
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedBy).toBe(fx.admin);
    expect(revoked.revokeReason).toBe(`remediation 2026-10 X1 (${plan.batchId}, R1a)`);
    for (const v of [
      'vendor@shop.example',
      'anna@target.example',
      'ceo@client.example',
      'late@shop2.example',
      'blocked@corp.example',
    ]) {
      expect(supp.get(v)!.revokedAt, v).toBeNull();
    }
    expect(supp.get('piotr@ecobeton-uk.ro')!.revokedAt).not.toBeNull();

    // Labels cleared on junk, kept on the prospect reply; relevance stored.
    const [nl] = await db.select().from(mailMessages).where(eq(mailMessages.id, fx.msg.nl!));
    expect(nl).toMatchObject({
      replyClassification: null,
      replyClassificationConfidence: null,
      replyClassifiedAt: null,
      outreachRelevance: 'bulk',
    });
    const [prospect] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, fx.msg.prospect!));
    expect(prospect).toMatchObject({
      replyClassification: 'unsubscribe',
      outreachRelevance: 'prospect_reply',
    });

    // Contacts archived + tagged, never deleted; colleagues stay active.
    const [promo] = await db.select().from(contacts).where(eq(contacts.id, fx.contact.promo!));
    expect(promo).toMatchObject({ status: 'archived', tags: ['inbound-auto'] });
    const [piotr] = await db.select().from(contacts).where(eq(contacts.id, fx.contact.piotr!));
    expect(piotr).toMatchObject({ status: 'active', tags: [] });
    const [contactCount] = await db.select({ n: sql<number>`count(*)::int` }).from(contacts);
    expect(contactCount!.n).toBe(12);

    // Only the false lead.replied notifications are gone.
    const left = (await db.select({ id: notifications.id }).from(notifications)).map((n) => n.id);
    expect(left.sort()).toEqual([fx.notif.out!, fx.notif.unparsed!, fx.notif.otherKind!].sort());

    // Audit: platform-scoped per category, workspace summaries, per-row revokes.
    const platform = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.kind, 'remediation.apply'), sql`${auditLog.workspaceId} IS NULL`));
    expect(platform.map((a) => (a.payload as { category: string }).category).sort()).toEqual([
      'R0',
      'R1',
      'R2',
      'R3',
      'R4',
    ]);
    const revokes = await db.select().from(auditLog).where(eq(auditLog.kind, 'suppression.revoke'));
    expect(revokes).toHaveLength(6);
    expect(revokes[0]!.payload).toMatchObject({
      remediationRun: plan.batchId,
      prior: { source: expect.any(String) },
    });

    const [run] = await db
      .select()
      .from(remediationRuns)
      .where(eq(remediationRuns.id, plan.batchId));
    expect(run).toMatchObject({ status: 'applied', appliedBy: fx.admin, planHash: plan.planHash });
  });

  it('is idempotent: the same report changes nothing, a fresh dry run is empty', async () => {
    await seedFixture();
    const plan = await dryRun();
    const decisions = renderDecisionsCsv(plan);
    await applyMailPlan({ report: plan, decisionsCsv: decisions, actor: await actor() });
    const afterFirst = await snapshot();

    const again = await applyMailPlan({
      report: plan,
      decisionsCsv: decisions,
      actor: await actor(),
    });
    expect(again).toMatchObject({ status: 'already_applied', totalChanged: 0 });

    const fresh = await dryRun();
    const second = await applyMailPlan({
      report: fresh,
      decisionsCsv: renderDecisionsCsv(fresh),
      actor: await actor(),
    });
    expect(second.status).toBe('applied');
    expect(second.totalChanged).toBe(0);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it('revert restores every changed row byte-for-byte', async () => {
    await seedFixture();
    const before = await snapshot();
    const plan = await dryRun();
    await applyMailPlan({
      report: plan,
      decisionsCsv: renderDecisionsCsv(plan),
      actor: await actor(),
    });
    expect(await snapshot()).not.toEqual(before);

    const result = await revertRun(plan.batchId, { actor: await actor() });
    expect(result).toMatchObject({ status: 'reverted', conflicts: [] });
    expect(result.reverted).toBe(39);
    expect(await snapshot()).toEqual(before);

    const [run] = await db
      .select()
      .from(remediationRuns)
      .where(eq(remediationRuns.id, plan.batchId));
    expect(run!.status).toBe('reverted');
    await expect(revertRun(plan.batchId, { actor: await actor() })).rejects.toMatchObject({
      code: 'already_reverted',
    });
    const platform = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.kind, 'remediation.revert'), sql`${auditLog.workspaceId} IS NULL`));
    expect(platform).toHaveLength(1);
  });

  it('honours per-row and per-category decisions; R8 credits and reverts through the ledger', async () => {
    const fx = await seedFixture();
    const plan = await dryRun();
    let csv = renderDecisionsCsv(plan);
    // R1b row → revoke; own-domain R3 colleague → archive; an R1a row deleted
    // from the file → left alone; R2 skipped in ws; R8 approved; R7 recheck.
    csv = editDecision(csv, (r) => r[1] === 'R1b' && r[3] === fx.supp.vendor!.toString(), 'revoke');
    csv = editDecision(
      csv,
      (r) => r[1] === 'R3' && r[3] === fx.contact.piotr!.toString(),
      'archive',
    );
    csv = editDecision(csv, (r) => r[1] === 'R1a' && r[3] === fx.supp.nl!.toString(), null);
    csv = editDecision(csv, (r) => r[1] === 'R2' && r[2] === fx.ws.toString(), 'skip');
    csv = editDecision(csv, (r) => r[1] === 'R8', 'approve');
    csv = editDecision(csv, (r) => r[1] === 'R7', 'recheck_now');

    const result = await applyMailPlan({ report: plan, decisionsCsv: csv, actor: await actor() });
    expect(result.status).toBe('applied');
    expect(result.decisions.missing).toEqual([`R1a|${fx.ws}|${fx.supp.nl}`]);
    expect(result.decisions.overrides).toHaveLength(5);
    expect(result.keptByDecision).toEqual({ r1a: 1, r3: 1 });

    const supp = new Map((await db.select().from(suppressionList)).map((s) => [s.value, s]));
    expect(supp.get('vendor@shop.example')!.revokeReason).toContain('R1b');
    expect(supp.get('news@substack.example')!.revokedAt).toBeNull();
    const [piotr] = await db.select().from(contacts).where(eq(contacts.id, fx.contact.piotr!));
    expect(piotr!.status).toBe('archived');
    const [nl] = await db.select().from(mailMessages).where(eq(mailMessages.id, fx.msg.nl!));
    expect(nl!.replyClassification).toBe('unsubscribe');
    // ws2's R2 was still approved.
    const [other] = await db.select().from(mailMessages).where(eq(mailMessages.id, fx.msg.other!));
    expect(other!.replyClassification).toBeNull();
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, fx.failingMailbox));
    expect(mb!.imapNextSyncAfter).not.toBeNull();

    const [wallet] = await db.select().from(workspaces).where(eq(workspaces.id, fx.ws));
    expect(wallet!.tokenBalance).toBe(1000n);
    const credits = await db
      .select()
      .from(tokenTransactions)
      .where(eq(tokenTransactions.kind, 'adjustment'));
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      delta: 3n,
      externalRef: `remediation:${plan.batchId}:R8:${fx.ws}`,
    });

    const reverted = await revertRun(plan.batchId, { actor: await actor() });
    expect(reverted.status).toBe('reverted');
    const [walletAfter] = await db.select().from(workspaces).where(eq(workspaces.id, fx.ws));
    expect(walletAfter!.tokenBalance).toBe(997n);
    const ledger = await db
      .select()
      .from(tokenTransactions)
      .where(eq(tokenTransactions.kind, 'adjustment'))
      .orderBy(asc(tokenTransactions.id));
    expect(ledger.map((l) => l.delta)).toEqual([3n, -3n]);
    const [mbAfter] = await db.select().from(mailboxes).where(eq(mailboxes.id, fx.failingMailbox));
    expect(mbAfter!.imapNextSyncAfter).toBeNull();
  });

  it('refuses a drifted plan, a foreign or invalid decisions file, unmet preconditions and pending sends', async () => {
    const fx = await seedFixture();
    const plan = await dryRun();
    const csv = renderDecisionsCsv(plan);
    const a = await actor();

    await expect(
      applyMailPlan({
        report: plan,
        decisionsCsv: csv.replaceAll(plan.batchId, '2026-10-funnel.mail.20200101T000000Z.abcdef'),
        actor: a,
      }),
    ).rejects.toMatchObject({ code: 'invalid_decisions' });
    await expect(
      applyMailPlan({
        report: plan,
        decisionsCsv: editDecision(csv, (r) => r[1] === 'R3', 'delete'),
        actor: a,
      }),
    ).rejects.toMatchObject({ code: 'invalid_decisions' });
    const foreign = formatCsv(
      [...DECISIONS_HEADER],
      [[plan.batchId, 'R3', fx.ws.toString(), '424242', '', 'x', '', 'archive', 'archive']],
    );
    expect(() => resolveDecisions(plan, foreign)).toThrow(/not in this plan/);
    await expect(
      applyMailPlan({ report: { ...plan, version: 99 }, decisionsCsv: csv, actor: a }),
    ).rejects.toMatchObject({ code: 'report_version' });

    // A queued send to an address R1 would un-suppress blocks the apply.
    const [q] = await db
      .insert(outreachQueue)
      .values({
        workspaceId: fx.ws,
        mailboxId: fx.mailbox,
        toAddresses: ['News@Substack.example'],
        subject: 'x',
      })
      .returning();
    const withQueue = await dryRun();
    expect(ws(withQueue, fx.ws).r5.pendingSendsToRevokeTargets).toBe(1);
    await expect(
      applyMailPlan({ report: withQueue, decisionsCsv: renderDecisionsCsv(withQueue), actor: a }),
    ).rejects.toMatchObject({ code: 'pending_sends' });
    await db.delete(outreachQueue).where(eq(outreachQueue.id, q!.id));

    // New data since the dry run → the hash differs → refused.
    await legacyInbound({
      ws: fx.ws,
      mailbox: fx.mailbox,
      threadId: fx.thread.nl!,
      key: 'late-arrival',
      from: 'new@list.example',
      headers: { list: '[object Object]' },
      label: 'unsubscribe',
    });
    await expect(
      applyMailPlan({ report: plan, decisionsCsv: csv, actor: a }),
    ).rejects.toMatchObject({ code: 'plan_changed' });

    // F-01 not live yet (no parse-time label) → refused unless rehearsal.
    await db.delete(mailMessages).where(eq(mailMessages.id, fx.msg.parser!));
    const unsettled = await dryRun();
    expect(unsettled.preconditions.ok).toBe(false);
    await expect(
      applyMailPlan({ report: unsettled, decisionsCsv: renderDecisionsCsv(unsettled), actor: a }),
    ).rejects.toMatchObject({ code: 'preconditions' });
    const rehearsal = await applyMailPlan({
      report: unsettled,
      decisionsCsv: renderDecisionsCsv(unsettled),
      actor: a,
      skipPreconditions: true,
    });
    expect(rehearsal.status).toBe('applied');

    const [run] = await db
      .select()
      .from(remediationRuns)
      .where(eq(remediationRuns.id, plan.batchId));
    expect(run).toBeUndefined();
  });

  it('a row changed since the apply aborts the revert; --skip-conflicts reverts the rest', async () => {
    const fx = await seedFixture();
    const plan = await dryRun();
    await applyMailPlan({
      report: plan,
      decisionsCsv: renderDecisionsCsv(plan),
      actor: await actor(),
    });

    // An operator re-adds a revoked address after the apply (re-activates it).
    await addSuppression(
      makeWorkspaceContext({ workspaceId: fx.ws, userId: fx.owner, role: 'owner' }),
      {
        value: 'news@substack.example',
        reason: 'unsubscribe',
        source: 'manual',
        note: 'confirmed by phone',
      },
    );
    await expect(revertRun(plan.batchId, { actor: await actor() })).rejects.toMatchObject({
      code: 'revert_conflicts',
    });
    const [stillApplied] = await db
      .select()
      .from(remediationRuns)
      .where(eq(remediationRuns.id, plan.batchId));
    expect(stillApplied!.status).toBe('applied');
    const [promo] = await db.select().from(contacts).where(eq(contacts.id, fx.contact.promo!));
    expect(promo!.status).toBe('archived');

    const partial = await revertRun(plan.batchId, { actor: await actor(), skipConflicts: true });
    expect(partial.status).toBe('revert_partial');
    expect(partial.conflicts).toHaveLength(1);
    expect(partial.conflicts[0]).toMatchObject({
      table: 'suppression_list',
      rowId: fx.supp.nl!.toString(),
    });
    const [nl] = await db.select().from(suppressionList).where(eq(suppressionList.id, fx.supp.nl!));
    expect(nl).toMatchObject({ revokedAt: null, source: 'manual', note: 'confirmed by phone' });
    const [promoAfter] = await db.select().from(contacts).where(eq(contacts.id, fx.contact.promo!));
    expect(promoAfter).toMatchObject({ status: 'active', tags: [] });
  });

  it('only an active super admin may apply or revert', async () => {
    const fx = await seedFixture();
    void fx;
    await expect(resolveActor('owner.ecobeton@gmail.com')).rejects.toMatchObject({
      code: 'actor_not_allowed',
    });
    await expect(resolveActor('nobody@platform.test')).rejects.toMatchObject({
      code: 'actor_not_found',
    });
  });
});

// ============ CLI ===================================================

describe('mail remediation: CLI', { timeout: 90000 }, () => {
  it('dry run writes private report files; apply and revert need --confirm-db and --actor', async () => {
    const fx = await seedFixture();
    const before = await snapshot();
    const out = mkdtempSync(path.join(os.tmpdir(), 'f06-'));
    const dbName = new URL(process.env.DATABASE_URL!).pathname.slice(1);

    expect(await cli(['--out', out])).toBe(0);
    const [batch] = readdirSync(out);
    const dir = path.join(out, batch!);
    for (const f of ['report.json', 'report.md', 'decisions.csv']) {
      expect(statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    }
    const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as MailPlan;
    expect(report.batchId).toBe(batch);
    expect(await snapshot()).toEqual(before);

    // Reports never land inside the repository (except the ignored folder).
    await expect(cli(['--out', 'src/tests'])).rejects.toMatchObject({ code: 'unsafe_out_dir' });

    const apply = [
      '--apply',
      '--report',
      path.join(dir, 'report.json'),
      '--decisions',
      path.join(dir, 'decisions.csv'),
    ];
    await expect(cli([...apply, '--actor', 'ops@platform.test'])).rejects.toMatchObject({
      code: 'confirm_db',
    });
    await expect(cli([...apply, '--confirm-db', dbName])).rejects.toMatchObject({ code: 'usage' });
    expect(await cli([...apply, '--actor', 'ops@platform.test', '--confirm-db', dbName])).toBe(0);
    expect(readdirSync(dir).some((f) => f.startsWith('apply-') && f.endsWith('.md'))).toBe(true);
    const [revoked] = await db
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.id, fx.supp.nl!));
    expect(revoked!.revokedAt).not.toBeNull();
    expect(await cli(['--check'])).toBe(0);

    // The batch id names a folder: anything else is refused before any write.
    await expect(
      cli(['--revert', '../../etc', '--actor', 'ops@platform.test', '--confirm-db', dbName]),
    ).rejects.toMatchObject({ code: 'usage' });
    expect(
      await cli([
        '--revert',
        batch!,
        '--out',
        out,
        '--actor',
        'ops@platform.test',
        '--confirm-db',
        dbName,
      ]),
    ).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});
