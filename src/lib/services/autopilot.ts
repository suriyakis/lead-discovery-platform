// Autopilot orchestrator. One runOnce(ctx) cycles through the four
// autopilot steps (auto-approve, generate + queue, CRM contact sync, CRM
// deal on qualified). Every step records 1+ rows on autopilot_log keyed by
// a shared runId so the UI + future operator dashboards can replay what
// happened.
//
// PC-13: what runs is decided by resolveAutomationPolicy
// (automation-policy.ts), the only reader of the step switches and of the
// per-product overlays. Overlays are narrow-only and enforced (I020): a
// product can switch autopilot or a step off, require a higher threshold,
// or be paused — a paused product gets no approvals, drafts, enqueues or
// CRM pushes, and its queued emails and follow-ups are held. The dead
// toggles are gone (I019, I067): "Auto-drain the send queue" (the 30 s
// drain tick always sends approved mail) and "Sync inbound mail" (the IMAP
// tick is the only automatic inbound path). Plan gating applies only to a
// switch turning ON (I063). The CRM steps push only new or changed leads,
// in id order, and the deal step skips leads whose contact is not synced
// (I072).
//
// PC-11 (I018): every candidate query filters in SQL before its LIMIT, so
// the per-run cap only counts work the step will do and a backlog drains
// across runs. Auto-approve: the product's enablement and threshold, one
// candidate per review item (approved once, origin 'autopilot', via
// autopilotApproveReviewItem). Generate + queue: no live draft for the pair
// yet, its pipeline lead has a plausible contact email (I001: no draft is
// written for a lead nobody can be emailed at — those pairs are counted as
// needs_contact), oldest approval first. The CRM steps push with origin
// 'autopilot' and every succeeded push is on the lead's timeline. A step's
// errors are reported once per run as an ops incident, one per step per
// day (autopilot-incidents.ts).
//
// All steps lean on existing services so the autopilot stays a thin
// orchestrator: it never reaches into the DB to do work that already has
// a service entry point.

import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db/client';
import {
  autopilotLog,
  autopilotProductSettings,
  autopilotSettings,
  type AutopilotLogEntry,
  type AutopilotProductSettings,
  type AutopilotSettings,
  type NewAutopilotProductSettings,
  type NewAutopilotSettings,
} from '@/lib/db/schema/autopilot';
import { crmSyncLog } from '@/lib/db/schema/crm';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles } from '@/lib/db/schema/products';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import type { ICRMConnector } from '@/lib/crm';
import { recordAuditEvent } from './audit';
import { checkGate, checkGates, type AutomationCapability } from './automation-gate';
import {
  AUTOPILOT_STEP_CAPABILITY,
  AUTOPILOT_STEP_FIELDS,
  AUTOPILOT_STEP_KEYS,
  productPauseOf,
  productPolicy,
  productsExcludedFromStep,
  resolveAutomationPolicy,
  type AutomationPolicy,
  type AutopilotStepKey,
} from './automation-policy';
import {
  LOG_ONCE_INCIDENT_SINK,
  reportAutopilotStepErrors,
  type AutopilotIncidentSink,
  type AutopilotStepErrors,
} from './autopilot-incidents';
import { plausibleEmailSql } from './contacts';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';
import { autopilotApproveReviewItem } from './review';
import { approveOutreachDraft, generateOutreachDraft } from './outreach';
import { enqueueDraft } from './outreach-queue';
import { defaultMailbox } from './mailbox';
import { listCrmConnections, pushDeal, pushLeadToCrm } from './crm';

export type AutopilotErrorCode =
  | 'permission_denied'
  | 'not_found'
  | 'invalid_input'
  /** PC-13: a product override may only narrow the workspace. */
  | 'widening_override'
  | 'invariant_violation';

export class AutopilotError extends Error {
  public readonly code: AutopilotErrorCode;
  constructor(message: string, code: AutopilotErrorCode) {
    super(message);
    this.name = 'AutopilotError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new AutopilotError(`Permission denied: ${op}`, 'permission_denied');

// ---- settings -----------------------------------------------------

export async function getAutopilotSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<AutopilotSettings> {
  const rows = await db
    .select()
    .from(autopilotSettings)
    .where(eq(autopilotSettings.workspaceId, ctx.workspaceId))
    .limit(1);
  if (rows[0]) return rows[0];
  const seed: NewAutopilotSettings = { workspaceId: ctx.workspaceId };
  await db.insert(autopilotSettings).values(seed).onConflictDoNothing();
  const reload = await db
    .select()
    .from(autopilotSettings)
    .where(eq(autopilotSettings.workspaceId, ctx.workspaceId))
    .limit(1);
  if (!reload[0]) throw new AutopilotError('settings init failed', 'invariant_violation');
  return reload[0];
}

export interface UpdateAutopilotSettingsInput {
  autopilotEnabled?: boolean;
  enableAutoApproveProjects?: boolean;
  autoApproveThreshold?: number;
  enableAutoEnqueueOutreach?: boolean;
  enableAutoCrmContactSync?: boolean;
  enableAutoCrmDealOnQualified?: boolean;
  maxApprovalsPerRun?: number;
  maxEnqueuesPerRun?: number;
  defaultMailboxId?: bigint | null;
  defaultCrmConnectionId?: bigint | null;
}

/** The switches the autopilot plan gate applies to: the master and the
 *  four step switches. */
export const AUTOPILOT_SWITCHES = [
  'autopilotEnabled',
  ...Object.values(AUTOPILOT_STEP_FIELDS),
] as const;
export type AutopilotSwitch = (typeof AUTOPILOT_SWITCHES)[number];

/** PC-13 (I063): the switches a save turns ON (false → true). Only those
 *  need a plan that includes autopilot; re-saving a switch that is
 *  already on, or turning things off, always goes through. */
export function switchesTurningOn(
  current: Pick<AutopilotSettings, AutopilotSwitch>,
  input: UpdateAutopilotSettingsInput,
): AutopilotSwitch[] {
  return AUTOPILOT_SWITCHES.filter((k) => input[k] === true && current[k] !== true);
}

export async function updateAutopilotSettings(
  ctx: WorkspaceContext,
  input: UpdateAutopilotSettingsInput,
): Promise<AutopilotSettings> {
  if (!canAdminWorkspace(ctx)) throw denied('autopilot.settings.update');
  const current = await getAutopilotSettings(ctx);
  // Autopilot is a subscription feature. Only switching something ON is
  // gated: a form re-posting switches that are already on, switching off
  // and the workspace pause (automation-pause.ts) all work on a lapsed plan.
  if (switchesTurningOn(current, input).length > 0) {
    const { assertAutopilotAllowed } = await import('./plan-limits');
    await assertAutopilotAllowed(ctx);
  }
  const updates: Partial<AutopilotSettings> & { updatedAt: Date } = {
    updatedAt: new Date(),
    updatedBy: ctx.userId,
  };
  for (const k of AUTOPILOT_SWITCHES) {
    if (input[k] !== undefined) (updates as Record<string, unknown>)[k] = input[k];
  }
  if (input.autoApproveThreshold !== undefined) {
    updates.autoApproveThreshold = clampInt(input.autoApproveThreshold, 0, 100);
  }
  if (input.maxApprovalsPerRun !== undefined) {
    updates.maxApprovalsPerRun = clampInt(input.maxApprovalsPerRun, 0, 1000);
  }
  if (input.maxEnqueuesPerRun !== undefined) {
    updates.maxEnqueuesPerRun = clampInt(input.maxEnqueuesPerRun, 0, 1000);
  }
  if (input.defaultMailboxId !== undefined) {
    updates.defaultMailboxId = input.defaultMailboxId;
  }
  if (input.defaultCrmConnectionId !== undefined) {
    updates.defaultCrmConnectionId = input.defaultCrmConnectionId;
  }
  const [updated] = await db
    .update(autopilotSettings)
    .set(updates)
    .where(eq(autopilotSettings.workspaceId, ctx.workspaceId))
    .returning();
  if (!updated) {
    throw new AutopilotError('settings update returned no row', 'invariant_violation');
  }
  await recordAuditEvent(ctx, {
    kind: 'autopilot.settings.update',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    // jsonb can't serialize bigint — render ids as strings.
    payload: Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
    ),
  });
  return updated;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// ---- per-product overlay (Phase 27, PC-13) -------------------------

// What an overlay MEANS is resolveAutomationPolicy's job (productPolicy);
// these two return the raw rows for the edit form.

export async function listProductAutopilotSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<AutopilotProductSettings[]> {
  return db
    .select()
    .from(autopilotProductSettings)
    .where(eq(autopilotProductSettings.workspaceId, ctx.workspaceId));
}

export async function getProductAutopilotSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  productProfileId: bigint,
): Promise<AutopilotProductSettings | null> {
  const rows = await db
    .select()
    .from(autopilotProductSettings)
    .where(
      and(
        eq(autopilotProductSettings.workspaceId, ctx.workspaceId),
        eq(autopilotProductSettings.productProfileId, productProfileId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * PC-13: overrides only narrow. Each switch is null (inherit the
 * workspace) or false (off for this product); true is refused
 * (`widening_override`). The threshold can only be raised above the
 * workspace's. Pausing is pauseProductAutomation / resumeProductAutomation.
 * Omit a field to leave it alone.
 */
export interface UpsertProductAutopilotSettingsInput {
  productProfileId: bigint;
  autopilotEnabled?: false | null;
  enableAutoApproveProjects?: false | null;
  autoApproveThreshold?: number | null;
  enableAutoEnqueueOutreach?: false | null;
  enableAutoCrmContactSync?: false | null;
  enableAutoCrmDealOnQualified?: false | null;
  defaultMailboxId?: bigint | null;
}

/** The narrow-only override switches of a product overlay. */
export const OVERRIDE_SWITCHES = AUTOPILOT_SWITCHES;

export const WIDENING_OVERRIDE_MESSAGE =
  'A product can only narrow what the workspace runs: inherit, off, a higher threshold or a pause. To run a step for some products only, switch it on for the workspace and off for the others.';

async function assertWorkspaceProduct(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  productProfileId: bigint,
): Promise<{ name: string }> {
  const [row] = await db
    .select({ name: productProfiles.name })
    .from(productProfiles)
    .where(
      and(
        eq(productProfiles.workspaceId, ctx.workspaceId),
        eq(productProfiles.id, productProfileId),
      ),
    )
    .limit(1);
  if (!row) throw new AutopilotError('product not found', 'not_found');
  return row;
}

export async function upsertProductAutopilotSettings(
  ctx: WorkspaceContext,
  input: UpsertProductAutopilotSettingsInput,
): Promise<AutopilotProductSettings> {
  if (!canAdminWorkspace(ctx)) throw denied('autopilot.product_settings.update');
  // Narrow-only (I020). Checked on the raw input as well: a caller that is
  // not type-checked (a form, a script) must not store a widening "on".
  const raw = input as unknown as Record<string, unknown>;
  for (const k of OVERRIDE_SWITCHES) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== false) {
      throw new AutopilotError(WIDENING_OVERRIDE_MESSAGE, 'widening_override');
    }
  }
  if ('emergencyPause' in raw) {
    throw new AutopilotError(
      'A product is paused with "Pause this product", not with an override.',
      'invalid_input',
    );
  }
  await assertWorkspaceProduct(ctx, input.productProfileId);
  const base = await getAutopilotSettings(ctx);
  let threshold = input.autoApproveThreshold;
  if (threshold !== undefined && threshold !== null) {
    threshold = clampInt(threshold, 0, 100);
    if (threshold < base.autoApproveThreshold) {
      throw new AutopilotError(
        `A product's approval threshold can only be higher than the workspace's (${base.autoApproveThreshold}). ${WIDENING_OVERRIDE_MESSAGE}`,
        'widening_override',
      );
    }
  }

  const existing = await getProductAutopilotSettings(ctx, input.productProfileId);
  const sw = (k: AutopilotSwitch): false | null =>
    input[k] !== undefined ? (input[k] ?? null) : existing?.[k] === false ? false : null;
  const merged: NewAutopilotProductSettings = {
    workspaceId: ctx.workspaceId,
    productProfileId: input.productProfileId,
    autopilotEnabled: sw('autopilotEnabled'),
    enableAutoApproveProjects: sw('enableAutoApproveProjects'),
    autoApproveThreshold:
      threshold !== undefined ? threshold : (existing?.autoApproveThreshold ?? null),
    enableAutoEnqueueOutreach: sw('enableAutoEnqueueOutreach'),
    enableAutoCrmContactSync: sw('enableAutoCrmContactSync'),
    enableAutoCrmDealOnQualified: sw('enableAutoCrmDealOnQualified'),
    defaultMailboxId:
      input.defaultMailboxId !== undefined
        ? input.defaultMailboxId
        : (existing?.defaultMailboxId ?? null),
    updatedBy: ctx.userId,
    updatedAt: new Date(),
  };
  // jsonb can't serialize bigint — render to string for the audit payload.
  const auditPayload: Record<string, unknown> = {
    productProfileId: input.productProfileId.toString(),
    autopilotEnabled: input.autopilotEnabled,
    enableAutoApproveProjects: input.enableAutoApproveProjects,
    autoApproveThreshold: threshold,
    enableAutoEnqueueOutreach: input.enableAutoEnqueueOutreach,
    enableAutoCrmContactSync: input.enableAutoCrmContactSync,
    enableAutoCrmDealOnQualified: input.enableAutoCrmDealOnQualified,
    defaultMailboxId:
      input.defaultMailboxId === undefined
        ? undefined
        : input.defaultMailboxId === null
          ? null
          : input.defaultMailboxId.toString(),
  };
  if (existing) {
    const [updated] = await db
      .update(autopilotProductSettings)
      .set(merged)
      .where(eq(autopilotProductSettings.id, existing.id))
      .returning();
    if (!updated) {
      throw new AutopilotError('product settings update returned no row', 'invariant_violation');
    }
    await recordAuditEvent(ctx, {
      kind: 'autopilot.product_settings.update',
      entityType: 'product_profile',
      entityId: input.productProfileId,
      payload: auditPayload,
    });
    return updated;
  }
  const [created] = await db.insert(autopilotProductSettings).values(merged).returning();
  if (!created) {
    throw new AutopilotError('product settings insert returned no row', 'invariant_violation');
  }
  await recordAuditEvent(ctx, {
    kind: 'autopilot.product_settings.create',
    entityType: 'product_profile',
    entityId: input.productProfileId,
    payload: auditPayload,
  });
  return created;
}

/**
 * "Clear all overrides": the product inherits every step again. A pause
 * is not an override — it stays until an owner or admin resumes it.
 */
export async function clearProductAutopilotSettings(
  ctx: WorkspaceContext,
  productProfileId: bigint,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw denied('autopilot.product_settings.clear');
  const existing = await getProductAutopilotSettings(ctx, productProfileId);
  if (existing?.pausedAt) {
    await db
      .update(autopilotProductSettings)
      .set({
        autopilotEnabled: null,
        enableAutoApproveProjects: null,
        autoApproveThreshold: null,
        enableAutoEnqueueOutreach: null,
        enableAutoCrmContactSync: null,
        enableAutoCrmDealOnQualified: null,
        defaultMailboxId: null,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .where(eq(autopilotProductSettings.id, existing.id));
  } else {
    await db
      .delete(autopilotProductSettings)
      .where(
        and(
          eq(autopilotProductSettings.workspaceId, ctx.workspaceId),
          eq(autopilotProductSettings.productProfileId, productProfileId),
        ),
      );
  }
  await recordAuditEvent(ctx, {
    kind: 'autopilot.product_settings.clear',
    entityType: 'product_profile',
    entityId: productProfileId,
    payload: { keptPause: Boolean(existing?.pausedAt) },
  });
}

// ---- product pause (PC-13) -------------------------------------------

/**
 * Pause one product: autopilot does nothing for it (no approvals, drafts,
 * enqueues or CRM pushes), its queued emails and due follow-ups are held
 * (still queued / pending, never failed) and no AI reply draft is written
 * for its leads. Like the workspace pause: any write role, never plan- or
 * wallet-gated, idempotent (pausing a paused product writes nothing).
 * Audited as automation.product_paused.
 */
export async function pauseProductAutomation(
  ctx: WorkspaceContext,
  productProfileId: bigint,
): Promise<{ alreadyPaused: boolean; since: Date }> {
  if (!canWrite(ctx)) throw denied('automation.product.pause');
  const product = await assertWorkspaceProduct(ctx, productProfileId);
  const result = await db.transaction(async (tx) => {
    // Create the overlay row when there is none (a concurrent pause loses
    // the insert harmlessly), then lock it.
    await tx
      .insert(autopilotProductSettings)
      .values({ workspaceId: ctx.workspaceId, productProfileId, updatedBy: ctx.userId })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(autopilotProductSettings)
      .where(
        and(
          eq(autopilotProductSettings.workspaceId, ctx.workspaceId),
          eq(autopilotProductSettings.productProfileId, productProfileId),
        ),
      )
      .for('update');
    if (!row) throw new AutopilotError('product settings row missing', 'invariant_violation');
    if (row.pausedAt) return { alreadyPaused: true, since: row.pausedAt };
    const now = new Date();
    await tx
      .update(autopilotProductSettings)
      .set({ pausedAt: now, pausedByUserId: ctx.userId, updatedBy: ctx.userId, updatedAt: now })
      .where(eq(autopilotProductSettings.id, row.id));
    return { alreadyPaused: false, since: now };
  });
  if (!result.alreadyPaused) {
    await recordAuditEvent(ctx, {
      kind: 'automation.product_paused',
      entityType: 'product_profile',
      entityId: productProfileId,
      payload: { productName: product.name, at: result.since.toISOString() },
    });
  }
  return result;
}

/** Resume a paused product (owners and admins). Audited as
 *  automation.product_resumed; resuming a running product writes nothing. */
export async function resumeProductAutomation(
  ctx: WorkspaceContext,
  productProfileId: bigint,
): Promise<{ wasPaused: boolean }> {
  if (!canAdminWorkspace(ctx)) throw denied('automation.product.resume');
  const product = await assertWorkspaceProduct(ctx, productProfileId);
  const [row] = await db
    .update(autopilotProductSettings)
    .set({ pausedAt: null, pausedByUserId: null, updatedBy: ctx.userId, updatedAt: new Date() })
    .where(
      and(
        eq(autopilotProductSettings.workspaceId, ctx.workspaceId),
        eq(autopilotProductSettings.productProfileId, productProfileId),
        isNotNull(autopilotProductSettings.pausedAt),
      ),
    )
    .returning({ id: autopilotProductSettings.id });
  if (!row) return { wasPaused: false };
  await recordAuditEvent(ctx, {
    kind: 'automation.product_resumed',
    entityType: 'product_profile',
    entityId: productProfileId,
    payload: { productName: product.name },
  });
  return { wasPaused: true };
}

// ---- run ---------------------------------------------------------

export interface AutopilotRunResult {
  runId: string;
  ranAt: Date;
  steps: Array<{
    step: string;
    outcome: 'success' | 'skipped' | 'error';
    detail: string | null;
  }>;
}

export interface RunOptions {
  /** Test seam — the CRM connector the CRM steps push through. */
  crmConnectorOverride?: ICRMConnector;
  /** PC-11: where step errors are reported, once per step and run (default:
   *  logged once per step and day; PC-07's raiseOpsEvent once integrated). */
  incidentSink?: AutopilotIncidentSink;
}

export async function runOnce(
  ctx: WorkspaceContext,
  options: RunOptions = {},
): Promise<AutopilotRunResult> {
  if (!canWrite(ctx)) throw denied('autopilot.run');
  await getAutopilotSettings(ctx); // the settings row exists from the first run on
  const policy = await resolveAutomationPolicy(ctx);
  const runId = randomUUID();
  const ranAt = new Date();
  const steps: AutopilotRunResult['steps'] = [];

  if (!policy.autopilot.enabled) {
    await recordStep(ctx, runId, 'guard', 'skipped', 'autopilot_disabled');
    steps.push({ step: 'guard', outcome: 'skipped', detail: 'autopilot_disabled' });
    return { runId, ranAt, steps };
  }

  // PC-06 + PC-05: autopilot is automatic work whoever presses Run now:
  // the workspace pause, an Autopilot hold (or scope 'all'), a workspace
  // with no accountable owner, or a plan without autopilot runs nothing.
  // (The plan check keeps a workspace that enabled autopilot while
  // subscribed and then lapsed from running forever.)
  {
    const gate = await checkGate(ctx, 'autopilot', { manual: false });
    if (!gate.allowed) {
      const detail =
        gate.reason === 'plan_no_autopilot'
          ? 'plan_no_autopilot'
          : `held: ${gate.message}`.slice(0, 500);
      await recordStep(ctx, runId, 'guard', 'skipped', detail);
      steps.push({ step: 'guard', outcome: 'skipped', detail });
      return { runId, ranAt, steps };
    }
  }

  // PC-06 + PC-05: before each step the gate is asked again — Autopilot
  // (a pause or hold placed mid-run stops the remaining steps) and the
  // step's own capability (a Sending or CRM-sync hold skips just that
  // step, recorded with why). Each step re-checks before every item too
  // (itemHeld), and PC-13 re-reads the item's product pause.
  const tally = new StepErrorTally();
  for (const step of AUTOPILOT_STEP_KEYS) {
    if (!policy.autopilot.steps[step]) continue;
    const capability = AUTOPILOT_STEP_CAPABILITY[step];
    const held = capability ? await heldStep(ctx, runId, step, capability) : null;
    steps.push(held ?? (await runStep(step, { ctx, runId, policy, options, tally })));
  }

  // PC-11: each step that had errors → one incident report for this run.
  await reportAutopilotStepErrors(options.incidentSink ?? LOG_ONCE_INCIDENT_SINK, {
    workspaceId: ctx.workspaceId,
    runId,
    at: ranAt,
    errors: tally.byStep,
  });

  return { runId, ranAt, steps };
}

type StepResult = AutopilotRunResult['steps'][number];

/** What a step runner gets: the run, its policy and the error tally. */
interface StepRun {
  ctx: WorkspaceContext;
  runId: string;
  policy: AutomationPolicy;
  options: RunOptions;
  tally: StepErrorTally;
}

type StepRunner = (run: StepRun) => Promise<StepResult>;

/** PC-11: the errors of each step in one run (failed items, failed CRM
 *  pushes, a step that threw). */
class StepErrorTally {
  readonly byStep = new Map<AutopilotStepKey, AutopilotStepErrors>();

  add(step: AutopilotStepKey, message: string): void {
    const seen = this.byStep.get(step);
    if (seen) seen.count++;
    else this.byStep.set(step, { count: 1, first: message });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Record an item's error on the run log and count it for the step. */
async function itemError(
  run: StepRun,
  step: AutopilotStepKey,
  message: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  run.tally.add(step, message);
  await recordStep(run.ctx, run.runId, step, 'error', message, entityType, entityId);
}

/** Run one step. A step that throws (its candidate query, say) is recorded
 *  as an error and counted; the run goes on with the next step. */
async function runStep(step: AutopilotStepKey, run: StepRun): Promise<StepResult> {
  try {
    return await STEP_RUNNERS[step](run);
  } catch (err) {
    const detail = errorMessage(err).slice(0, 500);
    run.tally.add(step, detail);
    await recordStep(run.ctx, run.runId, step, 'error', detail);
    return { step, outcome: 'error', detail };
  }
}

// ---- steps -------------------------------------------------------

/** PC-06 + PC-05: null when the gate allows Autopilot and the step's
 *  `capability`; otherwise the step is recorded as skipped with the
 *  gate's reason and returned. */
async function heldStep(
  ctx: WorkspaceContext,
  runId: string,
  step: string,
  capability: AutomationCapability,
): Promise<StepResult | null> {
  const gate = await checkGates(ctx, ['autopilot', capability], { manual: false });
  if (gate.allowed) return null;
  const detail = `held: ${gate.message}`.slice(0, 500);
  await recordStep(ctx, runId, step, 'skipped', detail);
  return { step, outcome: 'skipped', detail };
}

/** PC-05: re-check before each item of a step (a candidate, a lead). A
 *  pause or hold placed mid-step stops the step at the next item, recorded
 *  as skipped with why; true = stop. */
async function itemHeld(
  ctx: WorkspaceContext,
  runId: string,
  step: string,
  capabilities: readonly AutomationCapability[],
): Promise<boolean> {
  const gate = await checkGates(ctx, capabilities, { manual: false });
  if (gate.allowed) return false;
  await recordStep(ctx, runId, step, 'skipped', `held: ${gate.message}`.slice(0, 500));
  return true;
}

/**
 * PC-13: does the step skip the item's product? The policy (loaded when
 * the run started) says whether the product switched the step off; its
 * pause is re-read now, so a product paused mid-run is skipped from its
 * next item on.
 */
async function productSkips(
  ctx: WorkspaceContext,
  policy: AutomationPolicy,
  step: AutopilotStepKey,
  productProfileId: bigint,
): Promise<boolean> {
  if (productPolicy(policy, productProfileId).steps[step] !== 'on') return true;
  return (await productPauseOf(ctx, productProfileId)) !== null;
}

/** Leave the products a step does not run for out of its candidate query,
 *  so they never use up the per-run cap. */
function excludeProducts(
  policy: AutomationPolicy,
  step: AutopilotStepKey,
  column: typeof qualifications.productProfileId | typeof qualifiedLeads.productProfileId,
) {
  const excluded = productsExcludedFromStep(policy, step);
  return excluded.length > 0 ? notInArray(column, excluded) : undefined;
}

function productSkipNote(n: number): string {
  return n > 0 ? ` product_skipped=${n}` : '';
}

/** review_items ⨝ qualifications: one row per (item, product classified). */
function itemQualificationJoin(): SQL | undefined {
  return and(
    eq(qualifications.workspaceId, reviewItems.workspaceId),
    eq(qualifications.sourceRecordId, reviewItems.sourceRecordId),
  );
}

/** PC-11 (I018): the score reaches the product's threshold — the policy's
 *  (the higher of the workspace's and the product's) — in SQL. */
function reachesApprovalThreshold(policy: AutomationPolicy): SQL | undefined {
  const base = policy.autopilot.autoApproveThreshold;
  const raised = policy.products.filter((p) => p.autoApproveThreshold > base);
  const atBase = gte(qualifications.relevanceScore, base);
  if (raised.length === 0) return atBase;
  return or(
    and(
      notInArray(
        qualifications.productProfileId,
        raised.map((p) => p.productProfileId),
      ),
      atBase,
    ),
    ...raised.map((p) =>
      and(
        eq(qualifications.productProfileId, p.productProfileId),
        gte(qualifications.relevanceScore, p.autoApproveThreshold),
      ),
    ),
  );
}

/**
 * PC-11 (I018): a qualification that makes autopilot approve its review
 * item, in SQL, so the per-run cap only counts items autopilot acts on: the
 * item is still 'new', the qualification relevant, its product runs the
 * step (not switched off or paused, autopilot not off for it) and the score
 * reaches that product's threshold.
 */
function autoApproveEligible(ctx: WorkspaceContext, policy: AutomationPolicy): SQL | undefined {
  return and(
    eq(reviewItems.workspaceId, ctx.workspaceId),
    eq(reviewItems.state, 'new'),
    eq(qualifications.isRelevant, true),
    excludeProducts(policy, 'auto_approve_projects', qualifications.productProfileId),
    reachesApprovalThreshold(policy),
  );
}

async function stepAutoApproveProjects(run: StepRun): Promise<StepResult> {
  const { ctx, runId, policy } = run;
  const step = 'auto_approve_projects';
  // One candidate per review item (its best eligible score), best first:
  // an item relevant to several products is approved once.
  const bestScore = sql<number>`max(${qualifications.relevanceScore})`.mapWith(Number);
  const candidates = await db
    .select({ reviewItemId: reviewItems.id, score: bestScore })
    .from(reviewItems)
    .innerJoin(qualifications, itemQualificationJoin())
    .where(autoApproveEligible(ctx, policy))
    .groupBy(reviewItems.id)
    .orderBy(desc(bestScore), asc(reviewItems.id))
    .limit(policy.autopilot.maxApprovalsPerRun);

  // The products each candidate is approved for.
  const productsByItem = new Map<string, bigint[]>();
  if (candidates.length > 0) {
    const rows = await db
      .select({
        reviewItemId: reviewItems.id,
        productProfileId: qualifications.productProfileId,
      })
      .from(reviewItems)
      .innerJoin(qualifications, itemQualificationJoin())
      .where(
        and(
          autoApproveEligible(ctx, policy),
          inArray(
            reviewItems.id,
            candidates.map((c) => c.reviewItemId),
          ),
        ),
      )
      .orderBy(asc(reviewItems.id), asc(qualifications.productProfileId));
    for (const r of rows) {
      const key = r.reviewItemId.toString();
      productsByItem.set(key, [...(productsByItem.get(key) ?? []), r.productProfileId]);
    }
  }

  let approved = 0;
  let productSkipped = 0;
  for (const c of candidates) {
    if (await itemHeld(ctx, runId, step, ['autopilot'])) break;
    // PC-13: a product paused since the run started no longer counts.
    const products: bigint[] = [];
    for (const productId of productsByItem.get(c.reviewItemId.toString()) ?? []) {
      if (!(await productSkips(ctx, policy, step, productId))) products.push(productId);
    }
    if (products.length === 0) {
      productSkipped++;
      continue;
    }
    try {
      const r = await autopilotApproveReviewItem(ctx, c.reviewItemId, {
        runId,
        productProfileIds: products,
      });
      if (r.approved) approved++;
      await recordStep(
        ctx,
        runId,
        step,
        r.approved ? 'success' : 'skipped',
        r.approved
          ? `score=${c.score} products=${products.join(',')}`
          : 'no longer new: someone decided it first',
        'review_item',
        c.reviewItemId.toString(),
      );
    } catch (err) {
      await itemError(run, step, errorMessage(err), 'review_item', c.reviewItemId.toString());
    }
  }
  return {
    step,
    outcome: 'success',
    detail: `approved=${approved}/${candidates.length}${productSkipNote(productSkipped)}`,
  };
}

/**
 * PC-11 (I018, I001): the (approved item, relevant product) pairs generate
 * + queue still has to do, in SQL before the LIMIT: the product runs the
 * step; the pair has no draft other than superseded ones (a drafted pair
 * never uses up the cap again); and the pair's pipeline lead has a
 * plausible contact email — `contact: 'waiting'` selects the pairs that
 * lack one instead (counted for the run log, never drafted).
 */
function enqueuePairs(
  ctx: WorkspaceContext,
  policy: AutomationPolicy,
  contact: 'has_email' | 'waiting',
): SQL | undefined {
  const leadWithEmail = db
    .select({ id: qualifiedLeads.id })
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, reviewItems.workspaceId),
        eq(qualifiedLeads.reviewItemId, reviewItems.id),
        eq(qualifiedLeads.productProfileId, qualifications.productProfileId),
        plausibleEmailSql(qualifiedLeads.contactEmail),
      ),
    );
  return and(
    eq(reviewItems.workspaceId, ctx.workspaceId),
    eq(reviewItems.state, 'approved'),
    eq(qualifications.isRelevant, true),
    excludeProducts(policy, 'auto_enqueue_outreach', qualifications.productProfileId),
    notExists(
      db
        .select({ id: outreachDrafts.id })
        .from(outreachDrafts)
        .where(
          and(
            eq(outreachDrafts.workspaceId, reviewItems.workspaceId),
            eq(outreachDrafts.reviewItemId, reviewItems.id),
            eq(outreachDrafts.productProfileId, qualifications.productProfileId),
            ne(outreachDrafts.status, 'superseded'),
          ),
        ),
    ),
    contact === 'has_email' ? exists(leadWithEmail) : notExists(leadWithEmail),
  );
}

async function stepAutoEnqueueOutreach(run: StepRun): Promise<StepResult> {
  const { ctx, runId, policy } = run;
  const step = 'auto_enqueue_outreach';
  // Approved review items with a relevant qualification and no draft for
  // that product yet: generate a draft + enqueue.
  const mailboxId = policy.autopilot.defaultMailboxId
    ? policy.autopilot.defaultMailboxId
    : ((await defaultMailbox(ctx))?.id ?? null);
  if (!mailboxId) {
    await recordStep(ctx, runId, step, 'skipped', 'no default mailbox');
    return { step, outcome: 'skipped', detail: 'no default mailbox' };
  }
  // Oldest approval first, so every pair gets its turn across runs.
  const candidates = await db
    .select({ ri: reviewItems, q: qualifications })
    .from(reviewItems)
    .innerJoin(qualifications, itemQualificationJoin())
    .where(enqueuePairs(ctx, policy, 'has_email'))
    .orderBy(asc(reviewItems.approvedAt), asc(reviewItems.id), asc(qualifications.productProfileId))
    .limit(policy.autopilot.maxEnqueuesPerRun);
  const [waiting] = await db
    .select({ n: count() })
    .from(reviewItems)
    .innerJoin(qualifications, itemQualificationJoin())
    .where(enqueuePairs(ctx, policy, 'waiting'));
  const needsContact = Number(waiting?.n ?? 0);

  let enqueued = 0;
  let productSkipped = 0;
  for (const row of candidates) {
    if (await itemHeld(ctx, runId, step, ['autopilot', 'sending'])) break;
    if (await productSkips(ctx, policy, step, row.q.productProfileId)) {
      productSkipped++;
      continue;
    }
    const productMailboxId =
      productPolicy(policy, row.q.productProfileId).defaultMailboxId ?? mailboxId;

    try {
      const draft = await generateOutreachDraft(ctx, {
        reviewItemId: row.ri.id,
        productProfileId: row.q.productProfileId,
        method: 'rules',
      });
      // The queue only accepts approved drafts. Auto-enqueue is an explicit
      // opt-in, so approval here is attributed to the workspace owner who
      // enabled it — recorded on the draft AND in the run log.
      await approveOutreachDraft(ctx, draft.id);
      await enqueueDraft(ctx, {
        draftId: draft.id,
        mailboxId: productMailboxId,
        delayMode: 'random',
      });
      enqueued++;
      await recordStep(
        ctx,
        runId,
        step,
        'success',
        `product=${row.q.productProfileId}`,
        'outreach_draft',
        draft.id.toString(),
      );
    } catch (err) {
      await itemError(run, step, errorMessage(err), 'review_item', row.ri.id.toString());
    }
  }
  return {
    step,
    outcome: 'success',
    detail: `enqueued=${enqueued}/${candidates.length}${
      needsContact > 0 ? ` needs_contact=${needsContact}` : ''
    }${productSkipNote(productSkipped)}`,
  };
}

/** I072: how long a failed CRM push of an unchanged lead waits before the
 *  autopilot tries it again (instead of on every 5-minute run). */
export const CRM_PUSH_RETRY_MS = 60 * 60 * 1000;

/** At most this many leads per CRM step and run, lowest id first. */
export const CRM_STEP_BATCH = 50;

async function crmConnectionFor(ctx: WorkspaceContext, policy: AutomationPolicy) {
  const conns = await listCrmConnections(ctx);
  const chosen = policy.autopilot.defaultCrmConnectionId;
  return chosen
    ? conns.find((c) => c.id === chosen && c.status !== 'archived')
    : conns.find((c) => c.status === 'active' && c.system === 'hubspot');
}

/**
 * I072: a lead needs a push of `kind` to the connection unless it already
 * has a succeeded push made since its last change, or a failed one made
 * since its last change within CRM_PUSH_RETRY_MS. Correlated NOT EXISTS on
 * crm_sync_log (the outer row is the qualified lead).
 */
function needsCrmPush(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  connectionId: bigint,
  kind: 'contact' | 'deal',
  now: Date,
) {
  const pushedSinceChange = (outcome: 'succeeded' | 'failed', since?: Date) =>
    db
      .select({ id: crmSyncLog.id })
      .from(crmSyncLog)
      .where(
        and(
          eq(crmSyncLog.workspaceId, ctx.workspaceId),
          eq(crmSyncLog.crmConnectionId, connectionId),
          eq(crmSyncLog.qualifiedLeadId, qualifiedLeads.id),
          eq(crmSyncLog.kind, kind),
          eq(crmSyncLog.outcome, outcome),
          gte(crmSyncLog.createdAt, qualifiedLeads.updatedAt),
          since ? gte(crmSyncLog.createdAt, since) : undefined,
        ),
      );
  return and(
    notExists(pushedSinceChange('succeeded')),
    notExists(pushedSinceChange('failed', new Date(now.getTime() - CRM_PUSH_RETRY_MS))),
  );
}

/** Record one CRM push on the run log; a failed push is an error of the
 *  step (counted for its incident) like a thrown one. */
async function recordCrmPush(
  run: StepRun,
  step: AutopilotStepKey,
  leadId: bigint,
  entry: { outcome: string; error: string | null },
): Promise<boolean> {
  if (entry.outcome === 'succeeded') {
    await recordStep(run.ctx, run.runId, step, 'success', null, 'qualified_lead', leadId.toString());
    return true;
  }
  await itemError(run, step, entry.error ?? `push ${entry.outcome}`, 'qualified_lead', leadId.toString());
  return false;
}

async function stepAutoCrmContactSync(run: StepRun): Promise<StepResult> {
  const { ctx, runId, policy, options } = run;
  const step = 'auto_crm_contact_sync';
  const conn = await crmConnectionFor(ctx, policy);
  if (!conn) {
    await recordStep(ctx, runId, step, 'skipped', 'no active CRM connection');
    return { step, outcome: 'skipped', detail: 'no active CRM connection' };
  }

  // I072: leads at qualified or beyond that were never pushed to this CRM,
  // or changed since their last push — in id order, so a backlog drains
  // across runs instead of the same 50 being re-pushed every 5 minutes.
  const candidates = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        inArray(qualifiedLeads.state, ['qualified', 'handed_over']),
        excludeProducts(policy, step, qualifiedLeads.productProfileId),
        needsCrmPush(ctx, conn.id, 'contact', new Date()),
      ),
    )
    .orderBy(asc(qualifiedLeads.id))
    .limit(CRM_STEP_BATCH);

  let synced = 0;
  let productSkipped = 0;
  for (const lead of candidates) {
    if (await itemHeld(ctx, runId, step, ['autopilot', 'crm_sync'])) break;
    if (await productSkips(ctx, policy, step, lead.productProfileId)) {
      productSkipped++;
      continue;
    }
    try {
      const r = await pushLeadToCrm(ctx, {
        connectionId: conn.id,
        leadId: lead.id,
        advanceState: false,
        connectorOverride: options.crmConnectorOverride,
        origin: 'autopilot',
      });
      if (await recordCrmPush(run, step, lead.id, r.entry)) synced++;
    } catch (err) {
      await itemError(run, step, errorMessage(err), 'qualified_lead', lead.id.toString());
    }
  }
  return {
    step,
    outcome: 'success',
    detail: `synced=${synced}/${candidates.length}${productSkipNote(productSkipped)}`,
  };
}

async function stepAutoCrmDealOnQualified(run: StepRun): Promise<StepResult> {
  const { ctx, runId, policy, options } = run;
  const step = 'auto_crm_deal_on_qualified';
  const conn = await crmConnectionFor(ctx, policy);
  if (!conn) {
    await recordStep(ctx, runId, step, 'skipped', 'no active CRM connection');
    return { step, outcome: 'skipped', detail: 'no active CRM connection' };
  }

  // I072: qualified leads whose contact is already synced to this CRM (a
  // deal needs it — a lead without one is left out quietly instead of
  // logging "push contact first" on every run) and whose deal was never
  // pushed or changed since, in id order.
  const candidates = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.state, 'qualified'),
        excludeProducts(policy, step, qualifiedLeads.productProfileId),
        exists(
          db
            .select({ id: crmSyncLog.id })
            .from(crmSyncLog)
            .where(
              and(
                eq(crmSyncLog.workspaceId, ctx.workspaceId),
                eq(crmSyncLog.crmConnectionId, conn.id),
                eq(crmSyncLog.qualifiedLeadId, qualifiedLeads.id),
                eq(crmSyncLog.kind, 'contact'),
                eq(crmSyncLog.outcome, 'succeeded'),
                isNotNull(crmSyncLog.externalId),
              ),
            ),
        ),
        needsCrmPush(ctx, conn.id, 'deal', new Date()),
      ),
    )
    .orderBy(asc(qualifiedLeads.id))
    .limit(CRM_STEP_BATCH);

  let created = 0;
  let productSkipped = 0;
  for (const lead of candidates) {
    if (await itemHeld(ctx, runId, step, ['autopilot', 'crm_sync'])) break;
    if (await productSkips(ctx, policy, step, lead.productProfileId)) {
      productSkipped++;
      continue;
    }
    try {
      const r = await pushDeal(ctx, {
        connectionId: conn.id,
        leadId: lead.id,
        connectorOverride: options.crmConnectorOverride,
        origin: 'autopilot',
      });
      if (await recordCrmPush(run, step, lead.id, r.entry)) created++;
    } catch (err) {
      await itemError(run, step, errorMessage(err), 'qualified_lead', lead.id.toString());
    }
  }
  return {
    step,
    outcome: 'success',
    detail: `created=${created}/${candidates.length}${productSkipNote(productSkipped)}`,
  };
}

const STEP_RUNNERS: Readonly<Record<AutopilotStepKey, StepRunner>> = {
  auto_approve_projects: stepAutoApproveProjects,
  auto_enqueue_outreach: stepAutoEnqueueOutreach,
  auto_crm_contact_sync: stepAutoCrmContactSync,
  auto_crm_deal_on_qualified: stepAutoCrmDealOnQualified,
};

// ---- log + read --------------------------------------------------

async function recordStep(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  runId: string,
  step: string,
  outcome: 'success' | 'skipped' | 'error',
  detail: string | null,
  entityType?: string,
  entityId?: string,
): Promise<void> {
  await db.insert(autopilotLog).values({
    workspaceId: ctx.workspaceId,
    runId,
    step,
    outcome,
    detail,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
  });
}

export async function listAutopilotLog(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  limit = 100,
): Promise<AutopilotLogEntry[]> {
  return db
    .select()
    .from(autopilotLog)
    .where(eq(autopilotLog.workspaceId, ctx.workspaceId))
    .orderBy(desc(autopilotLog.createdAt))
    .limit(Math.min(limit, 1000));
}
