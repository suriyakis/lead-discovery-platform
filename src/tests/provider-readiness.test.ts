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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import { db } from '@/lib/db/client';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { mailMessages } from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
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
import { translateText } from '@/lib/services/translation';
import { buildHandbookSource } from '@/lib/assistant/handbook';
import {
  VENDOR_FEATURES,
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

  it('grounded search on a console key promises no token billing (the adapter logs it as the workspace\'s own)', async () => {
    await consoleKey('gemini.apiKey');
    const ctx = await tenant();
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'discovery').billedFromTokens).toBe(false);
    const html = await panel(r);
    expect(rowHtml(html, 'discovery')).toContain('Runs on Leadsonar&#x27;s Google Gemini key');
    expect(rowHtml(html, 'discovery')).not.toContain('token balance');
    const line = clean(
      await renderToHtml(
        KeySourceLine({ vendor: 'gemini', readiness: r, isAdmin: true, byokAllowed: true }),
      ),
    );
    // The key line says the platform key's usage is paid from tokens and
    // names what is not: the grounded search and research (here Gemini
    // also writes, as the auto-detected AI provider, and that is debited).
    // It used to name only the debited jobs, which read as "the rest of
    // this key's usage is free" — Suggest with AI and large uploads' index
    // embeddings are debited too.
    expect(line).toContain(
      'Leadsonar provides the key; usage is paid from your token balance, except Discovery and Lead research, which are not charged.',
    );
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

  // Replaces "an empty wallet stops every job, whatever the key", which
  // encoded the bug: lead research and reading scanned PDFs check no
  // wallet, so the page said they were refused while they ran.
  it('an empty wallet pauses only the wallet-gated jobs; lead research and scanned PDFs still run', async () => {
    await prodPlatform();
    const ctx = await tenant({ balance: 0n });
    const r = await getProviderReadiness(ctx);
    expect(Object.fromEntries(r.jobs.map((j) => [j.job, j.state]))).toEqual({
      discovery: 'no_tokens',
      qualification: 'no_tokens',
      research: 'ready',
      first_emails: 'no_tokens',
      replies: 'no_tokens',
      drafting: 'no_tokens',
      knowledge: 'no_tokens',
      ocr: 'ready',
    });
    const html = await panel(r);
    // Every key is there: one alert, the wallet's, which may say so.
    expect(alertTones(html)).toEqual(['warning']);
    expect(html).toContain('Providers are ready, but the token balance is empty');
    expect(html).toContain('<a href="/settings/billing">Buy tokens</a>');
    expect(html).toContain(
      'Discovery, Qualification, First emails, Replies to leads, Follow-ups and other writing, Knowledge retrieval pause until tokens are added.',
    );
    // OCR on the platform key is still debited (recordUsage has no floor);
    // research on the console's Gemini key is not (the adapter logs it as
    // the workspace's own). Suggest with AI checks no wallet and is
    // debited; so is the ungated translation on the drafting provider.
    // Of lead research only the Research panel runs: the research before
    // a draft sits behind generateOutreachDraft's assertTokens. Indexing
    // an upload embeds on the platform OpenAI key, ungated and debited.
    expect(html).toContain(
      'The Research panel on a lead, Reading scanned PDFs, Suggest with AI on products, some translation and the signature redesign, and indexing the documents you upload still run, and their usage is still deducted (except the Research panel on a lead), so the balance can go below zero.',
    );
    expect(html).not.toContain('Lead research, Reading scanned PDFs');
    expect(html).not.toContain('refused');
    expect(rowHtml(html, 'ocr')).toContain(
      'It still runs while the token balance is empty, and its usage is still deducted',
    );
    expect(rowHtml(html, 'research')).toContain(
      'The Research panel on a lead still runs while the token balance is empty. The research before a draft pauses with drafting while the token balance is empty.',
    );
    expect(rowHtml(html, 'research')).not.toContain('deducted');
    expect(rowHtml(html, 'research')).not.toContain('It still runs');
    // The row pauses, but not the translation on its provider that checks
    // no wallet — Show translation / Re-translate on a draft and a new
    // email, never the same buttons on a reply or a follow-up awaiting
    // approval (the gated /api/translate: refused, so "need tokens").
    expect(rowHtml(html, 'drafting')).toContain(
      'the token balance is empty, so this job pauses until tokens are added. Still running: Show translation and Re-translate on a draft and on a new email, translating a queued draft or an approved follow-up as it is sent, translating a search recipe&#x27;s queries when it is saved, and the signature redesign — and their usage is still deducted, so the balance can go below zero. On a reply or a follow-up awaiting approval, Show translation and Re-translate need tokens.',
    );
    expect(html).not.toContain('Translate button');
    expect(html).not.toContain('they pause');
    // Retrieval pauses with drafting; indexing an upload does not.
    expect(rowHtml(html, 'knowledge')).toContain(
      'so this job pauses until tokens are added. Still running: indexing the documents you upload — and its usage is still deducted, so the balance can go below zero.',
    );
    // A paused job with no ungated part says no more.
    expect(rowHtml(html, 'replies')).not.toContain('Still running');
  });

  it('a Gemini key kept only in the server env: lead research on an empty wallet is still deducted', async () => {
    // F1's first fixture. The adapter logs an env key as the platform's,
    // so recordUsage debits lead research — and the page must say so.
    process.env.GEMINI_API_KEY = 'env-gemini';
    const ctx = await tenant({ balance: 0n });
    const r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'research')).toMatchObject({
      vendor: 'gemini',
      key: 'platform',
      state: 'ready',
      platformKeyDebited: true,
      billedFromTokens: true,
    });
    // Discovery's safety net runs on the same key, and is debited too.
    expect(jobOf(r.jobs, 'discovery')).toMatchObject({
      vendor: 'gemini',
      state: 'no_tokens',
      billedFromTokens: true,
    });
    expect(rowHtml(await panel(r), 'research')).toContain(
      'The Research panel on a lead still runs while the token balance is empty, and its usage is still deducted, so the balance can go below zero. The research before a draft pauses with drafting while the token balance is empty.',
    );
    // The Gemini key line promises billing for every job on it.
    const line = clean(
      await renderToHtml(
        KeySourceLine({ vendor: 'gemini', readiness: r, isAdmin: true, byokAllowed: true }),
      ),
    );
    expect(line).toContain('Leadsonar provides the key; usage is paid from your token balance.');

    // With every other job ready, the empty-wallet alert counts the
    // Research panel among what is still deducted — no exception left.
    await prodPlatform();
    await dropConsoleKey('gemini.apiKey');
    const full = await panel(await getProviderReadiness(ctx));
    expect(full).toContain(
      'The Research panel on a lead, Reading scanned PDFs, Suggest with AI on products, some translation and the signature redesign, and indexing the documents you upload still run, and their usage is still deducted, so the balance can go below zero.',
    );
  });

  it('the research row never promises what a top-up cannot bring back', async () => {
    // Lead research on the env Gemini key; no AI key anywhere, so a draft
    // cannot be written even once tokens are added.
    process.env.RESEARCH_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'env-gemini';
    process.env.AI_PROVIDER = 'anthropic';
    const ctx = await tenant({ balance: 0n });
    let r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'research').state).toBe('ready');
    expect(jobOf(r.jobs, 'first_emails').state).toBe('no_key');
    let row = rowHtml(await panel(r), 'research');
    expect(row).toContain(
      'The research before a draft pauses with drafting while the token balance is empty.',
    );
    expect(row).not.toContain('until tokens are added');

    // Without a research key, the row does not say drafts are still
    // written: on an empty wallet none is.
    delete process.env.GEMINI_API_KEY;
    r = await getProviderReadiness(ctx);
    expect(jobOf(r.jobs, 'research').state).toBe('no_key');
    row = rowHtml(await panel(r), 'research');
    expect(row).toContain('so lead research fails; a draft skips the research rather than failing.');
    expect(row).not.toContain('still written');
  });

  it('grounded research debits exactly when the page says: an env key yes, a console key no', async () => {
    const ctx = await tenant();
    const { lead } = await seedLead(ctx);
    await setBalance(ctx, 0n);
    stubGeminiFetch();
    try {
      // A console key (not the env var's value): logged as the workspace's
      // own, never debited.
      process.env.GEMINI_API_KEY = 'env-gemini';
      await consoleKey('gemini.apiKey', 'console-gemini');
      expect(jobOf((await getProviderReadiness(ctx)).jobs, 'research').platformKeyDebited).toBe(
        false,
      );
      await researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who buys?' });
      expect(await balanceOf(ctx)).toBe(0n);

      // The console key holds the env var's very value: logged as the
      // platform's, debited — the page says so, and the run takes the
      // balance below zero.
      await dropConsoleKey('gemini.apiKey');
      await consoleKey('gemini.apiKey', 'env-gemini');
      expect(jobOf((await getProviderReadiness(ctx)).jobs, 'research').platformKeyDebited).toBe(
        true,
      );
      await researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who installs?' });
      const afterConsole = await balanceOf(ctx);
      expect(afterConsole).toBeLessThan(0n);

      // Only the env key: debited, further below zero, on an empty wallet.
      await dropConsoleKey('gemini.apiKey');
      expect(jobOf((await getProviderReadiness(ctx)).jobs, 'research')).toMatchObject({
        platformKeyDebited: true,
        state: 'ready',
      });
      await researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who sells?' });
      expect(await balanceOf(ctx)).toBeLessThan(afterConsole);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the wallet facts agree with the runtime: discovery and drafts refuse, lead research runs', async () => {
    _setResearchProviderForTests(new MockResearchProvider());
    const ctx = await tenant();
    // A lead to research, made while the wallet still has tokens.
    const { product, item, lead } = await seedLead(ctx);

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
    // Not gated: the Research panel's call runs on an empty wallet. The
    // research before a draft is gated — generateOutreachDraft refused
    // above before any research — and the row says so (gatedPart).
    expect(gated('research')).toBe(false);
    expect(jobOf(r.jobs, 'research').gatedPart).toEqual({
      running: 'the Research panel on a lead',
      paused: 'the research before a draft pauses with drafting',
    });
    await expect(
      researchLead(ctx, { qualifiedLeadId: lead.id, question: 'Who buys?' }),
    ).resolves.toMatchObject({ cached: false });
    // Drafting is gated, but translateText — behind Show translation on a
    // draft and on a new email — checks no wallet: the row's "Still
    // running" (each entry point is run in the describe below).
    expect(gated('drafting')).toBe(true);
    expect(jobOf(r.jobs, 'drafting').ungatedPart?.detail).toContain(
      'Show translation and Re-translate on a draft',
    );
    await expect(
      translateText(ctx, { text: 'Hallo Welt', targetLanguage: 'en', recordAudit: false }),
    ).resolves.toBeDefined();
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
    expect(r.jobs.filter((j) => j.state === 'no_tokens')).toHaveLength(6);
    const html = await panel(r);
    expect(alertTones(html)).toEqual(['danger', 'warning']);
    // The key alert: one job, for a key reason — and it says it leaves the
    // paused jobs out of that count.
    expect(html).toContain('1 job will not run without a key');
    expect(html).toContain(
      'Reading scanned PDFs — see the reason on each row below. Not counted here: the 6 jobs paused because the token balance is empty.',
    );
    // The wallet alert, with its action, never "Providers are ready".
    expect(html).toContain('The token balance is empty');
    expect(html).not.toContain('Providers are ready');
    expect(html).toContain('<a href="/settings/billing">Buy tokens</a>');
    expect(html).toContain(
      'Discovery, Qualification, First emails, Replies to leads, Follow-ups and other writing, Knowledge retrieval pause until tokens are added.',
    );
    // Without a key, reading scanned PDFs is not among what still runs.
    expect(html).toContain(
      'The Research panel on a lead, Suggest with AI on products, some translation and the signature redesign, and indexing the documents you upload still run, and their usage is still deducted (except the Research panel on a lead), so the balance can go below zero.',
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
      'Discovery, Qualification, First emails, Replies to leads, Follow-ups and other writing, Knowledge retrieval pause until tokens are added.',
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
      'Reading scanned PDFs — see the reason on each row below. Qualification has no key, so it would score with keyword rules only — and the empty token balance pauses it too. Not counted here: the 6 jobs paused because the token balance is empty.',
    );
    expect(both).not.toContain('runs on keyword rules only');
  });

  it('every job that checks the wallet lacks a key or a provider: the wallet alert names them, not "the jobs that use tokens"', async () => {
    // Reachable only with qualification on no provider at all (keyword
    // rules count among the pauses). Lead research and scanned PDFs have
    // keys, use tokens and still run — so "the jobs that use tokens have
    // no key" would be false.
    process.env.SEARCH_PROVIDER = 'serpapi';
    process.env.AI_PROVIDER = 'mock';
    process.env.VECTOR_STORAGE_PROVIDER = 'mock';
    process.env.RESEARCH_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'env-gemini';
    process.env.MISTRAL_API_KEY = 'env-mistral';
    await consoleSetting('qualification.provider', 'mock');
    const ctx = await tenant({ balance: 0n });
    const r = await getProviderReadiness(ctx);
    expect(Object.fromEntries(r.jobs.map((j) => [j.job, j.state]))).toEqual({
      discovery: 'no_key',
      qualification: 'not_set_up',
      research: 'ready',
      first_emails: 'not_set_up',
      replies: 'not_set_up',
      drafting: 'not_set_up',
      knowledge: 'not_set_up',
      ocr: 'ready',
    });
    const html = await panel(r);
    expect(alertTones(html)).toEqual(['danger', 'warning']);
    expect(html).toContain('6 jobs will not run without a key or a provider');
    expect(html).toContain(
      'Discovery, Qualification, First emails, Replies to leads, Follow-ups and other writing, Knowledge retrieval need a key or a provider first (see their rows); once they have one, they pause until tokens are added. The Research panel on a lead and Reading scanned PDFs still run, and their usage is still deducted, so the balance can go below zero.',
    );
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

// ---- what "Still running" names really runs -----------------------------------

// The drafting and knowledge rows' "Still running" and the empty-wallet
// alert name work whose entry points check no wallet. Each is run here on
// an empty, non-exempt wallet, on a platform key kept in the server env
// (debited: Anthropic for the writing, OpenAI for indexing's embeddings):
// it must complete, and its usage must take the balance below zero — as
// the page says. A wallet gate added to any of them fails its own test;
// then the page, not the gate, is what to change.
describe('on an empty wallet, the work the page lists as still running runs — and is debited', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function draftingRow(ctx: Pick<WorkspaceContext, 'workspaceId'>, names: string) {
    const drafting = jobOf((await emptyWalletOnPlatformAnthropic(ctx)).jobs, 'drafting');
    expect(drafting).toMatchObject({ state: 'no_tokens', key: 'platform', billedFromTokens: true });
    expect(drafting.ungatedPart?.detail).toContain(names);
  }

  it('Show translation on a draft: translateDraftAction → generateDraftTranslation', async () => {
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
    await draftingRow(ctx, 'Show translation and Re-translate on a draft');

    signIn(s.ownerId);
    const to = await expectRedirect(() =>
      translateDraftAction(draft!.id.toString(), claimedForm(s.workspaceId)),
    );
    const flash = new URL(to, 'http://flash.invalid').searchParams;
    expect(flash.get('error')).toBeNull();
    expect(flash.get('message')).toMatch(/^Translation generated/);
    const [after] = await db.select().from(outreachDrafts).where(eq(outreachDrafts.id, draft!.id));
    expect(after!.targetLanguage).toBe('de');
    expect(after!.bodyTranslated).toBe('[DE] Who handles concrete repair at your company?');
    expect(await balanceOf(ctx)).toBeLessThan(0n);
  });

  it('Show translation on a new email: translateComposeAction', async () => {
    const ctx = await tenant();
    await draftingRow(ctx, 'on a draft and on a new email');
    signIn(ctx.userId);
    const r = await translateComposeAction({
      subject: 'Prices',
      body: 'Thanks for your reply — here are the prices.',
      targetLanguage: 'de',
      expectedWorkspaceId: ctx.workspaceId.toString(),
    });
    expect(r).toEqual({
      ok: true,
      subject: '[DE] Prices',
      body: '[DE] Thanks for your reply — here are the prices.',
    });
    expect(await balanceOf(ctx)).toBeLessThan(0n);
  });

  it('Show translation on a reply or a follow-up awaiting approval needs tokens: /api/translate answers 402', async () => {
    // The copy says these labels need tokens there — refused, not queued:
    // the gated route answers 402 and nothing runs later.
    const ctx = await tenant();
    const drafting = jobOf((await emptyWalletOnPlatformAnthropic(ctx)).jobs, 'drafting');
    expect(drafting.ungatedPart?.note).toBe(
      'on a reply or a follow-up awaiting approval, Show translation and Re-translate need tokens',
    );
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

  it('an approved follow-up, translated as it is sent: approveFollowUp', async () => {
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
    await draftingRow(ctx, 'an approved follow-up as it is sent');

    const approved = await approveFollowUp(ctx, step!.id, undefined, {
      mailProviderOverride: provider,
    });
    expect(approved.status).toBe('sent');
    expect(provider.sent.at(-1)!.message.text).toContain(
      '[DE] Did you have a chance to look at our offer?',
    );
    expect(await balanceOf(ctx)).toBeLessThan(0n);
  });

  it('a queued draft, translated as it is sent: drainQueue', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const { draft } = await queuedDraft(s, 'anna@target.com');
    await setOutreachLanguage(ctx, (await leadFor(draft.reviewItemId)).id, 'de');
    await draftingRow(ctx, 'translating a queued draft');

    // The background drain tick asks the same 'sending' gate, without
    // spendsTokens: on an empty wallet it runs too.
    expect(tickVerdict(await resolveAutomationPolicy(ctx), 'outreach.drain.tick')).toEqual({
      run: true,
    });
    const r = await drainQueue(ctx, { providerOverride: new MockMailProvider() });
    expect(r.sent).toBe(1);
    const [msg] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceId));
    expect(msg!.targetLanguage).toBe('de');
    expect(msg!.bodyText).toContain(`[DE] ${draft.body}`);
    expect(await balanceOf(ctx)).toBeLessThan(0n);
  });

  it("a search recipe's queries, translated when it is saved: createRecipe", async () => {
    const ctx = await tenant();
    const conn = await createConnector(ctx, { templateType: 'mock', name: 'Mock', config: {} });
    await draftingRow(ctx, "translating a search recipe's queries when it is saved");

    const recipe = await createRecipe(ctx, {
      connectorId: conn.id,
      name: 'German buyers',
      searchQueries: ['concrete repair contractors'],
      selectors: { language: 'de' },
    });
    // Translated — not the native query the best-effort fallback keeps.
    expect((recipe.selectors as Record<string, unknown>).searchQueriesIssued).toEqual([
      '[DE] concrete repair contractors',
    ]);
    expect(await balanceOf(ctx)).toBeLessThan(0n);
  });

  it("a search recipe's queries, translated when it is saved: updateRecipe", async () => {
    const ctx = await tenant();
    const conn = await createConnector(ctx, { templateType: 'mock', name: 'Mock', config: {} });
    // Saved without a search language while the wallet had tokens.
    const recipe = await createRecipe(ctx, {
      connectorId: conn.id,
      name: 'Buyers',
      searchQueries: ['pump buyers'],
    });
    await draftingRow(ctx, "translating a search recipe's queries when it is saved");

    const updated = await updateRecipe(ctx, recipe.id, {
      selectors: { language: 'de' },
      searchQueries: ['pump buyers'],
    });
    expect((updated.selectors as Record<string, unknown>).searchQueriesIssued).toEqual([
      '[DE] pump buyers',
    ]);
    expect(await balanceOf(ctx)).toBeLessThan(0n);
  });

  it('the signature redesign: POST /api/signatures/redesign', async () => {
    const ctx = await tenant();
    await draftingRow(ctx, 'and the signature redesign');
    signIn(ctx.userId);
    const res = await redesignSignaturePOST(
      new Request('http://localhost/api/signatures/redesign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: 'Anna Nowak', company: 'Acme' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { bodyHtml: string }).bodyHtml).toContain('Anna Nowak');
    expect(await balanceOf(ctx)).toBeLessThan(0n);
  });

  it('Suggest with AI on products: suggestStageAngle', async () => {
    const ctx = await tenant();
    const product = await createProductProfile(ctx, { name: 'Test Product' });
    const r = await emptyWalletOnPlatformAnthropic(ctx);
    const feature = r.features.find((f) => f.id === 'suggest_angles')!;
    expect(feature).toMatchObject({ walletGated: false, platformKeyDebited: true });
    expect(feature.vendors.find((v) => v.vendor === 'anthropic')).toMatchObject({
      key: 'platform',
      hasKey: true,
    });
    expect(await panel(r)).toContain('Suggest with AI on products');

    const out = await suggestStageAngle(ctx, product.id, 'discovery', 'anthropic');
    expect(out.text).toBe('Lead with what a failed repair costs them.');
    expect(await balanceOf(ctx)).toBeLessThan(0n);
  });

  it('indexing the documents you upload: uploadDocument → the knowledge.index job', async () => {
    // Knowledge retrieval pauses with drafting, but an upload is still
    // indexed — its embeddings on the platform OpenAI key, debited.
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
      billedFromTokens: false,
    });
    expect(knowledge.ungatedPart).toMatchObject({
      parts: ['indexing the documents you upload'],
      billedFromTokens: true,
    });

    stubOpenAIEmbeddingsFetch();
    const root = await mkdtemp(path.join(tmpdir(), 'readiness-index-'));
    _setStorageForTests(new LocalFileStorage(root));
    // Once any earlier test has registered the job handlers, the in-memory
    // queue runs knowledge.index by itself as soon as the source is added,
    // and under load it claims the row before runQueuedIndexJobs does (the
    // outcome then reads 'skipped'). A fresh queue with no handlers leaves
    // the run to this test.
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
      await createKnowledgeSource(ctx, {
        kind: 'document',
        title: document.name,
        documentId: document.id,
        scope: { kind: 'workspace' },
      });
      const outcomes = await runQueuedIndexJobs(ctx);
      expect(outcomes.map((o) => o.kind)).toEqual(['succeeded']);
    } finally {
      _setJobQueueForTests(previousQueue);
      _setStorageForTests(null);
      await rm(root, { recursive: true, force: true });
    }
    expect(await balanceOf(ctx)).toBeLessThan(0n);
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
    const [needTokens, runs] = rest!.split(' These still run');
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
    expect(r.jobs.filter((j) => j.ungatedPart).map((j) => j.job)).toEqual(['drafting', 'knowledge']);
    expect(named).toContain(VENDOR_FEATURES[0]!.label);
    expect(named.length).toBeGreaterThanOrEqual(8);
    for (const name of named) {
      expect(runs!.toLowerCase(), name).toContain(name.toLowerCase());
    }
    // …and what pauses, where the same button labels call the gated route
    // (refused with a 402, so "need tokens", as the panel's note says).
    expect(pauses).toContain('outreach drafting (with the research before a draft)');
    expect(needTokens).toContain(
      'Show translation and Re-translate on a reply or on a follow-up awaiting approval need tokens too',
    );
    expect(jobOf(r.jobs, 'drafting').ungatedPart!.note).toContain(
      'on a reply or a follow-up awaiting approval, Show translation and Re-translate need tokens',
    );
    expect(text).not.toContain('Translate button');
    expect(text).toContain(
      'an empty wallet pauses discovery, qualification, drafting and some translation (Tokens & billing lists what pauses and what still runs)',
    );
  });
});

// ---- the other places that say the wallet is empty -------------------------------

// The panel and the handbook say some translation still runs on an empty
// wallet (and is debited). The out-of-tokens notification, the billing
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
      'some translation and the signature redesign',
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
