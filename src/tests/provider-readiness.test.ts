// Settings → AI & search must say truthfully whether each job will run, and
// on whose key (getProviderReadiness, src/lib/services/provider-readiness.ts).
//
// The incident (26 Nov): a Simple-setup tenant saw every vendor as "not
// configured" because the page only asked the server env for a platform
// key, while the platform's keys live in the admin console — and the
// runtime uses them. The first case below is that workspace as prod has it.
//
// Every row is checked against the factory the runtime calls, so a change
// to a cascade that readiness does not follow fails here. Fixtures go
// straight into the tables; no vendor is ever called (the factories only
// resolve keys, they do not connect).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import { db } from '@/lib/db/client';
import { usageLog } from '@/lib/db/schema/audit';
import { connectorRecipes } from '@/lib/db/schema/connectors';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { mailMessages } from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { indexingJobs } from '@/lib/db/schema/rag';
import { platformSettings } from '@/lib/db/schema/platform-settings';
import { reviewItems } from '@/lib/db/schema/review';
import { platformSecrets, workspaceSecrets } from '@/lib/db/schema/secrets';
import { workspaceProviderSettings, workspaces } from '@/lib/db/schema/workspaces';
import {
  _setAIProviderForTests,
  getAIProviderById,
  getAIProviderForCtx,
  getQualificationProviderForCtx,
} from '@/lib/ai';
import { getWorkspaceDiagnostics } from '@/lib/diagnostics/engine';
import {
  EMBEDDING_DIM,
  _setEmbeddingProviderForTests,
  getEmbeddingProviderForCtx,
} from '@/lib/embeddings';
import { MockMailProvider } from '@/lib/mail';
import { getOcrProviderForCtx } from '@/lib/ocr';
import { PLATFORM_PROVIDER_KEYS } from '@/lib/platform-provider-keys';
import { _setSearchProviderForTests } from '@/lib/search';
import { getWebSearchProviderForCtx } from '@/lib/search/web-search';
import {
  MockResearchProvider,
  _setResearchProviderForTests,
  getResearchProviderForCtx,
} from '@/lib/research';
import { InMemoryJobQueue, _setJobQueueForTests, getJobQueue } from '@/lib/jobs';
import { registerJobHandlers } from '@/lib/jobs/bootstrap';
import { LocalFileStorage, _setStorageForTests } from '@/lib/storage';
import { _setVectorStorageProviderForTests, getVectorStorageProviderForCtx } from '@/lib/vector-storage';
import { askAssistant } from '@/lib/services/assistant';
import { resolveAutomationPolicy, tickVerdict } from '@/lib/services/automation-policy';
import {
  assertCanStartRun,
  createConnector,
  createRecipe,
  startRun,
  updateRecipe,
} from '@/lib/services/connector-run';
import { encryptValue } from '@/lib/services/crypto';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { uploadDocument } from '@/lib/services/documents';
import { approveFollowUp } from '@/lib/services/follow-up';
import { TOKENS_DEFER_MS } from '@/lib/services/knowledge-indexing';
import { createKnowledgeSource } from '@/lib/services/knowledge-sources';
import { researchLead } from '@/lib/services/lead-research';
import { sendMessage } from '@/lib/services/mail';
import { generateOutreachDraft } from '@/lib/services/outreach';
import { drainQueue } from '@/lib/services/outreach-queue';
import { getStageProvider } from '@/lib/services/outreach-stage-models';
import { ensureQualifiedLead, setOutreachLanguage } from '@/lib/services/pipeline';
import { suggestStageAngle } from '@/lib/services/product-angle-suggester';
import { createProductProfile } from '@/lib/services/product-profile';
import { resolveProviderKey } from '@/lib/services/secrets';
import { TokenError, debitTokens } from '@/lib/services/token-ledger';
import { recordUsage } from '@/lib/services/usage';
import { buildHandbookSource } from '@/lib/assistant/handbook';
import {
  getProviderReadiness,
  type JobId,
  type JobReadiness,
  type ProviderReadiness,
} from '@/lib/services/provider-readiness';
import {
  KeySourceLine,
  NoKeyNote,
  ProviderReadinessPanel,
} from '@/components/ProviderReadinessPanel';
import EditProductPage from '@/app/(app)/products/[id]/page';
import BillingPage from '@/app/(app)/settings/billing/page';
import IntegrationsPage from '@/app/(app)/settings/integrations/page';
import { translateDraftAction } from '@/app/(app)/drafts/[id]/actions';
import { translateComposeAction } from '@/app/(app)/mailbox/[id]/compose/actions';
import { POST as redesignSignaturePOST } from '@/app/api/signatures/redesign/route';
import { POST as translatePOST } from '@/app/api/translate/route';
import { expectRedirect, renderToHtml } from './helpers/next-render';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { runQueuedIndexJobs } from './helpers/knowledge';
import { queueCtx, queuedDraft, setupQueueWorkspace } from './helpers/outreach-fixtures';
import { claimHeaders, claimedForm } from './helpers/workspace-guard';

// The settings page signs in through a plain session object instead of
// Auth.js; getWorkspaceContext() stays real.
const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));

// ---- env hygiene ----------------------------------------------------------

const ENV_KEYS = [
  'AI_PROVIDER',
  'AI_MODEL',
  'SEARCH_PROVIDER',
  'RESEARCH_PROVIDER',
  'RESEARCH_MODEL',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_MODEL',
  'VECTOR_STORAGE_PROVIDER',
  'MISTRAL_OCR_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'SERPAPI_KEY',
  'PERPLEXITY_API_KEY',
] as const;
let savedEnv: Record<string, string | undefined> = {};

function clearInjectedProviders(): void {
  _setAIProviderForTests(null);
  _setEmbeddingProviderForTests(null);
  _setSearchProviderForTests(null);
  _setResearchProviderForTests(null);
  _setVectorStorageProviderForTests(null);
}

beforeEach(async () => {
  await truncateAll();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  clearInjectedProviders();
  session.current = null;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  clearInjectedProviders();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- fixtures -------------------------------------------------------------

async function tenant(
  opts: {
    balance?: bigint;
    billingExempt?: boolean;
    setupMode?: 'simple' | 'advanced';
    plan?: 'starter' | 'pro';
  } = {},
): Promise<WorkspaceContext> {
  const owner = await seedUser({ email: 'tenant@test.local' });
  const workspaceId = await seedWorkspace({ name: 'Tenant', ownerUserId: owner });
  await db
    .update(workspaces)
    .set({
      setupMode: opts.setupMode ?? 'simple',
      tokenBalance: opts.balance ?? 1598n,
      billingExempt: opts.billingExempt ?? false,
      ...(opts.plan ? { plan: opts.plan, subscriptionStatus: 'active' } : {}),
    })
    .where(eq(workspaces.id, workspaceId));
  return makeWorkspaceContext({ workspaceId, userId: owner, role: 'owner' });
}

async function setBalance(ctx: Pick<WorkspaceContext, 'workspaceId'>, balance: bigint): Promise<void> {
  await db.update(workspaces).set({ tokenBalance: balance }).where(eq(workspaces.id, ctx.workspaceId));
}

async function consoleKey(key: string, value = `console-${key}`): Promise<void> {
  await db.insert(platformSecrets).values({
    key,
    encryptedValue: encryptValue(value),
    scope: key.split('.')[0]!,
  });
}

async function dropConsoleKey(key: string): Promise<void> {
  await db.delete(platformSecrets).where(eq(platformSecrets.key, key));
}

async function byokKey(workspaceId: bigint, key: string, value = `byok-${key}`): Promise<void> {
  await db.insert(workspaceSecrets).values({
    workspaceId,
    key,
    encryptedValue: encryptValue(value),
    scope: key.split('.')[0]!,
  });
}

async function consoleSetting(key: string, value: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

/** Prod as of 26 Nov: no provider key in the server env, every key saved in
 *  the admin console, the console's defaults for qualification and search,
 *  and the env selectors for AI and embeddings. */
async function prodPlatform(): Promise<void> {
  process.env.AI_PROVIDER = 'anthropic';
  process.env.SEARCH_PROVIDER = 'serpapi';
  process.env.EMBEDDING_PROVIDER = 'openai';
  for (const k of [
    'anthropic.apiKey',
    'openai.apiKey',
    'gemini.apiKey',
    'deepseek.apiKey',
    'mistral.apiKey',
    'serpapi.apiKey',
  ]) {
    await consoleKey(k);
  }
  await consoleSetting('ai.model', 'claude-sonnet-5');
  await consoleSetting('qualification.provider', 'anthropic');
  await consoleSetting('qualification.model', 'claude-opus-5');
  await consoleSetting('search.provider', 'serpapi');
}

const jobOf = (jobs: JobReadiness[], id: JobId) => {
  const j = jobs.find((x) => x.job === id);
  if (!j) throw new Error(`no ${id} row`);
  return j;
};

const clean = (html: string) => html.replaceAll('<!-- -->', '');

/** The panel's alerts, in order, by tone (Alert renders role + data-tone;
 *  the row badges carry a data-tone of their own, without the role). */
const alertTones = (html: string) =>
  [...html.matchAll(/role="(?:alert|status)" data-tone="([a-z]+)"/g)].map((m) => m[1]);

/** One job's row in the rendered panel. */
function rowHtml(html: string, job: JobId): string {
  const m = new RegExp(`<li[^>]*data-job="${job}"[\\s\\S]*?</li>`).exec(html);
  if (!m) throw new Error(`no ${job} row in the panel`);
  return m[0];
}

async function panel(
  r: ProviderReadiness,
  who: { simple?: boolean; isAdmin?: boolean; byokAllowed?: boolean } = {},
): Promise<string> {
  return clean(
    await renderToHtml(
      ProviderReadinessPanel({
        readiness: r,
        simple: who.simple ?? true,
        isAdmin: who.isAdmin ?? true,
        byokAllowed: who.byokAllowed ?? true,
      }),
    ),
  );
}

/** A qualified lead, made by one mock discovery run while the workspace
 *  still has tokens and no provider keys (so nothing real is called). */
async function seedLead(ctx: WorkspaceContext) {
  const product = await createProductProfile(ctx, { name: 'Test Product' });
  const conn = await createConnector(ctx, { templateType: 'mock', name: 'Mock', config: {} });
  const recipe = await createRecipe(ctx, {
    connectorId: conn.id,
    name: 'r',
    selectors: { seed: 'readiness', count: 1 },
  });
  await startRun(ctx, { connectorId: conn.id, recipeId: recipe.id, wait: true });
  const [item] = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, ctx.workspaceId));
  const lead = await ensureQualifiedLead(ctx, item!.id, product.id);
  return { product, item: item!, lead };
}

async function balanceOf(ctx: Pick<WorkspaceContext, 'workspaceId'>): Promise<bigint> {
  const [w] = await db
    .select({ tokenBalance: workspaces.tokenBalance })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId));
  return w!.tokenBalance;
}

/** A grounded Gemini answer, so the real adapter runs without calling Google. */
function stubGeminiFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'They buy pumps.' }] },
              groundingMetadata: { webSearchQueries: ['who buys'] },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
}

/**
 * The Anthropic Messages API answered locally, so the real adapter runs —
 * metered, and debited when it runs on the platform key — without calling
 * Anthropic. A translation comes back tagged with its target language
 * ("[DE] …", as handbook-claims' H-22 stub does), a signature redesign as
 * plain HTML, anything else as a line of text.
 */
function stubAnthropicFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = url instanceof Request ? url.url : String(url);
      if (!href.endsWith('/v1/messages')) throw new Error(`unexpected fetch in test: ${href}`);
      const req = JSON.parse(String(init?.body)) as {
        system?: string;
        messages: Array<{ content: string }>;
      };
      const system = req.system ?? '';
      const prompt = req.messages[0]!.content;
      const lang = /natural .+ \(([a-z]{2})\)/.exec(system)?.[1];
      const text = lang
        ? JSON.stringify({
            translatedText: `[${lang.toUpperCase()}] ${prompt}`,
            detectedLanguage: 'en',
            isSameLanguage: false,
          })
        : /email signature designer/.test(system)
          ? JSON.stringify({
              bodyHtml: '<table><tr><td><strong>Anna Nowak</strong> · Acme</td></tr></table>',
            })
          : 'Lead with what a failed repair costs them.';
      return new Response(
        JSON.stringify({
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
}

/**
 * The OpenAI embeddings API answered locally, so the real metered adapter
 * runs without calling OpenAI. It reports 10M input tokens a call — an
 * upload large enough that Math.round leaves real cents to debit.
 */
function stubOpenAIEmbeddingsFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = url instanceof Request ? url.url : String(url);
      if (!href.endsWith('/v1/embeddings')) throw new Error(`unexpected fetch in test: ${href}`);
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          model: 'text-embedding-3-small',
          data: input.map((_, index) => ({
            index,
            embedding: Array.from({ length: EMBEDDING_DIM }, (_v, i) => (i === index ? 1 : 0)),
          })),
          usage: { prompt_tokens: 10_000_000, total_tokens: 10_000_000 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
}

/**
 * An empty, non-exempt wallet, with all AI writing on the platform's
 * Anthropic key kept in the server env — usage the page says is debited.
 * Returns the readiness the page would render.
 */
async function emptyWalletOnPlatformAnthropic(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<ProviderReadiness> {
  process.env.AI_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'env-anthropic';
  _setAIProviderForTests(null);
  await setBalance(ctx, 0n);
  stubAnthropicFetch();
  return getProviderReadiness(ctx);
}

/** Server actions and routes resolve the workspace from the session. */
function signIn(userId: string | bigint): void {
  session.current = { user: { id: userId.toString(), role: 'member', accountStatus: 'active' } };
}

/** The qualified lead queuedDraft made for a review item. */
async function leadFor(reviewItemId: bigint) {
  const [lead] = await db
    .select()
    .from(qualifiedLeads)
    .where(eq(qualifiedLeads.reviewItemId, reviewItemId));
  return lead!;
}

/** The first function-valued `prop` on any element of a server component's
 *  tree (a server action handed to a client component). */
function propOf<T>(node: ReactNode, prop: string): T {
  const found = (n: ReactNode): T | null => {
    if (Array.isArray(n)) {
      for (const c of n) {
        const f = found(c);
        if (f) return f;
      }
      return null;
    }
    if (!isValidElement(n)) return null;
    const props = (n as ReactElement<Record<string, unknown>>).props;
    if (typeof props[prop] === 'function') return props[prop] as T;
    return found(props.children as ReactNode);
  };
  const f = found(node);
  if (!f) throw new Error(`no ${prop} in the tree`);
  return f;
}

/** The web-search provider id without the grounding adapter's prefix. */
async function runtimeDiscoveryVendor(ctx: WorkspaceContext): Promise<string> {
  return (await getWebSearchProviderForCtx(ctx)).id.replace(/^research:/, '');
}

// ---- the incident ----------------------------------------------------------

describe('a Simple workspace on the console keys (the 26 Nov report)', () => {
  it('every job runs on the platform key — none reads "not configured"', async () => {
    await prodPlatform();
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);

    expect(r.allReady).toBe(true);
    expect(jobOf(r.jobs, 'discovery')).toMatchObject({
      vendor: 'serpapi',
      key: 'platform',
      state: 'ready',
      billedFromTokens: true,
    });
    expect(jobOf(r.jobs, 'qualification')).toMatchObject({
      vendor: 'anthropic',
      model: 'claude-opus-5',
      key: 'platform',
      state: 'ready',
    });
    // Outreach goes through the stage tiers, not the AI default.
    expect(jobOf(r.jobs, 'first_emails')).toMatchObject({
      vendor: 'openai',
      model: 'gpt-5-nano',
      key: 'platform',
      state: 'ready',
    });
    expect(jobOf(r.jobs, 'replies')).toMatchObject({
      vendor: 'anthropic',
      model: 'claude-opus-4-7',
      key: 'platform',
      state: 'ready',
    });
    expect(jobOf(r.jobs, 'drafting')).toMatchObject({
      vendor: 'anthropic',
      model: 'claude-sonnet-5',
      key: 'platform',
      state: 'ready',
    });
    // Retrieval is never debited (its query embedding rounds to 0 cents;
    // the OpenAI vector store's query usage is not recorded), so the page
    // must not promise token billing for it.
    expect(jobOf(r.jobs, 'knowledge')).toMatchObject({
      vendor: 'openai',
      key: 'platform',
      state: 'ready',
      billedFromTokens: false,
    });
    // Research auto-detects the console's Gemini key.
    expect(jobOf(r.jobs, 'research')).toMatchObject({
      vendor: 'gemini',
      key: 'platform',
      state: 'ready',
    });
    expect(jobOf(r.jobs, 'ocr')).toMatchObject({ vendor: 'mistral', key: 'platform', state: 'ready' });
    const anthropic = r.vendors.find((v) => v.vendor === 'anthropic')!;
    expect(anthropic).toMatchObject({ workspaceKey: false, platformKey: true, effective: 'platform' });
    // A vendor the platform has no key for is still reported as such.
    const perplexity = r.vendors.find((v) => v.vendor === 'perplexity')!;
    expect(perplexity.effective).toBe('none');
  });

  it('agrees with the runtime: every factory runs on the vendor and key the page names', async () => {
    await prodPlatform();
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    // Each would throw "no key configured (workspace or platform)" if the
    // console key were not the one the runtime uses.
    expect((await getAIProviderForCtx(ctx)).id).toBe(jobOf(r.jobs, 'drafting').vendor);
    expect((await getQualificationProviderForCtx(ctx)).id).toBe(
      jobOf(r.jobs, 'qualification').vendor,
    );
    await expect(getEmbeddingProviderForCtx(ctx)).resolves.toBeDefined();
    expect((await getVectorStorageProviderForCtx(ctx)).id).toBe('pgvector');
    expect(await runtimeDiscoveryVendor(ctx)).toBe(jobOf(r.jobs, 'discovery').vendor);
    expect((await resolveProviderKey(ctx, 'serpapi.apiKey', 'SERPAPI_KEY'))?.source).toBe(
      'platform',
    );
    expect((await getResearchProviderForCtx(ctx)).id).toBe(jobOf(r.jobs, 'research').vendor);
    expect((await getOcrProviderForCtx(ctx))?.keySource).toBe('platform');

    const first = await getStageProvider(ctx, 'discovery');
    expect({ vendor: first.provider.id, model: first.model }).toEqual({
      vendor: jobOf(r.jobs, 'first_emails').vendor,
      model: jobOf(r.jobs, 'first_emails').model,
    });
    const pitch = await getStageProvider(ctx, 'pitch');
    expect({ vendor: pitch.provider.id, model: pitch.model }).toEqual({
      vendor: jobOf(r.jobs, 'replies').vendor,
      model: jobOf(r.jobs, 'replies').model,
    });
  });

  it('the panel tells the tenant the platform provides the key and tokens pay for it', async () => {
    await prodPlatform();
    const ctx = await tenant();
    const html = await panel(await getProviderReadiness(ctx));
    expect(html).toContain('Everything is ready to run');
    expect(html).toContain('Runs on Leadsonar&#x27;s Anthropic (Claude) key');
    expect(html).toContain('1,598 tokens left');
    expect(html).not.toMatch(/not configured/i);
    // Knowledge retrieval is not debited: its row promises no billing.
    expect(rowHtml(html, 'knowledge')).not.toContain('token balance');
  });

  it('the admin console catalogue describes what a vendor can do, never which is the default', () => {
    // Which vendor runs a job depends on console and env settings; the
    // catalogue text "the default AI provider" contradicted the job rows.
    for (const spec of PLATFORM_PROVIDER_KEYS) {
      expect(spec.role, spec.vendor).not.toMatch(/default|optional|alternative/i);
    }
  });
});

// ---- outreach tiers ----------------------------------------------------------

describe('first emails and replies follow the outreach stage tiers', () => {
  it('without an OpenAI key, first emails fall back to the default AI provider and its model', async () => {
    await prodPlatform();
    await dropConsoleKey('openai.apiKey');
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'first_emails')).toMatchObject({
      vendor: 'anthropic',
      model: 'claude-sonnet-5',
      key: 'platform',
    });
    const first = await getStageProvider(ctx, 'discovery');
    expect(first.provider.id).toBe('anthropic');
    // '' = the provider's own (workspace-default) model.
    expect(first.model).toBe('');
  });

  it('the workspace key is reported per tier: own Anthropic key, platform OpenAI key', async () => {
    await prodPlatform();
    const ctx = await tenant();
    await byokKey(ctx.workspaceId, 'anthropic.apiKey');
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'replies')).toMatchObject({ key: 'workspace', billedFromTokens: false });
    expect(jobOf(r.jobs, 'first_emails')).toMatchObject({ key: 'platform', billedFromTokens: true });
    const html = await panel(r, { simple: false });
    expect(rowHtml(html, 'replies')).toContain('Runs on your own Anthropic (Claude) key');
    expect(rowHtml(html, 'first_emails')).toContain('Usage is paid from your token balance');
  });

  it('DeepSeek drafting shows its built-in model, never the AI_MODEL meant for another vendor', async () => {
    process.env.AI_PROVIDER = 'deepseek';
    process.env.AI_MODEL = 'claude-sonnet-5';
    await consoleKey('deepseek.apiKey');
    const ctx = await tenant();
    expect(jobOf((await getProviderReadiness(ctx)).jobs, 'drafting')).toMatchObject({
      vendor: 'deepseek',
      model: null,
    });
  });
});

// ---- discovery ----------------------------------------------------------------

describe('discovery agrees with getWebSearchProviderForCtx', () => {
  it('the safety net: no search provider and a Gemini key → grounded Gemini', async () => {
    await consoleKey('gemini.apiKey');
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'discovery')).toMatchObject({
      vendor: 'gemini',
      key: 'platform',
      state: 'ready',
    });
    expect(await runtimeDiscoveryVendor(ctx)).toBe('gemini');
    expect(r.discoveryChoice).toEqual({ id: 'gemini', source: 'default' });
    expect(r.discoveryPlatformDefault).toBe('gemini');
  });

  it('grounded search on a console key is paid from tokens, and the adapter logs it as the platform\'s', async () => {
    // Until 27 Nov the grounding adapter compared its key with the env
    // var: a console key was logged as the workspace's own and never
    // debited, and this row promised no billing to match. The factory now
    // hands the adapter resolveProviderKey's source.
    await consoleKey('gemini.apiKey');
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'discovery')).toMatchObject({
      key: 'platform',
      platformKeyDebited: true,
      billedFromTokens: true,
    });
    const html = await panel(r);
    expect(rowHtml(html, 'discovery')).toContain('Runs on Leadsonar&#x27;s Google Gemini key');
    expect(rowHtml(html, 'discovery')).toContain('Usage is paid from your token balance');
    const line = clean(
      await renderToHtml(
        KeySourceLine({ vendor: 'gemini', readiness: r, isAdmin: true, byokAllowed: true }),
      ),
    );
    // Every job on the key is debited (Gemini also writes, as the
    // auto-detected AI provider): no exception to name.
    expect(line).toContain('Leadsonar provides the key; usage is paid from your token balance.');
    expect(line).not.toContain('not charged');
    // The runtime agrees: the safety net's adapter reports the console key
    // as the platform's, so the connector's usage row is debited.
    stubGeminiFetch();
    try {
      const outcome = await (await getWebSearchProviderForCtx(ctx)).search(ctx, 'pump buyers');
      expect(outcome.usage.keySource).toBe('platform');
      // The workspace's own key — even one holding the platform key's very
      // value — is the workspace's: never debited.
      await byokKey(ctx.workspaceId, 'gemini.apiKey', 'console-gemini.apiKey');
      const own = await (await getWebSearchProviderForCtx(ctx)).search(ctx, 'pump buyers');
      expect(own.usage.keySource).toBe('workspace');
      expect(jobOf((await getProviderReadiness(ctx)).jobs, 'discovery')).toMatchObject({
        key: 'workspace',
        billedFromTokens: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('follows the workspace grounding choice only when its key exists', async () => {
    await prodPlatform();
    const ctx = await tenant();
    await db.insert(workspaceProviderSettings).values({
      workspaceId: ctx.workspaceId,
      researchProvider: 'perplexity',
    });
    // No Perplexity key anywhere: the runtime falls back to plain search.
    expect(jobOf((await getProviderReadiness(ctx)).jobs, 'discovery').vendor).toBe('serpapi');
    expect(await runtimeDiscoveryVendor(ctx)).toBe('serpapi');
    await consoleKey('perplexity.apiKey');
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'discovery')).toMatchObject({
      vendor: 'perplexity',
      key: 'platform',
      state: 'ready',
    });
    expect(await runtimeDiscoveryVendor(ctx)).toBe('perplexity');
    expect(r.discoveryChoice).toEqual({ id: 'perplexity', source: 'workspace' });
    // Without the choice the platform tier would run SerpAPI.
    expect(r.discoveryPlatformDefault).toBe('serpapi');
  });
});

// ---- keys -------------------------------------------------------------------------

describe('where a key comes from', () => {
  it('a platform key kept only in the server env counts as the platform key', async () => {
    process.env.AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-env-only';
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    expect(r.vendors.find((v) => v.vendor === 'anthropic')).toMatchObject({
      workspaceKey: false,
      platformKey: true,
      effective: 'platform',
    });
    expect(jobOf(r.jobs, 'drafting')).toMatchObject({ key: 'platform', state: 'ready' });
    await expect(getAIProviderForCtx(ctx)).resolves.toBeDefined();
  });

  it("the workspace's own key wins over the platform's, and says who bills it", async () => {
    await prodPlatform();
    const ctx = await tenant();
    await byokKey(ctx.workspaceId, 'anthropic.apiKey');
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'drafting')).toMatchObject({ key: 'workspace', state: 'ready' });
    // Discovery still runs on the platform's SerpAPI key.
    expect(jobOf(r.jobs, 'discovery').key).toBe('platform');
    const html = await panel(r, { simple: false });
    expect(html).toContain('Runs on your own Anthropic (Claude) key');
  });

  it('an own key no job runs on is "saved, but no job uses it" — never "is used"', async () => {
    // The finding's fixture: a Gemini key, no SEARCH_PROVIDER, and a saved
    // SerpAPI key with Web Search left on the platform default. Discovery
    // takes the Gemini safety net, so SerpAPI is never called.
    await consoleKey('gemini.apiKey');
    const ctx = await tenant({ setupMode: 'advanced', plan: 'pro' });
    await byokKey(ctx.workspaceId, 'serpapi.apiKey');
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'discovery').vendor).toBe('gemini');
    expect(await runtimeDiscoveryVendor(ctx)).toBe('gemini');
    const line = async (isAdmin: boolean, simple = false) =>
      clean(
        await renderToHtml(
          KeySourceLine({ vendor: 'serpapi', readiness: r, isAdmin, byokAllowed: true, simple }),
        ),
      );
    const admin = await line(true);
    expect(admin).toContain('own SerpAPI key is saved, but no job uses it now');
    expect(admin).toContain('Choosing SerpAPI in Active providers puts it to use.');
    expect(admin).not.toContain('key is used');
    expect(admin).not.toContain('bills your account');
    expect(await line(false)).toContain('A workspace admin can put it to use');
    expect(await line(true, true)).toContain('Switch to Advanced setup and choose SerpAPI');

    // Once discovery does run on it, the line says what uses it.
    await db.insert(workspaceProviderSettings).values({
      workspaceId: ctx.workspaceId,
      searchProvider: 'serpapi',
    });
    const used = clean(
      await renderToHtml(
        KeySourceLine({
          vendor: 'serpapi',
          readiness: await getProviderReadiness(ctx),
          isAdmin: true,
          byokAllowed: true,
        }),
      ),
    );
    expect(used).toContain('own SerpAPI key is used for Discovery; SerpAPI bills your account');
  });
});

// ---- the other answers -------------------------------------------------------

describe('what the page says when a job cannot run', () => {
  it('no key anywhere: "will not run", and the runtime agrees by throwing', async () => {
    process.env.AI_PROVIDER = 'anthropic';
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'drafting')).toMatchObject({
      vendor: 'anthropic',
      key: 'none',
      state: 'no_key',
    });
    expect(r.allReady).toBe(false);
    await expect(getAIProviderForCtx(ctx)).rejects.toThrow(/no key configured/);
    await expect(getStageProvider(ctx, 'discovery')).rejects.toThrow(/no key configured/);

    const html = await panel(r);
    expect(html).toContain('Will not run');
    expect(html).toContain('Leadsonar needs to set up an Anthropic (Claude) key');
    expect(html).toContain('href="/support"');
  });

  it('qualification without a key runs on keyword rules — degraded, not stopped', async () => {
    await prodPlatform();
    await dropConsoleKey('deepseek.apiKey');
    await consoleSetting('qualification.provider', 'deepseek');
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'qualification')).toMatchObject({
      vendor: 'deepseek',
      key: 'none',
      state: 'rules_only',
    });
    // The AI provider cannot be built; qualification.ts catches that and
    // scores with the rules engine (method 'rules_fallback').
    await expect(getQualificationProviderForCtx(ctx)).rejects.toThrow(/no key/i);
    const html = await panel(r);
    expect(html).toContain('Keyword rules only');
    expect(html).toContain('Qualification runs on keyword rules only');
    expect(html).not.toMatch(/will not run/i);
  });

  it('knowledge retrieval follows the vector-storage provider first', async () => {
    await prodPlatform();
    process.env.VECTOR_STORAGE_PROVIDER = 'mock';
    const ctx = await tenant();
    expect(jobOf((await getProviderReadiness(ctx)).jobs, 'knowledge')).toMatchObject({
      vendor: 'mock',
      state: 'not_set_up',
    });
    delete process.env.VECTOR_STORAGE_PROVIDER;
    await db.insert(workspaceProviderSettings).values({
      workspaceId: ctx.workspaceId,
      vectorStorageProvider: 'openai',
    });
    expect(jobOf((await getProviderReadiness(ctx)).jobs, 'knowledge')).toMatchObject({
      vendor: 'openai',
      model: null,
      key: 'platform',
      state: 'ready',
    });
    expect((await getVectorStorageProviderForCtx(ctx)).id).toBe('openai');
  });

  it('scanned PDFs need a Mistral key — the row says so and the runtime agrees', async () => {
    await prodPlatform();
    await dropConsoleKey('mistral.apiKey');
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'ocr')).toMatchObject({ vendor: 'mistral', key: 'none', state: 'no_key' });
    expect(await getOcrProviderForCtx(ctx)).toBeNull();
    expect(rowHtml(await panel(r), 'ocr')).toContain('scanned PDFs cannot be read');
  });

  it('a provider section without a key names the jobs it stops — or says it stops none', async () => {
    await prodPlatform();
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    // Perplexity: no key anywhere, and no job uses it.
    const unused = clean(
      await renderToHtml(
        NoKeyNote({ vendor: 'perplexity', readiness: r, isAdmin: true, byokAllowed: true }),
      ),
    );
    expect(unused).toContain('no job uses Perplexity now, so nothing is affected');
    expect(unused).not.toMatch(/not configured|will not run/i);
    // DS-09: the badge is the provider_key_gap signal, not a hand-toned one.
    expect(unused).toContain('data-signal="provider_key_gap" data-value="unused"');

    // Jobs that do run on a vendor with no key are named.
    await truncateAll();
    process.env.AI_PROVIDER = 'anthropic';
    const bare = await tenant();
    const bareReadiness = await getProviderReadiness(bare);
    const note = async (isAdmin: boolean, byokAllowed: boolean) =>
      clean(
        await renderToHtml(
          NoKeyNote({ vendor: 'anthropic', readiness: bareReadiness, isAdmin, byokAllowed }),
        ),
      );
    const admin = await note(true, true);
    expect(admin).toMatch(
      /First emails, Replies to leads, Follow-ups and other writing will not run until a key is added/,
    );
    expect(admin).toContain('data-signal="provider_key_gap" data-value="stops_jobs"');
    // No OpenAI key either, so the product angle suggester has no model.
    expect(admin).toContain('Without it, Suggest with AI on products will not work.');
    expect(admin).toContain('add a workspace key below');
    // Without BYOK on the plan, never send them to add their own key.
    const starter = await note(true, false);
    expect(starter).not.toContain('add a workspace key');
    expect(starter).toContain('your own keys need the Pro plan');
    expect(await note(false, true)).toContain('ask a workspace admin');
  });

  it('the remedy offers only what the reader can do', async () => {
    process.env.AI_PROVIDER = 'anthropic';
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    const advanced = (isAdmin: boolean, byokAllowed: boolean) =>
      panel(r, { simple: false, isAdmin, byokAllowed }).then((h) => rowHtml(h, 'drafting'));
    expect(await advanced(true, true)).toContain(
      'Add your own Anthropic (Claude) key in its section below, pick another provider',
    );
    const noByok = await advanced(true, false);
    expect(noByok).not.toContain('Add your own');
    expect(noByok).toContain('Your own keys need the Pro plan.');
    expect(await advanced(false, true)).toContain(
      'Ask a workspace admin to pick another provider or get an Anthropic (Claude) key.',
    );
  });

  it('a member is never told an admin can pick a provider where there is none to pick', async () => {
    // No Mistral key, and no real provider for discovery (the mock).
    await consoleKey('anthropic.apiKey');
    process.env.AI_PROVIDER = 'anthropic';
    const ctx = await tenant({ setupMode: 'advanced', plan: 'pro' });
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'ocr').state).toBe('no_key');
    expect(jobOf(r.jobs, 'discovery').state).toBe('not_set_up');
    const html = await panel(r, { simple: false, isAdmin: false, byokAllowed: true });
    // A missing key and a missing provider: the title names both reasons.
    expect(html).toMatch(/\d jobs will not run without a key or a provider/);
    // Reading scanned PDFs is always Mistral: no picker, no key section.
    const ocr = rowHtml(html, 'ocr');
    expect(ocr).toContain('Ask a workspace admin or <a href="/support">Leadsonar support</a> for a Mistral (OCR) key.');
    expect(ocr).not.toContain('pick another provider');
    // Not set up: there is no provider to replace — an admin picks one.
    const discovery = rowHtml(html, 'discovery');
    expect(discovery).toContain('Ask a workspace admin to pick a provider.');
    expect(discovery).not.toContain('get a provider for this job');
  });

  it('knowledge retrieval offers no "pick another provider": every option needs the OpenAI key', async () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    const ctx = await tenant({ setupMode: 'advanced' });
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'knowledge')).toMatchObject({ vendor: 'openai', state: 'no_key' });
    const row = async (isAdmin: boolean, byokAllowed: boolean) =>
      rowHtml(await panel(r, { simple: false, isAdmin, byokAllowed }), 'knowledge');
    const pro = await row(true, true);
    expect(pro).toContain('Add your own OpenAI key in its section below, or');
    expect(pro).not.toMatch(/pick another provider/i);
    const starter = await row(true, false);
    expect(starter).toContain('Leadsonar support</a> for a platform key. Your own keys need the Pro plan.');
    expect(starter).not.toMatch(/pick another provider/i);
    expect(await row(false, true)).not.toMatch(/pick another provider/i);
  });

  it('a vendor only Suggest with AI calls is never "not needed now"', async () => {
    // The finding's fixture: only a Gemini key. Replies and first emails
    // fall back to Gemini, so no job runs on Anthropic or OpenAI — but the
    // product angle suggester calls them directly, with no fallback.
    await consoleKey('gemini.apiKey');
    const ctx = await tenant({ setupMode: 'advanced', plan: 'pro' });
    let r = await getProviderReadiness(ctx);
    expect(r.jobs.filter((j) => j.vendor === 'anthropic' || j.vendor === 'openai')).toEqual([]);
    // The runtime agrees: the suggester's provider lookup finds no key.
    expect(await getAIProviderById(ctx, 'anthropic')).toBeNull();
    expect(await getAIProviderById(ctx, 'openai')).toBeNull();
    const note = async (vendor: string) =>
      clean(
        await renderToHtml(NoKeyNote({ vendor, readiness: r, isAdmin: true, byokAllowed: true })),
      );
    const anthropic = await note('anthropic');
    expect(anthropic).toContain('data-value="limits_jobs"');
    expect(anthropic).toContain('No key — limits a job');
    expect(anthropic).toContain('Suggest with AI on products will not work until a key is added');
    expect(anthropic).not.toContain('nothing is affected');

    // One of the two keys: the other model still works.
    await consoleKey('openai.apiKey');
    r = await getProviderReadiness(ctx);
    expect(await note('anthropic')).toContain(
      'Suggest with AI on products can still use GPT-5 but not Opus 4.7 until a key is added',
    );
  });

  it('a billing-exempt workspace runs with an empty wallet', async () => {
    await prodPlatform();
    const ctx = await tenant({ balance: 0n, billingExempt: true });
    const r = await getProviderReadiness(ctx);
    expect(r.allReady).toBe(true);
    const html = await panel(r);
    expect(alertTones(html)).toEqual(['success']);
    expect(html).not.toContain('token balance is empty');
  });

  // 27 Nov (Jacol: "Recs, but free sends"): every job checks the wallet.
  // Until then lead research, scanned PDFs, Suggest with AI, some
  // translation, the signature redesign and indexing ran on an empty
  // wallet and were debited below zero — and the page said so.
  it('an empty wallet pauses every job; only sending still translates, free', async () => {
    await prodPlatform();
    const ctx = await tenant({ balance: 0n });
    const r = await getProviderReadiness(ctx);
    expect(Object.fromEntries(r.jobs.map((j) => [j.job, j.state]))).toEqual({
      discovery: 'no_tokens',
      qualification: 'no_tokens',
      research: 'no_tokens',
      first_emails: 'no_tokens',
      replies: 'no_tokens',
      drafting: 'no_tokens',
      knowledge: 'no_tokens',
      ocr: 'no_tokens',
    });
    expect(r.jobs.every((j) => j.walletGated && j.gatedPart === null)).toBe(true);
    expect(r.features.every((f) => f.walletGated)).toBe(true);
    const html = await panel(r);
    // Every key is there: one alert, the wallet's, which may say so.
    expect(alertTones(html)).toEqual(['warning']);
    expect(html).toContain('Providers are ready, but the token balance is empty');
    expect(html).toContain('<a href="/settings/billing">Buy tokens</a>');
    expect(html).toContain(
      'Discovery, Qualification, Lead research, First emails, Replies to leads, Follow-ups and other writing, Knowledge retrieval, Reading scanned PDFs pause until tokens are added.',
    );
    // What still runs is sending's translation, which the platform pays
    // for: nothing on the page is "still deducted" any more.
    expect(html).toContain(
      'Translating a queued draft or an approved follow-up as it is sent still runs.',
    );
    expect(html).not.toContain('still deducted');
    expect(html).not.toContain('below zero');
    expect(html).not.toContain('Translate button');
    expect(rowHtml(html, 'drafting')).toContain(
      'the token balance is empty, so this job pauses until tokens are added. Still running: translating a queued draft or an approved follow-up as it is sent — Leadsonar pays for it, so nothing is deducted.',
    );
    for (const job of ['research', 'ocr', 'knowledge', 'replies'] as const) {
      expect(rowHtml(html, job)).toContain('so this job pauses until tokens are added.');
      expect(rowHtml(html, job)).not.toContain('Still running');
    }
  });

  it('a Gemini key kept only in the server env: lead research is paid from tokens, so it pauses on an empty wallet', async () => {
    // F1's first fixture. The adapter logs an env key as the platform's,
    // so recordUsage debits lead research — and on an empty wallet the
    // Research panel refuses, as the row says.
    process.env.GEMINI_API_KEY = 'env-gemini';
    const ctx = await tenant({ balance: 0n });
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'research')).toMatchObject({
      vendor: 'gemini',
      key: 'platform',
      state: 'no_tokens',
      platformKeyDebited: true,
      billedFromTokens: true,
      gatedPart: null,
    });
    // Discovery's safety net runs on the same key, and is debited too.
    expect(jobOf(r.jobs, 'discovery')).toMatchObject({
      vendor: 'gemini',
      state: 'no_tokens',
      billedFromTokens: true,
    });
    const row = rowHtml(await panel(r), 'research');
    expect(row).toContain(
      'Gemini key is ready, but the token balance is empty, so this job pauses until tokens are added.',
    );
    expect(row).not.toContain('still runs');
    // The Gemini key line promises billing for every job on it.
    const line = clean(
      await renderToHtml(
        KeySourceLine({ vendor: 'gemini', readiness: r, isAdmin: true, byokAllowed: true }),
      ),
    );
    expect(line).toContain('Leadsonar provides the key; usage is paid from your token balance.');
  });

  it('lead research without a key: the row names the key gap, and never that drafts are still written', async () => {
    process.env.RESEARCH_PROVIDER = 'gemini';
    process.env.AI_PROVIDER = 'anthropic';
    const ctx = await tenant({ balance: 0n });
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'research').state).toBe('no_key');
    const row = rowHtml(await panel(r), 'research');
    expect(row).toContain('so lead research fails; a draft skips the research rather than failing.');
    expect(row).not.toContain('still written');
  });

  it('grounded research debits exactly when the page says: a platform key yes (console or env), the workspace\'s own no', async () => {
    const ctx = await tenant();
    const { lead } = await seedLead(ctx);
    // A funded wallet: on an empty one the Research panel refuses (27 Nov).
    const start = await balanceOf(ctx);
    stubGeminiFetch();
    try {
      // A console key that is not the env var's value — prod's setup.
      // Until 27 Nov the adapter compared its key with the env var and
      // logged this one as the workspace's own: never debited.
      process.env.GEMINI_API_KEY = 'env-gemini';
      await consoleKey('gemini.apiKey', 'console-gemini');
      expect(jobOf((await getProviderReadiness(ctx)).jobs, 'research')).toMatchObject({
        key: 'platform',
        platformKeyDebited: true,
        billedFromTokens: true,
        state: 'ready',
      });
      await researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who buys?' });
      const afterConsole = await balanceOf(ctx);
      expect(afterConsole).toBeLessThan(start);

      // Only the env key: debited too.
      await dropConsoleKey('gemini.apiKey');
      expect(jobOf((await getProviderReadiness(ctx)).jobs, 'research')).toMatchObject({
        key: 'platform',
        billedFromTokens: true,
      });
      await researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who installs?' });
      const afterEnv = await balanceOf(ctx);
      expect(afterEnv).toBeLessThan(afterConsole);

      // The workspace's own key, even one holding the env var's very value
      // (which the old comparison logged as the platform's, debiting the
      // tenant for its own key): never debited, and the page says so.
      await byokKey(ctx.workspaceId, 'gemini.apiKey', 'env-gemini');
      expect(jobOf((await getProviderReadiness(ctx)).jobs, 'research')).toMatchObject({
        key: 'workspace',
        billedFromTokens: false,
      });
      await researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who sells?' });
      expect(await balanceOf(ctx)).toBe(afterEnv);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Perplexity research on a console key is debited too, and on the workspace\'s own key never', async () => {
    process.env.RESEARCH_PROVIDER = 'perplexity';
    process.env.PERPLEXITY_API_KEY = 'env-perplexity';
    const ctx = await tenant();
    const { lead } = await seedLead(ctx);
    const start = await balanceOf(ctx);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'They buy pumps.' } }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
            citations: ['https://pumps.example/buyers'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    try {
      await consoleKey('perplexity.apiKey', 'console-perplexity');
      expect(jobOf((await getProviderReadiness(ctx)).jobs, 'research')).toMatchObject({
        vendor: 'perplexity',
        key: 'platform',
        billedFromTokens: true,
      });
      const run = await researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who buys?' });
      expect(run.outcome?.usage.keySource).toBe('platform');
      const afterConsole = await balanceOf(ctx);
      expect(afterConsole).toBeLessThan(start);

      await byokKey(ctx.workspaceId, 'perplexity.apiKey', 'env-perplexity');
      expect(jobOf((await getProviderReadiness(ctx)).jobs, 'research')).toMatchObject({
        key: 'workspace',
        billedFromTokens: false,
      });
      const own = await researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who sells?' });
      expect(own.outcome?.usage.keySource).toBe('workspace');
      expect(await balanceOf(ctx)).toBe(afterConsole);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the wallet facts agree with the runtime: discovery, drafts and new research refuse; a cached answer loads', async () => {
    _setResearchProviderForTests(new MockResearchProvider());
    const ctx = await tenant();
    // A lead to research, made while the wallet still has tokens — and one
    // answer looked up then.
    const { product, item, lead } = await seedLead(ctx);
    await researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who buys?' });

    await setBalance(ctx, 0n);
    const r = await getProviderReadiness(ctx);
    const gated = (job: JobId) => jobOf(r.jobs, job).walletGated;
    // Gated: the entry point throws before any provider is called.
    expect(gated('discovery')).toBe(true);
    await expect(assertCanStartRun(ctx)).rejects.toBeInstanceOf(TokenError);
    expect(gated('first_emails')).toBe(true);
    await expect(
      generateOutreachDraft(ctx, { reviewItemId: item!.id, productProfileId: product.id }),
    ).rejects.toBeInstanceOf(TokenError);
    // Lead research is gated whole (27 Nov): a new question is refused, an
    // answer already looked up still loads — it costs nothing.
    expect(gated('research')).toBe(true);
    expect(jobOf(r.jobs, 'research').gatedPart).toBeNull();
    await expect(
      researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who installs?' }),
    ).rejects.toBeInstanceOf(TokenError);
    await expect(
      researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who buys?' }),
    ).resolves.toMatchObject({ cached: true });
    // Drafting is gated; only sending's translation runs on (the describe
    // below runs every entry point).
    expect(gated('drafting')).toBe(true);
    expect(jobOf(r.jobs, 'drafting').ungatedPart?.parts).toEqual([
      'translating a queued draft or an approved follow-up as it is sent',
    ]);
    expect(gated('ocr')).toBe(true);
  });

  it('no provider at all (the mock) is "not set up", not ready', async () => {
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'drafting')).toMatchObject({ vendor: 'mock', state: 'not_set_up' });
    expect(jobOf(r.jobs, 'discovery')).toMatchObject({ vendor: 'mock', state: 'not_set_up' });
  });
});

// ---- the alerts ---------------------------------------------------------------

// The panel used to render ONE alert, by priority: a missing Mistral key
// on an empty wallet read "1 job will not run — Reading scanned PDFs",
// with no word of the six jobs the wallet paused and no Buy tokens; and
// keyword-rules qualification on an empty wallet read "Providers are
// ready". Now a key or provider problem and the empty wallet each get
// their own alert, and each count says what it counts.
describe('the alerts: a key gap never hides the empty wallet', () => {
  it('no Mistral key on an empty wallet: the key alert counts the key gap, the wallet alert the pauses', async () => {
    await prodPlatform();
    await dropConsoleKey('mistral.apiKey');
    const ctx = await tenant({ balance: 0n });
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'ocr').state).toBe('no_key');
    expect(r.jobs.filter((j) => j.state === 'no_tokens')).toHaveLength(7);
    const html = await panel(r);
    expect(alertTones(html)).toEqual(['danger', 'warning']);
    // The key alert: one job, for a key reason — and it says it leaves the
    // paused jobs out of that count.
    expect(html).toContain('1 job will not run without a key');
    expect(html).toContain(
      'Reading scanned PDFs — see the reason on each row below. Not counted here: the 7 jobs paused because the token balance is empty.',
    );
    // The wallet alert, with its action, never "Providers are ready".
    expect(html).toContain('The token balance is empty');
    expect(html).not.toContain('Providers are ready');
    expect(html).toContain('<a href="/settings/billing">Buy tokens</a>');
    expect(html).toContain(
      'Discovery, Qualification, Lead research, First emails, Replies to leads, Follow-ups and other writing, Knowledge retrieval pause until tokens are added.',
    );
    expect(html).toContain(
      'Translating a queued draft or an approved follow-up as it is sent still runs.',
    );
    // A member gets the same alerts, without the purchase action.
    const member = await panel(r, { isAdmin: false });
    expect(alertTones(member)).toEqual(['danger', 'warning']);
    expect(member).not.toContain('Buy tokens');
  });

  it('keyword-rules qualification on an empty wallet: never "Providers are ready", and qualification pauses too', async () => {
    await prodPlatform();
    await dropConsoleKey('deepseek.apiKey');
    await consoleSetting('qualification.provider', 'deepseek');
    const ctx = await tenant({ balance: 0n });
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'qualification')).toMatchObject({ state: 'rules_only', walletGated: true });
    const html = await panel(r);
    expect(alertTones(html)).toEqual(['warning', 'warning']);
    // The key alert names the key gap — never that qualification "runs"
    // on keyword rules while the wallet alert says it pauses.
    expect(html).toContain('Qualification has no key for AI scoring');
    expect(html).toContain(
      'Qualification has no key, so it would score with keyword rules only — and the empty token balance pauses it too. See the row below.',
    );
    expect(html).not.toContain('runs on keyword rules only');
    expect(html).toContain('The token balance is empty');
    expect(html).not.toContain('Providers are ready');
    expect(html).toContain('<a href="/settings/billing">Buy tokens</a>');
    // Keyword-rules scoring runs inside a discovery run (or Re-classify
    // all), behind the same wallet gate: it is counted among the pauses.
    expect(html).toContain(
      'Discovery, Qualification, Lead research, First emails, Replies to leads, Follow-ups and other writing, Knowledge retrieval, Reading scanned PDFs pause until tokens are added.',
    );
    expect(rowHtml(html, 'qualification')).toContain(
      'The token balance is empty too, so this job pauses until tokens are added.',
    );
    // The runtime agrees: no discovery run (where scoring happens) starts.
    await expect(assertCanStartRun(ctx)).rejects.toBeInstanceOf(TokenError);

    // The same on the danger alert, when another job has no key either.
    await dropConsoleKey('mistral.apiKey');
    const both = await panel(await getProviderReadiness(ctx));
    expect(alertTones(both)).toEqual(['danger', 'warning']);
    expect(both).toContain(
      'Reading scanned PDFs — see the reason on each row below. Qualification has no key, so it would score with keyword rules only — and the empty token balance pauses it too. Not counted here: the 7 jobs paused because the token balance is empty.',
    );
    expect(both).not.toContain('runs on keyword rules only');
  });

  it('every job that checks the wallet lacks a key or a provider: the wallet alert names them, not "the jobs that use tokens"', async () => {
    // Every job checks the wallet (27 Nov), so this is the case where none
    // can run for want of a key or a provider: the wallet alert must not
    // say "the jobs that use tokens have no key" — it names them, and that
    // each pauses once it has one.
    process.env.SEARCH_PROVIDER = 'serpapi';
    process.env.AI_PROVIDER = 'mock';
    process.env.VECTOR_STORAGE_PROVIDER = 'mock';
    process.env.RESEARCH_PROVIDER = 'gemini';
    await consoleSetting('qualification.provider', 'mock');
    const ctx = await tenant({ balance: 0n });
    const r = await getProviderReadiness(ctx);
    expect(Object.fromEntries(r.jobs.map((j) => [j.job, j.state]))).toEqual({
      discovery: 'no_key',
      qualification: 'not_set_up',
      research: 'no_key',
      first_emails: 'not_set_up',
      replies: 'not_set_up',
      drafting: 'not_set_up',
      knowledge: 'not_set_up',
      ocr: 'no_key',
    });
    const html = await panel(r);
    expect(alertTones(html)).toEqual(['danger', 'warning']);
    expect(html).toContain('8 jobs will not run without a key or a provider');
    expect(html).toContain(
      'Discovery, Qualification, Lead research, First emails, Replies to leads, Follow-ups and other writing, Knowledge retrieval, Reading scanned PDFs need a key or a provider first (see their rows); once they have one, they pause until tokens are added.',
    );
    expect(html).not.toContain('still run');
    expect(html).not.toContain('The jobs that use tokens');
  });

  it('a key gap on a funded wallet: the key alert alone, nothing about tokens', async () => {
    await prodPlatform();
    await dropConsoleKey('mistral.apiKey');
    const ctx = await tenant();
    const html = await panel(await getProviderReadiness(ctx));
    expect(alertTones(html)).toEqual(['danger']);
    expect(html).toContain('1 job will not run without a key');
    expect(html).toContain('Reading scanned PDFs — see the reason on each row below.</p>');
    expect(html).not.toContain('Not counted here');
    expect(html).not.toContain('token balance is empty');
    expect(html).not.toContain('Buy tokens');
  });

  it('a key gap on a billing-exempt workspace with no tokens: no wallet alert', async () => {
    await prodPlatform();
    await dropConsoleKey('mistral.apiKey');
    const ctx = await tenant({ balance: 0n, billingExempt: true });
    const r = await getProviderReadiness(ctx);
    expect(r.wallet.empty).toBe(false);
    const html = await panel(r);
    expect(alertTones(html)).toEqual(['danger']);
    expect(html).not.toContain('Not counted here');
    expect(html).not.toContain('token balance is empty');
  });
});

// ---- an empty wallet, entry point by entry point ---------------------------------

// 27 Nov (Jacol: "Recs, but free sends"). Until then the drafting and
// knowledge rows' "Still running" named work whose entry points checked no
// wallet — Show translation on a draft and on a new email, a recipe's
// query translation, the signature redesign, Suggest with AI, indexing an
// upload — and it ran on an empty wallet, debited below zero. Now each is
// refused (or waits for tokens), and only sending still translates: free,
// never debited. Each entry point runs here on an empty, non-exempt wallet,
// on a platform key kept in the server env (Anthropic for the writing,
// OpenAI for indexing's embeddings) — keys whose usage IS debited, so a
// balance that stays at zero proves nothing was charged.
describe('on an empty wallet, what pauses is refused, and only sending still translates — free', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const NO_TOKENS = 'No tokens left — a workspace admin can buy a token pack in Settings → Billing.';
  const SEND_TRANSLATION = 'translating a queued draft or an approved follow-up as it is sent';

  /** How often the stubbed vendor API was called. */
  const vendorCalls = () => vi.mocked(globalThis.fetch).mock.calls.length;

  /** The drafting row as the page renders it: paused, with sending's
   *  translation as its only still-running part, paid by the platform. */
  async function emptyDraftingRow(ctx: Pick<WorkspaceContext, 'workspaceId'>) {
    const drafting = jobOf((await emptyWalletOnPlatformAnthropic(ctx)).jobs, 'drafting');
    expect(drafting).toMatchObject({ state: 'no_tokens', key: 'platform', billedFromTokens: true });
    expect(drafting.ungatedPart).toMatchObject({
      parts: [SEND_TRANSLATION],
      platformPaid: true,
      billedFromTokens: false,
      note: null,
    });
  }

  /** usage_log rows the platform pays for (payload.platformPaid). */
  async function platformPaidUsage(ctx: Pick<WorkspaceContext, 'workspaceId'>) {
    const rows = await db
      .select({ payload: usageLog.payload, cents: usageLog.costEstimateCents })
      .from(usageLog)
      .where(eq(usageLog.workspaceId, ctx.workspaceId));
    return rows.filter((r) => (r.payload as Record<string, unknown> | null)?.platformPaid === true);
  }

  const selectorsOf = (recipe: { selectors: unknown }) => recipe.selectors as Record<string, unknown>;

  it('a platform-paid usage row debits nothing; the same row without the tag does', async () => {
    const ctx = await tenant({ balance: 1000n });
    const row = { kind: 'ai.generate' as const, provider: 'anthropic', units: 1, costEstimateCents: 50 };
    await recordUsage(ctx, { ...row, payload: { keySource: 'platform', platformPaid: true } });
    expect(await balanceOf(ctx)).toBe(1000n);
    await recordUsage(ctx, { ...row, payload: { keySource: 'platform' } });
    expect(await balanceOf(ctx)).toBe(850n);
  });

  it('Show translation on a draft is refused: translateDraftAction → generateDraftTranslation', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const { draft: queued } = await queuedDraft(s, 'anna@target.com');
    await setOutreachLanguage(ctx, (await leadFor(queued.reviewItemId)).id, 'de');
    // A draft still under review (one active draft per lead and product):
    // the page offers Show translation on it.
    const [draft] = await db
      .update(outreachDrafts)
      .set({ status: 'draft' })
      .where(eq(outreachDrafts.id, queued.id))
      .returning();
    await emptyDraftingRow(ctx);

    signIn(s.ownerId);
    const to = await expectRedirect(() =>
      translateDraftAction(draft!.id.toString(), claimedForm(s.workspaceId)),
    );
    expect(new URL(to, 'http://flash.invalid').searchParams.get('error')).toBe(NO_TOKENS);
    const [after] = await db.select().from(outreachDrafts).where(eq(outreachDrafts.id, draft!.id));
    expect(after!.bodyTranslated).toBe(draft!.bodyTranslated);
    expect(after!.targetLanguage).toBe(draft!.targetLanguage);
    expect(vendorCalls()).toBe(0);
    expect(await balanceOf(ctx)).toBe(0n);
  });

  it('Show translation on a new email is refused: translateComposeAction', async () => {
    const ctx = await tenant();
    await emptyDraftingRow(ctx);
    signIn(ctx.userId);
    const r = await translateComposeAction({
      subject: 'Prices',
      body: 'Thanks for your reply — here are the prices.',
      targetLanguage: 'de',
      expectedWorkspaceId: ctx.workspaceId.toString(),
    });
    expect(r).toEqual({ ok: false, error: NO_TOKENS });
    expect(vendorCalls()).toBe(0);
    expect(await balanceOf(ctx)).toBe(0n);
  });

  it('Show translation on a reply or a follow-up awaiting approval: /api/translate answers 402', async () => {
    const ctx = await tenant();
    await emptyDraftingRow(ctx);
    signIn(ctx.userId);
    const res = await translatePOST(
      new Request('http://localhost/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...claimHeaders(ctx.workspaceId) },
        body: JSON.stringify({ subject: 'Re: prices', body: 'Here they are.', targetLanguage: 'de' }),
      }),
    );
    expect(res.status).toBe(402);
    expect(await balanceOf(ctx)).toBe(0n);
  });

  it('an approved follow-up is still translated as it is sent, and never debited: approveFollowUp', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const { draft: queued } = await queuedDraft(s, 'anna@target.com');
    const lead = await leadFor(queued.reviewItemId);
    await setOutreachLanguage(ctx, lead.id, 'de');
    const provider = new MockMailProvider();
    const first = await sendMessage(ctx, {
      mode: 'sequence',
      origin: 'manual',
      mailboxId: s.mailboxId,
      to: [{ address: 'anna@target.com' }],
      subject: 'Hi',
      text: 'x',
      providerOverride: provider,
    });
    const [step] = await db
      .insert(outreachFollowUps)
      .values({
        workspaceId: s.workspaceId,
        qualifiedLeadId: lead.id,
        threadId: first.threadId!,
        stepNumber: 1,
        totalSteps: 1,
        scheduledFor: new Date(),
        status: 'awaiting_approval',
        stagedSubject: 'Following up',
        stagedBody: 'Did you have a chance to look at our offer?',
      })
      .returning();
    await emptyDraftingRow(ctx);

    const approved = await approveFollowUp(ctx, step!.id, undefined, {
      mailProviderOverride: provider,
    });
    expect(approved.status).toBe('sent');
    expect(provider.sent.at(-1)!.message.text).toContain(
      '[DE] Did you have a chance to look at our offer?',
    );
    expect(vendorCalls()).toBeGreaterThan(0);
    expect(await balanceOf(ctx)).toBe(0n);
    // Logged at its real cost, for cost tracking — tagged as the platform's.
    const paid = await platformPaidUsage(ctx);
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((r) => (r.cents ?? 0) > 0)).toBe(true);
  });

  it('a queued draft is still translated as it is sent, and never debited — on a funded wallet too: drainQueue', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const { draft } = await queuedDraft(s, 'anna@target.com');
    await setOutreachLanguage(ctx, (await leadFor(draft.reviewItemId)).id, 'de');
    await emptyDraftingRow(ctx);

    // The background drain tick asks the 'sending' gate, without
    // spendsTokens: on an empty wallet it runs.
    expect(tickVerdict(await resolveAutomationPolicy(ctx), 'outreach.drain.tick')).toEqual({
      run: true,
    });
    // Free whatever the wallet holds: on a funded one nothing is taken either.
    await setBalance(ctx, 1000n);
    const r = await drainQueue(ctx, { providerOverride: new MockMailProvider() });
    expect(r.sent).toBe(1);
    const [msg] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceId));
    expect(msg!.targetLanguage).toBe('de');
    expect(msg!.bodyText).toContain(`[DE] ${draft.body}`);
    expect(await balanceOf(ctx)).toBe(1000n);
    expect((await platformPaidUsage(ctx)).length).toBeGreaterThan(0);
  });

  it('a search recipe saved on an empty wallet keeps its queries untranslated until its next run: createRecipe → startRun', async () => {
    const ctx = await tenant();
    const conn = await createConnector(ctx, { templateType: 'mock', name: 'Mock', config: {} });
    await emptyDraftingRow(ctx);

    const recipe = await createRecipe(ctx, {
      connectorId: conn.id,
      name: 'German buyers',
      searchQueries: ['concrete repair contractors'],
      selectors: { language: 'de', seed: 'pending', count: 1 },
    });
    expect(selectorsOf(recipe)).not.toHaveProperty('searchQueriesIssued');
    expect(selectorsOf(recipe).searchQueriesIssuedPending).toBe(true);
    expect(vendorCalls()).toBe(0);
    expect(await balanceOf(ctx)).toBe(0n);
    // No run starts on an empty wallet…
    await expect(startRun(ctx, { connectorId: conn.id, recipeId: recipe.id })).rejects.toBeInstanceOf(
      TokenError,
    );

    // …and after a top-up the run translates the queries first, for itself
    // and for every later run. (A fresh queue with no handlers leaves the
    // run itself pending: only its start is under test.)
    await setBalance(ctx, 1000n);
    registerJobHandlers();
    const previousQueue = getJobQueue();
    _setJobQueueForTests(new InMemoryJobQueue());
    try {
      const { run } = await startRun(ctx, { connectorId: conn.id, recipeId: recipe.id });
      expect((run.recipeSnapshot as Record<string, unknown>).searchQueriesIssued).toEqual([
        '[DE] concrete repair contractors',
      ]);
    } finally {
      _setJobQueueForTests(previousQueue);
    }
    const [row] = await db.select().from(connectorRecipes).where(eq(connectorRecipes.id, recipe.id));
    expect(selectorsOf(row!).searchQueriesIssued).toEqual(['[DE] concrete repair contractors']);
    expect(selectorsOf(row!)).not.toHaveProperty('searchQueriesIssuedPending');
    expect(await balanceOf(ctx)).toBeLessThan(1000n);
  });

  it("editing a recipe's queries on an empty wallet drops the stale translation and waits: updateRecipe", async () => {
    const ctx = await tenant();
    const conn = await createConnector(ctx, { templateType: 'mock', name: 'Mock', config: {} });
    await emptyDraftingRow(ctx);
    // Saved while the wallet had tokens: translated.
    await setBalance(ctx, 1000n);
    const recipe = await createRecipe(ctx, {
      connectorId: conn.id,
      name: 'Buyers',
      searchQueries: ['pump buyers'],
      selectors: { language: 'de' },
    });
    expect(selectorsOf(recipe).searchQueriesIssued).toEqual(['[DE] pump buyers']);

    await setBalance(ctx, 0n);
    const calls = vendorCalls();
    const updated = await updateRecipe(ctx, recipe.id, { searchQueries: ['valve buyers'] });
    expect(selectorsOf(updated)).not.toHaveProperty('searchQueriesIssued');
    expect(selectorsOf(updated).searchQueriesIssuedPending).toBe(true);
    expect(vendorCalls()).toBe(calls);
    expect(await balanceOf(ctx)).toBe(0n);
  });

  it('the signature redesign is refused with a 402: POST /api/signatures/redesign', async () => {
    const ctx = await tenant();
    await emptyDraftingRow(ctx);
    signIn(ctx.userId);
    const res = await redesignSignaturePOST(
      new Request('http://localhost/api/signatures/redesign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: 'Anna Nowak', company: 'Acme' }),
      }),
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'insufficient_tokens', detail: NO_TOKENS });
    expect(vendorCalls()).toBe(0);
    expect(await balanceOf(ctx)).toBe(0n);
  });

  it('Suggest with AI on products is refused: suggestStageAngle', async () => {
    const ctx = await tenant();
    const product = await createProductProfile(ctx, { name: 'Test Product' });
    const r = await emptyWalletOnPlatformAnthropic(ctx);
    const feature = r.features.find((f) => f.id === 'suggest_angles')!;
    expect(feature).toMatchObject({ walletGated: true, platformKeyDebited: true });
    expect(await panel(r)).not.toContain('Suggest with AI on products still');

    await expect(suggestStageAngle(ctx, product.id, 'discovery', 'anthropic')).rejects.toThrow(
      NO_TOKENS,
    );
    // The product page's button flashes the refusal, not "failed".
    signIn(ctx.userId);
    const tree = await EditProductPage({
      params: Promise.resolve({ id: product.id.toString() }),
      searchParams: Promise.resolve({}),
    });
    const suggest = propOf<(fd: FormData) => Promise<void>>(tree, 'suggesterAction');
    const form = new FormData();
    form.set('stage', 'discovery');
    form.set('vendor', 'anthropic');
    const to = await expectRedirect(() => suggest(form));
    expect(new URL(to, 'http://flash.invalid').searchParams.get('error')).toBe(NO_TOKENS);
    expect(vendorCalls()).toBe(0);
    expect(await balanceOf(ctx)).toBe(0n);
  });

  it('an upload waits to be indexed, and is indexed after a top-up: uploadDocument → the knowledge.index job', async () => {
    const ctx = await tenant();
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'env-openai';
    process.env.VECTOR_STORAGE_PROVIDER = 'pgvector';
    await setBalance(ctx, 0n);
    const knowledge = jobOf((await getProviderReadiness(ctx)).jobs, 'knowledge');
    expect(knowledge).toMatchObject({
      state: 'no_tokens',
      vendor: 'openai',
      key: 'platform',
      ungatedPart: null,
    });

    stubOpenAIEmbeddingsFetch();
    const root = await mkdtemp(path.join(tmpdir(), 'readiness-index-'));
    _setStorageForTests(new LocalFileStorage(root));
    // Once any earlier test has registered the job handlers, the in-memory
    // queue runs knowledge.index by itself as soon as the source is added.
    // A fresh queue with no handlers leaves the runs to this test.
    const previousQueue = getJobQueue();
    _setJobQueueForTests(new InMemoryJobQueue());
    try {
      // As the /documents upload form does: store it, then add it to the
      // knowledge base, which queues the knowledge.index job.
      const { document } = await uploadDocument(ctx, {
        filename: 'pump-datasheet.txt',
        mimeType: 'text/plain',
        body: Buffer.from('The P-40 pump moves 40 cubic metres an hour at 6 bar.\n'.repeat(40)),
      });
      const source = await createKnowledgeSource(ctx, {
        kind: 'document',
        title: document.name,
        documentId: document.id,
        scope: { kind: 'workspace' },
      });
      const runOf = async () =>
        (await db.select().from(indexingJobs).where(eq(indexingJobs.knowledgeSourceId, source.id)))[0]!;

      // It waits — queued and noted, never failed — and nothing is called.
      expect(await runQueuedIndexJobs(ctx)).toEqual([{ kind: 'skipped', reason: 'no_tokens' }]);
      expect(await runOf()).toMatchObject({ status: 'queued', note: 'waiting_for_tokens', attempts: 0 });
      expect(vendorCalls()).toBe(0);
      expect(await balanceOf(ctx)).toBe(0n);

      // After a top-up its next try (the sweep's, once due) indexes it.
      await setBalance(ctx, 1000n);
      const later = new Date(Date.now() + TOKENS_DEFER_MS + 1000);
      const outcomes = await runQueuedIndexJobs(ctx, { now: () => later });
      expect(outcomes.map((o) => o.kind)).toEqual(['succeeded']);
      expect(await runOf()).toMatchObject({ status: 'succeeded', note: 'embedded' });
    } finally {
      _setJobQueueForTests(previousQueue);
      _setStorageForTests(null);
      await rm(root, { recursive: true, force: true });
    }
    expect(await balanceOf(ctx)).toBeLessThan(1000n);
  });
});

// ---- the handbook -------------------------------------------------------------

describe('the handbook says what the panel says about an empty wallet', () => {
  it('Tokens & billing names what still runs as the panel does; troubleshooting points there', async () => {
    // The handbook said both "an empty wallet pauses … translation" and
    // "the Translate button … still runs" — a button that does not exist.
    const text = buildHandbookSource().replace(/\s+/g, ' ');
    const bullet = /- When the wallet is empty, (.*?) \[\/settings\/integrations\] shows what pauses and what still runs\./.exec(
      text,
    )?.[1];
    expect(bullet).toBeDefined();
    const [pauses, rest] = bullet!.split(' PAUSE until tokens arrive');
    const [waits, runs] = rest!.split(' These still run');
    expect(runs).toBeDefined();
    // Everything the panel can name as still running on an empty wallet,
    // taken from its own data — not a copy of it here: the ungated jobs
    // (or the part of one that runs), the ungated features, and every
    // part of a paused job that checks no wallet. A part added to the
    // panel and not to the handbook fails here, by name.
    await prodPlatform();
    const r = await getProviderReadiness(await tenant({ balance: 0n }));
    const named = [
      ...r.jobs.filter((j) => !j.walletGated).map((j) => j.gatedPart?.running ?? j.label),
      ...r.features.filter((f) => !f.walletGated).map((f) => f.label),
      ...r.jobs.flatMap((j) => j.ungatedPart?.parts ?? []),
    ];
    // Since 27 Nov: sending's translation alone, and it is free.
    expect(named).toEqual(['translating a queued draft or an approved follow-up as it is sent']);
    for (const name of named) {
      expect(runs!.toLowerCase(), name).toContain(name.toLowerCase());
    }
    expect(runs).toContain('free of charge, never taken from your tokens');
    expect(runs).not.toMatch(/charged|below zero/);
    // …and what pauses: everything the panel lists as paused, the
    // Research panel and Suggest with AI included; uploads and recipes wait.
    for (const paused of [
      'discovery',
      'qualification',
      'lead research (the Research panel on a lead',
      'outreach drafting',
      'Suggest with AI on products',
      'the signature redesign',
      'translation (Show translation and Re-translate everywhere, and incoming mail)',
      'reading scanned PDFs',
    ]) {
      expect(pauses, paused).toContain(paused);
    }
    expect(waits).toContain('Documents you upload wait to be indexed');
    expect(waits).toContain('keeps its queries untranslated until its next run');
    expect(text).not.toContain('Translate button');
    expect(text).toContain(
      'an empty wallet pauses discovery, qualification, drafting and some translation (Tokens & billing lists what pauses and what still runs)',
    );
  });
});

// ---- the other places that say the wallet is empty -------------------------------

// The panel and the handbook say some translation still runs on an empty
// wallet — since 27 Nov only sending's, which the platform pays for. The out-of-tokens notification, the billing
// page, the /health finding and the guide's own empty-wallet answer said
// "discovery, drafting and translation are paused" — all translation.
describe('every other place that says the wallet is empty agrees with the panel', () => {
  const PAUSED = 'discovery, qualification, drafting and some translation';
  const ALL_TRANSLATION = /discovery, drafting and translation|AI drafting, translation and/;

  it('the notification, the /health finding, the guide and the billing page say "some translation"', async () => {
    await prodPlatform();
    const ctx = await tenant({ balance: 5n });
    // The panel's answer these must agree with: translation on the
    // drafting provider partly still runs on an empty wallet.
    expect(jobOf((await getProviderReadiness(ctx)).jobs, 'drafting').ungatedPart?.short).toBe(
      'translating a queued draft or an approved follow-up as it is sent',
    );

    // The notification sent when a debit empties the wallet.
    await debitTokens(ctx.workspaceId, { tokens: 10n, reason: 'usage that empties the wallet' });
    const [note] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.workspaceId, ctx.workspaceId), eq(notifications.kind, 'tokens.empty')));
    expect(note?.title).toBe(`Out of tokens — ${PAUSED} are paused`);

    // The /health finding.
    const finding = (await getWorkspaceDiagnostics(ctx, { fresh: true })).findings.find(
      (f) => f.code === 'tokens.empty',
    );
    expect(finding?.detail).toContain(
      'Discovery, qualification, AI drafting, some translation and the AI review are paused until tokens are added (Settings → AI & search shows what still runs).',
    );

    // The guide's own answer: no model call on an empty wallet.
    const answer = await askAssistant(ctx, 'why is nothing running?');
    expect(answer.fallbackReason).toBe('wallet_empty');
    expect(answer.answer).toContain(
      `the AI guide is paused — and so are ${PAUSED} ([/settings/integrations] shows what pauses and what still runs).`,
    );

    // The billing page's badge, and its token packs (a list of examples,
    // not of everything tokens pay for).
    signIn(ctx.userId);
    const billing = clean(await renderToHtml(await BillingPage({ searchParams: Promise.resolve({}) })));
    expect(billing).toContain(`empty — ${PAUSED} are paused`);
    expect(billing).toContain('tokens — spent on metered work such as discovery search');

    for (const said of [note!.title, finding!.detail, answer.answer, billing]) {
      expect(said).not.toMatch(ALL_TRANSLATION);
    }
  });
});

// ---- the settings page ----------------------------------------------------------

describe('/settings/integrations renders the same answer', () => {
  async function renderPage(
    ctx: WorkspaceContext,
    searchParams: { ok?: string } = {},
  ): Promise<string> {
    session.current = {
      user: { id: ctx.userId.toString(), role: 'member', accountStatus: 'active' },
    };
    const tree = await IntegrationsPage({ searchParams: Promise.resolve(searchParams) });
    return clean(await renderToHtml(tree));
  }

  /** One vendor's line in the Simple "API keys by provider" list. */
  function vendorLine(html: string, vendor: string): string {
    const m = new RegExp(`data-vendor="${vendor}"[\\s\\S]*?</dd>`).exec(html);
    if (!m) throw new Error(`no ${vendor} line in the Simple list`);
    return m[0];
  }

  /** One provider section of the Advanced page, by its heading. */
  function sectionHtml(html: string, heading: string): string {
    const at = html.indexOf(`<h2>${heading}</h2>`);
    if (at < 0) throw new Error(`no "${heading}" section on the page`);
    return html.slice(at, html.indexOf('</section>', at));
  }

  /** The "(active: <code>X</code> via Y)" caption of a provider control. */
  function caption(html: string, label: string): { id: string; source: string } {
    const at = html.indexOf(`<span>${label}</span>`);
    if (at < 0) throw new Error(`no "${label}" control on the page`);
    const m = /\(active: <code>([^<]+)<\/code> via ([a-z]+)\)/.exec(html.slice(at));
    if (!m) throw new Error(`no caption after "${label}"`);
    return { id: m[1]!, source: m[2]! };
  }

  it('Simple: the panel, platform keys per vendor, and no "not configured" anywhere', async () => {
    await prodPlatform();
    const ctx = await tenant();
    const html = await renderPage(ctx);
    expect(html).toContain('What runs, and on whose key');
    expect(html).toContain('Everything is ready to run');
    expect(html).toContain('Platform key');
    // Perplexity has no key and no job uses it.
    expect(html).toContain('No key — not needed now');
    expect(html).not.toMatch(/not configured/i);
  });

  it('Simple: each vendor line comes from the job rows, never the console catalogue', async () => {
    await prodPlatform();
    const ctx = await tenant();
    const html = await renderPage(ctx);
    // Anthropic runs qualification, replies and the other writing here —
    // not "the default AI provider" of the catalogue.
    const anthropic = vendorLine(html, 'anthropic');
    expect(anthropic).toContain(
      'Used for Qualification, Replies to leads, Follow-ups and other writing, Suggest with AI on products.',
    );
    expect(anthropic).not.toContain('default');
    expect(vendorLine(html, 'serpapi')).toContain('Used for Discovery.');
    expect(vendorLine(html, 'gemini')).toContain('Used for Lead research.');
    expect(vendorLine(html, 'mistral')).toContain('Used for Reading scanned PDFs.');
    // DeepSeek has a key, but qualification runs on Anthropic.
    expect(vendorLine(html, 'deepseek')).toContain('Not used by any job now.');
    // No key and nothing uses it: the badge says it all.
    const perplexity = vendorLine(html, 'perplexity');
    expect(perplexity).toContain('data-signal="provider_key_gap" data-value="unused"');
    expect(perplexity).not.toContain('class="muted small"');
  });

  it('Simple: a vendor whose only job is degraded reads amber, as its row does', async () => {
    await prodPlatform();
    await dropConsoleKey('deepseek.apiKey');
    await consoleSetting('qualification.provider', 'deepseek');
    const ctx = await tenant();
    const html = await renderPage(ctx);
    const deepseek = vendorLine(html, 'deepseek');
    expect(deepseek).toContain('data-signal="provider_key_gap" data-value="limits_jobs"');
    expect(deepseek).toContain('No key — limits a job');
    expect(deepseek).toContain('Qualification runs on keyword rules only until a key is added.');
    expect(deepseek).not.toContain('a job needs it');
  });

  it("Simple with a saved own key says that key still wins", async () => {
    await prodPlatform();
    const ctx = await tenant();
    await byokKey(ctx.workspaceId, 'anthropic.apiKey');
    const html = await renderPage(ctx);
    expect(html).toContain('except where this workspace saved its own key');
    expect(html).toContain('Your key');
  });

  it('Advanced: the captions name what discovery and drafting really run on', async () => {
    await prodPlatform();
    const ctx = await tenant({ setupMode: 'advanced', plan: 'pro' });
    const html = await renderPage(ctx);
    const r = await getProviderReadiness(ctx);
    // Web Search names what discovery runs on and where the choice came
    // from. The old caption followed the research cascade and read
    // "gemini via default" (the console's Gemini key) while discovery ran
    // on SerpAPI.
    const webSearch = caption(html, 'Web Search');
    expect(webSearch).toEqual({ id: 'serpapi', source: 'platform' });
    expect(webSearch.id).toBe(jobOf(r.jobs, 'discovery').vendor);
    expect(webSearch.id).toBe(await runtimeDiscoveryVendor(ctx));
    // Drafting: the AI provider control, and the Anthropic section's line.
    // Its label names what it drives (getAIProviderForCtx's callers) —
    // never lead research (lead-research.ts asks getResearchProviderForCtx
    // only) or first emails (their stage tier's vendor, this one only as a
    // fallback).
    const ai = caption(
      html,
      'AI provider (follow-ups, suggested replies, translation, learning, etc.)',
    );
    expect(html).not.toContain('AI provider (drafts, learning, research');
    expect(ai).toEqual({ id: 'anthropic', source: 'env' });
    expect(ai.id).toBe(jobOf(r.jobs, 'drafting').vendor);
    expect(ai.id).toBe((await getAIProviderForCtx(ctx)).id);
    expect(html).toMatch(
      /Active AI provider:<\/strong>\s*<code>anthropic<\/code>\s*<span class="muted small">\(via env\)<\/span>/,
    );
    expect(html).not.toMatch(/not configured/i);
    // The Anthropic section reads the platform key as paid from tokens.
    expect(html).toContain('Leadsonar provides the key; usage is paid from your token balance');
    // OpenAI: everything is debited but knowledge retrieval — first emails,
    // and Suggest with AI (GPT-5), which no job row lists. Naming only
    // "First emails" read as if the suggester were free.
    expect(html).toContain(
      'Leadsonar provides the key; usage is paid from your token balance, except Knowledge retrieval, which is not charged.',
    );
    expect(html).not.toContain('usage for First emails is paid');
    // Perplexity: no key, no job.
    expect(html).toContain('no job uses Perplexity now, so nothing is affected');
  });

  it('Advanced: the copy claims only what the page and the runtime do', async () => {
    await prodPlatform();
    const ctx = await tenant({ setupMode: 'advanced', plan: 'pro' });
    const html = await renderPage(ctx);
    // Readiness checks that a key exists; no button tests "its" key.
    expect(html).toContain(
      'This page checks that each key is saved, not that the provider accepts it',
    );
    expect(html).not.toContain('checks that its key works');
    // The select's real option, not an "inherit env default" that is not there.
    expect(html).toContain('Choose <em>platform default (…)</em> to fall back');
    expect(html).not.toContain('inherit env default');
    // Gemini and Perplexity in tenant terms: what they run, no env vars.
    expect(html).toContain('Runs discovery as grounded web search — Gemini searches Google');
    // Perplexity never runs discovery as a platform default
    // (getWebSearchProviderForCtx grounds only on the workspace's choice);
    // only lead research can default to it (the research cascade).
    const perplexity = sectionHtml(html, 'Perplexity');
    expect(perplexity).toMatch(
      /Runs discovery as grounded web search — Perplexity Sonar[^]*?— when it is chosen under Web Search in\s+Active providers, and lead research when it is chosen there or is\s+the platform&#x27;s research default\./,
    );
    expect(perplexity).not.toContain('or is the platform default');
    expect(html).not.toMatch(/[A-Z]+_(PROVIDER|API_KEY|MODEL)/);
    // Pro: the own-key forms are there.
    expect(html).toContain('Set workspace SerpAPI key');
    expect(html).toContain('A workspace can bring its own Anthropic key');
    // The platform has no Perplexity key: the intro offers none.
    expect(perplexity).toContain(
      'A workspace can bring its own Perplexity key (Perplexity bills that account). Leadsonar has no platform key for Perplexity.',
    );
    expect(perplexity).not.toContain('or run on');
  });

  it('a billing-exempt workspace is told one thing everywhere: it is not charged', async () => {
    await prodPlatform();
    const ctx = await tenant({ setupMode: 'advanced', plan: 'pro', billingExempt: true });
    const html = await renderPage(ctx);
    expect(html).toContain('This workspace is not charged for usage.');
    expect(html).toContain('Leadsonar provides the key; this workspace is not charged for usage.');
    expect(html).toContain('platform key (this workspace is not charged for usage)');
    expect(html).not.toContain('token balance');
  });

  it('Advanced without a key: the section names the stopped jobs', async () => {
    process.env.AI_PROVIDER = 'anthropic';
    const starter = await tenant({ setupMode: 'advanced', plan: 'starter' });
    const html = await renderPage(starter);
    expect(html).toMatch(/Follow-ups and other writing will not run until a key is added/);
    // Starter has no BYOK: the page never sends them to add their own key.
    expect(html).toContain('your own keys need the Pro plan');
    expect(html).not.toContain('add a workspace key below');
    expect(html).not.toContain('Add your own Anthropic');
  });

  it('Advanced on a plan without BYOK offers no own-key form or promise', async () => {
    await prodPlatform();
    const starter = await tenant({ setupMode: 'advanced', plan: 'starter' });
    // Saved while the plan allowed it: it still wins, and can be cleared.
    await byokKey(starter.workspaceId, 'anthropic.apiKey');
    const html = await renderPage(starter, { ok: 'mode-advanced' });
    expect(html).not.toContain('Set workspace');
    expect(html).not.toContain('A workspace can bring its own');
    expect(html).not.toContain('workspace (BYOK) keys are editable');
    expect(html).not.toContain('workspace keys are now editable');
    expect(html).toContain('Your own keys need the Pro plan — <a href="/settings/billing">');
    expect(html).toContain('Clear workspace Anthropic key');
    expect(html).toContain('own Anthropic key, saved earlier, still takes precedence');
    expect(sectionHtml(html, 'SerpAPI')).toContain('This workspace runs on Leadsonar&#x27;s platform key');
    // The platform has no Perplexity key: the section never says the
    // workspace runs on one (it sat above "Platform key: none").
    const perplexity = sectionHtml(html, 'Perplexity');
    expect(perplexity).toContain('Leadsonar has no platform key for Perplexity.');
    expect(perplexity).not.toContain('runs on Leadsonar');
    expect(perplexity).toContain('none — the platform has no key for this provider');
  });

  it('an own key saved earlier, with no platform key behind it, claims no platform key', async () => {
    const starter = await tenant({ setupMode: 'advanced', plan: 'starter' });
    await byokKey(starter.workspaceId, 'perplexity.apiKey');
    const perplexity = sectionHtml(await renderPage(starter), 'Perplexity');
    expect(perplexity).toContain(
      'own Perplexity key, saved earlier, still applies (Perplexity bills that account). Leadsonar has no platform key for Perplexity.',
    );
    expect(perplexity).not.toContain('takes precedence over');
  });

  it('Simple with an own key on a plan without BYOK is not told to add keys', async () => {
    await prodPlatform();
    const starter = await tenant({ plan: 'starter' });
    await byokKey(starter.workspaceId, 'anthropic.apiKey');
    const html = await renderPage(starter);
    expect(html).toContain('Switch to Advanced setup to remove it or choose providers.');
    expect(html).not.toContain('add keys');
  });
});
