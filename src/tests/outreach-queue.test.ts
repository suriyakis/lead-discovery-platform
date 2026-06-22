import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import { outreachDrafts, outreachQueue } from '@/lib/db/schema/outreach';
import { mailMessages } from '@/lib/db/schema/mailing';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import { ensureQualifiedLead, updateContact } from '@/lib/services/pipeline';
import {
  generateDraftTranslation,
  generateOutreachDraft,
  saveDraftTranslation,
} from '@/lib/services/outreach';
import { createMailbox } from '@/lib/services/mailbox';
import {
  cancelQueueEntry,
  drainQueue,
  enqueueDraft,
  getSendSettings,
  listQueueEntries,
  rescheduleQueueEntry,
  updateSendSettings,
} from '@/lib/services/outreach-queue';
import { addSuppression } from '@/lib/services/suppression';
import { reviewItems } from '@/lib/db/schema/review';
import { MockMailProvider } from '@/lib/mail';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner'): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

/**
 * Stub AI provider that tags translateText output with the target code
 * parsed from the system prompt (e.g. "[DE] ...") so a translation is
 * observable in tests. Used to verify subject + body translation at send.
 */
const taggingAi: IAIProvider = {
  id: 'stub',
  model: 'stub-model',
  async generateText() {
    throw new Error('generateText not used here');
  },
  async generateJson(input) {
    const m = (input.system ?? '').match(/natural .+ \(([a-z]{2})\)/);
    const tgt = m?.[1] ?? 'en';
    return { translatedText: `[${tgt.toUpperCase()}] ${input.prompt}` } as never;
  },
  estimateCost() {
    return 0;
  },
  async healthCheck() {
    return { ok: true };
  },
};

async function seedDraftableLead(
  s: Setup,
  recipientEmail = 'anna@target.com',
  opts: { productLanguage?: string } = {},
) {
  const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
    name: 'P',
    shortDescription: 'thing',
    language: opts.productLanguage,
  });
  const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    name: 'r',
    selectors: { seed: 'q', count: 1 },
  });
  await startRun(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    recipeId: r.id,
    wait: true,
  });
  const reviews = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, s.workspaceA));
  const lead = await ensureQualifiedLead(
    ctx(s.workspaceA, s.ownerA),
    reviews[0]!.id,
    product.id,
  );
  await updateContact(ctx(s.workspaceA, s.ownerA), lead.id, {
    contactName: 'Anna',
    contactEmail: recipientEmail,
  });
  const draft = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
    reviewItemId: reviews[0]!.id,
    productProfileId: product.id,
  });
  const mb = await createMailbox(ctx(s.workspaceA, s.ownerA), {
    name: 'sales',
    fromAddress: 'sales@nulife.pl',
    smtpHost: 'smtp.example.com',
    smtpUser: 'sales@nulife.pl',
    smtpPassword: 'pw',
    imap: {
      host: 'imap.example.com',
      user: 'sales@nulife.pl',
      password: 'pw',
    },
  });
  return { draft, mailbox: mb };
}

// ============ settings ===============================================

describe('send settings', () => {
  it('lazy-creates defaults on first read', async () => {
    const s = await setup();
    const settings = await getSendSettings(ctx(s.workspaceA, s.ownerA));
    expect(settings.dailyEmailLimit).toBe(50);
    expect(settings.defaultDelayMode).toBe('random');
    expect(settings.emergencyPause).toBe(false);
  });

  it('updateSendSettings clamps and audits', async () => {
    const s = await setup();
    const updated = await updateSendSettings(ctx(s.workspaceA, s.ownerA), {
      dailyEmailLimit: 12,
      domainCooldownHours: 48,
      defaultDelayMode: 'fixed',
      emergencyPause: true,
    });
    expect(updated.dailyEmailLimit).toBe(12);
    expect(updated.emergencyPause).toBe(true);
    expect(updated.defaultDelayMode).toBe('fixed');
  });

  it('non-admin cannot update settings', async () => {
    const s = await setup();
    await expect(
      updateSendSettings(ctx(s.workspaceA, s.ownerA, 'member'), {
        dailyEmailLimit: 0,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ============ enqueue ================================================

describe('enqueueDraft', () => {
  it('creates a queued entry pulling recipient from the lead', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    const entry = await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    expect(entry.status).toBe('queued');
    expect(entry.toAddresses).toEqual(['anna@target.com']);
    expect(entry.subject).toBe(draft.subject);
    expect(entry.bodyText).toBe(draft.body);
    expect(entry.scheduledSendAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('refuses to enqueue a rejected draft', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    await db
      .update(outreachDrafts)
      .set({ status: 'rejected' })
      .where(eq(outreachDrafts.id, draft.id));
    await expect(
      enqueueDraft(ctx(s.workspaceA, s.ownerA), {
        draftId: draft.id,
        mailboxId: mailbox.id,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

// ============ drain (suppression / cooldown / cap / pause) ===========

describe('drainQueue', () => {
  it('sends a queued entry and marks it sent', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    const provider = new MockMailProvider();
    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: provider,
    });
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
    const all = await listQueueEntries(ctx(s.workspaceA, s.ownerA));
    expect(all[0]!.status).toBe('sent');
    expect(all[0]!.sentMessageId).not.toBe(null);
  });

  it('emergency pause halts everything', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    await updateSendSettings(ctx(s.workspaceA, s.ownerA), { emergencyPause: true });
    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    expect(r).toEqual({ picked: 0, sent: 0, failed: 0, skipped: 0 });
    const all = await listQueueEntries(ctx(s.workspaceA, s.ownerA));
    expect(all[0]!.status).toBe('queued');
  });

  it('suppression skips the entry', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'anna@target.com',
      reason: 'unsubscribe',
    });
    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    expect(r.skipped).toBe(1);
    const all = await listQueueEntries(ctx(s.workspaceA, s.ownerA));
    expect(all[0]!.status).toBe('skipped');
    expect(all[0]!.lastError).toMatch(/suppressed/);
  });

  it('domain cooldown skips a follow-up to the same domain', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    await updateSendSettings(ctx(s.workspaceA, s.ownerA), {
      domainCooldownHours: 24,
    });

    // 1) Send first message — succeeds.
    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });

    // 2) Enqueue a SECOND entry to the same domain, immediately. Cooldown
    //    should skip it.
    await db.insert(outreachQueue).values({
      workspaceId: s.workspaceA,
      mailboxId: mailbox.id,
      toAddresses: ['anna@target.com'],
      subject: 'follow-up',
      bodyText: 'still here',
      delayMode: 'immediate',
      scheduledSendAt: new Date(Date.now() - 1000),
      status: 'queued',
      createdBy: s.ownerA,
    });
    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    expect(r.skipped).toBe(1);
    const queued = await listQueueEntries(ctx(s.workspaceA, s.ownerA));
    const followup = queued.find((e) => e.subject === 'follow-up');
    expect(followup?.status).toBe('skipped');
    expect(followup?.lastError).toMatch(/cooldown/);
  });

  it('daily cap blocks the drain when already-sent count >= limit', async () => {
    const s = await setup();
    await updateSendSettings(ctx(s.workspaceA, s.ownerA), {
      dailyEmailLimit: 1,
    });
    const { draft, mailbox } = await seedDraftableLead(s);
    // Insert a recent outbound message synthetically to consume the cap.
    await db.insert(mailMessages).values({
      workspaceId: s.workspaceA,
      mailboxId: mailbox.id,
      direction: 'outbound',
      status: 'sent',
      messageId: '<synthetic@cap.test>',
      fromAddress: mailbox.fromAddress,
      subject: 'cap eater',
      sentAt: new Date(),
    } as never);

    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    expect(r.picked).toBe(0);
    const all = await listQueueEntries(ctx(s.workspaceA, s.ownerA));
    expect(all[0]!.status).toBe('queued'); // still queued — will fire tomorrow
  });
});

// ============ dual-language send (Flow A) =============================

describe('drainQueue — dual-language (Flow A)', () => {
  it('translates the native draft to the target language and stores both sides', async () => {
    const s = await setup();
    // Product targets German; workspace native stays English, so the
    // draft is composed in English and translated to German at send.
    const { draft, mailbox } = await seedDraftableLead(s, 'anna@target.com', {
      productLanguage: 'de',
    });
    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    expect(r.sent).toBe(1);

    const [msg] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceA));
    expect(msg!.direction).toBe('outbound');
    expect(msg!.targetLanguage).toBe('de');
    expect(msg!.nativeLanguage).toBe('en');
    // The native reference is the operator-approved (English) draft body.
    expect(msg!.bodyTextNative).toBe(draft.body);
  });

  it('translates the subject as well as the body at send', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s, 'anna@target.com', {
      productLanguage: 'de',
    });
    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    // Swap in the tagging AI only for the send-time translation (after the
    // draft was generated with the default mock).
    _setAIProviderForTests(taggingAi);
    await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });

    const [msg] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceA));
    // Both the sent subject and body are in the target language…
    expect(msg!.subject).toContain('[DE]');
    expect(msg!.bodyText).toContain('[DE]');
    expect(msg!.targetLanguage).toBe('de');
    // …while the native reference body is untouched.
    expect(msg!.bodyTextNative).toBe(draft.body);
  });

  it('records native === target when no translation is needed', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    const [msg] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceA));
    expect(msg!.targetLanguage).toBe('en');
    expect(msg!.nativeLanguage).toBe('en');
    expect(msg!.bodyTextNative).toBe(draft.body);
  });
});

// ============ stored draft translation ================================

describe('drainQueue — operator-edited draft translation', () => {
  it('sends the stored/edited translation instead of auto-translating', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s, 'anna@target.com', {
      productLanguage: 'de',
    });
    _setAIProviderForTests(taggingAi);
    // Operator generates a translation, then hand-edits it.
    await generateDraftTranslation(ctx(s.workspaceA, s.ownerA), draft.id);
    await saveDraftTranslation(ctx(s.workspaceA, s.ownerA), draft.id, {
      subject: 'Betreff (edited)',
      body: 'HAND-EDITED GERMAN BODY',
    });
    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });

    const [msg] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceA));
    // The exact edited text goes out — NOT a fresh auto-translation.
    expect(msg!.bodyText).toBe('HAND-EDITED GERMAN BODY');
    expect(msg!.subject).toBe('Betreff (edited)');
    expect(msg!.targetLanguage).toBe('de');
    // The native (English) draft body is kept as the reference.
    expect(msg!.bodyTextNative).toBe(draft.body);
  });
});

// ============ cancel + reschedule =====================================

describe('queue mutate', () => {
  it('cancelQueueEntry transitions queued -> cancelled', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    const entry = await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'fixed',
    });
    const cancelled = await cancelQueueEntry(ctx(s.workspaceA, s.ownerA), entry.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('rescheduleQueueEntry shifts scheduled_send_at', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    const entry = await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'fixed',
    });
    const future = new Date(Date.now() + 60 * 60_000);
    const updated = await rescheduleQueueEntry(
      ctx(s.workspaceA, s.ownerA),
      entry.id,
      future,
    );
    expect(updated.scheduledSendAt.getTime()).toBe(future.getTime());
  });

  it('cannot reschedule a sent entry', async () => {
    const s = await setup();
    const { draft, mailbox } = await seedDraftableLead(s);
    await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
      draftId: draft.id,
      mailboxId: mailbox.id,
      delayMode: 'immediate',
    });
    await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    const all = await listQueueEntries(ctx(s.workspaceA, s.ownerA));
    await expect(
      rescheduleQueueEntry(ctx(s.workspaceA, s.ownerA), all[0]!.id, new Date()),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
