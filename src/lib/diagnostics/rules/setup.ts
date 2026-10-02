// AP-06 rules: configuration and discovery — tokens, products, recipes,
// runs, the web-search provider, knowledge indexing, the plan and learning.

import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { usageLog } from '@/lib/db/schema/audit';
import { connectorRecipes, connectorRuns, connectors } from '@/lib/db/schema/connectors';
import { knowledgeSources } from '@/lib/db/schema/documents';
import { learningEvents, learningLessons } from '@/lib/db/schema/learning';
import { mailboxes } from '@/lib/db/schema/mailing';
import { productProfiles } from '@/lib/db/schema/products';
import { formatUtc } from '@/lib/format-utc';
import { getWebSearchProviderForCtx } from '@/lib/search/web-search';
import { resolveEffectivePlan } from '@/lib/services/plan-limits';
import { getProviderSettings } from '@/lib/services/provider-settings';
import { daysBefore, plural } from '../env';
import { fixHref } from '../hrefs';
import { defineRule } from '../rule';
import { notifyEveryDays, type FindingDraft } from '../types';

// ---- wallet and products ----------------------------------------------------

export const tokensEmptyRule = defineRule({
  id: 'tokens.empty',
  owner: 'billing',
  summary: 'The token wallet is empty (not billing-exempt).',
  async evaluate(env) {
    const ws = await env.workspace();
    if (ws.billingExempt || ws.tokenBalance > 0n) return [];
    return [
      {
        code: 'tokens.empty',
        severity: 'critical',
        title: 'Token wallet is empty',
        detail:
          'Discovery, AI drafting, translation and the AI review are paused until tokens are added. ' +
          'Buy a token pack or start a subscription.',
        facts: { balance: Number(ws.tokenBalance) },
        href: fixHref.billing(),
      },
    ];
  },
});

export const productsNoneRule = defineRule({
  id: 'products.none',
  owner: 'diagnostics',
  summary: 'No active product profile.',
  async evaluate(env) {
    const [row] = await db
      .select({ n: count() })
      .from(productProfiles)
      .where(
        and(
          eq(productProfiles.workspaceId, env.ctx.workspaceId),
          eq(productProfiles.active, true),
        ),
      );
    if (Number(row?.n ?? 0) > 0) return [];
    return [
      {
        code: 'products.none',
        severity: 'warning',
        title: 'No active product',
        detail: 'Nothing can be qualified or pitched until a product profile is active.',
        href: fixHref.newProduct(),
      },
    ];
  },
});

// ---- recipes -----------------------------------------------------------------

/**
 * The ONE place that counts recipes by target country (I182; a grep test
 * keeps it that way). Only what can run: ACTIVE recipes on ACTIVE
 * connectors (the crawl engine skips the rest), and a country is set only
 * when it is non-blank — the same reading as qualification.ts's pick().
 */
export async function countRecipesByCountry(
  workspaceId: bigint,
): Promise<{ active: number; withCountry: number }> {
  const [row] = await db
    .select({
      active: count(),
      // A filtered aggregate over a jsonb field has no builder form.
      withCountry: sql<number>`count(*) filter (where nullif(btrim(${connectorRecipes.selectors}->>'country'), '') is not null)::int`,
    })
    .from(connectorRecipes)
    .innerJoin(
      connectors,
      and(
        eq(connectors.id, connectorRecipes.connectorId),
        eq(connectors.workspaceId, connectorRecipes.workspaceId),
      ),
    )
    .where(
      and(
        eq(connectorRecipes.workspaceId, workspaceId),
        eq(connectorRecipes.active, true),
        eq(connectors.active, true),
      ),
    );
  return { active: Number(row?.active ?? 0), withCountry: Number(row?.withCountry ?? 0) };
}

export const recipesNoCountryRule = defineRule({
  id: 'recipes.no_country',
  owner: 'discovery',
  summary: 'Active recipes (on active connectors) without a target country: the geography gate is off.',
  async evaluate(env) {
    const { active, withCountry } = await countRecipesByCountry(env.ctx.workspaceId);
    const without = active - withCountry;
    if (active === 0 || without === 0) return [];
    return [
      {
        code: 'recipes.no_country',
        severity: 'warning',
        title: `${without} of ${active} active recipes have no target country`,
        detail:
          'The geography gate is OFF for these recipes: leads from any country pass review and can ' +
          'be emailed. Set a country on each recipe to turn the gate on.',
        facts: { activeRecipes: active, withoutCountry: without },
        href: fixHref.searches(),
      },
    ];
  },
});

// ---- runs ---------------------------------------------------------------------

export const runsFailedRule = defineRule({
  id: 'runs.failed',
  owner: 'discovery',
  summary: 'Discovery runs that failed in the last 7 days.',
  async evaluate(env) {
    const [row] = await db
      .select({ n: count() })
      .from(connectorRuns)
      .where(
        and(
          eq(connectorRuns.workspaceId, env.ctx.workspaceId),
          eq(connectorRuns.status, 'failed'),
          gte(connectorRuns.createdAt, daysBefore(env.now, 7)),
          lt(connectorRuns.createdAt, env.now),
        ),
      );
    const n = Number(row?.n ?? 0);
    if (n === 0) return [];
    return [
      {
        code: 'runs.failed',
        severity: 'warning',
        title: `${plural(n, 'discovery run')} failed in the last 7 days`,
        detail: 'A failed run found nothing. Open the search to see the error on its runs.',
        facts: { failedRuns: n },
        href: fixHref.searches(),
      },
    ];
  },
});

/**
 * I074 proxy: a run that "succeeded" with 0 records. PC-10 now fails a run
 * whose every query failed, so what is left here usually means searches
 * that are too narrow or a provider that returns nothing. Warning when it
 * is every successful run of the week (discovery produces nothing), info
 * when only some.
 */
export const runsZeroResultsRule = defineRule({
  id: 'runs.zero_results',
  owner: 'discovery',
  summary: "Runs that 'succeeded' with 0 records in the last 7 days.",
  async evaluate(env) {
    const [row] = await db
      .select({
        succeeded: count(),
        empty: sql<number>`count(*) filter (where ${connectorRuns.recordCount} = 0)::int`,
      })
      .from(connectorRuns)
      .where(
        and(
          eq(connectorRuns.workspaceId, env.ctx.workspaceId),
          eq(connectorRuns.status, 'succeeded'),
          gte(connectorRuns.createdAt, daysBefore(env.now, 7)),
          lt(connectorRuns.createdAt, env.now),
        ),
      );
    const succeeded = Number(row?.succeeded ?? 0);
    const empty = Number(row?.empty ?? 0);
    if (empty === 0) return [];
    const all = empty === succeeded;
    return [
      {
        code: 'runs.zero_results',
        severity: all ? 'warning' : 'info',
        title: all
          ? `Every discovery run of the last 7 days found nothing (${plural(empty, 'run')})`
          : `${empty} of ${succeeded} discovery runs in the last 7 days found nothing`,
        detail:
          'A run that finishes with 0 records usually means its queries are too narrow, its country ' +
          'excludes everything, or the search provider returned nothing. Check the recipe and the ' +
          'web search settings.',
        facts: { emptyRuns: empty, succeededRuns: succeeded },
        href: fixHref.searches(),
      },
    ];
  },
});

// ---- the web-search provider ---------------------------------------------------

/**
 * I073: discovery silently on the mock search, which invents companies.
 * Two signals: search usage billed to the mock in the last 7 days, and
 * what a web search would use right now (the same resolver the
 * internet_search connector calls — no network: it only builds the
 * client), which matters only while an active web-search recipe exists.
 *   critical  mock results were stored in the last 7 days
 *   warning   web-search recipes would run on the mock; notifies (daily)
 *             only when a schedule would actually run them
 */
export const searchMockRule = defineRule({
  id: 'search.mock',
  owner: 'discovery',
  summary: 'Web-search recipes would run (or ran in 7 days) on the mock search, which invents companies.',
  async evaluate(env) {
    const wsId = env.ctx.workspaceId;
    const [usageRow, recipeRow] = await Promise.all([
      db
        .select({ n: count() })
        .from(usageLog)
        .where(
          and(
            eq(usageLog.workspaceId, wsId),
            eq(usageLog.kind, 'search.query'),
            eq(sql<string>`${usageLog.payload}->>'keySource'`, 'mock'),
            gte(usageLog.createdAt, daysBefore(env.now, 7)),
            lt(usageLog.createdAt, env.now),
          ),
        ),
      db
        .select({ n: count() })
        .from(connectorRecipes)
        .innerJoin(
          connectors,
          and(
            eq(connectors.id, connectorRecipes.connectorId),
            eq(connectors.workspaceId, connectorRecipes.workspaceId),
          ),
        )
        .where(
          and(
            eq(connectorRecipes.workspaceId, wsId),
            eq(connectorRecipes.active, true),
            eq(connectors.active, true),
            eq(connectors.templateType, 'internet_search'),
          ),
        ),
    ]);
    const mockQueries = Number(usageRow[0]?.n ?? 0);
    const webRecipes = Number(recipeRow[0]?.n ?? 0);
    if (mockQueries === 0 && webRecipes === 0) return [];
    const [provider, settings, policy] = await Promise.all([
      getWebSearchProviderForCtx(env.ctx),
      getProviderSettings(env.ctx),
      env.policy(),
    ]);
    const wouldUseMock = provider.id === 'mock' && webRecipes > 0;
    if (!wouldUseMock && mockQueries === 0) return [];

    const research = settings.researchProvider?.trim() || null;
    const scheduled = policy.discovery.enabledPlans > 0;
    const why =
      research === 'gemini' || research === 'perplexity'
        ? `${research === 'gemini' ? 'Gemini' : 'Perplexity'} is chosen for web search, but no key for it is configured (workspace or platform), so discovery falls back to the mock.`
        : 'No real web-search provider with a key is available, so discovery uses the mock.';
    const sentences = [
      'The mock search returns made-up companies, not real ones.',
      wouldUseMock
        ? why
        : provider.id === 'mock'
          ? `No web-search recipe is active now, but a new one would use the mock too. ${why}`
          : 'A real provider is configured now.',
      mockQueries > 0
        ? 'Reject or delete the records those runs produced; they are not real companies.'
        : null,
      provider.id === 'mock'
        ? 'Add the key, or choose a provider that has one, in AI & search.'
        : null,
    ];
    return [
      {
        code: 'search.mock',
        severity: mockQueries > 0 ? 'critical' : 'warning',
        title:
          mockQueries > 0
            ? `Discovery used the mock search ${plural(mockQueries, 'time')} in the last 7 days`
            : 'Discovery would use the mock search',
        detail: sentences.filter((s): s is string => Boolean(s)).join(' '),
        facts: {
          wouldUseMock,
          mockQueries7d: mockQueries,
          webSearchRecipes: webRecipes,
          researchProvider: research,
          enabledSchedules: policy.discovery.enabledPlans,
        },
        href: fixHref.integrations(),
        notify: {
          policy: mockQueries > 0 || scheduled ? notifyEveryDays(1) : { kind: 'never' },
          dedupeKey: 'search.mock',
        },
      },
    ];
  },
});

// ---- knowledge -----------------------------------------------------------------

export const knowledgeIndexFailedRule = defineRule({
  id: 'knowledge.index_failed',
  owner: 'knowledge',
  summary: 'Knowledge sources whose last indexing run failed.',
  async evaluate(env) {
    const rows = await db
      .select({ id: knowledgeSources.id, title: knowledgeSources.title })
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.workspaceId, env.ctx.workspaceId),
          eq(knowledgeSources.indexStatus, 'failed'),
        ),
      )
      .orderBy(knowledgeSources.id)
      .limit(51);
    if (rows.length === 0) return [];
    const n = rows.length > 50 ? '50+' : String(rows.length);
    const one = rows.length === 1 ? rows[0]! : null;
    return [
      {
        code: 'knowledge.index_failed',
        severity: 'warning',
        title: one
          ? `Knowledge source "${one.title}" failed to index`
          : `${n} knowledge sources failed to index`,
        detail:
          'Drafts and qualification cannot use what they say (or use the version indexed before). ' +
          'Open each one to see why and index it again.',
        facts: { failedSources: rows.length > 50 ? 51 : rows.length },
        href: one ? fixHref.knowledgeSource(one.id) : fixHref.knowledge(),
      },
    ];
  },
});

// ---- plan and learning (advisory) --------------------------------------------------

/**
 * Context for "why can't I add a second mailbox / switch on autopilot":
 * the effective plan's limits while on Free or a trial, or once a limit is
 * reached. Advisory: never notifies, never costs score.
 */
export const planLimitsRule = defineRule({
  id: 'plan.limits',
  owner: 'billing',
  summary: 'The plan’s limits while on Free or a trial, or once a limit is reached (advisory).',
  async evaluate(env) {
    const ws = await env.workspace();
    const plan = resolveEffectivePlan(ws);
    const [products, boxes] = await Promise.all([
      db
        .select({ n: count() })
        .from(productProfiles)
        .where(eq(productProfiles.workspaceId, env.ctx.workspaceId)),
      db.select({ n: count() }).from(mailboxes).where(eq(mailboxes.workspaceId, env.ctx.workspaceId)),
    ]);
    const productCount = Number(products[0]?.n ?? 0);
    const mailboxCount = Number(boxes[0]?.n ?? 0);
    const { limits } = plan;
    const productsFull = limits.maxProducts !== null && productCount >= limits.maxProducts;
    const mailboxesFull = limits.maxMailboxes !== null && mailboxCount >= limits.maxMailboxes;
    const trial = ws.subscriptionStatus === 'trial' && !ws.billingExempt;
    if (plan.id !== 'free' && !trial && !productsFull && !mailboxesFull) return [];

    const cap = (n: number | null, one: string, many: string) =>
      n === null ? `unlimited ${many}` : `up to ${plural(n, one, many)}`;
    const parts = [
      `${cap(limits.maxProducts, 'product', 'products')} (${productCount} used)`,
      `${cap(limits.maxMailboxes, 'mailbox', 'mailboxes')} (${mailboxCount} used)`,
      limits.autopilot ? 'autopilot included' : 'no autopilot',
      limits.byok ? 'your own API keys allowed' : 'no own API keys',
    ];
    const planName = plan.id === 'free' ? 'Free' : plan.id.charAt(0).toUpperCase() + plan.id.slice(1);
    const trialEnds = trial && ws.trialEndsAt ? ` The trial ends ${formatUtc(ws.trialEndsAt)}.` : '';
    return [
      {
        code: 'plan.limits',
        severity: 'info',
        advisory: true,
        title: trial ? `Trial: ${planName} plan limits` : `${planName} plan limits`,
        detail: `This plan allows ${parts.join(', ')}.${trialEnds}${productsFull || mailboxesFull ? ' A limit is reached; upgrading raises it.' : ''}`,
        facts: {
          plan: plan.id,
          subscriptionStatus: ws.subscriptionStatus,
          products: productCount,
          maxProducts: limits.maxProducts,
          mailboxes: mailboxCount,
          maxMailboxes: limits.maxMailboxes,
          autopilot: limits.autopilot,
        },
        href: fixHref.billing(),
      },
    ];
  },
});

/**
 * Knowledge-first: nothing has taught the qualifier yet — no active
 * learned rule and no operator decision in 30 days (production: 0 lessons,
 * 0 events). Advisory: it is a usage gap, not a fault.
 */
export const learningUnfedRule = defineRule({
  id: 'learning.unfed',
  owner: 'knowledge',
  summary: 'No active learned rule and no operator decision in 30 days (advisory).',
  async evaluate(env) {
    const wsId = env.ctx.workspaceId;
    const [products, lessons, decisions] = await Promise.all([
      db
        .select({ n: count() })
        .from(productProfiles)
        .where(and(eq(productProfiles.workspaceId, wsId), eq(productProfiles.active, true))),
      db
        .select({ n: count() })
        .from(learningLessons)
        .where(and(eq(learningLessons.workspaceId, wsId), eq(learningLessons.lifecycle, 'active'))),
      db
        .select({ n: count() })
        .from(learningEvents)
        .where(
          and(
            eq(learningEvents.workspaceId, wsId),
            eq(learningEvents.origin, 'operator'),
            gte(learningEvents.createdAt, daysBefore(env.now, 30)),
            lt(learningEvents.createdAt, env.now),
          ),
        ),
    ]);
    // No product: products.none says what to do first.
    if (Number(products[0]?.n ?? 0) === 0) return [];
    if (Number(lessons[0]?.n ?? 0) > 0 || Number(decisions[0]?.n ?? 0) > 0) return [];
    const finding: FindingDraft = {
      code: 'learning.unfed',
      severity: 'info',
      advisory: true,
      title: 'Nothing has taught the qualifier yet',
      detail:
        'There is no active learned rule and no review decision from the last 30 days. Approving or ' +
        'rejecting a few review items, with a reason, teaches it what fits your products.',
      href: fixHref.review(),
    };
    return [finding];
  },
});
