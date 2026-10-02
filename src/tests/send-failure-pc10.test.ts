// PC-10 — the send-failure model, atomic 'sent' and manual recovery on
// the outreach queue (I007, I013, I014).
//
//   (2) a failure thrown after the mail_messages insert leaves the row
//       'sent' (the queue row commits with the insert);
//   (3) a transient error requeues with backoff, a sender-auth error leaves
//       the row queued and the mailbox failing, and no recipient is
//       suppressed for sender-side errors;
//   (4) Requeue / Retry from failed go back through suppression, the cap
//       and the cooldown;
//   plus: retrySend settles the linked queue row, a paused mailbox holds
//   its queue, and the pure model (kinds, backoff, classification).
//
// The reaper's half of acceptance (1) and the runs live in
// stuck-work-pc10.test.ts.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import { auditLog } from '@/lib/db/schema/audit';
import { mailMessages, mailboxes, suppressionList } from '@/lib/db/schema/mailing';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { opsEvents } from '@/lib/db/schema/ops';
import {
  outreachDrafts,
  outreachQueue,
  outreachSendSettings,
  outreachThreadState,
} from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import {
  LOCAL_MAX_ATTEMPTS,
  SEND_BACKOFF_BASE_MS,
  SEND_BACKOFF_MAX_MS,
  TRANSIENT_MAX_ATTEMPTS,
  classifySendFailure,
  decideRetry,
  isAfterDelivery,
  sendBackoffMs,
  tagAfterDelivery,
  tagTransportFailure,
} from '@/lib/mail/send-failure';
import { classifySmtpError } from '@/lib/mail/smtp-errors';
import { reportSendInterrupted } from '@/lib/ops/work-incidents';
import { RETRY_DRAFT_IN_FLIGHT_ERROR, retrySend } from '@/lib/services/mail';
import { updateMailbox } from '@/lib/services/mailbox';
import {
  MAILBOX_PAUSED_HOLD_REASON,
  OutreachQueueError,
  SEND_GATE_REFUSALS,
  _setSendGateForTests,
  drainQueue,
  evaluateSendGate,
  getSendSettings,
  requeueQueueEntry,
  retryQueueEntry,
} from '@/lib/services/outreach-queue';
import { addSuppression } from '@/lib/services/suppression';
import { truncateAll } from './helpers/db';
import {
  FlakyProvider,
  eauth,
  greylisted,
  outboundCopy,
  queueCtx as ctx,
  queuedDraft,
  relayDenied,
  setupQueueWorkspace as setup,
  userUnknown,
  withFailingTrigger as withTrigger,
  type QueueSetup as Setup,
} from './helpers/outreach-fixtures';

// ---- local helpers ------------------------------------------------------

async function row(id: bigint) {
  const [r] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
  return r!;
}

async function suppressions(workspaceId: bigint) {
  return db.select().from(suppressionList).where(eq(suppressionList.workspaceId, workspaceId));
}

async function outbound(workspaceId: bigint) {
  return db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.workspaceId, workspaceId), eq(mailMessages.direction, 'outbound')))
    .orderBy(mailMessages.id);
}

/** Lift the backoff so the next drain picks the row up. */
async function dueNow(id: bigint) {
  await db
    .update(outreachQueue)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(eq(outreachQueue.id, id));
}

/** An outbound to `to` (a delivered one counts for the cap and the cooldown). */
function deliveredTo(s: Setup, to: string, status: 'sent' | 'failed' = 'sent') {
  return outboundCopy(s, { to, status });
}

const throwingAi: IAIProvider = {
  id: 'stub',
  model: 'stub-model',
  async generateText() {
    throw new Error('AI provider unavailable (503)');
  },
  async generateJson() {
    throw new Error('AI provider unavailable (503)');
  },
  estimateCost() {
    return 0;
  },
  async healthCheck() {
    return { ok: false };
  },
};

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- the pure model ------------------------------------------------------

describe('send-failure model (pure)', () => {
  it('transient retries 5 times with a doubling backoff, local and unknown 3', () => {
    const now = new Date('2026-10-02T10:00:00Z');
    const waits: number[] = [];
    for (let attempt = 1; attempt < TRANSIENT_MAX_ATTEMPTS; attempt++) {
      const d = decideRetry('transient', attempt, now);
      expect(d.action).toBe('retry');
      if (d.action === 'retry') waits.push((d.nextAttemptAt.getTime() - now.getTime()) / 60_000);
    }
    expect(waits).toEqual([5, 10, 20, 40]);
    expect(decideRetry('transient', TRANSIENT_MAX_ATTEMPTS, now)).toEqual({
      action: 'give_up',
      attempt: 5,
      maxAttempts: 5,
    });
    expect(decideRetry('local', LOCAL_MAX_ATTEMPTS - 1, now).action).toBe('retry');
    expect(decideRetry('local', LOCAL_MAX_ATTEMPTS, now).action).toBe('give_up');
    expect(decideRetry('unknown', LOCAL_MAX_ATTEMPTS, now).action).toBe('give_up');
    expect(decideRetry('sender_auth', 1, now)).toEqual({ action: 'hold' });
    for (const kind of ['recipient_hard', 'policy', 'interrupted'] as const) {
      expect(decideRetry(kind, 1, now)).toEqual({ action: 'fail' });
    }
  });

  it('caps the backoff', () => {
    expect(sendBackoffMs(1)).toBe(SEND_BACKOFF_BASE_MS);
    expect(sendBackoffMs(50)).toBe(SEND_BACKOFF_MAX_MS);
    expect(sendBackoffMs(0)).toBe(SEND_BACKOFF_BASE_MS);
  });

  it('classifies tagged SMTP failures, platform refusals and everything else', () => {
    const cases: Array<[Error, string]> = [
      [eauth(), 'sender_auth'],
      [greylisted(), 'transient'],
      [
        Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:587'), {
          code: 'ESOCKET',
          command: 'CONN',
        }),
        'transient',
      ],
      [relayDenied(), 'policy'],
      [userUnknown(), 'recipient_hard'],
    ];
    for (const [err, kind] of cases) {
      tagTransportFailure(err, classifySmtpError(err, ['anna@target.com']));
      expect(classifySendFailure(err).kind).toBe(kind);
    }
    expect(classifySendFailure(new Error('translation failed: 503')).kind).toBe('local');
    expect(
      classifySendFailure(
        Object.assign(new Error('mailbox is archived'), { code: 'invalid_input' }),
      ).kind,
    ).toBe('policy');
    // Untagged but SMTP-shaped: still read as SMTP.
    expect(classifySendFailure(greylisted(), ['anna@target.com']).kind).toBe('transient');

    const delivered = new Error('insert failed');
    expect(isAfterDelivery(delivered)).toBe(false);
    tagAfterDelivery(delivered);
    expect(isAfterDelivery(delivered)).toBe(true);
    // Tagging never changes the error itself.
    expect(delivered.message).toBe('insert failed');
  });
});

// ---- (3) failure kinds on the queue --------------------------------------

describe('queue failures by kind (I007, I014)', () => {
  it('(3) a transient error requeues with backoff, retries up to 5 attempts, then fails — never suppressing', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    const provider = new FlakyProvider(greylisted);

    const before = Date.now();
    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r).toMatchObject({ picked: 1, sent: 0, failed: 0, retrying: 1 });

    let q = await row(entry.id);
    expect(q.status).toBe('queued');
    expect(q.attemptCount).toBe(1);
    expect(q.lastFailureKind).toBe('transient');
    expect(q.lastError).toMatch(/^Attempt 1 of 5 failed \(Temporary failure\): .*451/);
    const wait = q.nextAttemptAt!.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(SEND_BACKOFF_BASE_MS - 1000);
    expect(wait).toBeLessThanOrEqual(SEND_BACKOFF_BASE_MS + 5000);

    // Backing off: the next drain leaves it alone.
    const again = await drainQueue(ctx(s), { providerOverride: provider });
    expect(again.picked).toBe(0);
    expect(provider.calls).toBe(1);

    // Attempts 2..5 (the failed attempts start no domain cooldown and
    // use none of the caps).
    for (let attempt = 2; attempt <= 5; attempt++) {
      await dueNow(entry.id);
      await drainQueue(ctx(s), { providerOverride: provider });
    }
    q = await row(entry.id);
    expect(provider.calls).toBe(5);
    expect(q.status).toBe('failed');
    expect(q.attemptCount).toBe(5);
    expect(q.lastFailureKind).toBe('transient');
    expect(q.lastError).toMatch(/^Gave up after 5 attempts \(Temporary failure\)/);
    expect(q.nextAttemptAt).toBeNull();

    expect(await suppressions(s.workspaceId)).toHaveLength(0);
  });

  it('(3) a transient error that clears is sent on the retry, and the failed copy leaves the Errors folder', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    const provider = new FlakyProvider(greylisted, 1);

    await drainQueue(ctx(s), { providerOverride: provider });
    await dueNow(entry.id);
    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r.sent).toBe(1);

    const q = await row(entry.id);
    expect(q.status).toBe('sent');
    expect(q.lastError).toBeNull();
    expect(q.lastFailureKind).toBeNull();
    const rows = await outbound(s.workspaceId);
    expect(rows.map((m) => m.status)).toEqual(['failed', 'sent']);
    expect(q.sentMessageId).toBe(rows[1]!.id);
    // The failed attempt is in Trash, so nobody re-sends a delivered email.
    expect(rows[0]!.trashedAt).not.toBeNull();
    expect(rows[1]!.trashedAt).toBeNull();
  });

  it('(3) a sender-auth error leaves the row queued, the mailbox failing, and suppresses nobody', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    const provider = new FlakyProvider(eauth);

    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r).toMatchObject({ sent: 0, failed: 0, retrying: 0, skipped: 1 });

    const q = await row(entry.id);
    expect(q.status).toBe('queued');
    expect(q.attemptCount).toBe(0); // a hold is not an attempt
    expect(q.lastFailureKind).toBe('sender_auth');
    expect(q.lastError).toMatch(/^Held: the mailbox is failing/);
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, s.mailboxId));
    expect(mb!.status).toBe('failing');
    expect(await suppressions(s.workspaceId)).toHaveLength(0);
  });

  it('(3) sender-side failures never suppress; only a recipient the server says does not exist is', async () => {
    const s = await setup();
    const relay = await queuedDraft(s, 'anna@target.com');
    const r1 = await drainQueue(ctx(s), { providerOverride: new FlakyProvider(relayDenied) });
    expect(r1.failed).toBe(1);
    const policyRow = await row(relay.entry.id);
    expect(policyRow.status).toBe('failed');
    expect(policyRow.lastFailureKind).toBe('policy');
    expect(policyRow.attemptCount).toBe(1); // not retried automatically
    expect(await suppressions(s.workspaceId)).toHaveLength(0);

    const gone = await queuedDraft(s, 'anna@target.com');
    const r2 = await drainQueue(ctx(s), { providerOverride: new FlakyProvider(userUnknown) });
    expect(r2.failed).toBe(1);
    const hardRow = await row(gone.entry.id);
    expect(hardRow.lastFailureKind).toBe('recipient_hard');
    const sup = await suppressions(s.workspaceId);
    expect(sup.map((x) => x.value)).toEqual(['anna@target.com']);
  });

  it('a failure before the submission (translation) retries 3 times as "local" and calls no mail server', async () => {
    const s = await setup({ productLanguage: 'de' });
    const { entry } = await queuedDraft(s, 'anna@target.com');
    const provider = new FlakyProvider(greylisted);
    _setAIProviderForTests(throwingAi);

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await dueNow(entry.id);
      await drainQueue(ctx(s), { providerOverride: provider });
      const q = await row(entry.id);
      expect(q.lastFailureKind).toBe('local');
      expect(q.status).toBe(attempt < 3 ? 'queued' : 'failed');
    }
    expect((await row(entry.id)).lastError).toMatch(
      /^Gave up after 3 attempts \(Error before sending\)/,
    );
    expect(provider.calls).toBe(0);
  });

  it('(I014) a paused mailbox holds its queue instead of failing it; reactivated, it sends', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    await updateMailbox(ctx(s), s.mailboxId, { status: 'paused' });
    const provider = new FlakyProvider(greylisted, 0);

    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r).toMatchObject({ sent: 0, failed: 0, skipped: 1 });
    let q = await row(entry.id);
    expect(q.status).toBe('queued');
    expect(q.lastError).toBe(MAILBOX_PAUSED_HOLD_REASON);
    expect(q.attemptCount).toBe(0);
    expect(provider.calls).toBe(0);

    await updateMailbox(ctx(s), s.mailboxId, { status: 'active' });
    await db
      .update(outreachQueue)
      .set({ scheduledSendAt: new Date(Date.now() - 1000) })
      .where(eq(outreachQueue.id, entry.id));
    await drainQueue(ctx(s), { providerOverride: provider });
    q = await row(entry.id);
    expect(q.status).toBe('sent');
  });
});

// ---- (2) atomic 'sent' ---------------------------------------------------

describe('a delivered send is sent, whatever fails after the insert (I013)', () => {
  it('(2) the audit row and the thread counters failing after the insert leave the row sent', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    const provider = new FlakyProvider(greylisted, 0);

    await withTrigger(
      'pc10_fail_send_audit',
      'audit_log',
      'BEFORE INSERT',
      "NEW.kind = 'mail.send'",
      () =>
        withTrigger('pc10_fail_touch_thread', 'mail_threads', 'BEFORE UPDATE', 'TRUE', async () => {
          const r = await drainQueue(ctx(s), { providerOverride: provider });
          expect(r).toMatchObject({ sent: 1, failed: 0 });
        }),
    );

    const q = await row(entry.id);
    expect(q.status).toBe('sent');
    const [sent] = await outbound(s.workspaceId);
    expect(sent!.status).toBe('sent');
    expect(q.sentMessageId).toBe(sent!.id);
    expect(provider.calls).toBe(1);
  });

  it('(2) the queue row turns sent in the same transaction as the mail row', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    // Make the mail row's insert fail after the server took the message:
    // nothing may claim the queue row is sent without a mail row …
    await withTrigger(
      'pc10_fail_sent_insert',
      'mail_messages',
      'BEFORE INSERT',
      "NEW.status = 'sent'",
      async () => {
        const provider = new FlakyProvider(greylisted, 0);
        const r = await drainQueue(ctx(s), { providerOverride: provider });
        // … but the email went out, so it is sent — never retried.
        expect(r.sent).toBe(1);
        expect(provider.calls).toBe(1);
        const again = await drainQueue(ctx(s), { providerOverride: provider });
        expect(again.picked).toBe(0);
        expect(provider.calls).toBe(1);
      },
    );
    const q = await row(entry.id);
    expect(q.status).toBe('sent');
    expect(q.sentMessageId).toBeNull();
    expect(q.lastError).toMatch(/^Sent, but recording it failed/);
    expect(await outbound(s.workspaceId)).toHaveLength(0);
  });
});

// ---- (4) manual recovery -------------------------------------------------

async function failedEntry(s: Setup, to = 'anna@target.com') {
  const created = await queuedDraft(s, to);
  await drainQueue(ctx(s), { providerOverride: new FlakyProvider(relayDenied) });
  const q = await row(created.entry.id);
  expect(q.status).toBe('failed');
  return { ...created, entry: q };
}

describe('Requeue and Retry now go back through suppression, the cap and the cooldown (I014)', () => {
  it('(4) requeue from failed: queued with fresh attempts, audited; the drain then applies suppression', async () => {
    const s = await setup();
    const { entry } = await failedEntry(s);

    const requeued = await requeueQueueEntry(ctx(s, 'member'), entry.id);
    expect(requeued).toMatchObject({
      status: 'queued',
      attemptCount: 0,
      lastError: null,
      lastFailureKind: null,
      nextAttemptAt: null,
    });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'outreach.queue.requeue'));
    expect(audit!.userId).toBe(s.memberId);
    expect(audit!.payload).toMatchObject({ from: 'failed', previousFailureKind: 'policy' });

    await addSuppression(ctx(s), {
      address: 'anna@target.com',
      reason: 'unsubscribe',
      source: 'manual',
    });
    const provider = new FlakyProvider(greylisted, 0);
    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r.skipped).toBe(1);
    expect(provider.calls).toBe(0);
    expect((await row(entry.id)).lastError).toBe('suppressed: anna@target.com');
  });

  it('(4) requeue from failed respects the daily cap', async () => {
    const s = await setup();
    const { entry } = await failedEntry(s);
    await getSendSettings(ctx(s));
    await db
      .update(outreachSendSettings)
      .set({ dailyEmailLimit: 1, domainCooldownHours: 0 })
      .where(eq(outreachSendSettings.workspaceId, s.workspaceId));
    await deliveredTo(s, 'someone@elsewhere.com');

    await requeueQueueEntry(ctx(s), entry.id);
    const provider = new FlakyProvider(greylisted, 0);
    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r.picked).toBe(0);
    expect(provider.calls).toBe(0);
    expect((await row(entry.id)).status).toBe('queued');
  });

  it('(4) requeue from failed respects the domain cooldown; a failed attempt starts none', async () => {
    const s = await setup();
    const { entry } = await failedEntry(s);
    // The failed attempt's own mail row (and another failed one) do not
    // start a cooldown …
    await deliveredTo(s, 'bob@target.com', 'failed');
    await requeueQueueEntry(ctx(s), entry.id);
    const first = await drainQueue(ctx(s), { providerOverride: new FlakyProvider(relayDenied) });
    expect(first.failed).toBe(1);

    // … a delivered email to the same domain does.
    await deliveredTo(s, 'bob@target.com');
    await requeueQueueEntry(ctx(s), entry.id);
    const provider = new FlakyProvider(greylisted, 0);
    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r.skipped).toBe(1);
    expect(provider.calls).toBe(0);
    expect((await row(entry.id)).lastError).toBe('domain cooldown');
  });

  it('(4) Retry now sends through the same checks, and stays queued under a pause or a full cap', async () => {
    const s = await setup();
    // All four fail first, before anything is delivered.
    const a = await failedEntry(s, 'anna@target.com');
    const b = await failedEntry(s, 'carl@target.com');
    const c = await failedEntry(s, 'dora@other.com');
    const d = await failedEntry(s, 'eve@third.com');

    // Happy path: sent at once.
    const ok = await retryQueueEntry(ctx(s, 'member'), a.entry.id, {
      providerOverride: new FlakyProvider(greylisted, 0),
    });
    expect(ok.outcome).toBe('sent');
    expect(ok.entry.status).toBe('sent');

    // Cooldown: the email just sent to target.com blocks another one there.
    const cooled = await retryQueueEntry(ctx(s), b.entry.id, {
      providerOverride: new FlakyProvider(greylisted, 0),
    });
    expect(cooled.outcome).toBe('skipped');
    expect(cooled.entry.lastError).toBe('domain cooldown');

    // Suppression.
    await addSuppression(ctx(s), { address: 'dora@other.com', reason: 'manual', source: 'manual' });
    const suppressed = await retryQueueEntry(ctx(s), c.entry.id, {
      providerOverride: new FlakyProvider(greylisted, 0),
    });
    expect(suppressed.outcome).toBe('skipped');
    expect(suppressed.entry.lastError).toBe('suppressed: dora@other.com');

    // Emergency pause: put back, not attempted.
    await db
      .update(outreachSendSettings)
      .set({ emergencyPause: true })
      .where(eq(outreachSendSettings.workspaceId, s.workspaceId));
    const paused = await retryQueueEntry(ctx(s), d.entry.id, {
      providerOverride: new FlakyProvider(greylisted, 0),
    });
    expect(paused).toMatchObject({ outcome: 'queued', reason: 'paused' });
    expect((await row(d.entry.id)).status).toBe('queued');

    // Daily cap used up: put back, not attempted.
    await db
      .update(outreachSendSettings)
      .set({ emergencyPause: false, dailyEmailLimit: 1 })
      .where(eq(outreachSendSettings.workspaceId, s.workspaceId));
    await db
      .update(outreachQueue)
      .set({ status: 'failed' })
      .where(eq(outreachQueue.id, d.entry.id));
    const capped = await retryQueueEntry(ctx(s), d.entry.id, {
      providerOverride: new FlakyProvider(greylisted, 0),
    });
    expect(capped).toMatchObject({ outcome: 'queued', reason: 'daily_limit' });
  });

  it('refuses what cannot be put back, and a viewer', async () => {
    const s = await setup();
    const { entry, draft } = await queuedDraft(s, 'anna@target.com');

    // Still queued.
    await expect(requeueQueueEntry(ctx(s), entry.id)).rejects.toThrow(/already waiting/);
    // Viewers only read.
    await db.update(outreachQueue).set({ status: 'failed' }).where(eq(outreachQueue.id, entry.id));
    await expect(retryQueueEntry(ctx(s, 'viewer'), entry.id)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(requeueQueueEntry(ctx(s, 'viewer'), entry.id)).rejects.toBeInstanceOf(
      OutreachQueueError,
    );
    // Only an approved draft goes out.
    await db
      .update(outreachDrafts)
      .set({ status: 'superseded' })
      .where(eq(outreachDrafts.id, draft.id));
    await expect(requeueQueueEntry(ctx(s), entry.id)).rejects.toThrow(/superseded/);
    await db
      .update(outreachDrafts)
      .set({ status: 'approved' })
      .where(eq(outreachDrafts.id, draft.id));
    // One waiting email per draft.
    await db.insert(outreachQueue).values({
      workspaceId: s.workspaceId,
      mailboxId: s.mailboxId,
      draftId: draft.id,
      toAddresses: ['anna@target.com'],
      subject: 'again',
      bodyText: 'x',
      status: 'queued',
      scheduledSendAt: new Date(Date.now() + 3_600_000),
    });
    await expect(requeueQueueEntry(ctx(s), entry.id)).rejects.toThrow(
      /already has an email waiting/,
    );
    expect((await row(entry.id)).status).toBe('failed');
  });

  it('requeueing an interrupted send resolves its incident', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    await db
      .update(outreachQueue)
      .set({
        status: 'failed',
        lastFailureKind: 'interrupted',
        lastError: 'Interrupted: delivery unknown.',
      })
      .where(eq(outreachQueue.id, entry.id));
    await reportSendInterrupted({
      workspaceId: s.workspaceId,
      entryId: entry.id,
      mailboxId: s.mailboxId,
      draftId: entry.draftId,
      claimedAt: new Date(),
    });
    const open = () =>
      db
        .select()
        .from(opsEvents)
        .where(and(eq(opsEvents.kind, 'send.interrupted'), isNull(opsEvents.resolvedAt)));
    expect(await open()).toHaveLength(1);

    await requeueQueueEntry(ctx(s, 'member'), entry.id);
    expect(await open()).toHaveLength(0);
    const [ev] = await db.select().from(opsEvents).where(eq(opsEvents.kind, 'send.interrupted'));
    expect(ev).toMatchObject({ resolution: 'manual', resolvedBy: s.memberId });
  });
});

// ---- the Errors-folder retry ------------------------------------------------

describe('retrySend settles the linked queue row (I013)', () => {
  it('a successful retry marks the failed queue row of its draft sent', async () => {
    const s = await setup();
    const { entry } = await failedEntry(s);
    const [failedCopy] = await outbound(s.workspaceId);
    expect(failedCopy!.status).toBe('failed');

    const result = await retrySend(ctx(s), [failedCopy!.id], new FlakyProvider(greylisted, 0));
    expect(result.retried).toEqual([failedCopy!.id]);
    expect(result.queueEntriesSent).toEqual([entry.id]);

    const q = await row(entry.id);
    expect(q.status).toBe('sent');
    const sent = (await outbound(s.workspaceId)).find((m) => m.status === 'sent');
    expect(q.sentMessageId).toBe(sent!.id);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.kind, 'mail.retry_send'));
    expect(audit!.payload).toMatchObject({ queueEntriesSent: [entry.id.toString()] });
  });
});

// ---- one draft goes out once (review: PC-10 duplicate sends) ---------------

/** Five greylisted attempts: the queue gives up and Errors holds five
 *  failed copies of the one email. */
async function gaveUpWithFiveCopies(s: Setup) {
  const created = await queuedDraft(s, 'anna@target.com');
  const provider = new FlakyProvider(greylisted);
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await dueNow(created.entry.id);
    await drainQueue(ctx(s), { providerOverride: provider });
  }
  const q = await row(created.entry.id);
  expect(q.status).toBe('failed');
  const copies = (await outbound(s.workspaceId)).filter(
    (m) => m.status === 'failed' && m.trashedAt === null,
  );
  expect(copies).toHaveLength(5);
  return { ...created, entry: q, copies };
}

describe('one draft goes out once (PC-10 review)', () => {
  it('after the queue gives up, a bulk Errors retry of every copy sends the email once', async () => {
    const s = await setup();
    const { entry, copies } = await gaveUpWithFiveCopies(s);
    const ids = copies.map((c) => c.id);

    const provider = new FlakyProvider(greylisted, 0);
    const result = await retrySend(ctx(s), ids, provider);
    expect(provider.calls).toBe(1);
    expect(result.retried).toEqual([ids[0]]);
    expect(result.skippedAlreadySent).toEqual(ids.slice(1));
    expect(result.queueEntriesSent).toEqual([entry.id]);
    expect((await row(entry.id)).status).toBe('sent');

    const rows = await outbound(s.workspaceId);
    expect(rows.filter((m) => m.status === 'sent')).toHaveLength(1);
    // Every failed copy left Errors.
    expect(rows.filter((m) => m.status === 'failed' && m.trashedAt === null)).toHaveLength(0);

    // Retrying any copy again (a stale page) sends nothing.
    const again = await retrySend(ctx(s), [ids[3]!], provider);
    expect(provider.calls).toBe(1);
    expect(again.retried).toEqual([]);
    expect(again.skippedAlreadySent).toEqual([ids[3]]);
  });

  it('a batch tries one email once: when the retry fails again, its other copies are skipped', async () => {
    const s = await setup();
    const { copies } = await gaveUpWithFiveCopies(s);
    const ids = copies.map((c) => c.id);

    const provider = new FlakyProvider(greylisted);
    const result = await retrySend(ctx(s), ids, provider);
    expect(provider.calls).toBe(1);
    expect(result.errors.map((e) => e.id)).toEqual([ids[0]]);
    expect(result.skippedDuplicate).toEqual(ids.slice(1));
  });

  it('the Errors retry waits while the queue is sending the same draft', async () => {
    const s = await setup();
    const { entry, copies } = await gaveUpWithFiveCopies(s);
    // An operator requeued the row and the drain has it in flight.
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: new Date() })
      .where(eq(outreachQueue.id, entry.id));

    const provider = new FlakyProvider(greylisted, 0);
    const result = await retrySend(ctx(s), [copies[0]!.id], provider);
    expect(provider.calls).toBe(0);
    expect(result.errors).toEqual([{ id: copies[0]!.id, error: RETRY_DRAFT_IN_FLIGHT_ERROR }]);
  });

  it('a failed row whose draft went out through another row cannot be put back, and the drain skips it', async () => {
    const s = await setup();
    const { entry: first, draft } = await failedEntry(s);
    // The draft is queued again and goes out through a second row.
    const [second] = await db
      .insert(outreachQueue)
      .values({
        workspaceId: s.workspaceId,
        mailboxId: s.mailboxId,
        draftId: draft.id,
        toAddresses: ['anna@target.com'],
        subject: draft.subject!,
        bodyText: draft.body,
        status: 'queued',
        scheduledSendAt: new Date(Date.now() - 1000),
      })
      .returning();
    const provider = new FlakyProvider(greylisted, 0);
    expect((await drainQueue(ctx(s), { providerOverride: provider })).sent).toBe(1);
    expect((await row(second!.id)).status).toBe('sent');

    await expect(requeueQueueEntry(ctx(s), first.id)).rejects.toThrow(/already been sent/);
    await expect(
      retryQueueEntry(ctx(s), first.id, { providerOverride: provider }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await row(first.id)).status).toBe('failed');

    // Even if it gets back into the queue some other way, the drain does
    // not send the draft a second time.
    await db
      .update(outreachQueue)
      .set({ status: 'queued', scheduledSendAt: new Date(Date.now() - 1000) })
      .where(eq(outreachQueue.id, first.id));
    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(provider.calls).toBe(1);
    const skipped = await row(first.id);
    expect(skipped.status).toBe('skipped');
    expect(skipped.lastError).toMatch(/already been sent/);
  });

  it('a row recorded sent without a mail row (after-delivery failure) also blocks a re-send', async () => {
    const s = await setup();
    const { entry: first, draft } = await failedEntry(s);
    await db.insert(outreachQueue).values({
      workspaceId: s.workspaceId,
      mailboxId: s.mailboxId,
      draftId: draft.id,
      toAddresses: ['anna@target.com'],
      subject: 'x',
      bodyText: 'x',
      status: 'sent',
      scheduledSendAt: new Date(),
      lastError: 'Sent, but recording it failed: boom',
    });
    await expect(requeueQueueEntry(ctx(s), first.id)).rejects.toThrow(/queue entry \d+/);
  });
});

// ---- one pre-send gate (review: PC-10 Retry now bypassing the drain) --------

describe('the drain and Retry now share one send gate (PC-10 review)', () => {
  afterEach(() => _setSendGateForTests(null));

  it('Retry now honours every refusal the drain honours', async () => {
    const s = await setup();
    const { entry } = await failedEntry(s, 'anna@target.com');
    const waiting = await queuedDraft(s, 'carl@other.com');
    const provider = new FlakyProvider(greylisted, 0);

    // Whatever the gate refuses with — today's refusals and any added to
    // SEND_GATE_REFUSALS later (the outbound stop, a hold) — stops both.
    for (const reason of SEND_GATE_REFUSALS) {
      _setSendGateForTests(async () => ({ open: false, reason }));
      await db.update(outreachQueue).set({ status: 'failed' }).where(eq(outreachQueue.id, entry.id));

      const drained = await drainQueue(ctx(s), { providerOverride: provider });
      expect(drained).toMatchObject({ picked: 0, sent: 0, blocked: reason });
      expect((await row(waiting.entry.id)).status).toBe('queued');

      const retried = await retryQueueEntry(ctx(s), entry.id, { providerOverride: provider });
      expect(retried).toMatchObject({ outcome: 'queued', reason });
      expect(provider.calls).toBe(0);
    }

    // Open again: both send.
    _setSendGateForTests(null);
    await db.update(outreachQueue).set({ status: 'failed' }).where(eq(outreachQueue.id, entry.id));
    expect((await retryQueueEntry(ctx(s), entry.id, { providerOverride: provider })).outcome).toBe(
      'sent',
    );
  });

  it('the real gate: the emergency pause first, then the daily cap of delivered mail', async () => {
    const s = await setup();
    const settings = await getSendSettings(ctx(s));
    const now = new Date();
    expect(await evaluateSendGate(ctx(s), settings, now)).toEqual({
      open: true,
      remaining: settings.dailyEmailLimit,
    });
    // A failed attempt uses none of the cap.
    await deliveredTo(s, 'x@one.com', 'failed');
    await deliveredTo(s, 'y@two.com');
    expect(await evaluateSendGate(ctx(s), { ...settings, dailyEmailLimit: 2 }, now)).toEqual({
      open: true,
      remaining: 1,
    });
    expect(await evaluateSendGate(ctx(s), { ...settings, dailyEmailLimit: 1 }, now)).toEqual({
      open: false,
      reason: 'daily_limit',
    });
    expect(
      await evaluateSendGate(ctx(s), { ...settings, dailyEmailLimit: 1, emergencyPause: true }, now),
    ).toEqual({ open: false, reason: 'paused' });
  });
});

// ---- bounce loops count emails, not retries (review: PC-10) -----------------

describe('the bounce-loop check counts emails, not retries (PC-10 review)', () => {
  it('five temporary failures of one queued email raise no bounce loop; three different failing emails do', async () => {
    const s = await setup();
    const { copies } = await gaveUpWithFiveCopies(s);
    expect(copies.every((c) => c.spamReason === null && c.spamAt === null)).toBe(true);
    const loopAudits = () =>
      db.select().from(auditLog).where(eq(auditLog.kind, 'mail.bounce_loop_auto_spam'));
    expect(await loopAudits()).toHaveLength(0);

    // A second email to the same address fails: one earlier email failed
    // (its five copies count once), still no loop.
    const second = await queuedDraft(s, 'anna@target.com');
    await drainQueue(ctx(s), { providerOverride: new FlakyProvider(relayDenied) });
    expect((await row(second.entry.id)).status).toBe('failed');
    expect(await loopAudits()).toHaveLength(0);

    // A third different email failing to it is the loop.
    await queuedDraft(s, 'anna@target.com');
    await drainQueue(ctx(s), { providerOverride: new FlakyProvider(relayDenied) });
    const last = (await outbound(s.workspaceId)).at(-1)!;
    expect(last.spamReason).toBe('bounce_loop');
    expect(await loopAudits()).toHaveLength(1);
  });
});

// ---- follow-ups after a retried first touch (review: PC-10) -----------------

describe('follow-ups after a retried first touch (PC-10 review)', () => {
  it('a first touch that goes out on its second attempt still schedules its follow-ups', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    const provider = new FlakyProvider(greylisted, 1);
    await drainQueue(ctx(s), { providerOverride: provider });
    const [failedCopy] = await outbound(s.workspaceId);
    expect(failedCopy!.status).toBe('failed');

    // The thread belongs to the lead's outreach.
    const [lead] = await db
      .select()
      .from(qualifiedLeads)
      .where(eq(qualifiedLeads.workspaceId, s.workspaceId));
    await db.insert(outreachThreadState).values({
      workspaceId: s.workspaceId,
      qualifiedLeadId: lead!.id,
      threadId: failedCopy!.threadId!,
      stage: 'discovery',
    });

    await dueNow(entry.id);
    expect((await drainQueue(ctx(s), { providerOverride: provider })).sent).toBe(1);
    const sent = (await outbound(s.workspaceId)).find((m) => m.status === 'sent')!;
    // The failed attempt and the delivered one share the thread …
    expect(sent.threadId).toBe(failedCopy!.threadId);
    // … and the delivered one is the first touch: follow-ups are scheduled.
    const followUps = await db
      .select()
      .from(outreachFollowUps)
      .where(eq(outreachFollowUps.threadId, sent.threadId!));
    expect(followUps.length).toBeGreaterThan(0);
    expect(followUps.every((f) => f.qualifiedLeadId === lead!.id)).toBe(true);
  });
});
