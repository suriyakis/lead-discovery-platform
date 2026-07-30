// Onboarding wizard service (Phase 47).
//
// Computes per-step completion for the /onboarding flow + lets the
// operator advance / dismiss the wizard. The wizard is workspace-scoped
// and any admin can run it; non-admins see a read-only view.
//
// Steps:
//   1. setup         — Simple (system keys, read-only integrations) or
//                      Advanced (system defaults, everything editable).
//   2. plan          — pricing / subscription (Stripe).
//   3. ai            — active AI provider is real + key reachable.
//   4. search        — real Web Search backend reachable.
//   5. mailbox       — at least one mailbox configured.
//   6. product       — at least one active product profile.
//   7. connector     — at least one connector configured.
//   8. run           — first discovery records exist.
//   9. review        — first approve/reject decision made.
//
// Each step returns a boolean `done`. The wizard is "completed" once
// every step is done OR the operator clicks Skip / Finish.

import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { connectors, sourceRecords } from '@/lib/db/schema/connectors';
import { reviewItems } from '@/lib/db/schema/review';
import { mailboxes } from '@/lib/db/schema/mailing';
import { productProfiles } from '@/lib/db/schema/products';
import {
  workspaces,
  type Workspace,
} from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, type WorkspaceContext } from './context';
import {
  resolveActiveProvider,
} from './provider-settings';
import { resolveProviderKey } from './secrets';

export class OnboardingError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OnboardingError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new OnboardingError(`Permission denied: ${op}`, 'permission_denied');

export type OnboardingStepKey =
  | 'setup'
  | 'plan'
  | 'ai'
  | 'search'
  | 'mailbox'
  | 'product'
  | 'connector'
  | 'run'
  | 'review';

/** How the workspace wants providers/keys managed. 'simple' = system
 *  keys only, integrations page read-only; 'advanced' = same defaults
 *  but everything editable (provider selection + BYOK). */
export type SetupMode = 'simple' | 'advanced';

export interface OnboardingStep {
  key: OnboardingStepKey;
  title: string;
  blurb: string;
  done: boolean;
  /** Where the step's CTA links to. */
  href: string;
  /** Optional explanation when not done — what's missing. */
  why?: string;
}

export interface OnboardingState {
  workspace: Workspace;
  steps: OnboardingStep[];
  /** Convenience: index of the next-incomplete step, -1 when all done. */
  nextStepIdx: number;
  /** True when the workspace's onboardingStatus is 'completed' OR every
   *  step is done. UI uses this to switch from "wizard" to "done"
   *  without a write. */
  effectivelyComplete: boolean;
}

/**
 * Read the workspace + compute per-step state. No writes.
 */
export async function getOnboardingState(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<OnboardingState> {
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!ws) {
    throw new OnboardingError('workspace not found', 'not_found');
  }

  // ─── Step 0: setup mode ────────────────────────────────────────────
  // Simple = the workspace runs on the platform's system API keys and
  // default providers, nothing to configure. Advanced = same defaults,
  // but the integrations page unlocks provider selection + BYOK.
  const setupMode = (ws.setupMode ?? null) as SetupMode | null;
  const setupDone = setupMode !== null;
  const simple = setupMode === 'simple';

  // ─── Step 1: plan ──────────────────────────────────────────────────
  // Today: 'trial' counts as done (the operator has acknowledged the
  // trial banner). When Stripe lands this becomes "subscription_status
  // in (trial, active)". `canceled` / `past_due` will block.
  const planDone =
    ws.subscriptionStatus === 'trial' ||
    ws.subscriptionStatus === 'active';

  // ─── Step 2: ai ────────────────────────────────────────────────────
  // Done when the active AI provider is real (not 'mock') AND a key
  // is configured (workspace BYOK or platform env).
  const aiActive = await resolveActiveProvider(
    ctx,
    'ai',
    process.env.AI_PROVIDER,
  );
  let aiDone = false;
  let aiWhy: string | undefined;
  if (aiActive.id === 'mock') {
    aiWhy = 'Active AI provider is mock — pick a real provider.';
  } else {
    const secretKey =
      aiActive.id === 'openai' ? 'openai.apiKey' :
      aiActive.id === 'anthropic' ? 'anthropic.apiKey' :
      aiActive.id === 'gemini' ? 'gemini.apiKey' :
      null;
    const envVar =
      aiActive.id === 'openai' ? 'OPENAI_API_KEY' :
      aiActive.id === 'anthropic' ? 'ANTHROPIC_API_KEY' :
      aiActive.id === 'gemini' ? 'GEMINI_API_KEY' :
      null;
    if (!secretKey || !envVar) {
      aiWhy = `Unsupported AI provider id: ${aiActive.id}`;
    } else {
      const resolved = await resolveProviderKey(ctx, secretKey, envVar);
      if (!resolved) {
        aiWhy = `${aiActive.id} is selected but no key is configured.`;
      } else {
        aiDone = true;
      }
    }
  }

  // ─── Step 2b: web search ────────────────────────────────────────────
  // Discovery is only real when the effective Web Search backend isn't
  // mock. Mirrors getWebSearchProviderForCtx: an explicit workspace
  // research provider wins; otherwise the grounded fallback counts when
  // a Gemini key is reachable; otherwise env SEARCH_PROVIDER decides.
  const { getProviderSettings } = await import('./provider-settings');
  const providerSettings = await getProviderSettings(ctx);
  const researchChoice = providerSettings.researchProvider?.trim();
  const searchChoice = providerSettings.searchProvider?.trim();
  let searchDone = false;
  let searchWhy: string | undefined;
  if (researchChoice === 'gemini' || researchChoice === 'perplexity') {
    searchDone = true;
  } else if ((searchChoice ?? process.env.SEARCH_PROVIDER ?? 'mock') === 'serpapi') {
    searchDone = true;
  } else if (!researchChoice && !searchChoice) {
    const geminiKey = await resolveProviderKey(ctx, 'gemini.apiKey', 'GEMINI_API_KEY');
    if (geminiKey) {
      searchDone = true; // grounded-Gemini fallback will serve discovery
    } else {
      searchWhy =
        'No real search backend — discovery would return mock data. Pick Gemini or Perplexity under Web Search, or configure SerpAPI.';
    }
  } else {
    searchWhy =
      'Web Search is set to mock — discovery returns fake results until you pick a real backend.';
  }

  // ─── Step 3: mailbox ───────────────────────────────────────────────
  const [mailboxRow] = await db
    .select({ c: count() })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.status, 'active'),
      ),
    );
  const mailboxDone = Number(mailboxRow?.c ?? 0) > 0;

  // ─── Step 4: product ───────────────────────────────────────────────
  const [productRow] = await db
    .select({ c: count() })
    .from(productProfiles)
    .where(
      and(
        eq(productProfiles.workspaceId, ctx.workspaceId),
        eq(productProfiles.active, true),
      ),
    );
  const productDone = Number(productRow?.c ?? 0) > 0;

  // ─── Step 5: connector ─────────────────────────────────────────────
  const [connectorRow] = await db
    .select({ c: count() })
    .from(connectors)
    .where(
      and(
        eq(connectors.workspaceId, ctx.workspaceId),
        eq(connectors.active, true),
      ),
    );
  const connectorDone = Number(connectorRow?.c ?? 0) > 0;

  // ─── Step 6: first discovery run ──────────────────────────────────
  // Configuration is done; this is the first VALUE moment — records in
  // the funnel. Any source record counts, however it was discovered.
  const [recordRow] = await db
    .select({ c: count() })
    .from(sourceRecords)
    .where(eq(sourceRecords.workspaceId, ctx.workspaceId));
  const runDone = Number(recordRow?.c ?? 0) > 0;

  // ─── Step 7: first review decision ─────────────────────────────────
  // Approving/rejecting the first leads teaches the learning memory and
  // unlocks outreach — a lead only becomes contactable once approved.
  const [decisionRow] = await db
    .select({ c: count() })
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.workspaceId, ctx.workspaceId),
        inArray(reviewItems.state, ['approved', 'rejected']),
      ),
    );
  const reviewDone = Number(decisionRow?.c ?? 0) > 0;

  // In simple mode a failing ai/search step is a PLATFORM problem (the
  // system key is missing server-side) — the user can't fix it from the
  // integrations page, so say so instead of sending them there.
  if (simple && !aiDone) {
    aiWhy =
      'The platform’s system AI key is not configured — contact support.';
  }
  if (simple && !searchDone) {
    searchWhy =
      'The platform’s system web-search backend is not configured — contact support.';
  }

  const steps: OnboardingStep[] = [
    {
      key: 'setup',
      title: 'Choose your setup',
      blurb:
        'Simple: your workspace runs on the platform’s system API keys and default providers — nothing to configure, ready to work as soon as you have tokens or a subscription. Advanced: same system defaults out of the box, but you can change providers and bring your own API keys under Settings → Integrations at any time.',
      done: setupDone,
      href: '/onboarding#setup',
      why: setupDone ? undefined : 'Pick Simple or Advanced to continue.',
    },
    {
      key: 'plan',
      title: 'Pick a plan',
      blurb:
        'Subscriptions are live (Starter / Pro via Stripe), and every new workspace starts with 500 free tokens — the prepaid currency that metered work (discovery, AI qualification, drafting, translation) spends. Top up anytime under Settings → Billing.',
      done: planDone,
      href: '/onboarding#plan',
    },
    {
      key: 'ai',
      title: simple ? 'AI provider — system default' : 'Connect an AI provider',
      blurb: simple
        ? 'Drafts, qualification, and reply assistance run on the platform’s system AI key — nothing to configure. Usage is billed from your token balance.'
        : 'Drafts, qualification, and reply assistance need a real LLM. The system default works out of the box; bring your own OpenAI / Anthropic / Gemini key in Active providers to run on your own account instead (BYOK usage is token-free).',
      done: aiDone,
      href: '/settings/integrations',
      why: aiWhy,
    },
    {
      key: 'search',
      title: simple
        ? 'Web Search — system default'
        : 'Pick a Web Search backend',
      blurb: simple
        ? 'Discovery finds companies via the platform’s system web-search backend (grounded Gemini search) — nothing to configure. Usage is billed from your token balance.'
        : 'Discovery finds companies via grounded web search. Gemini grounding is the recommended backend (used automatically when available); SerpAPI is the alternative.',
      done: searchDone,
      href: '/settings/integrations',
      why: searchWhy,
    },
    {
      key: 'mailbox',
      title: 'Connect a mailbox',
      blurb:
        'SMTP for sending, IMAP for inbound replies. Without one, generated drafts can’t be sent.',
      done: mailboxDone,
      href: '/mailbox/new',
      why: mailboxDone ? undefined : 'No active mailbox yet.',
    },
    {
      key: 'product',
      title: 'Create your first product',
      blurb:
        'Products define what you sell. Discovery, qualification, and outreach all read from the product profile — description, sectors, keywords, and outreach language.',
      done: productDone,
      href: '/products/new',
      why: productDone ? undefined : 'No active product profile yet.',
    },
    {
      key: 'connector',
      title: 'Configure a connector',
      blurb:
        'Connectors run discovery so leads flow into the review queue. Important: set the TARGET COUNTRY and language on each recipe — the geography gate rejects companies outside the recipe’s country, at qualification and again before any email is sent.',
      done: connectorDone,
      href: '/connectors',
      why: connectorDone ? undefined : 'No active connector yet.',
    },
    {
      key: 'run',
      title: 'Run your first discovery',
      blurb:
        'Start a run from the connector (or let the Crawl Engine schedule fire). Discovered companies land in the review queue, already AI-qualified against your product and geo-checked against the recipe’s country.',
      done: runDone,
      href: '/connectors',
      why: runDone ? undefined : 'No records discovered yet — start a run on your connector.',
    },
    {
      key: 'review',
      title: 'Review your first leads',
      blurb:
        'Approve or reject what discovery found. Approvals become contactable leads; every decision (and comment) trains the learning memory, so the platform qualifies better each week.',
      done: reviewDone,
      href: '/review',
      why: reviewDone ? undefined : 'No approve/reject decisions yet.',
    },
  ];

  const nextStepIdx = steps.findIndex((s) => !s.done);
  const allDone = nextStepIdx === -1;
  const effectivelyComplete =
    ws.onboardingStatus === 'completed' || allDone;

  return {
    workspace: ws,
    steps,
    nextStepIdx,
    effectivelyComplete,
  };
}

/** Mark the wizard as complete. Idempotent — repeated calls are no-ops. */
export async function markOnboardingComplete(
  ctx: WorkspaceContext,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw denied('onboarding.complete');
  const [updated] = await db
    .update(workspaces)
    .set({ onboardingStatus: 'completed', updatedAt: new Date() })
    .where(eq(workspaces.id, ctx.workspaceId))
    .returning({ status: workspaces.onboardingStatus });
  if (updated && updated.status === 'completed') {
    await recordAuditEvent(ctx, {
      kind: 'onboarding.complete',
      entityType: 'workspace',
      entityId: ctx.workspaceId,
    });
  }
}

/**
 * Choose (or later change) the workspace setup mode. Admin-only.
 *
 * Switching to 'simple' resets the workspace's provider-selection
 * overrides to NULL so the workspace genuinely runs on the system
 * defaults. Stored BYOK keys are NOT deleted — that would be
 * destructive — but note they still take precedence for key
 * resolution; the integrations summary shows the effective source so
 * nothing is hidden.
 */
export async function setSetupMode(
  ctx: WorkspaceContext,
  mode: SetupMode,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw denied('onboarding.setup_mode');
  if (mode !== 'simple' && mode !== 'advanced') {
    throw new OnboardingError(`unknown setup mode: ${mode}`, 'invalid_input');
  }
  await db
    .update(workspaces)
    .set({ setupMode: mode, updatedAt: new Date() })
    .where(eq(workspaces.id, ctx.workspaceId));
  if (mode === 'simple') {
    const { updateProviderSettings } = await import('./provider-settings');
    await updateProviderSettings(ctx, {
      aiProvider: null,
      aiModel: null,
      embeddingProvider: null,
      researchProvider: null,
      researchModel: null,
      searchProvider: null,
      vectorStorageProvider: null,
      qualificationProvider: null,
      qualificationModel: null,
    });
  }
  await recordAuditEvent(ctx, {
    kind: 'onboarding.setup_mode',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { mode },
  });
}

/**
 * Move the wizard to `in_progress` if it's still `pending`. Used when
 * the operator first lands on /onboarding so the dashboard knows
 * they've at least started.
 */
export async function markOnboardingStarted(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<void> {
  await db
    .update(workspaces)
    .set({ onboardingStatus: 'in_progress', updatedAt: new Date() })
    .where(
      and(
        eq(workspaces.id, ctx.workspaceId),
        eq(workspaces.onboardingStatus, 'pending'),
      ),
    );
}
