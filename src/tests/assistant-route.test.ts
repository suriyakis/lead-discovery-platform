// AP-02 route tests: /api/assistant end to end (auth errors, empty
// answers, the empty wallet, super-admin billing) plus the shared
// auth-error mapping on every API route that calls getWorkspaceContext.
//
// next-auth is mocked (sessions are database-backed in prod); everything
// below auth runs for real against the lane's test database. The billing
// tests go through the REAL provider factory + metering decorator with a
// stubbed fetch, so they prove what lands in usage_log and the ledger.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '@/lib/connectors/mock';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { usageLog } from '@/lib/db/schema/audit';
import { tokenTransactions } from '@/lib/db/schema/tokens';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenOptions,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import { _resetRateLimitsForTests } from '@/lib/rate-limit';
import { makeWorkspaceContext } from '@/lib/services/context';
import { resolveWorkspaceContextForUser } from '@/lib/services/workspace-resolution';
import { updateProviderSettings } from '@/lib/services/provider-settings';
import { summarizeUsage, summarizeUsageByKeySource } from '@/lib/services/usage';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/lib/auth';
import { POST as assistantPOST } from '@/app/api/assistant/route';
import { POST as translatePOST } from '@/app/api/translate/route';
import { POST as suggestReplyPOST } from '@/app/api/communication/suggest-reply/route';
import { POST as replyPOST } from '@/app/api/communication/reply/route';
import { GET as productsGET, POST as productsPOST } from '@/app/api/products/route';
import {
  DELETE as productDELETE,
  GET as productGET,
  PATCH as productPATCH,
} from '@/app/api/products/[id]/route';
import { POST as redesignPOST } from '@/app/api/signatures/redesign/route';
import { POST as sendTestPOST } from '@/app/api/signatures/send-test/route';
import { POST as buyTokensPOST } from '@/app/api/stripe/buy-tokens/route';
import { POST as checkoutPOST } from '@/app/api/stripe/checkout/route';
import { POST as portalPOST } from '@/app/api/stripe/portal/route';

type SessionUser = {
  id: string;
  role: 'member' | 'super_admin';
  accountStatus: 'pending' | 'active' | 'suspended' | 'rejected';
};
const authMock = auth as unknown as Mock<() => Promise<{ user: SessionUser } | null>>;

function signIn(user: SessionUser): void {
  authMock.mockResolvedValue({ user });
}

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * MOB-06: /api/assistant is guarded — the panel sends the workspace its
 * page was rendered for, i.e. the one the signed-in user resolves to.
 */
async function askPost(body: unknown): Promise<Request> {
  const signed = await authMock();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signed) {
    try {
      const page = await resolveWorkspaceContextForUser(
        signed.user.id,
        signed.user.role === 'super_admin',
      );
      headers['x-expected-workspace'] = page.workspaceId.toString();
    } catch {
      // no workspace: the route answers that itself
    }
  }
  return new Request('http://localhost/api/assistant', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function ask(question: string): Promise<Response> {
  return assistantPOST(await askPost({ question }));
}

class StubProvider implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public calls = 0;
  constructor(private readonly reply: string | Error) {}
  async generateText(_input: AIGenInput, _options?: AIGenOptions): Promise<AIGenResult> {
    this.calls += 1;
    if (this.reply instanceof Error) throw this.reply;
    return { text: this.reply, model: this.model, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async generateJson<T>(): Promise<T> {
    throw new Error('not used');
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true };
  }
}

interface World {
  workspaceId: bigint;
  ownerId: string;
}

let seq = 0;
async function world(): Promise<World> {
  seq += 1;
  const ownerId = await seedUser({ email: `route-owner-${seq}@test.local` });
  const workspaceId = await seedWorkspace({ name: `Route ${seq}`, ownerUserId: ownerId });
  return { workspaceId, ownerId };
}

beforeEach(async () => {
  await truncateAll();
  _resetRateLimitsForTests();
  authMock.mockReset();
});

afterEach(() => {
  _setAIProviderForTests(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('auth errors on API routes (I183)', () => {
  it.each([
    ['/api/assistant', () => assistantPOST(post('/api/assistant', { question: 'hi' }))],
    [
      '/api/translate',
      () => translatePOST(post('/api/translate', { body: 'hello', targetLanguage: 'de' })),
    ],
    [
      '/api/communication/suggest-reply',
      () => suggestReplyPOST(post('/api/communication/suggest-reply', { threadId: '1' })),
    ],
  ])('a suspended user gets 403 account_inactive on %s', async (_path, call) => {
    const w = await world();
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'suspended' });
    const res = await call();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('account_inactive');
    expect(body.detail).toMatch(/suspended/i);
  });

  it('every other route that resolves the workspace answers the same', async () => {
    const w = await world();
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'rejected' });
    const params = { params: Promise.resolve({ id: '1' }) };
    const nreq = (method: string) =>
      new NextRequest('http://localhost/api/products/1', { method, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
    const responses = await Promise.all([
      replyPOST(post('/api/communication/reply', {})),
      productsGET(new NextRequest('http://localhost/api/products')),
      productsPOST(nreq('POST')),
      productGET(nreq('GET'), params),
      productPATCH(nreq('PATCH'), params),
      productDELETE(nreq('DELETE'), params),
      redesignPOST(post('/api/signatures/redesign', {})),
      sendTestPOST(post('/api/signatures/send-test', {})),
      buyTokensPOST(post('/api/stripe/buy-tokens', { packId: 'pack_s' })),
      checkoutPOST(post('/api/stripe/checkout', { planId: 'starter' })),
      portalPOST(post('/api/stripe/portal', {})),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('account_inactive');
    }
  });

  it('a user without a workspace gets 400 no_workspace', async () => {
    const loner = await seedUser({ email: 'loner@test.local' });
    signIn({ id: loner, role: 'member', accountStatus: 'active' });
    const res = await ask('hi');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no_workspace');
  });
});

describe('POST /api/assistant', () => {
  it('a blank model answer is 502 empty_answer, retryable', async () => {
    const w = await world();
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'active' });
    _setAIProviderForTests(new StubProvider(''));
    const res = await ask('why no leads?');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'empty_answer', retryable: true });
    expect(body.detail).toMatch(/try again/);
  });

  it('an empty wallet gets a 200 deterministic answer and the model is never called', async () => {
    const w = await world();
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'active' });
    const stub = new StubProvider('model answer');
    _setAIProviderForTests(stub);
    await db.update(workspaces).set({ tokenBalance: 0n }).where(eq(workspaces.id, w.workspaceId));

    const res = await ask('why am I getting no leads?');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(stub.calls).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.source).toBe('deterministic');
    expect(body.answer).toContain('[/settings/billing]');
    expect(body.findings).toContain('tokens.empty');
    // MOB-06: the answer says which workspace its links belong to.
    expect(body.workspaceId).toBe(w.workspaceId.toString());
  });

  it('a 5,000-character earlier answer in the history is clipped, not a 400', async () => {
    const w = await world();
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'active' });
    let prompt = '';
    const stub = new StubProvider('Short answer.');
    vi.spyOn(stub, 'generateText').mockImplementation(async (input: AIGenInput) => {
      prompt = input.prompt;
      return { text: 'Short answer.', model: 'stub-1', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    _setAIProviderForTests(stub);
    const res = await assistantPOST(
      await askPost({
        question: 'and the emergency pause?',
        history: [
          { role: 'user', content: 'explain autopilot' },
          { role: 'assistant', content: `START${'y'.repeat(4995)}` },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).answer).toBe('Short answer.');
    // The model still sees the start of the long turn (500 characters).
    expect(prompt).toContain(`Guide: START${'y'.repeat(495)}\n`);
  });

  it('a provider failure is a generic retryable 500 — raw provider text never reaches the user', async () => {
    const w = await world();
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'active' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    _setAIProviderForTests(
      new StubProvider(new Error('anthropic messages 529: {"type":"overloaded_error"}')),
    );
    const res = await ask('hello?');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'assistant_failed', retryable: true });
    expect(JSON.stringify(body)).not.toMatch(/anthropic|529|overloaded/);
  });
});

describe('POST /api/assistant — billing through the real metering path', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-platform';
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = savedKey;
  });

  /** Workspace on the platform Anthropic key; fetch answers with `reply`. */
  async function anthropicWorld(reply: unknown): Promise<World> {
    const w = await world();
    await updateProviderSettings(
      makeWorkspaceContext({ workspaceId: w.workspaceId, userId: w.ownerId, role: 'owner' }),
      { aiProvider: 'anthropic', aiModel: 'claude-haiku-4-5' },
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify(reply), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    return w;
  }

  const ANSWER = {
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: 'Open [/connectors] and set the country.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 100 },
  };

  async function ledger(workspaceId: bigint) {
    const usage = await db.select().from(usageLog).where(eq(usageLog.workspaceId, workspaceId));
    const tx = await db
      .select()
      .from(tokenTransactions)
      .where(eq(tokenTransactions.workspaceId, workspaceId));
    return { usage, tx };
  }

  it("an owner's question is metered and debited (control)", async () => {
    const w = await anthropicWorld(ANSWER);
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'active' });
    const res = await ask('why no leads?');
    expect(res.status).toBe(200);
    const { usage, tx } = await ledger(w.workspaceId);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.kind).toBe('ai.assistant');
    expect(usage[0]!.payload).not.toHaveProperty('support');
    expect(tx).toHaveLength(1);
  });

  it("a super-admin's god-mode question is logged with payload.support=true and never debited", async () => {
    const w = await anthropicWorld(ANSWER);
    const admin = await seedUser({ email: 'support@platform.local', role: 'super_admin' });
    await db.update(users).set({ activeWorkspaceId: w.workspaceId }).where(eq(users.id, admin));
    signIn({ id: admin, role: 'super_admin', accountStatus: 'active' });

    const res = await ask('why is nothing sending?');
    expect(res.status).toBe(200);
    expect((await res.json()).answer).toContain('[/connectors]');

    const { usage, tx } = await ledger(w.workspaceId);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.kind).toBe('ai.assistant');
    expect(usage[0]!.payload).toMatchObject({ support: true, keySource: 'platform' });
    expect(usage[0]!.costEstimateCents).toBeGreaterThan(0); // the platform's cost is still recorded
    expect(tx).toHaveLength(0);
    const [wallet] = await db
      .select({ balance: workspaces.tokenBalance })
      .from(workspaces)
      .where(eq(workspaces.id, w.workspaceId));
    expect(wallet!.balance).toBe(500n);

    // The tenant's own usage views leave support rows out.
    const tenantCtx = { workspaceId: w.workspaceId };
    expect(await summarizeUsage(tenantCtx)).toEqual([]);
    expect(await summarizeUsageByKeySource(tenantCtx)).toEqual([]);
  });

  it('a super-admin asking in a tenant with an EMPTY wallet still gets the model, as support, and nothing is debited', async () => {
    const w = await anthropicWorld(ANSWER);
    await db.update(workspaces).set({ tokenBalance: 0n }).where(eq(workspaces.id, w.workspaceId));
    const admin = await seedUser({ email: 'support2@platform.local', role: 'super_admin' });
    await db.update(users).set({ activeWorkspaceId: w.workspaceId }).where(eq(users.id, admin));
    signIn({ id: admin, role: 'super_admin', accountStatus: 'active' });

    const res = await ask('why is nothing sending?');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('ai'); // not the "buy tokens" checklist
    expect(body.answer).toContain('[/connectors]');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const { usage, tx } = await ledger(w.workspaceId);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.payload).toMatchObject({ support: true });
    expect(tx).toHaveLength(0);
    const [wallet] = await db
      .select({ balance: workspaces.tokenBalance })
      .from(workspaces)
      .where(eq(workspaces.id, w.workspaceId));
    expect(wallet!.balance).toBe(0n);
  });

  it('a thinking-only answer is a 502 that is logged but never billed', async () => {
    const w = await anthropicWorld({
      model: 'claude-haiku-4-5',
      content: [{ type: 'thinking', thinking: '' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1000, output_tokens: 1500 },
    });
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'active' });
    const res = await ask('why no leads?');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('empty_answer');
    const { usage, tx } = await ledger(w.workspaceId);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.payload).toMatchObject({ unbilled: 'empty_output' });
    expect(tx).toHaveLength(0);
  });

  it('a blank end_turn answer is also never billed', async () => {
    const w = await anthropicWorld({ ...ANSWER, content: [{ type: 'text', text: '  ' }] });
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'active' });
    const res = await ask('why no leads?');
    expect(res.status).toBe(502);
    const { usage, tx } = await ledger(w.workspaceId);
    expect(usage[0]!.payload).toMatchObject({ unbilled: 'empty_output' });
    expect(tx).toHaveLength(0);
  });

  it('a refusal returns the deterministic answer and is never billed', async () => {
    const w = await anthropicWorld({
      ...ANSWER,
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: null },
    });
    signIn({ id: w.ownerId, role: 'member', accountStatus: 'active' });
    const res = await ask('something odd');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('deterministic');
    expect(body.answer).toMatch(/^I can't answer that one/);
    const { usage, tx } = await ledger(w.workspaceId);
    expect(usage[0]!.payload).toMatchObject({ unbilled: 'refusal' });
    expect(tx).toHaveLength(0);
  });
});
