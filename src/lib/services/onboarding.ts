// Onboarding wizard service (Phase 47).
//
// Computes per-step completion for the /onboarding flow + lets the
// operator advance / dismiss the wizard. The wizard is workspace-scoped
// and any admin can run it; non-admins see a read-only view.
//
// Steps:
//   1. plan          — pricing / subscription. Today: trial banner +
//                      placeholder for Stripe checkout.
//   2. ai            — AI provider selected + key reachable.
//   3. mailbox       — at least one mailbox configured.
//   4. product       — at least one active product profile.
//   5. connector     — at least one connector configured.
//
// Each step returns a boolean `done`. The wizard is "completed" once
// every step is done OR the operator clicks Skip / Finish.

import { and, count, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { connectors } from '@/lib/db/schema/connectors';
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
  | 'plan'
  | 'ai'
  | 'mailbox'
  | 'product'
  | 'connector';

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
      null;
    const envVar =
      aiActive.id === 'openai' ? 'OPENAI_API_KEY' :
      aiActive.id === 'anthropic' ? 'ANTHROPIC_API_KEY' :
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

  const steps: OnboardingStep[] = [
    {
      key: 'plan',
      title: 'Pick a plan',
      blurb:
        'Subscription billing is rolling out next phase. For now every workspace gets full feature access while you set things up.',
      done: planDone,
      href: '/onboarding#plan',
    },
    {
      key: 'ai',
      title: 'Connect an AI provider',
      blurb:
        'Drafts, qualification, and reply assistance need a real LLM. Pick OpenAI or Anthropic in Active providers and paste your API key.',
      done: aiDone,
      href: '/settings/integrations',
      why: aiWhy,
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
        'Products define what you sell. Discovery, qualification, and outreach all read from the product profile.',
      done: productDone,
      href: '/products/new',
      why: productDone ? undefined : 'No active product profile yet.',
    },
    {
      key: 'connector',
      title: 'Configure a connector',
      blurb:
        'Connectors run discovery against the providers you have configured (SerpAPI, directory harvesters, etc.) so leads flow into the review queue.',
      done: connectorDone,
      href: '/connectors',
      why: connectorDone ? undefined : 'No active connector yet.',
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
