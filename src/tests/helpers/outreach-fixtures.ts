// Shared fixtures for the PC-10 outreach queue suites: a workspace with an
// owner, a member and a viewer, one SMTP mailbox and a product; approved
// drafts queued for a lead; nodemailer-shaped SMTP errors and a provider
// that fails a set number of times.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  connectorRecipes,
  connectorRuns,
  connectors,
  sourceRecords,
} from '@/lib/db/schema/connectors';
import { mailMessages } from '@/lib/db/schema/mailing';
import { outreachDrafts, outreachQueue } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { reviewItems } from '@/lib/db/schema/review';
import { MockMailProvider, type OutboundMessage, type SendResult } from '@/lib/mail';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { createMailbox } from '@/lib/services/mailbox';
import { createProductProfile } from '@/lib/services/product-profile';
import { seedUser, seedWorkspace } from './db';

export interface QueueSetup {
  workspaceId: bigint;
  ownerId: string;
  memberId: string;
  viewerId: string;
  mailboxId: bigint;
  productId: bigint;
}

let seq = 0;

export function queueCtx(
  s: QueueSetup,
  who: 'owner' | 'member' | 'viewer' = 'owner',
): WorkspaceContext {
  const userId = who === 'owner' ? s.ownerId : who === 'member' ? s.memberId : s.viewerId;
  return makeWorkspaceContext({ workspaceId: s.workspaceId, userId, role: who });
}

export async function setupQueueWorkspace(
  opts: { productLanguage?: string } = {},
): Promise<QueueSetup> {
  seq += 1;
  const tag = `${seq}-${Date.now()}`;
  const ownerId = await seedUser({ email: `pc10-owner-${tag}@test.local` });
  const memberId = await seedUser({ email: `pc10-member-${tag}@test.local` });
  const viewerId = await seedUser({ email: `pc10-viewer-${tag}@test.local` });
  const workspaceId = await seedWorkspace({
    name: `pc10-${tag}`,
    ownerUserId: ownerId,
    extraMembers: [
      { userId: memberId, role: 'member' },
      { userId: viewerId, role: 'viewer' },
    ],
  });
  const c = makeWorkspaceContext({ workspaceId, userId: ownerId, role: 'owner' });
  const mb = await createMailbox(c, {
    name: 'sales',
    fromAddress: 'sales@nulife.pl',
    fromName: 'Sales',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'sales@nulife.pl',
    smtpPassword: 'secret',
    imap: null,
    isDefault: true,
  });
  const product = await createProductProfile(c, { name: 'P1', language: opts.productLanguage });
  return { workspaceId, ownerId, memberId, viewerId, mailboxId: mb.id, productId: product.id };
}

/** An approved draft for a lead at `to`, queued and due now. */
export async function queuedDraft(s: QueueSetup, to: string) {
  seq += 1;
  const [conn] = await db
    .insert(connectors)
    .values({ workspaceId: s.workspaceId, name: 'c', templateType: 'mock', active: true })
    .returning();
  const [recipe] = await db
    .insert(connectorRecipes)
    .values({ workspaceId: s.workspaceId, connectorId: conn!.id, name: 'r', templateType: 'mock' })
    .returning();
  const [run] = await db
    .insert(connectorRuns)
    .values({
      workspaceId: s.workspaceId,
      connectorId: conn!.id,
      recipeId: recipe!.id,
      status: 'succeeded',
    })
    .returning();
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: s.workspaceId,
      sourceSystem: 'mock',
      sourceId: `pc10-${seq}-${Math.random()}`,
      connectorId: conn!.id,
      recipeId: recipe!.id,
      runId: run!.id,
      rawData: {},
      normalizedData: {},
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId: s.workspaceId, sourceRecordId: sr!.id, state: 'approved' })
    .returning();
  await db.insert(qualifiedLeads).values({
    workspaceId: s.workspaceId,
    reviewItemId: ri!.id,
    productProfileId: s.productId,
    state: 'contacted',
    contactEmail: to,
  });
  const [draft] = await db
    .insert(outreachDrafts)
    .values({
      workspaceId: s.workspaceId,
      reviewItemId: ri!.id,
      sourceRecordId: sr!.id,
      productProfileId: s.productId,
      status: 'approved',
      stage: 'discovery',
      subject: 'Quick question',
      body: 'Who handles concrete repair at your company?',
      method: 'rules',
    })
    .returning();
  const [entry] = await db
    .insert(outreachQueue)
    .values({
      workspaceId: s.workspaceId,
      mailboxId: s.mailboxId,
      draftId: draft!.id,
      toAddresses: [to],
      subject: draft!.subject!,
      bodyText: draft!.body,
      delayMode: 'immediate',
      scheduledSendAt: new Date(Date.now() - 60_000),
      status: 'queued',
      createdBy: s.ownerId,
    })
    .returning();
  return { draft: draft!, entry: entry! };
}

/** An outbound mail_messages row (a delivered or failed copy). */
export async function outboundCopy(
  s: QueueSetup,
  input: { to: string; status: 'sent' | 'failed'; sourceDraftId?: bigint | null; createdAt?: Date },
) {
  const [m] = await db
    .insert(mailMessages)
    .values({
      workspaceId: s.workspaceId,
      mailboxId: s.mailboxId,
      direction: 'outbound',
      status: input.status,
      messageId: `<pc10-${Math.random()}@test>`,
      fromAddress: 'sales@nulife.pl',
      toAddresses: [input.to],
      subject: 'Earlier',
      bodyText: 'x',
      failureReason: input.status === 'failed' ? '421 try again later' : null,
      sourceDraftId: input.sourceDraftId ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning();
  return m!;
}

/** A nodemailer-shaped SMTP error. */
export function smtpError(code: string, command: string, response: string | null): Error {
  const err = new Error(response ? `${code} failed: ${response}` : code) as Error &
    Record<string, unknown>;
  err.code = code;
  err.command = command;
  if (response) {
    err.response = response;
    err.responseCode = Number(response.slice(0, 3));
  }
  return err;
}

export const greylisted = () =>
  smtpError('EENVELOPE', 'RCPT TO', '451 4.7.1 <anna@target.com>: Greylisted, try again later');
export const eauth = () =>
  smtpError('EAUTH', 'AUTH PLAIN', '535 5.7.8 Error: authentication failed');
export const relayDenied = () =>
  smtpError('EENVELOPE', 'RCPT TO', '554 5.7.1 <anna@target.com>: Relay access denied');
export const userUnknown = () =>
  smtpError(
    'EENVELOPE',
    'RCPT TO',
    '550 5.1.1 <anna@target.com>: Recipient address rejected: User unknown',
  );

/** Throws `make()` for the first `failures` sends, then delivers. */
export class FlakyProvider extends MockMailProvider {
  public calls = 0;
  constructor(
    private readonly make: () => Error,
    private readonly failures = Number.POSITIVE_INFINITY,
  ) {
    super();
  }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.calls += 1;
    if (this.calls <= this.failures) throw this.make();
    return super.send(message);
  }
}

/** Run `fn` with a row trigger that raises when `condition` holds; the
 *  trigger is always dropped afterwards. */
export async function withFailingTrigger(
  name: string,
  table: string,
  timing: 'BEFORE INSERT' | 'BEFORE UPDATE',
  condition: string,
  fn: () => Promise<void>,
): Promise<void> {
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ${condition} THEN RAISE EXCEPTION 'pc10 test: ${name}'; END IF;
        RETURN NEW;
      END $$;`),
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();`,
    ),
  );
  try {
    await fn();
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table};`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}();`));
  }
}
