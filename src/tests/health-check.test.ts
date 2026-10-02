// AI workspace health check tests: rule findings from seeded problem
// states, report persistence + scoring, warning notification, the AI
// communication review with a stub provider, and the due-claim logic.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import type { ZodSchema } from 'zod';
import { db } from '@/lib/db/client';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  type MailboxStatus,
} from '@/lib/db/schema/mailing';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  collectRuleFindings,
  listHealthReports,
  mailboxFindings,
  processDueHealthChecks,
  runWorkspaceHealthCheck,
  type HealthFinding,
  type ThreadReview,
} from '@/lib/services/health-check';
import { createConnector, createRecipe } from '@/lib/services/connector-run';
import { listNotifications } from '@/lib/services/notifications';
import { createProductProfile } from '@/lib/services/product-profile';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

class StubReviewer implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public calls = 0;
  constructor(private readonly verdict: Record<string, unknown>) {}
  async generateText(_i: AIGenInput): Promise<AIGenResult> {
    throw new Error('not used');
  }
  async generateJson<T>(_i: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    this.calls += 1;
    return schema.parse(this.verdict);
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true, detail: 'stub' };
  }
}

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'health@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

async function seedThread(s: Setup): Promise<bigint> {
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId: s.workspaceA,
      name: 'sales',
      fromAddress: 'sales@test.local',
      smtpHost: 'smtp.x',
      smtpUser: 'sales',
      smtpPasswordSecretKey: 'mailbox.smtp_health',
      imapFolder: 'INBOX',
      status: 'active',
    })
    .returning();
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId: s.workspaceA,
      mailboxId: mb!.id,
      subject: 'Waterproofing inquiry',
      externalThreadKey: 'subj:health-1',
      participants: ['anna@x.com', 'sales@test.local'],
      messageCount: 3,
      lastMessageAt: new Date(),
    })
    .returning();
  const mk = (direction: 'inbound' | 'outbound', body: string, i: number) => ({
    workspaceId: s.workspaceA,
    mailboxId: mb!.id,
    threadId: thread!.id,
    direction,
    status: direction === 'inbound' ? ('received' as const) : ('sent' as const),
    messageId: `<h${i}@x>`,
    fromAddress: direction === 'inbound' ? 'anna@x.com' : 'sales@test.local',
    toAddresses: [direction === 'inbound' ? 'sales@test.local' : 'anna@x.com'],
    subject: 'Waterproofing inquiry',
    bodyText: body,
  });
  await db.insert(mailMessages).values([
    mk('outbound', 'Hi, who handles waterproofing at your firm?', 1),
    mk('inbound', 'That would be me. What do you offer?', 2),
    mk('outbound', 'Hi, who handles waterproofing at your firm?', 3),
  ]);
  return thread!.id;
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

describe('collectRuleFindings', () => {
  it('flags empty wallet, missing product and missing mailbox', async () => {
    const s = await setup();
    await db
      .update(workspaces)
      .set({ tokenBalance: 0n })
      .where(eq(workspaces.id, s.workspaceA));
    const findings = await collectRuleFindings(ctx(s.workspaceA, s.ownerA));
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('tokens.empty');
    expect(codes).toContain('products.none');
    expect(codes).toContain('mailbox.none');
    // Without a mailbox there is no sending AND no inbox sync — the old
    // copy only mentioned approved drafts.
    const mailbox = findings.find((f) => f.code === 'mailbox.none')!;
    expect(mailbox.message).toBe(
      'No mailbox is connected — nothing can be sent and no replies are read.',
    );
  });

  describe('mailboxes by status (failing holds its queue; paused holds it, fails due follow-ups)', () => {
    async function addMailbox(s: Setup, address: string, status: MailboxStatus): Promise<bigint> {
      const [row] = await db
        .insert(mailboxes)
        .values({
          workspaceId: s.workspaceA,
          name: address,
          fromAddress: address,
          smtpHost: 'smtp.x',
          smtpUser: address,
          smtpPasswordSecretKey: `mailbox.smtp_${address}`,
          imapFolder: 'INBOX',
          status,
        })
        .returning({ id: mailboxes.id });
      return row!.id;
    }
    async function mailboxCodes(s: Setup) {
      const findings = await collectRuleFindings(ctx(s.workspaceA, s.ownerA));
      return findings.filter((f) => f.code.startsWith('mailbox.'));
    }

    it('a workspace whose only mailbox is failing is told its queue is held, not that it still sends', async () => {
      const s = await setup();
      const id = await addMailbox(s, 'sales@test.local', 'failing');
      const found = await mailboxCodes(s);
      expect(found.map((f) => f.code)).toEqual(['mailbox.failing', 'mailbox.none']);
      expect(found[0]!.message).toContain('Mailbox "sales@test.local" has been failing.');
      expect(found[0]!.message).toContain('queued outreach and follow-ups are held');
      expect(found[0]!.message).not.toContain('still sends');
      expect(found[0]!.href).toBe(`/mailbox/${id}`);
      expect(found[1]!.message).toContain('(each one is failing)');
      expect(found[1]!.message).toContain('held until it works again');
    });

    it('a failing mailbox is reported even when another one is active', async () => {
      const s = await setup();
      await addMailbox(s, 'sales@test.local', 'active');
      await addMailbox(s, 'info@test.local', 'failing');
      expect((await mailboxCodes(s)).map((f) => f.code)).toEqual(['mailbox.failing']);
    });

    it('only paused mailboxes: queued outreach waits, due follow-ups are marked failed', async () => {
      const s = await setup();
      await addMailbox(s, 'sales@test.local', 'paused');
      const found = await mailboxCodes(s);
      expect(found.map((f) => f.code)).toEqual(['mailbox.none']);
      expect(found[0]!.message).toContain('(each one is paused)');
      expect(found[0]!.message).toContain('Outreach queued on a paused mailbox waits');
      expect(found[0]!.message).toContain('follow-ups that come due on it are marked failed, not held');
      expect(found[0]!.href).toBe('/mailbox');
    });

    it('a paused mailbox next to an active one is not a problem', async () => {
      const s = await setup();
      await addMailbox(s, 'sales@test.local', 'active');
      await addMailbox(s, 'info@test.local', 'paused');
      expect(await mailboxCodes(s)).toEqual([]);
    });

    it('only archived mailboxes count as none', async () => {
      const s = await setup();
      await addMailbox(s, 'old@test.local', 'archived');
      const found = await mailboxCodes(s);
      expect(found.map((f) => f.code)).toEqual(['mailbox.none']);
      expect(found[0]!.href).toBe('/mailbox/new');
    });

    it('names each failing mailbox with its own link and the mailbox page advice (pure)', () => {
      const row = (id: bigint, name: string, status: MailboxStatus, lastError: string | null) => ({
        id,
        name,
        status,
        lastError,
        lastErrorAt: null,
        failingSince: new Date('2026-10-01T08:00:00Z'),
        smtpHost: 'mail.example.test',
        smtpPort: 587,
        imapHost: 'mail.example.test',
        imapPort: 993,
      });
      const found = mailboxFindings([
        row(1n, 'alpha', 'failing', 'SMTP: connect ECONNREFUSED 192.0.2.1:587'),
        row(2n, 'beta', 'failing', 'IMAP: Command failed: [AUTHENTICATIONFAILED] Authentication failed.'),
        row(3n, 'gamma', 'active', null),
        row(4n, 'delta', 'archived', null),
      ]);
      expect(found.map((f) => [f.code, f.href])).toEqual([
        ['mailbox.failing', '/mailbox/1'],
        ['mailbox.failing', '/mailbox/2'],
      ]);
      expect(found[0]!.message).toContain('Mailbox "alpha" has been failing since 2026-10-01 08:00 UTC.');
      expect(found[0]!.message).toContain('port 465');
      expect(found[1]!.message).toContain('refused the login');
      expect(mailboxFindings([row(4n, 'delta', 'archived', null)])).toEqual([
        expect.objectContaining({ code: 'mailbox.none', href: '/mailbox/new' }),
      ]);
    });
  });

  it('recipes without a target country: says the geography gate is off, not "held for review"', async () => {
    const s = await setup();
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'no country',
      selectors: { seed: 'hc', count: 1 },
    });
    await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'poland',
      selectors: { seed: 'hc2', count: 1, country: 'PL' },
    });
    const findings = await collectRuleFindings(ctx(s.workspaceA, s.ownerA));
    const f = findings.find((x) => x.code === 'recipes.no_country');
    expect(f).toBeDefined();
    expect(f!.message).toBe(
      '1 of 2 recipes have no target country — the geography gate is off for them, so leads from any country pass review and can be emailed.',
    );
    expect(f!.message).not.toContain('manual review');
    expect(f!.href).toBe('/connectors');
  });
});

describe('runWorkspaceHealthCheck', () => {
  it('persists a report, scores it, and notifies on warnings', async () => {
    const s = await setup();
    _setAIProviderForTests(
      new StubReviewer({
        naturalness: 40,
        issues: ['repeats the opening question verbatim in message 3'],
        advice: ['vary the follow-up wording; reference the reply received'],
      }),
    );
    await seedThread(s);

    const report = await runWorkspaceHealthCheck({ workspaceId: s.workspaceA });
    expect(report.score).toBeLessThan(80);
    const commReview = report.commReview as ThreadReview[];
    expect(commReview).toHaveLength(1);
    expect(commReview[0]!.issues[0]).toContain('repeats');
    const findings = report.findings as HealthFinding[];
    expect(findings.some((f) => f.code === 'products.none')).toBe(true);

    const notifs = await listNotifications(ctx(s.workspaceA, s.ownerA));
    const warning = notifs.find((n) => n.kind === 'health.warning');
    expect(warning).toBeTruthy();
    expect(warning!.href).toBe('/health');

    const listed = await listHealthReports(ctx(s.workspaceA, s.ownerA));
    expect(listed).toHaveLength(1);
  });

  it('healthy workspace with clean conversations produces no warning notification', async () => {
    const s = await setup();
    _setAIProviderForTests(
      new StubReviewer({ naturalness: 95, issues: [], advice: [] }),
    );
    await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    await seedThread(s); // gives the workspace a mailbox too

    const report = await runWorkspaceHealthCheck({ workspaceId: s.workspaceA });
    expect(report.score).toBeGreaterThanOrEqual(80);
    const notifs = await listNotifications(ctx(s.workspaceA, s.ownerA));
    expect(notifs.some((n) => n.kind === 'health.warning')).toBe(false);
  });
});

describe('processDueHealthChecks', () => {
  it('claims due workspaces once and respects the interval', async () => {
    const s = await setup();
    _setAIProviderForTests(new StubReviewer({ naturalness: 90, issues: [], advice: [] }));

    const first = await processDueHealthChecks();
    expect(first.checked).toBeGreaterThanOrEqual(1);

    // Immediately after, nothing is due (lastAt stamped).
    const second = await processDueHealthChecks();
    expect(second.checked).toBe(0);

    // Backdate past the interval → due again.
    await db
      .update(workspaces)
      .set({ healthCheckLastAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(workspaces.id, s.workspaceA));
    const third = await processDueHealthChecks();
    expect(third.checked).toBeGreaterThanOrEqual(1);
  });

  it('skips workspaces with the check disabled', async () => {
    const s = await setup();
    await db
      .update(workspaces)
      .set({ healthCheckEnabled: false })
      .where(eq(workspaces.id, s.workspaceA));
    const result = await processDueHealthChecks();
    const reports = await listHealthReports(ctx(s.workspaceA, s.ownerA));
    expect(reports).toHaveLength(0);
    expect(result.failed).toBe(0);
  });
});
