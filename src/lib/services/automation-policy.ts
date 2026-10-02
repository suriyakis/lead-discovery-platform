// PC-13 (+ the backend of flow:F-08 and the ia:F-17 resolver): one answer
// to "what runs on its own in this workspace — for which product — and if
// not, why not".
//
//   resolveAutomationPolicy(ctx)
//                     the workspace's AutomationPolicy: the automation gate's
//                     state (pause, holds, platform stop, owner, go-live,
//                     wallet, plan) plus the configuration of every automatic
//                     path (autopilot and its per-product overlays, the send
//                     queue, follow-ups, inbox sync, reply auto-actions and
//                     drafting, background AI, trash purge, auto top-up),
//                     resolved into one `paths` line per path. The only
//                     reader of autopilot_settings' step switches and of
//                     autopilot_product_settings.
//   workspacesForTick()
//                     every active workspace with its policy (batched: a
//                     fixed number of queries whatever the workspace count)
//                     — the list each background tick iterates, asking
//                     tickVerdict(policy, tick) whether to run.
//   productPolicy(policy, productId)
//                     the resolved autopilot for one product. Overlays are
//                     NARROW-ONLY (I020): a product inherits the workspace,
//                     turns a step (or autopilot) off, raises the threshold,
//                     or is paused; it can never switch on what the
//                     workspace has off.
//   getAutomationState(ctx)
//                     read model for the header pill (ia:F-17): Stopped by
//                     platform > Paused > Blocked > Autopilot on > Manual,
//                     "Partly paused", degradations (amber dot), a one-liner
//                     generated from the real configuration, and "What runs
//                     right now" (the paths). UI lands later (F-08 / PC-34).
//   autopilotFlow(policy, productId)
//                     the /autopilot flow view, rendered from the policy.
//
// Everything that decides is pure (buildAutomationPolicy, productPolicy,
// tickVerdict, describeAutomationState, autopilotFlow) so tests drive it
// table-first; the loaders only gather inputs.

import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import {
  autopilotProductSettings,
  autopilotSettings,
  type AutopilotSettings,
} from '@/lib/db/schema/autopilot';
import { crawlPlans } from '@/lib/db/schema/connectors';
import { mailboxes, replyAutoActions } from '@/lib/db/schema/mailing';
import { productProfiles } from '@/lib/db/schema/products';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  CAPABILITY_LABELS,
  activeWorkspacesForTicks,
  decideGate,
  holdCovers,
  loadAutomationStates,
  ownerProblemMessage,
  type AutomationCapability,
  type AutomationState,
  type GateItemOptions,
  type GateRefusal,
  type TickWorkspace,
} from './automation-gate';
import type { WorkspaceContext } from './context';

// ---- autopilot steps ----------------------------------------------------

/** The four autopilot steps, in the order runOnce runs them. */
export const AUTOPILOT_STEP_KEYS = [
  'auto_approve_projects',
  'auto_enqueue_outreach',
  'auto_crm_contact_sync',
  'auto_crm_deal_on_qualified',
] as const;
export type AutopilotStepKey = (typeof AUTOPILOT_STEP_KEYS)[number];

/** The settings column of each step (workspace row and overlay alike). */
export const AUTOPILOT_STEP_FIELDS = {
  auto_approve_projects: 'enableAutoApproveProjects',
  auto_enqueue_outreach: 'enableAutoEnqueueOutreach',
  auto_crm_contact_sync: 'enableAutoCrmContactSync',
  auto_crm_deal_on_qualified: 'enableAutoCrmDealOnQualified',
} as const satisfies Record<AutopilotStepKey, keyof AutopilotSettings>;
export type AutopilotStepField = (typeof AUTOPILOT_STEP_FIELDS)[AutopilotStepKey];

/** Operator-facing step names (/autopilot, the state one-liner). */
export const AUTOPILOT_STEP_LABELS: Readonly<Record<AutopilotStepKey, string>> = {
  auto_approve_projects: 'Auto-approve relevant review items',
  auto_enqueue_outreach: 'Generate + queue outreach drafts',
  auto_crm_contact_sync: "Sync qualified leads' contacts to the CRM",
  auto_crm_deal_on_qualified: 'Create CRM deals for qualified leads',
};

/** Short names for sentences ("auto-approve and generate + queue"). */
const STEP_SHORT: Readonly<Record<AutopilotStepKey, string>> = {
  auto_approve_projects: 'auto-approve',
  auto_enqueue_outreach: 'generate + queue',
  auto_crm_contact_sync: 'CRM contact sync',
  auto_crm_deal_on_qualified: 'CRM deals',
};

/** The capability a step needs besides Autopilot (null: Autopilot only). */
export const AUTOPILOT_STEP_CAPABILITY: Readonly<
  Record<AutopilotStepKey, AutomationCapability | null>
> = {
  auto_approve_projects: null,
  auto_enqueue_outreach: 'sending',
  auto_crm_contact_sync: 'crm_sync',
  auto_crm_deal_on_qualified: 'crm_sync',
};

/** autopilot_settings column defaults, for a workspace with no row yet. */
export const AUTOPILOT_DEFAULTS = {
  autopilotEnabled: false,
  enableAutoApproveProjects: false,
  autoApproveThreshold: 70,
  enableAutoEnqueueOutreach: false,
  enableAutoCrmContactSync: false,
  enableAutoCrmDealOnQualified: false,
  maxApprovalsPerRun: 20,
  maxEnqueuesPerRun: 20,
  defaultMailboxId: null,
  defaultCrmConnectionId: null,
} as const;

// ---- policy types -------------------------------------------------------

/** Why a step does (not) run for one product. */
export type StepStatus =
  | 'on'
  /** The workspace has the step off. */
  | 'workspace_off'
  /** The workspace has autopilot (the master) off. */
  | 'autopilot_off'
  /** The product's overlay turns this step off. */
  | 'product_off'
  /** The product's overlay turns autopilot off for it. */
  | 'product_autopilot_off'
  /** The product is paused. */
  | 'product_paused';

export interface ProductPause {
  since: Date;
  byUserId: string | null;
}

/** The workspace's autopilot configuration. */
export interface AutopilotPolicy {
  /** The master switch. */
  enabled: boolean;
  /** The effective plan includes autopilot. */
  planAllows: boolean;
  steps: Readonly<Record<AutopilotStepKey, boolean>>;
  autoApproveThreshold: number;
  maxApprovalsPerRun: number;
  maxEnqueuesPerRun: number;
  defaultMailboxId: bigint | null;
  defaultCrmConnectionId: bigint | null;
}

/** A product's overlay row as the resolver needs it (narrow-only values). */
export interface ProductOverlayInput {
  productProfileId: bigint;
  productName: string;
  autopilotEnabled: boolean | null;
  enableAutoApproveProjects: boolean | null;
  autoApproveThreshold: number | null;
  enableAutoEnqueueOutreach: boolean | null;
  enableAutoCrmContactSync: boolean | null;
  enableAutoCrmDealOnQualified: boolean | null;
  defaultMailboxId: bigint | null;
  pausedAt: Date | null;
  pausedByUserId: string | null;
}

/** Autopilot resolved for one product. */
export interface ProductPolicy {
  productProfileId: bigint;
  /** null for a product without an overlay row (its name is not loaded). */
  productName: string | null;
  /** Some override narrows the workspace for this product. */
  hasOverrides: boolean;
  pause: ProductPause | null;
  /** Autopilot runs for this product at all (master on, not off, not paused). */
  autopilotEnabled: boolean;
  steps: Readonly<Record<AutopilotStepKey, StepStatus>>;
  /** The higher of the workspace's and the product's threshold. */
  autoApproveThreshold: number;
  defaultMailboxId: bigint | null;
}

export interface PausedProduct {
  productProfileId: bigint;
  productName: string;
  pause: ProductPause;
}

/** Background ticks (registered by lib/jobs/repeatables.ts). */
export const AUTOMATION_TICKS = [
  'autopilot.tick',
  'outreach.drain.tick',
  'mail.imap.tick',
  'outreach.follow_up.tick',
  'knowledge.compact.tick',
  'mail.trash.purge.tick',
  'crawl.engine.tick',
  'health.check.tick',
] as const;
export type AutomationTick = (typeof AUTOMATION_TICKS)[number];

export type AutomationPathKey =
  | 'discovery'
  | 'autopilot'
  | 'sending'
  | 'follow_ups'
  | 'inbox_sync'
  | 'reply_actions'
  | 'reply_drafts'
  | 'knowledge'
  | 'health_check'
  | 'trash_purge'
  | 'auto_topup';

/**
 *   runs     runs as configured
 *   partial  runs, but part of it waits (a paused product, the go-live
 *            hold, a failing mailbox, the AI half of the health check)
 *   held     configured to run, but the gate stops it now (the pause, a
 *            hold, the platform stop, no accountable owner, the plan, an
 *            empty wallet)
 *   off      not configured to run
 */
export type PathStatus = 'runs' | 'partial' | 'held' | 'off';

/** One automatic path: a line of "What runs right now". */
export interface AutomationPath {
  key: AutomationPathKey;
  label: string;
  /** The registered background ticks that run it; [] for work done inline
   *  (on each synced reply, on a debit). */
  ticks: readonly AutomationTick[];
  /** When it runs, in words. */
  cadence: string;
  capability: AutomationCapability;
  status: PathStatus;
  /** One sentence: what it does now, or why it waits. */
  detail: string;
}

export interface AutomationPolicy {
  workspaceId: bigint;
  evaluatedAt: Date;
  /** The automation gate's inputs. */
  state: AutomationState;
  autopilot: AutopilotPolicy;
  /** Products with an overlay row (overrides or a pause), by id. Any other
   *  product inherits the workspace (productPolicy). */
  products: readonly ProductPolicy[];
  pausedProducts: readonly PausedProduct[];
  followUps: { enabled: boolean; requireApproval: boolean };
  inbox: {
    /** "Mailbox auto-sync" (workspaces.imap_auto_sync_enabled). */
    autoSync: boolean;
    imapMailboxes: number;
    failingMailboxes: number;
  };
  replies: {
    autoDraft: boolean;
    autoSuppressUnsubscribe: boolean;
    autoSuppressBounce: boolean;
    autoCloseNegative: boolean;
    autoExtractRedirects: boolean;
  };
  discovery: { enabledPlans: number };
  healthCheck: { enabled: boolean; intervalDays: number };
  trash: { retentionDays: number };
  autoTopUp: { enabled: boolean };
  /** One line per automatic path, in "What runs right now" order. */
  paths: readonly AutomationPath[];
}

/** Everything buildAutomationPolicy needs; the loaders gather it. */
export interface AutomationPolicyInputs {
  state: AutomationState;
  autopilot: Omit<AutopilotPolicy, 'planAllows'>;
  overlays: readonly ProductOverlayInput[];
  workspace: {
    followUpEnabled: boolean;
    followUpRequireApproval: boolean;
    imapAutoSyncEnabled: boolean;
    autoDraftReplies: boolean;
    autoTopupEnabled: boolean;
    healthCheckEnabled: boolean;
    healthCheckIntervalDays: number;
    trashRetentionDays: number;
  };
  replyActions: {
    autoSuppressUnsubscribe: boolean;
    autoSuppressBounce: boolean;
    autoCloseNegative: boolean;
    autoExtractRedirects: boolean;
  };
  enabledCrawlPlans: number;
  imapMailboxes: number;
  failingMailboxes: number;
}

// ---- pure resolution ------------------------------------------------------

function overlayStepValue(o: ProductOverlayInput, step: AutopilotStepKey): boolean | null {
  return o[AUTOPILOT_STEP_FIELDS[step]];
}

/**
 * Autopilot for one product: the workspace, narrowed by the overlay. An
 * overlay value of true is ignored (narrow-only — the service and a CHECK
 * constraint refuse to store one; this keeps the resolver honest if one
 * ever slips in). Precedence per step: product paused > workspace master
 * off > product master off > workspace step off > product step off.
 */
export function resolveProductPolicy(
  autopilot: Pick<
    AutopilotPolicy,
    'enabled' | 'steps' | 'autoApproveThreshold' | 'defaultMailboxId'
  >,
  overlay: ProductOverlayInput | null,
  productProfileId: bigint,
): ProductPolicy {
  const pause: ProductPause | null = overlay?.pausedAt
    ? { since: overlay.pausedAt, byUserId: overlay.pausedByUserId }
    : null;
  const productAutopilotOff = overlay?.autopilotEnabled === false;
  const steps = {} as Record<AutopilotStepKey, StepStatus>;
  for (const step of AUTOPILOT_STEP_KEYS) {
    let status: StepStatus = 'on';
    if (pause) status = 'product_paused';
    else if (!autopilot.enabled) status = 'autopilot_off';
    else if (productAutopilotOff) status = 'product_autopilot_off';
    else if (!autopilot.steps[step]) status = 'workspace_off';
    else if (overlay && overlayStepValue(overlay, step) === false) status = 'product_off';
    steps[step] = status;
  }
  const hasOverrides =
    overlay !== null &&
    (overlay.autopilotEnabled === false ||
      AUTOPILOT_STEP_KEYS.some((s) => overlayStepValue(overlay, s) === false) ||
      overlay.autoApproveThreshold !== null ||
      overlay.defaultMailboxId !== null);
  return {
    productProfileId,
    productName: overlay?.productName ?? null,
    hasOverrides,
    pause,
    autopilotEnabled: autopilot.enabled && !productAutopilotOff && pause === null,
    steps,
    autoApproveThreshold: Math.max(
      autopilot.autoApproveThreshold,
      overlay?.autoApproveThreshold ?? 0,
    ),
    defaultMailboxId: overlay?.defaultMailboxId ?? autopilot.defaultMailboxId,
  };
}

/** The resolved autopilot of a product (an inheriting one when it has no
 *  overlay row). */
export function productPolicy(policy: AutomationPolicy, productProfileId: bigint): ProductPolicy {
  return (
    policy.products.find((p) => p.productProfileId === productProfileId) ??
    resolveProductPolicy(policy.autopilot, null, productProfileId)
  );
}

/** Products a step does not run for although the workspace runs it (off or
 *  paused for the product): runOnce leaves them out of its candidates. */
export function productsExcludedFromStep(
  policy: AutomationPolicy,
  step: AutopilotStepKey,
): bigint[] {
  return policy.products
    .filter((p) => p.steps[step] !== 'on')
    .map((p) => p.productProfileId);
}

function gate(
  state: AutomationState,
  capability: AutomationCapability,
  item: GateItemOptions = {},
): GateRefusal | null {
  const d = decideGate(state, capability, { ...item, manual: false });
  return d.allowed ? null : d;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Held: <gate message>" without doubling a leading "Held:". */
function heldDetail(refusal: GateRefusal): string {
  return /^held:/i.test(refusal.message) ? refusal.message : `Held: ${refusal.message}`;
}

/** The names of the paused products, for a sentence. */
function pausedNames(paused: readonly PausedProduct[]): string {
  return list(paused.map((p) => p.productName));
}

function buildPaths(p: Omit<AutomationPolicy, 'paths'>): AutomationPath[] {
  const { state } = p;
  const paths: AutomationPath[] = [];
  const pausedNote =
    p.pausedProducts.length === 0
      ? ''
      : p.pausedProducts.length === 1
        ? ` The paused product ${pausedNames(p.pausedProducts)} waits until it is resumed.`
        : ` The paused products ${pausedNames(p.pausedProducts)} wait until they are resumed.`;

  // Discovery: scheduled crawls.
  {
    const refusal = gate(state, 'discovery', { spendsTokens: true });
    const base = {
      key: 'discovery' as const,
      label: 'Scheduled crawls',
      ticks: ['crawl.engine.tick'] as const,
      cadence: 'checked every 5 minutes; each crawl plan runs on its own interval',
      capability: 'discovery' as const,
    };
    if (p.discovery.enabledPlans === 0) {
      paths.push({
        ...base,
        status: 'off',
        detail: 'No crawl plan is enabled: discovery runs only when someone starts it.',
      });
    } else if (refusal) {
      paths.push({ ...base, status: 'held', detail: heldDetail(refusal) });
    } else {
      paths.push({
        ...base,
        status: 'runs',
        detail: `${plural(p.discovery.enabledPlans, 'crawl plan')} run${p.discovery.enabledPlans === 1 ? 's' : ''} on schedule; found records are qualified against your products.`,
      });
    }
  }

  // Autopilot.
  {
    const base = {
      key: 'autopilot' as const,
      label: 'Autopilot',
      ticks: ['autopilot.tick'] as const,
      cadence: 'every 5 minutes, and right after each crawl that found records',
      capability: 'autopilot' as const,
    };
    const onSteps = AUTOPILOT_STEP_KEYS.filter((s) => p.autopilot.steps[s]);
    if (!p.autopilot.enabled) {
      paths.push({
        ...base,
        status: 'off',
        detail: 'Autopilot is off: nothing is approved, drafted or sent to the CRM for you.',
      });
    } else if (onSteps.length === 0) {
      paths.push({
        ...base,
        status: 'off',
        detail: 'Autopilot is on, but every step is off, so it does nothing.',
      });
    } else {
      const refusal = gate(state, 'autopilot');
      if (refusal) {
        paths.push({ ...base, status: 'held', detail: heldDetail(refusal) });
      } else {
        const what = onSteps.map((s) =>
          s === 'auto_approve_projects'
            ? `auto-approve (score ≥ ${p.autopilot.autoApproveThreshold})`
            : STEP_SHORT[s],
        );
        const narrowed = p.products.filter(
          (pp) => pp.pause === null && onSteps.some((s) => pp.steps[s] !== 'on'),
        ).length;
        const narrowNote =
          narrowed > 0
            ? ` ${plural(narrowed, 'product')} ${narrowed === 1 ? 'has' : 'have'} steps switched off.`
            : '';
        paths.push({
          ...base,
          status: p.pausedProducts.length > 0 ? 'partial' : 'runs',
          detail: `Runs ${list(what)} every 5 minutes.${narrowNote}${pausedNote}`,
        });
      }
    }
  }

  // The send queue: always on in the background.
  {
    const base = {
      key: 'sending' as const,
      label: 'Send queue',
      ticks: ['outreach.drain.tick'] as const,
      cadence: 'every 30 seconds',
      capability: 'sending' as const,
    };
    const refusal = gate(state, 'sending');
    if (refusal) {
      paths.push({ ...base, status: 'held', detail: heldDetail(refusal) });
    } else {
      const notes: string[] = [];
      if (!state.live) {
        notes.push(
          'Not live yet: cold emails and AI reply drafts wait in the queue until the platform releases the workspace; email you write yourself sends normally.',
        );
      }
      if (p.inbox.failingMailboxes > 0) {
        notes.push(
          `${plural(p.inbox.failingMailboxes, 'failing mailbox', 'failing mailboxes')} hold${p.inbox.failingMailboxes === 1 ? 's' : ''} its queued emails.`,
        );
      }
      paths.push({
        ...base,
        status: notes.length > 0 || p.pausedProducts.length > 0 ? 'partial' : 'runs',
        detail: `Approved emails send automatically every 30 seconds, within each mailbox's sending window and the daily cap.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}${pausedNote}`,
      });
    }
  }

  // Follow-ups.
  {
    const base = {
      key: 'follow_ups' as const,
      label: 'Follow-ups',
      ticks: ['outreach.follow_up.tick'] as const,
      cadence: 'every hour',
      capability: 'sending' as const,
    };
    if (!p.followUps.enabled) {
      paths.push({ ...base, status: 'off', detail: 'Follow-ups are off.' });
    } else {
      const refusal = gate(state, 'sending', { origin: 'follow_up', spendsTokens: true });
      if (refusal) {
        paths.push({ ...base, status: 'held', detail: heldDetail(refusal) });
      } else {
        paths.push({
          ...base,
          status: p.pausedProducts.length > 0 ? 'partial' : 'runs',
          detail: `${
            p.followUps.requireApproval
              ? 'Due follow-ups are written by AI and wait for your approval before they send.'
              : 'Due follow-ups are written by AI and send automatically, without approval.'
          }${pausedNote}`,
        });
      }
    }
  }

  // Inbox sync.
  {
    const base = {
      key: 'inbox_sync' as const,
      label: 'Inbox sync',
      ticks: ['mail.imap.tick'] as const,
      cadence: 'every 2 minutes (15 when a mailbox is quiet)',
      capability: 'inbox_sync' as const,
    };
    if (!p.inbox.autoSync) {
      paths.push({
        ...base,
        status: 'off',
        detail: 'Mailbox auto-sync is off: mail is read only when someone clicks Sync.',
      });
    } else if (p.inbox.imapMailboxes === 0 && p.inbox.failingMailboxes === 0) {
      paths.push({ ...base, status: 'off', detail: 'No mailbox receives mail (IMAP) yet.' });
    } else {
      const refusal = gate(state, 'inbox_sync');
      if (refusal) {
        paths.push({ ...base, status: 'held', detail: heldDetail(refusal) });
      } else if (p.inbox.failingMailboxes > 0) {
        paths.push({
          ...base,
          status: 'partial',
          detail: `Replies are read every 2 minutes; ${plural(p.inbox.failingMailboxes, 'failing mailbox', 'failing mailboxes')} ${p.inbox.failingMailboxes === 1 ? 'is' : 'are'} only re-checked, with a growing delay.`,
        });
      } else {
        paths.push({ ...base, status: 'runs', detail: 'Replies are read every 2 minutes.' });
      }
    }
  }

  // Reply auto-actions (inline, on each synced reply to your outreach).
  {
    const base = {
      key: 'reply_actions' as const,
      label: 'Reply auto-actions',
      ticks: [] as const,
      cadence: 'on each reply to your outreach',
      capability: 'inbound_actions' as const,
    };
    const on: string[] = [];
    if (p.replies.autoSuppressUnsubscribe) on.push('suppress the sender on an unsubscribe');
    if (p.replies.autoSuppressBounce) on.push('suppress the sender on a bounce');
    if (p.replies.autoCloseNegative) on.push('close the lead on a negative reply');
    if (p.replies.autoExtractRedirects) on.push('create contacts from redirect replies');
    if (on.length === 0) {
      paths.push({
        ...base,
        status: 'off',
        detail: 'Off: replies are classified and shown to you; you decide what to do.',
      });
    } else {
      const refusal = gate(state, 'inbound_actions');
      paths.push(
        refusal
          ? { ...base, status: 'held', detail: heldDetail(refusal) }
          : {
              ...base,
              status: 'runs',
              detail: `${upperFirst(list(on))}.`,
            },
      );
    }
  }

  // AI reply drafts (inline).
  {
    const base = {
      key: 'reply_drafts' as const,
      label: 'AI reply drafts',
      ticks: [] as const,
      cadence: 'on each reply to your outreach',
      capability: 'background_ai' as const,
    };
    if (!p.replies.autoDraft) {
      paths.push({
        ...base,
        status: 'off',
        detail: 'Off: you write every reply yourself.',
      });
    } else {
      const refusal = gate(state, 'background_ai', { spendsTokens: true });
      paths.push(
        refusal
          ? { ...base, status: 'held', detail: heldDetail(refusal) }
          : {
              ...base,
              status: p.pausedProducts.length > 0 ? 'partial' : 'runs',
              detail: `AI drafts the next reply on lead threads for your review; nothing is sent until you approve it.${pausedNote}`,
            },
      );
    }
  }

  // Knowledge compaction + learning synthesis.
  {
    const base = {
      key: 'knowledge' as const,
      label: 'Knowledge compaction',
      ticks: ['knowledge.compact.tick'] as const,
      cadence: 'weekly',
      capability: 'background_ai' as const,
    };
    const refusal = gate(state, 'background_ai', { spendsTokens: true });
    paths.push(
      refusal
        ? { ...base, status: 'held', detail: heldDetail(refusal) }
        : {
            ...base,
            status: 'runs',
            detail:
              'Weekly: merges duplicate lessons and proposes new ones from recent decisions and replies.',
          },
    );
  }

  // Health check.
  {
    const base = {
      key: 'health_check' as const,
      label: 'Health check',
      ticks: ['health.check.tick'] as const,
      cadence: `every ${plural(p.healthCheck.intervalDays, 'day')}`,
      capability: 'background_ai' as const,
    };
    if (!p.healthCheck.enabled) {
      paths.push({ ...base, status: 'off', detail: 'The scheduled health check is off.' });
    } else {
      const refusal = gate(state, 'background_ai', { spendsTokens: true });
      paths.push(
        refusal
          ? {
              ...base,
              status: 'partial',
              detail: `Checks the setup every ${plural(p.healthCheck.intervalDays, 'day')}; the AI review of recent conversations waits. ${heldDetail(refusal)}`,
            }
          : {
              ...base,
              status: 'runs',
              detail: `Every ${plural(p.healthCheck.intervalDays, 'day')}: checks the setup and has AI review recent conversations.`,
            },
      );
    }
  }

  // Trash purge.
  {
    const base = {
      key: 'trash_purge' as const,
      label: 'Trash purge',
      ticks: ['mail.trash.purge.tick'] as const,
      cadence: 'daily',
      capability: 'trash_purge' as const,
    };
    if (p.trash.retentionDays <= 0) {
      paths.push({ ...base, status: 'off', detail: 'Off: Trash is kept until someone empties it.' });
    } else {
      const refusal = gate(state, 'trash_purge');
      paths.push(
        refusal
          ? { ...base, status: 'held', detail: heldDetail(refusal) }
          : {
              ...base,
              status: 'runs',
              detail: `Daily: messages in Trash for more than ${plural(p.trash.retentionDays, 'day')} are deleted for good.`,
            },
      );
    }
  }

  // Auto top-up (inline, on a debit that crosses the low-balance line).
  {
    const base = {
      key: 'auto_topup' as const,
      label: 'Auto top-up',
      ticks: [] as const,
      cadence: 'when the wallet runs low',
      capability: 'auto_topup' as const,
    };
    if (!p.autoTopUp.enabled) {
      paths.push({ ...base, status: 'off', detail: 'Off: tokens are bought by hand.' });
    } else {
      const refusal = gate(state, 'auto_topup');
      paths.push(
        refusal
          ? { ...base, status: 'held', detail: heldDetail(refusal) }
          : {
              ...base,
              status: 'runs',
              detail: 'Buys the chosen token pack with the saved card when the wallet runs low.',
            },
      );
    }
  }

  return paths;
}

/** The policy from its inputs. Pure. */
export function buildAutomationPolicy(input: AutomationPolicyInputs): AutomationPolicy {
  const autopilot: AutopilotPolicy = {
    ...input.autopilot,
    planAllows: input.state.planAllowsAutopilot,
  };
  const overlays = [...input.overlays].sort((a, b) =>
    a.productProfileId < b.productProfileId ? -1 : a.productProfileId > b.productProfileId ? 1 : 0,
  );
  const products = overlays.map((o) => resolveProductPolicy(autopilot, o, o.productProfileId));
  const pausedProducts: PausedProduct[] = overlays
    .filter((o) => o.pausedAt !== null)
    .map((o) => ({
      productProfileId: o.productProfileId,
      productName: o.productName,
      pause: { since: o.pausedAt!, byUserId: o.pausedByUserId },
    }));
  const withoutPaths: Omit<AutomationPolicy, 'paths'> = {
    workspaceId: input.state.workspaceId,
    evaluatedAt: input.state.evaluatedAt,
    state: input.state,
    autopilot,
    products,
    pausedProducts,
    followUps: {
      enabled: input.workspace.followUpEnabled,
      requireApproval: input.workspace.followUpRequireApproval,
    },
    inbox: {
      autoSync: input.workspace.imapAutoSyncEnabled,
      imapMailboxes: input.imapMailboxes,
      failingMailboxes: input.failingMailboxes,
    },
    replies: { autoDraft: input.workspace.autoDraftReplies, ...input.replyActions },
    discovery: { enabledPlans: input.enabledCrawlPlans },
    healthCheck: {
      enabled: input.workspace.healthCheckEnabled,
      intervalDays: input.workspace.healthCheckIntervalDays,
    },
    trash: { retentionDays: input.workspace.trashRetentionDays },
    autoTopUp: { enabled: input.workspace.autoTopupEnabled },
  };
  return { ...withoutPaths, paths: buildPaths(withoutPaths) };
}

/** The path line for a key (every policy has one per key). */
export function policyPath(policy: AutomationPolicy, key: AutomationPathKey): AutomationPath {
  const p = policy.paths.find((x) => x.key === key);
  if (!p) throw new Error(`automation policy has no path ${key}`);
  return p;
}

// ---- ticks ----------------------------------------------------------------

export type TickVerdict =
  | { run: true }
  /** Not configured to run here (autopilot off, auto-sync off, no plan). */
  | { run: false; off: string }
  /** The gate stops it (count as held; not an error). */
  | { run: false; held: GateRefusal };

/**
 * Whether a background tick does its work in this workspace now. The gate
 * is asked first (a held workspace is counted as held whatever its
 * configuration), then the configuration. A tick's service still
 * re-checks the gate before every item it works on.
 */
export function tickVerdict(policy: AutomationPolicy, tick: AutomationTick): TickVerdict {
  const held = (capability: AutomationCapability, item: GateItemOptions = {}): TickVerdict | null => {
    const refusal = gate(policy.state, capability, item);
    return refusal ? { run: false, held: refusal } : null;
  };
  switch (tick) {
    case 'autopilot.tick':
      return (
        held('autopilot') ??
        (policy.autopilot.enabled ? { run: true } : { run: false, off: 'autopilot is off' })
      );
    case 'outreach.drain.tick':
      return held('sending') ?? { run: true };
    case 'mail.imap.tick':
      return (
        held('inbox_sync') ??
        (policy.inbox.autoSync ? { run: true } : { run: false, off: 'mailbox auto-sync is off' })
      );
    case 'outreach.follow_up.tick':
      return (
        held('sending') ??
        (policy.followUps.enabled ? { run: true } : { run: false, off: 'follow-ups are off' })
      );
    case 'crawl.engine.tick':
      return (
        held('discovery') ??
        (policy.discovery.enabledPlans > 0
          ? { run: true }
          : { run: false, off: 'no crawl plan is enabled' })
      );
    case 'mail.trash.purge.tick':
      return (
        held('trash_purge') ??
        (policy.trash.retentionDays > 0 ? { run: true } : { run: false, off: 'trash is kept' })
      );
    case 'knowledge.compact.tick':
      return held('background_ai', { spendsTokens: true }) ?? { run: true };
    case 'health.check.tick':
      // The configuration check runs under the pause too; its AI review
      // asks the gate itself (health-check.ts).
      return policy.healthCheck.enabled
        ? { run: true }
        : { run: false, off: 'the health check is off' };
  }
}

// ---- loaders ----------------------------------------------------------------

async function loadInputs(
  states: readonly AutomationState[],
): Promise<Map<string, AutomationPolicyInputs>> {
  const out = new Map<string, AutomationPolicyInputs>();
  if (states.length === 0) return out;
  const ids = states.map((s) => s.workspaceId);

  const [apRows, overlayRows, wsRows, replyRows, planRows, mailboxRows] = await Promise.all([
    db.select().from(autopilotSettings).where(inArray(autopilotSettings.workspaceId, ids)),
    db
      .select({ o: autopilotProductSettings, productName: productProfiles.name })
      .from(autopilotProductSettings)
      .innerJoin(
        productProfiles,
        and(
          eq(productProfiles.id, autopilotProductSettings.productProfileId),
          eq(productProfiles.workspaceId, autopilotProductSettings.workspaceId),
        ),
      )
      .where(inArray(autopilotProductSettings.workspaceId, ids)),
    db
      .select({
        id: workspaces.id,
        followUpEnabled: workspaces.followUpEnabled,
        followUpRequireApproval: workspaces.followUpRequireApproval,
        imapAutoSyncEnabled: workspaces.imapAutoSyncEnabled,
        autoDraftReplies: workspaces.autoDraftReplies,
        autoTopupEnabled: workspaces.autoTopupEnabled,
        billingExempt: workspaces.billingExempt,
        healthCheckEnabled: workspaces.healthCheckEnabled,
        healthCheckIntervalDays: workspaces.healthCheckIntervalDays,
        trashRetentionDays: workspaces.trashRetentionDays,
      })
      .from(workspaces)
      .where(inArray(workspaces.id, ids)),
    db.select().from(replyAutoActions).where(inArray(replyAutoActions.workspaceId, ids)),
    db
      .select({ workspaceId: crawlPlans.workspaceId, n: count() })
      .from(crawlPlans)
      .where(and(inArray(crawlPlans.workspaceId, ids), eq(crawlPlans.enabled, true)))
      .groupBy(crawlPlans.workspaceId),
    db
      .select({
        workspaceId: mailboxes.workspaceId,
        status: mailboxes.status,
        imapHost: mailboxes.imapHost,
      })
      .from(mailboxes)
      .where(inArray(mailboxes.workspaceId, ids)),
  ]);

  const key = (id: bigint) => id.toString();
  const apBy = new Map(apRows.map((r) => [key(r.workspaceId), r]));
  const wsBy = new Map(wsRows.map((r) => [key(r.id), r]));
  const replyBy = new Map(replyRows.map((r) => [key(r.workspaceId), r]));
  const plansBy = new Map(planRows.map((r) => [key(r.workspaceId), Number(r.n)]));
  const overlaysBy = new Map<string, ProductOverlayInput[]>();
  for (const { o, productName } of overlayRows) {
    const listFor = overlaysBy.get(key(o.workspaceId)) ?? [];
    listFor.push({
      productProfileId: o.productProfileId,
      productName,
      autopilotEnabled: o.autopilotEnabled,
      enableAutoApproveProjects: o.enableAutoApproveProjects,
      autoApproveThreshold: o.autoApproveThreshold,
      enableAutoEnqueueOutreach: o.enableAutoEnqueueOutreach,
      enableAutoCrmContactSync: o.enableAutoCrmContactSync,
      enableAutoCrmDealOnQualified: o.enableAutoCrmDealOnQualified,
      defaultMailboxId: o.defaultMailboxId,
      pausedAt: o.pausedAt,
      pausedByUserId: o.pausedByUserId,
    });
    overlaysBy.set(key(o.workspaceId), listFor);
  }
  const imapBy = new Map<string, number>();
  const failingBy = new Map<string, number>();
  for (const m of mailboxRows) {
    const k = key(m.workspaceId);
    if (m.status === 'active' && m.imapHost) imapBy.set(k, (imapBy.get(k) ?? 0) + 1);
    if (m.status === 'failing') failingBy.set(k, (failingBy.get(k) ?? 0) + 1);
  }

  for (const state of states) {
    const k = key(state.workspaceId);
    const ws = wsBy.get(k);
    if (!ws) continue;
    const ap = apBy.get(k);
    const reply = replyBy.get(k);
    out.set(k, {
      state,
      autopilot: {
        enabled: ap?.autopilotEnabled ?? AUTOPILOT_DEFAULTS.autopilotEnabled,
        steps: {
          auto_approve_projects:
            ap?.enableAutoApproveProjects ?? AUTOPILOT_DEFAULTS.enableAutoApproveProjects,
          auto_enqueue_outreach:
            ap?.enableAutoEnqueueOutreach ?? AUTOPILOT_DEFAULTS.enableAutoEnqueueOutreach,
          auto_crm_contact_sync:
            ap?.enableAutoCrmContactSync ?? AUTOPILOT_DEFAULTS.enableAutoCrmContactSync,
          auto_crm_deal_on_qualified:
            ap?.enableAutoCrmDealOnQualified ?? AUTOPILOT_DEFAULTS.enableAutoCrmDealOnQualified,
        },
        autoApproveThreshold: ap?.autoApproveThreshold ?? AUTOPILOT_DEFAULTS.autoApproveThreshold,
        maxApprovalsPerRun: ap?.maxApprovalsPerRun ?? AUTOPILOT_DEFAULTS.maxApprovalsPerRun,
        maxEnqueuesPerRun: ap?.maxEnqueuesPerRun ?? AUTOPILOT_DEFAULTS.maxEnqueuesPerRun,
        defaultMailboxId: ap?.defaultMailboxId ?? AUTOPILOT_DEFAULTS.defaultMailboxId,
        defaultCrmConnectionId:
          ap?.defaultCrmConnectionId ?? AUTOPILOT_DEFAULTS.defaultCrmConnectionId,
      },
      overlays: overlaysBy.get(k) ?? [],
      workspace: {
        followUpEnabled: ws.followUpEnabled,
        followUpRequireApproval: ws.followUpRequireApproval,
        imapAutoSyncEnabled: ws.imapAutoSyncEnabled,
        autoDraftReplies: ws.autoDraftReplies,
        // A billing-exempt workspace is never charged (billing.ts).
        autoTopupEnabled: ws.autoTopupEnabled && !ws.billingExempt,
        healthCheckEnabled: ws.healthCheckEnabled,
        healthCheckIntervalDays: ws.healthCheckIntervalDays,
        trashRetentionDays: ws.trashRetentionDays,
      },
      // reply_auto_actions column defaults when the row does not exist yet.
      replyActions: {
        autoSuppressUnsubscribe: reply?.autoSuppressUnsubscribe ?? false,
        autoSuppressBounce: reply?.autoSuppressBounce ?? false,
        autoCloseNegative: reply?.autoCloseNegative ?? false,
        autoExtractRedirects: reply?.autoExtractRedirects ?? true,
      },
      enabledCrawlPlans: plansBy.get(k) ?? 0,
      imapMailboxes: imapBy.get(k) ?? 0,
      failingMailboxes: failingBy.get(k) ?? 0,
    });
  }
  return out;
}

/** Policies for already-loaded automation states (keyed by workspace id
 *  string). A fixed number of queries whatever the number of states. */
export async function loadAutomationPolicies(
  states: readonly AutomationState[],
): Promise<Map<string, AutomationPolicy>> {
  const inputs = await loadInputs(states);
  const out = new Map<string, AutomationPolicy>();
  for (const [k, input] of inputs) out.set(k, buildAutomationPolicy(input));
  return out;
}

export class AutomationPolicyNotFoundError extends Error {
  public readonly code = 'not_found' as const;
  constructor(workspaceId: bigint) {
    super(`workspace ${workspaceId} not found`);
    this.name = 'AutomationPolicyNotFoundError';
  }
}

/**
 * The workspace's automation policy. Pass `state` when the caller already
 * loaded it (a tick); otherwise it is loaded now.
 */
export async function resolveAutomationPolicy(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: { state?: AutomationState; now?: Date } = {},
): Promise<AutomationPolicy> {
  const state =
    options.state ??
    (await loadAutomationStates([ctx.workspaceId], options.now)).get(ctx.workspaceId.toString());
  if (!state) throw new AutomationPolicyNotFoundError(ctx.workspaceId);
  const policy = (await loadAutomationPolicies([state])).get(ctx.workspaceId.toString());
  if (!policy) throw new AutomationPolicyNotFoundError(ctx.workspaceId);
  return policy;
}

export interface TickWorkspacePolicy extends TickWorkspace {
  policy: AutomationPolicy;
}

/** Every active workspace with its automation context, state and policy:
 *  the list each background tick iterates (see tickVerdict). */
export async function workspacesForTick(now: Date = new Date()): Promise<TickWorkspacePolicy[]> {
  const wss = await activeWorkspacesForTicks(now);
  const policies = await loadAutomationPolicies(wss.map((w) => w.state));
  const out: TickWorkspacePolicy[] = [];
  for (const ws of wss) {
    const policy = policies.get(ws.workspaceId.toString());
    if (policy) out.push({ ...ws, policy });
  }
  return out;
}

/**
 * The product's pause as it is now (one query) — for the loops that
 * re-check before every item, so a product paused mid-run stops at the
 * next item. null = not paused.
 */
export async function productPauseOf(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  productProfileId: bigint,
): Promise<(ProductPause & { productName: string }) | null> {
  const [row] = await db
    .select({
      pausedAt: autopilotProductSettings.pausedAt,
      pausedByUserId: autopilotProductSettings.pausedByUserId,
      productName: productProfiles.name,
    })
    .from(autopilotProductSettings)
    .innerJoin(productProfiles, eq(productProfiles.id, autopilotProductSettings.productProfileId))
    .where(
      and(
        eq(autopilotProductSettings.workspaceId, ctx.workspaceId),
        eq(autopilotProductSettings.productProfileId, productProfileId),
        isNotNull(autopilotProductSettings.pausedAt),
      ),
    )
    .limit(1);
  if (!row?.pausedAt) return null;
  return { since: row.pausedAt, byUserId: row.pausedByUserId, productName: row.productName };
}

/** Why automatic outbound for a paused product waits (queue rows and
 *  follow-ups keep it as their last error). */
export function productPausedMessage(productName: string): string {
  return `Held: the product "${productName}" is paused. This goes out once an owner or admin resumes it; nothing is lost.`;
}

// ---- the header pill (ia:F-17) ---------------------------------------------

export type AutomationStateKind =
  | 'stopped_by_platform'
  | 'paused'
  | 'blocked'
  | 'autopilot_on'
  | 'manual';

export const AUTOMATION_STATE_LABELS: Readonly<Record<AutomationStateKind, string>> = {
  stopped_by_platform: 'Stopped by platform',
  paused: 'Paused',
  blocked: 'Blocked',
  autopilot_on: 'Autopilot on',
  manual: 'Manual',
};

export interface AutomationStatus {
  kind: AutomationStateKind;
  /** The pill text: the kind's label, or "Partly paused". */
  label: string;
  /** Autopilot on / Manual, while part of the work is held by a hold that
   *  covers only some capabilities, or a paused product. */
  partlyPaused: boolean;
  /** The go-live hold is lifted. */
  live: boolean;
  /** Amber dot: something degrades what runs (no tokens, failing mailboxes). */
  degraded: boolean;
  degradations: string[];
  /** One sentence for the pill's tooltip / popover head, generated from the
   *  real configuration. */
  summary: string;
  /** Why it is stopped, paused, blocked or partly paused. */
  reasons: string[];
  /** Labels of the automatic paths that still run (fully or in part). */
  continues: string[];
  /** "What runs right now". */
  paths: readonly AutomationPath[];
  /** The banner text while Paused or Stopped; null otherwise. */
  banner: string | null;
}

function sentence(s: string): string {
  const t = s.trim();
  return t.endsWith('.') ? t : `${t}.`;
}

/**
 * The pill from a policy. Pure. Precedence: Stopped by platform (the
 * platform-wide outbound stop, or a platform hold on everything or on
 * Sending) > Paused (the workspace pause, or a workspace hold on
 * everything) > Blocked (archived, no accountable owner, autopilot on
 * without a plan that includes it) > Autopilot on > Manual.
 */
export function describeAutomationState(
  policy: AutomationPolicy,
  extras: { pausedByLabel?: string | null } = {},
): AutomationStatus {
  const { state } = policy;
  const now = state.evaluatedAt;
  const liveHolds = state.holds.filter(
    (h) => h.expiresAt === null || h.expiresAt.getTime() > now.getTime(),
  );
  const platformStopHold = liveHolds.find(
    (h) => h.source === 'platform' && holdCovers(h, 'sending'),
  );
  const tenantAllHold = liveHolds.find((h) => h.source === 'tenant' && h.scope === 'all');
  const partialHolds = liveHolds.filter(
    (h) => h.scope === 'capabilities' && h !== platformStopHold,
  );

  const reasons: string[] = [];
  let kind: AutomationStateKind;
  if (state.platformOutboundStop || platformStopHold) {
    kind = 'stopped_by_platform';
    if (state.platformOutboundStop) {
      reasons.push(
        `Outbound email is stopped for every workspace by the platform: ${state.platformOutboundStop.reason}`,
      );
    }
    if (platformStopHold) {
      reasons.push(
        `${platformStopHold.scope === 'all' ? 'All automation' : list(platformStopHold.capabilities.map((c) => CAPABILITY_LABELS[c]))} is on hold by the platform: ${platformStopHold.reason}`,
      );
    }
  } else if (state.pause || tenantAllHold) {
    kind = 'paused';
    if (state.pause) {
      reasons.push(
        `Paused${extras.pausedByLabel ? ` by ${extras.pausedByLabel}` : ''} since ${state.pause.since.toISOString()}${state.pause.reason ? `: ${state.pause.reason}` : ''}`,
      );
    }
    if (tenantAllHold) reasons.push(`All automation is on hold: ${tenantAllHold.reason}`);
  } else if (
    state.workspaceStatus !== 'active' ||
    state.ownerProblem ||
    (policy.autopilot.enabled && !policy.autopilot.planAllows)
  ) {
    kind = 'blocked';
    if (state.workspaceStatus !== 'active') {
      reasons.push('This workspace is archived, so nothing runs automatically.');
    }
    if (state.ownerProblem) reasons.push(ownerProblemMessage(state));
    if (policy.autopilot.enabled && !policy.autopilot.planAllows) {
      reasons.push(
        'Autopilot is on, but the plan does not include it, so it does not run. Upgrade in Settings → Billing.',
      );
    }
  } else {
    kind = policy.autopilot.enabled ? 'autopilot_on' : 'manual';
  }

  const partlyPaused =
    (kind === 'autopilot_on' || kind === 'manual') &&
    (partialHolds.length > 0 || policy.pausedProducts.length > 0);
  if (partlyPaused) {
    for (const h of partialHolds) {
      reasons.push(
        `${list(h.capabilities.map((c) => CAPABILITY_LABELS[c]))} ${h.capabilities.length === 1 ? 'is' : 'are'} on hold (placed by ${h.source === 'platform' ? 'the platform' : 'this workspace'}): ${h.reason}`,
      );
    }
    for (const p of policy.pausedProducts) {
      reasons.push(
        `The product "${p.productName}" is paused: autopilot skips it and its emails and follow-ups wait.`,
      );
    }
  }

  const degradations: string[] = [];
  if (!state.walletHasTokens) {
    degradations.push('No tokens left: discovery, AI drafting and follow-ups wait.');
  }
  if (policy.inbox.failingMailboxes > 0) {
    degradations.push(
      `${plural(policy.inbox.failingMailboxes, 'mailbox', 'mailboxes')} failing: ${policy.inbox.failingMailboxes === 1 ? 'its' : 'their'} queued emails are held and replies to ${policy.inbox.failingMailboxes === 1 ? 'it' : 'them'} are not read.`,
    );
  }

  const continues = policy.paths
    .filter((p) => p.status === 'runs' || p.status === 'partial')
    .map((p) => p.label);

  const line = (key: AutomationPathKey) => sentence(policyPath(policy, key).detail);
  let summary: string;
  switch (kind) {
    case 'stopped_by_platform':
      summary = `Stopped by the platform: ${reasons[0] ?? 'outbound email is stopped'}`;
      break;
    case 'paused':
      summary = `Paused: nothing is sent, composed or run automatically until an owner or admin resumes it; ${continues.length > 0 ? `still running: ${list(continues)}` : 'nothing else runs'}.`;
      break;
    case 'blocked':
      summary = `Blocked: ${reasons[0] ?? 'automatic work cannot run'}`;
      break;
    case 'autopilot_on':
      summary = [
        `Autopilot on. ${line('autopilot')}`,
        line('sending'),
        line('follow_ups'),
        line('inbox_sync'),
        `Reply auto-actions: ${lowerFirst(line('reply_actions'))}`,
      ].join(' ');
      break;
    case 'manual':
      summary = [
        'Manual: nothing is approved or drafted for you.',
        line('sending'),
        line('follow_ups'),
        line('inbox_sync'),
        `Reply auto-actions: ${lowerFirst(line('reply_actions'))}`,
      ].join(' ');
      break;
  }
  if (partlyPaused) {
    summary = `Partly paused: ${reasons.map(sentence).join(' ')} Still running: ${list(continues)}. ${summary}`;
  }

  const banner =
    kind === 'paused' || kind === 'stopped_by_platform' ? reasons.map(sentence).join(' ') : null;

  return {
    kind,
    label: partlyPaused ? 'Partly paused' : AUTOMATION_STATE_LABELS[kind],
    partlyPaused,
    live: state.live !== null,
    degraded: degradations.length > 0,
    degradations,
    summary,
    reasons,
    continues,
    paths: policy.paths,
    banner,
  };
}

/** The header pill's read model for the workspace (read-only; any member). */
export async function getAutomationState(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: { now?: Date } = {},
): Promise<AutomationStatus> {
  const policy = await resolveAutomationPolicy(ctx, options);
  let pausedByLabel: string | null = null;
  if (policy.state.pause?.byUserId) {
    const [u] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, policy.state.pause.byUserId))
      .limit(1);
    pausedByLabel = u ? u.name?.trim() || u.email : null;
  }
  return describeAutomationState(policy, { pausedByLabel });
}

// ---- the /autopilot flow view ---------------------------------------------

/**
 *   on      runs for this scope
 *   off     not configured to run
 *   always  runs in the background whatever autopilot says
 *   inline  runs as part of other work (a record lands, a reply arrives)
 *   held    configured, but the gate (or a product pause) stops it now
 *   partial runs, but part of it waits
 */
export type FlowStepStatus = 'on' | 'off' | 'always' | 'inline' | 'held' | 'partial';

export interface FlowStep {
  key:
    | 'discovery'
    | 'classify'
    | 'auto_approve'
    | 'generate_queue'
    | 'send_queue'
    | 'replies'
    | 'crm';
  label: string;
  status: FlowStepStatus;
  blurb: string;
}

const STEP_STATUS_TEXT: Readonly<Record<Exclude<StepStatus, 'on'>, string>> = {
  workspace_off: 'Off.',
  autopilot_off: 'Off: autopilot is off.',
  product_off: 'Off for this product.',
  product_autopilot_off: 'Off: autopilot is off for this product.',
  product_paused: 'Held: this product is paused.',
};

/**
 * The flow view on /autopilot for the workspace (productId null) or one
 * product, rendered from the policy — so it shows what really runs: the
 * send queue is always on in the background, a paused product holds its
 * mail, a lapsed plan or the pause holds autopilot.
 */
export function autopilotFlow(policy: AutomationPolicy, productId: bigint | null): FlowStep[] {
  const product = productId !== null ? productPolicy(policy, productId) : null;
  const autopilotPath = policyPath(policy, 'autopilot');
  const autopilotHeld = autopilotPath.status === 'held' ? autopilotPath.detail : null;

  const stepFlow = (
    step: AutopilotStepKey,
    onBlurb: string,
    offBlurb: string,
  ): { status: FlowStepStatus; blurb: string } => {
    const status: StepStatus = product
      ? product.steps[step]
      : !policy.autopilot.enabled
        ? 'autopilot_off'
        : policy.autopilot.steps[step]
          ? 'on'
          : 'workspace_off';
    if (status === 'product_paused') return { status: 'held', blurb: STEP_STATUS_TEXT[status] };
    if (status === 'workspace_off') return { status: 'off', blurb: offBlurb };
    if (status !== 'on') return { status: 'off', blurb: STEP_STATUS_TEXT[status] };
    if (autopilotHeld) return { status: 'held', blurb: autopilotHeld };
    return { status: 'on', blurb: onBlurb };
  };

  const discovery = policyPath(policy, 'discovery');
  const sending = policyPath(policy, 'sending');
  const replyActions = policyPath(policy, 'reply_actions');
  const threshold = product ? product.autoApproveThreshold : policy.autopilot.autoApproveThreshold;

  const crmContact = stepFlow(
    'auto_crm_contact_sync',
    "syncs new and changed qualified leads' contacts",
    'Off: leads reach the CRM only when someone pushes them.',
  );
  const crmDeal = stepFlow(
    'auto_crm_deal_on_qualified',
    'creates a deal for each new qualified lead whose contact is synced',
    'Off: leads reach the CRM only when someone pushes them.',
  );
  const crmOn = [crmContact, crmDeal].filter((c) => c.status === 'on').map((c) => c.blurb);
  const crm: { status: FlowStepStatus; blurb: string } =
    crmOn.length > 0
      ? { status: 'on', blurb: `Every 5 minutes autopilot ${list(crmOn)}.` }
      : ([crmContact, crmDeal].find((c) => c.status === 'held') ?? crmContact);

  const sendFlow: { status: FlowStepStatus; blurb: string } = product?.pause
    ? {
        status: 'held',
        blurb: 'Held for this product: its queued emails and follow-ups wait until it is resumed.',
      }
    : sending.status === 'held'
      ? { status: 'held', blurb: sending.detail }
      : {
          status: sending.status === 'partial' ? 'partial' : 'always',
          blurb: `Always on in the background, whatever autopilot says. ${sending.detail}`,
        };

  return [
    {
      key: 'discovery',
      label: '1. Discovery',
      status:
        discovery.status === 'off'
          ? 'off'
          : discovery.status === 'held'
            ? 'held'
            : discovery.status === 'partial'
              ? 'partial'
              : 'on',
      blurb: discovery.detail,
    },
    {
      key: 'classify',
      label: '2. Classify',
      status: 'inline',
      blurb: 'AI scores every new record against each active product as it lands.',
    },
    {
      key: 'auto_approve',
      label: '3. Auto-approve',
      ...stepFlow(
        'auto_approve_projects',
        `Review items still "new" scoring ${threshold} or more are approved in the workspace owner's name; no person looks at them.`,
        'Off: you approve every review item yourself.',
      ),
    },
    {
      key: 'generate_queue',
      label: '4. Generate + queue',
      ...stepFlow(
        'auto_enqueue_outreach',
        "For each approved item, writes a template draft per relevant product, approves it in the owner's name and queues it; nobody reviews these emails.",
        'Off: you write, approve and queue every first email yourself.',
      ),
    },
    { key: 'send_queue', label: '5. Send queue', ...sendFlow },
    {
      key: 'replies',
      label: '6. Classify replies',
      status: 'inline',
      blurb: `Replies to your outreach are classified as they arrive. Inbox sync: ${lowerFirst(policyPath(policy, 'inbox_sync').detail)} Reply auto-actions: ${lowerFirst(replyActions.detail)}`,
    },
    { key: 'crm', label: '7. Hand over to CRM', ...crm },
  ];
}
