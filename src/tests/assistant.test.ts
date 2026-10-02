// "Ask the platform" guide tests — the prompt must carry the handbook
// AND the live workspace snapshot, so answers are diagnoses.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { mailboxes } from '@/lib/db/schema/mailing';
import {
  AIOutputError,
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenOptions,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  ASSISTANT_GENERATION,
  AssistantError,
  askAssistant,
} from '@/lib/services/assistant';
import { BRAND_NAME } from '@/lib/brand';
import { createProductProfile } from '@/lib/services/product-profile';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

class CapturingProvider implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public lastInput: AIGenInput | null = null;
  public lastOptions: AIGenOptions | undefined;
  public calls = 0;
  /** What generateText does: return this text, or throw this error. */
  constructor(private readonly reply: string | Error = '  Check [/settings/billing].  ') {}
  async generateText(input: AIGenInput, options?: AIGenOptions): Promise<AIGenResult> {
    this.calls += 1;
    this.lastInput = input;
    this.lastOptions = options;
    if (this.reply instanceof Error) throw this.reply;
    return {
      text: this.reply,
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  async generateJson<T>(): Promise<T> {
    throw new Error('not used');
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
  const ownerA = await seedUser({ email: 'assistant@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

async function emptyWallet(workspaceId: bigint): Promise<void> {
  await db.update(workspaces).set({ tokenBalance: 0n }).where(eq(workspaces.id, workspaceId));
}

function outputError(kind: 'empty' | 'refusal'): AIOutputError {
  return new AIOutputError(
    {
      kind,
      provider: 'stub',
      model: 'stub-1',
      stopReason: kind === 'empty' ? 'max_tokens' : 'refusal',
      usage: { inputTokens: 10, outputTokens: 900 },
    },
    `stub ${kind}`,
  );
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

describe('askAssistant', () => {
  it('grounds the prompt in the handbook AND the live workspace snapshot', async () => {
    const s = await setup();
    const stub = new CapturingProvider();
    _setAIProviderForTests(stub);
    await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'Sealer' });

    const result = await askAssistant(
      ctx(s.workspaceA, s.ownerA),
      'why am I getting no leads?',
    );
    expect(result.answer).toBe('Check [/settings/billing].'); // trimmed

    const prompt = stub.lastInput!.prompt;
    expect(prompt).toContain('PLATFORM HANDBOOK');
    expect(prompt).toContain('GEOGRAPHY GATE IS HARD');
    expect(prompt).toContain('THIS WORKSPACE RIGHT NOW');
    expect(prompt).toContain('Token balance: 500');
    // The dead "EMPTY" marker is gone: an empty wallet never reaches here.
    expect(prompt).not.toContain('EMPTY');
    expect(prompt).toContain('Active products: 1');
    expect(prompt).toContain(
      'Mailboxes: 0 active, 0 failing (queued sends held, not read), 0 paused (not sending, due sends fail, not read)',
    );
    expect(prompt).toContain('why am I getting no leads?');
    expect(stub.lastInput!.system).toContain(`guide of ${BRAND_NAME}`);
    // maxTokens no longer bounds the visible answer on every model (the
    // per-model output floors), so the prompt asks for brevity itself.
    expect(stub.lastInput!.system).toMatch(/under\s+about 250 words/);
    expect(stub.lastInput!.system).not.toMatch(/Lead\s+Discovery\s+Platform/i);
    // The model reads the handbook without its claim tags.
    expect(prompt).toContain('Known limitations right now');
    expect(prompt).not.toMatch(/\{H-\d{2}\}/);
  });

  it('tells the model which mailboxes are failing or paused, not just how many are active', async () => {
    const s = await setup();
    const stub = new CapturingProvider();
    _setAIProviderForTests(stub);
    const base = {
      workspaceId: s.workspaceA,
      smtpHost: 'smtp.x',
      imapFolder: 'INBOX',
    };
    await db.insert(mailboxes).values([
      { ...base, name: 'a', fromAddress: 'a@x.test', smtpUser: 'a', smtpPasswordSecretKey: 'k.a', status: 'failing' },
      { ...base, name: 'b', fromAddress: 'b@x.test', smtpUser: 'b', smtpPasswordSecretKey: 'k.b', status: 'paused' },
      { ...base, name: 'c', fromAddress: 'c@x.test', smtpUser: 'c', smtpPasswordSecretKey: 'k.c', status: 'archived' },
    ]);
    await askAssistant(ctx(s.workspaceA, s.ownerA), 'why are replies not showing up?');
    expect(stub.lastInput!.prompt).toContain(
      'Mailboxes: 0 active, 1 failing (queued sends held, not read), 1 paused (not sending, due sends fail, not read)',
    );
  });

  it('carries short conversation history', async () => {
    const s = await setup();
    const stub = new CapturingProvider();
    _setAIProviderForTests(stub);
    await askAssistant(ctx(s.workspaceA, s.ownerA), 'and then?', [
      { role: 'user', content: 'how do I add a mailbox?' },
      { role: 'assistant', content: 'Go to [/mailbox/new].' },
    ]);
    const prompt = stub.lastInput!.prompt;
    expect(prompt).toContain('how do I add a mailbox?');
    expect(prompt).toContain('Go to [/mailbox/new].');
  });

  it('rejects empty and oversized questions', async () => {
    const s = await setup();
    _setAIProviderForTests(new CapturingProvider());
    await expect(
      askAssistant(ctx(s.workspaceA, s.ownerA), '   '),
    ).rejects.toThrow(AssistantError);
    await expect(
      askAssistant(ctx(s.workspaceA, s.ownerA), 'x'.repeat(2001)),
    ).rejects.toThrow(AssistantError);
  });

  it('asks every model for a bounded-reasoning answer, and tags no ordinary question as support', async () => {
    const s = await setup();
    const stub = new CapturingProvider();
    _setAIProviderForTests(stub);
    const r = await askAssistant(ctx(s.workspaceA, s.ownerA), 'how do I add a mailbox?');
    expect(r.source).toBe('ai');
    expect(stub.lastOptions).toMatchObject({ ...ASSISTANT_GENERATION, reasoning: 'low' });
    expect(stub.lastOptions?.support).toBeUndefined();
  });

  it("tags a super-admin's question (member or god mode) as platform support", async () => {
    const s = await setup();
    const stub = new CapturingProvider();
    _setAIProviderForTests(stub);
    await askAssistant(ctx(s.workspaceA, s.ownerA, 'super_admin'), 'why is nothing sending?');
    expect(stub.lastOptions?.support).toBe(true);
  });

  it('a blank model answer is a retryable empty_answer error, never a blank answer', async () => {
    const s = await setup();
    _setAIProviderForTests(new CapturingProvider('   \n '));
    const err = await askAssistant(ctx(s.workspaceA, s.ownerA), 'hello?').catch((e) => e);
    expect(err).toBeInstanceOf(AssistantError);
    expect(err.code).toBe('empty_answer');
    expect(err.retryable).toBe(true);
  });

  it('a typed empty-output error from the adapter is also empty_answer', async () => {
    const s = await setup();
    _setAIProviderForTests(new CapturingProvider(outputError('empty')));
    const err = await askAssistant(ctx(s.workspaceA, s.ownerA), 'hello?').catch((e) => e);
    expect(err).toBeInstanceOf(AssistantError);
    expect(err.code).toBe('empty_answer');
  });

  it('a refusal returns the deterministic answer instead of an error', async () => {
    const s = await setup();
    _setAIProviderForTests(new CapturingProvider(outputError('refusal')));
    const r = await askAssistant(ctx(s.workspaceA, s.ownerA), 'something odd');
    expect(r.source).toBe('deterministic');
    expect(r.fallbackReason).toBe('refusal');
    expect(r.answer).toMatch(/^I can't answer that one\.\n\nWhat I can see in this workspace right now:\n/);
    // Said once, not twice.
    expect(r.answer.match(/what I can see in this workspace/gi)).toHaveLength(1);
    // A fresh workspace has no product and no mailbox — both are named.
    expect(r.findings).toEqual(expect.arrayContaining(['products.none', 'mailbox.none']));
    expect(r.answer).toContain('[/mailbox/new]');
  });

  it('transport failures still propagate (the route turns them into a generic retryable 500)', async () => {
    const s = await setup();
    _setAIProviderForTests(new CapturingProvider(new Error('anthropic messages 529: overloaded')));
    await expect(askAssistant(ctx(s.workspaceA, s.ownerA), 'hello?')).rejects.toThrow(/529/);
  });
});

describe('askAssistant on an empty wallet', () => {
  it('skips the model and answers from the rule findings with a billing link', async () => {
    const s = await setup();
    const stub = new CapturingProvider();
    _setAIProviderForTests(stub);
    await emptyWallet(s.workspaceA);

    const r = await askAssistant(ctx(s.workspaceA, s.ownerA), 'why am I getting no leads?');
    expect(stub.calls).toBe(0);
    expect(r.source).toBe('deterministic');
    expect(r.fallbackReason).toBe('wallet_empty');
    expect(r.findings).toContain('tokens.empty');
    expect(r.answer).toContain('[/settings/billing]');
    expect(r.answer).toMatch(/^Your token wallet is empty/);
    expect(r.answer).toContain('Auto top-up');
    // The header already says the wallet is empty: the tokens.empty
    // finding is not listed a second time, the other findings are.
    expect(r.answer).not.toContain('Token wallet is empty — discovery');
    expect(r.answer).toContain('Anything else I can see in this workspace right now:');
    expect(r.answer).toContain('No active product profile');
    // An owner can buy tokens — no "ask an admin" line for them.
    expect(r.answer).not.toContain('ask one of them');
  });

  it('tells a member who cannot buy tokens to ask an owner or admin', async () => {
    const s = await setup();
    _setAIProviderForTests(new CapturingProvider());
    await emptyWallet(s.workspaceA);
    const r = await askAssistant(ctx(s.workspaceA, s.ownerA, 'member'), 'help');
    expect(r.answer).toContain('Only workspace owners and admins can buy tokens');
  });

  it('a billing-exempt workspace with no balance still gets the model', async () => {
    const s = await setup();
    const stub = new CapturingProvider();
    _setAIProviderForTests(stub);
    await db
      .update(workspaces)
      .set({ tokenBalance: 0n, billingExempt: true })
      .where(eq(workspaces.id, s.workspaceA));
    const r = await askAssistant(ctx(s.workspaceA, s.ownerA), 'help');
    expect(stub.calls).toBe(1);
    expect(r.source).toBe('ai');
  });
});
