// PC-38 (I184, I028): guards for an operator's AI buttons — a rate limit
// per workspace and single-flight.
//
// Before this the buttons that start AI work had neither: a double-click,
// a second tab or a scripted client could start "Re-classify all",
// "Synthesize now", "Compact now" or a product autofill again and again,
// each one AI call (or thousands) on the platform key — or on the
// workspace's own key, where no wallet gate caps anything.
//
//   withRateLimit(ctx, action, fn)   at most GUARDED_ACTIONS[action].limit
//                                    starts per window per workspace, on
//                                    the shared limiter (src/lib/rate-limit
//                                    .ts: Postgres, so the web server and
//                                    the worker count together and a deploy
//                                    resets nothing). Over it: ActionGuard-
//                                    Error 'rate_limited' and fn never runs.
//   singleFlight(ctx, action, fn)    fn runs under the work lease
//                                    (kind 'action', resource = the action's
//                                    name or '<name>:<id>', purpose
//                                    'action:<name>'; services/work-leases
//                                    .ts). While someone holds it a second
//                                    caller gets ActionGuardError
//                                    'already_running' and fn never runs.
//   guardAction(ctx, action, fn)     both: single-flight first, so a
//                                    double-click that gets "already
//                                    running" does not use up the limit.
//
// ActionGuardError is a coded service error: describeActionError shows its
// message as is (src/lib/action-errors.ts).
//
// Single-flight that other work already gives is not doubled: autopilot's
// Run now runs under the workspace's 'autopilot.run' lease and a recipe's
// Run now under the recipe's 'connector.recipe' lease (PC-12), so those two
// take only the rate limit.

import { rateLimitCheck } from '@/lib/rate-limit';
import { formatUtc } from '@/lib/format-utc';
import type { WorkspaceContext } from './context';
import {
  ACTION_RESOURCE_PATTERN,
  withWorkLease,
  type LeaseHolder,
  type WorkLease,
  type WorkLeaseSpec,
} from './work-leases';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface GuardedActionPolicy {
  /** The button, as the operator knows it. */
  label: string;
  /** Starts allowed per window per workspace. */
  limit: number;
  windowMs: number;
}

/**
 * Every guarded button. The limits leave normal use untouched (nobody
 * synthesizes more than a few times an hour) and stop loops.
 */
export const GUARDED_ACTIONS = {
  'qualification.reclassify_all': { label: 'Re-classify all', limit: 6, windowMs: HOUR },
  'learning.synthesize': { label: 'Synthesize now', limit: 6, windowMs: HOUR },
  'knowledge.compact': { label: 'Compact now', limit: 6, windowMs: HOUR },
  'product.autofill': { label: 'Generate product profile', limit: 20, windowMs: HOUR },
  'health.check_now': { label: 'Run check now', limit: 6, windowMs: HOUR },
  'autopilot.run_now': { label: 'Autopilot Run now', limit: 30, windowMs: HOUR },
  'crawl_plan.run_now': { label: 'Crawl plan Run now', limit: 30, windowMs: HOUR },
  'connector.recipe_run_now': { label: 'Recipe Run now', limit: 60, windowMs: HOUR },
} as const satisfies Record<string, GuardedActionPolicy>;

export type GuardedAction = keyof typeof GUARDED_ACTIONS;

export type ActionGuardCode = 'rate_limited' | 'already_running';

/** A guard refused the action; nothing ran. */
export class ActionGuardError extends Error {
  public readonly code: ActionGuardCode;
  public readonly action: GuardedAction;
  /** 'rate_limited': how long until the window ends. */
  public readonly retryAfterMs: number | null;
  /** 'already_running': who holds the action's lease. */
  public readonly held: LeaseHolder | null;

  constructor(
    message: string,
    input: {
      code: ActionGuardCode;
      action: GuardedAction;
      retryAfterMs?: number | null;
      held?: LeaseHolder | null;
    },
  ) {
    super(message);
    this.name = 'ActionGuardError';
    this.code = input.code;
    this.action = input.action;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.held = input.held ?? null;
  }
}

/** The limiter key of an action in a workspace. */
export function actionRateLimitKey(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  action: GuardedAction,
): string {
  return `action:${action}:ws:${ctx.workspaceId}`;
}

/** The work-lease resource of an action ('<name>' or '<name>:<id>'). */
export function actionLeaseResource(action: GuardedAction, resource?: bigint | string): string {
  const key = resource === undefined ? action : `${action}:${resource.toString()}`;
  if (!ACTION_RESOURCE_PATTERN.test(key)) {
    throw new Error(`invalid action lease resource ${JSON.stringify(key)}`);
  }
  return key;
}

/** "a minute", "12 minutes", "2 hours". */
export function describeWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  if (minutes === 1) return 'a minute';
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

function describeWindow(windowMs: number): string {
  if (windowMs === HOUR) return 'hour';
  if (windowMs === MINUTE) return 'minute';
  return describeWait(windowMs);
}

export function rateLimitedMessage(action: GuardedAction, retryAfterMs: number): string {
  const p: GuardedActionPolicy = GUARDED_ACTIONS[action];
  return `${p.label} was used ${p.limit} times in the last ${describeWindow(p.windowMs)} in this workspace. Try again in ${describeWait(retryAfterMs)}.`;
}

export function alreadyRunningMessage(
  action: GuardedAction,
  held: Pick<LeaseHolder, 'acquiredAt'> | null,
): string {
  const since = held ? ` (started ${formatUtc(held.acquiredAt)})` : '';
  return `${GUARDED_ACTIONS[action].label} is already running in this workspace${since}. This click started nothing; the running one finishes on its own.`;
}

/** Throw ActionGuardError 'already_running' for this action. */
export function alreadyRunning(
  action: GuardedAction,
  held: LeaseHolder | null,
  message: string = alreadyRunningMessage(action, held),
): ActionGuardError {
  return new ActionGuardError(message, { code: 'already_running', action, held });
}

/**
 * Run `fn` when the workspace is within the action's limit (counting this
 * start); otherwise throw ActionGuardError 'rate_limited'.
 */
export async function withRateLimit<T>(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  action: GuardedAction,
  fn: () => Promise<T>,
): Promise<T> {
  const p: GuardedActionPolicy = GUARDED_ACTIONS[action];
  const decision = await rateLimitCheck(actionRateLimitKey(ctx, action), p.limit, p.windowMs);
  if (!decision.allowed) {
    throw new ActionGuardError(rateLimitedMessage(action, decision.retryAfterMs), {
      code: 'rate_limited',
      action,
      retryAfterMs: decision.retryAfterMs,
    });
  }
  return fn();
}

export interface SingleFlightOptions {
  /** What the action acts on (a plan or recipe id): one at a time per
   *  resource instead of per workspace. */
  resource?: bigint | string;
  /** Lease policy overrides (WorkLeaseSpec). */
  lease?: Pick<WorkLeaseSpec, 'ttlMs' | 'maxHoldMs' | 'autoRenew'>;
}

/**
 * Run `fn` under the action's work lease, released afterwards; when
 * someone else holds it, throw ActionGuardError 'already_running'.
 */
export async function singleFlight<T>(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  action: GuardedAction,
  fn: (lease: WorkLease) => Promise<T>,
  options: SingleFlightOptions = {},
): Promise<T> {
  const r = await withWorkLease(
    ctx,
    {
      kind: 'action',
      resource: actionLeaseResource(action, options.resource),
      purpose: `action:${action}`,
      ...options.lease,
    },
    fn,
  );
  if (r.status === 'lease_held') throw alreadyRunning(action, r.held);
  return r.value;
}

/** singleFlight + withRateLimit: the guard every AI button goes through. */
export async function guardAction<T>(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  action: GuardedAction,
  fn: (lease: WorkLease) => Promise<T>,
  options: SingleFlightOptions = {},
): Promise<T> {
  return singleFlight(ctx, action, (lease) => withRateLimit(ctx, action, () => fn(lease)), options);
}
