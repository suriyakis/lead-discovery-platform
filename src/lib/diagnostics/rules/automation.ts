// AP-06 rules: what stops or runs automatic work — the platform stop, the
// accountable owner, the workspace pause, holds, the go-live hold and
// autopilot. All read the one automation policy (PC-13), loaded once per
// evaluation by the environment.

import { and, count, eq, gte, lt, max } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { autopilotLog } from '@/lib/db/schema/autopilot';
import { formatUtc } from '@/lib/format-utc';
import { describeHoldScope, ownerProblemMessage } from '@/lib/services/automation-gate';
import { AUTOPILOT_STEP_KEYS, type AutopilotStepKey } from '@/lib/services/automation-policy';
import { hoursBefore, plural } from '../env';
import { fixHref } from '../hrefs';
import { defineRule } from '../rule';
import type { FindingDraft } from '../types';

export const platformStopRule = defineRule({
  id: 'automation.platform_stop',
  owner: 'ops',
  summary: 'The platform-wide outbound stop (super-admin only).',
  async evaluate(env) {
    const stop = (await env.policy()).state.platformOutboundStop;
    if (!stop) return [];
    return [
      {
        code: 'automation.platform_stop',
        severity: 'warning',
        title: 'Outbound email is stopped by the platform',
        detail:
          `The platform team stopped outbound email for every workspace since ${formatUtc(stop.since)}: ` +
          `${stop.reason} Nothing is sent, manual email included, until they lift it. Inbox sync keeps reading.`,
        href: fixHref.support(),
        since: stop.since,
        actionKinds: ['contact_support'],
      },
    ];
  },
});

export const ownerRule = defineRule({
  id: 'automation.owner',
  owner: 'ops',
  summary: 'No accountable owner: automatic work is stopped (PC-06).',
  async evaluate(env) {
    const { state } = await env.policy();
    if (!state.ownerProblem) return [];
    return [
      {
        code: 'automation.owner',
        severity: 'critical',
        title: 'Automatic work stopped: the owner is not accountable',
        detail: ownerProblemMessage(state),
        facts: { problem: state.ownerProblem },
        href: fixHref.members(),
        since: state.ownerIncidentOpenSince,
        actionKinds: ['open', 'contact_support'],
      },
    ];
  },
});

/**
 * The one workspace pause (PC-05, I004). The two legacy flags
 * (autopilot_settings.emergency_pause, outreach_send_settings
 * .emergency_pause) are write-only mirrors of it now, so this reads the
 * pause alone and says what it stops and what keeps running.
 */
export const outreachPausedRule = defineRule({
  id: 'outreach.paused',
  owner: 'ops',
  summary: 'The workspace pause: what it stops and what keeps running.',
  async evaluate(env) {
    const { state } = await env.policy();
    const pause = state.pause;
    if (!pause) return [];
    let pausedBy: string | null = null;
    if (pause.byUserId) {
      const [u] = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, pause.byUserId))
        .limit(1);
      if (u) pausedBy = u.name?.trim() || u.email;
    }
    return [
      {
        code: 'outreach.paused',
        severity: 'warning',
        title: 'All automation is paused',
        detail:
          `Paused${pausedBy ? ` by ${pausedBy}` : ''} since ${formatUtc(pause.since)}${pause.reason ? `: ${pause.reason}` : ''}. ` +
          'The send queue, follow-ups, autopilot, scheduled searches, reply auto-actions and background AI ' +
          'wait; nothing fails. Inbox sync keeps reading. A manual send asks you to confirm "send anyway". ' +
          'An owner or admin resumes it.',
        facts: { source: pause.source, pausedBy },
        href: fixHref.pause(),
        since: pause.since,
        actionKinds: ['open'],
      },
    ];
  },
});

export const holdsRule = defineRule({
  id: 'automation.hold',
  owner: 'ops',
  summary: 'Each enforced hold, by the workspace or the platform (PC-06).',
  async evaluate(env) {
    const { state } = await env.policy();
    const now = env.now.getTime();
    return state.holds
      .filter((h) => h.expiresAt === null || h.expiresAt.getTime() > now)
      .map((h): FindingDraft => {
        const what = describeHoldScope(h);
        const platform = h.source === 'platform';
        return {
          code: 'automation.hold',
          severity: 'warning',
          title: `${what} ${h.scope === 'capabilities' && h.capabilities.length > 1 ? 'are' : 'is'} on hold${platform ? ' by the platform' : ''}`,
          detail:
            `Since ${formatUtc(h.placedAt)}: ${h.reason}` +
            (h.expiresAt ? ` It ends ${formatUtc(h.expiresAt)}.` : '') +
            (platform
              ? ' Only the platform team can release it.'
              : ' An owner or admin of this workspace releases it.'),
          facts: {
            holdId: h.id.toString(),
            source: h.source,
            scope: h.scope,
            capabilities: h.capabilities.join(','),
          },
          href: platform ? fixHref.support() : fixHref.autopilot(),
          entity: { type: 'hold', id: h.id.toString() },
          since: h.placedAt,
          actionKinds: platform ? ['contact_support'] : ['open'],
        };
      });
  },
});

/** flow:F-07: workspaces start not live; a person on the platform team
 *  releases them (the F-40 checklist later). Info: it is the expected
 *  state of a new workspace, but it explains "why did nothing go out". */
export const goLiveRule = defineRule({
  id: 'golive.not_live',
  owner: 'ops',
  summary: 'The go-live hold: cold, follow-up and AI-reply mail held until released.',
  async evaluate(env) {
    const { state } = await env.policy();
    if (state.live) return [];
    return [
      {
        code: 'golive.not_live',
        severity: 'info',
        title: 'Outreach is not live yet',
        detail:
          'Cold outreach, follow-ups and AI reply emails are held (queued, never failed) until the platform ' +
          'team releases this workspace. Manual email sends normally.',
        href: fixHref.support(),
        actionKinds: ['contact_support'],
      },
    ];
  },
});

const STEP_SHORT: Readonly<Record<AutopilotStepKey, string>> = {
  auto_approve_projects: 'Auto-approve',
  auto_enqueue_outreach: 'Generate + queue',
  auto_crm_contact_sync: 'CRM contact sync',
  auto_crm_deal_on_qualified: 'CRM deals',
};

/**
 * Autopilot as it really is (I057): on (which steps, threshold, product
 * overrides, the last run and its errors in 24 h), or off with steps still
 * armed — production's workspace 2 has auto-approve on while autopilot is
 * off, so switching autopilot on would start approving at once.
 *   warning  armed while off; on without a plan that includes it
 *   info     on, running (the state the assistant needs)
 *   none     off with nothing armed
 */
export const autopilotStateRule = defineRule({
  id: 'autopilot.state',
  owner: 'diagnostics',
  summary: 'Autopilot on (steps, threshold, last run, errors in 24 h) or steps armed while it is off.',
  async evaluate(env) {
    const policy = await env.policy();
    const ap = policy.autopilot;
    const stepsOn = AUTOPILOT_STEP_KEYS.filter((k) => ap.steps[k]);
    if (!ap.enabled && stepsOn.length === 0) return [];

    const [[errors], [last]] = await Promise.all([
      db
        .select({ n: count() })
        .from(autopilotLog)
        .where(
          and(
            eq(autopilotLog.workspaceId, env.ctx.workspaceId),
            eq(autopilotLog.outcome, 'error'),
            gte(autopilotLog.createdAt, hoursBefore(env.now, 24)),
            lt(autopilotLog.createdAt, env.now),
          ),
        ),
      db
        .select({ at: max(autopilotLog.createdAt) })
        .from(autopilotLog)
        .where(eq(autopilotLog.workspaceId, env.ctx.workspaceId)),
    ]);
    const errors24h = Number(errors?.n ?? 0);
    const lastRunAt = last?.at ?? null;
    const overrides = policy.products.filter((p) => p.hasOverrides).length;
    const facts = {
      enabled: ap.enabled,
      planAllows: ap.planAllows,
      stepsOn: stepsOn.join(','),
      autoApproveThreshold: ap.autoApproveThreshold,
      productOverrides: overrides,
      pausedProducts: policy.pausedProducts.length,
      lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
      errors24h,
    };
    const stepList = stepsOn.map((k) => STEP_SHORT[k]).join(', ');

    if (!ap.enabled) {
      const approveArmed = ap.steps.auto_approve_projects;
      return [
        {
          code: 'autopilot.state',
          severity: 'warning',
          title: approveArmed
            ? 'Auto-approve armed while autopilot is off'
            : 'Autopilot steps armed while autopilot is off',
          detail:
            `Autopilot is off, but ${plural(stepsOn.length, 'step is', 'steps are')} still switched on (${stepList}).` +
            (approveArmed
              ? ` Switching autopilot on would start approving review items scored ${ap.autoApproveThreshold} or more without a person.`
              : ' Switching autopilot on would start them at once.') +
            ' Switch the steps off on the Autopilot page unless that is what you want.',
          facts,
          href: fixHref.autopilot(),
        },
      ];
    }

    const sentences = [
      stepsOn.length > 0 ? `Steps on: ${stepList}.` : 'No step is switched on, so it does nothing yet.',
      ap.steps.auto_approve_projects ? `Auto-approve threshold: ${ap.autoApproveThreshold}.` : null,
      overrides > 0 ? `${plural(overrides, 'product narrows', 'products narrow')} it.` : null,
      policy.pausedProducts.length > 0
        ? `${plural(policy.pausedProducts.length, 'product is', 'products are')} paused.`
        : null,
      lastRunAt ? `Last activity ${formatUtc(new Date(lastRunAt))}.` : 'It has not run yet.',
      errors24h > 0 ? `${plural(errors24h, 'step error')} in the last 24 hours.` : null,
      ap.planAllows ? null : 'The plan does not include autopilot, so it does not run.',
      ap.steps.auto_approve_projects
        ? 'The review items it approves are attributed to the workspace owner.'
        : null,
    ];
    return [
      {
        code: 'autopilot.state',
        severity: ap.planAllows ? 'info' : 'warning',
        title: ap.planAllows ? 'Autopilot is on' : 'Autopilot is on, but the plan does not include it',
        detail: sentences.filter((s): s is string => Boolean(s)).join(' '),
        facts,
        href: fixHref.autopilot(),
      },
    ];
  },
});
