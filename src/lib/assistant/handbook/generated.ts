// Generated handbook blocks (AP-03): facts the code already holds,
// rendered as handbook text, so the guide changes when the code does
// instead of drifting from it.
//
//   screens            the navigation registry's route table (I134)
//   pipelineStages     pipelineState / closeReason enum values
//   replyClasses       REPLY_CLASSES (I133)
//   languagePrecedence LANGUAGE_PRECEDENCE, which the resolver walks (I132)
//   autopilotSteps     AUTOPILOT_STEPS, in run order
//   billing            the plan and pack catalogue as the billing page
//                      offers it, plus the trial length (I181)
//
// Everything here is free of database access so the docs export
// (scripts/handbook-export.ts) runs without a database.

import { AUTOPILOT_STEPS, type AutopilotStepId } from '@/lib/autopilot/steps';
import {
  FREE_LIMITS,
  getAvailablePlans,
  getPlans,
  readTrialDays,
  type BillingEnv,
  type PlanDefinition,
  type PlanLimits,
} from '@/lib/billing/plans';
import { tokenPacks, type TokenPack } from '@/lib/billing/tokens';
import { closeReason, pipelineState } from '@/lib/db/schema/pipeline';
import { LANGUAGE_PRECEDENCE } from '@/lib/i18n/language-precedence';
import { REPLY_CLASSES } from '@/lib/mail/reply-classes';
import { routeTable, type RouteTableRow } from '@/lib/nav/route-table';

export interface HandbookBlocks {
  screens: string;
  pipelineStages: string;
  replyClasses: string;
  languagePrecedence: string;
  autopilotSteps: string;
  billing: string;
}

// ---- billing --------------------------------------------------------------

export interface BillingFacts {
  /** Plans on sale (a price id is set). */
  plans: ReadonlyArray<PlanDefinition>;
  /** Token packs on sale (a price id is set). */
  packs: ReadonlyArray<TokenPack>;
  trialDays: number;
  /** True for the docs: the default catalogue, not what one install sells. */
  documented?: boolean;
}

/** What this install sells, read once from the environment at boot. */
export function billingFactsFromEnv(env: BillingEnv = process.env): BillingFacts {
  return {
    plans: getAvailablePlans(env),
    packs: tokenPacks(env).filter((p) => p.priceId !== null),
    trialDays: readTrialDays(env),
  };
}

/** The default catalogue, for docs/USER_GUIDE.md (independent of any env). */
export function documentedBillingFacts(): BillingFacts {
  return {
    plans: getPlans({}),
    packs: tokenPacks({}),
    trialDays: readTrialDays({}),
    documented: true,
  };
}

const n = (value: number) => value.toLocaleString('en-US');

function limitsPhrase(l: PlanLimits): string {
  const parts = [
    l.maxProducts === null
      ? 'unlimited products'
      : `up to ${l.maxProducts} product${l.maxProducts === 1 ? '' : 's'}`,
    l.maxMailboxes === null
      ? 'unlimited mailboxes'
      : `up to ${l.maxMailboxes} mailbox${l.maxMailboxes === 1 ? '' : 'es'}`,
  ];
  if (l.autopilot) parts.push('autopilot');
  if (l.byok) parts.push('BYOK (your own API keys)');
  return parts.join(', ');
}

export function billingBlock(f: BillingFacts): string {
  const lines: string[] = [];
  if (f.plans.length === 0) {
    lines.push(
      '- No subscription plan is on sale right now: the workspace runs on its welcome tokens and token packs.',
    );
  } else {
    const plans = f.plans
      .map(
        (p) =>
          `${p.name} (${p.displayPrice}) includes ${n(p.monthlyTokens)} tokens a month + ${limitsPhrase(p.limits)}.`,
      )
      .join(' ');
    const trial =
      f.trialDays > 0
        ? `A new subscription starts with a ${f.trialDays}-day free trial: the card is taken up front, the trial runs on the welcome tokens, and the first paid invoice brings the first allowance.`
        : 'New subscriptions start without a free trial.';
    lines.push(
      `- SUBSCRIPTIONS refill the wallet monthly. ${plans} Unused tokens roll over while subscribed. The allowance lands when each invoice is PAID. ${trial}`,
    );
  }
  const free = `${FREE_LIMITS.maxProducts} product, ${FREE_LIMITS.maxMailboxes} mailbox, ${
    FREE_LIMITS.autopilot ? 'autopilot' : 'no autopilot'
  }, ${FREE_LIMITS.byok ? 'BYOK' : 'no BYOK'}`;
  lines.push(`- Without a subscription: ${free} — but token packs still work for metered usage.`);
  lines.push(
    f.packs.length === 0
      ? '- No one-time token packs are on sale right now.'
      : `- One-time top-up packs for bursts: ${f.packs
          .map((p) => `${p.name} ${p.display} → ${n(p.tokens)}`)
          .join(', ')} tokens.`,
  );
  if (f.documented) {
    lines.push(
      '- These are the default prices; the billing page shows the plans and packs on sale and their prices.',
    );
  }
  return lines.join('\n');
}

// ---- small lists ----------------------------------------------------------

export function pipelineStagesSentence(): string {
  const stages = pipelineState.enumValues.filter((s) => s !== 'closed');
  return `Stages, in order: ${stages.join(' → ')}; any stage can move to closed, and closing needs a close reason (${closeReason.enumValues.join(', ')}).`;
}

export function replyClassesList(): string {
  return `${REPLY_CLASSES.slice(0, -1).join(', ')} or ${REPLY_CLASSES.at(-1)}`;
}

export function languagePrecedenceList(): string {
  const tiers = LANGUAGE_PRECEDENCE.filter((t) => t.source !== 'default');
  const fallback = LANGUAGE_PRECEDENCE.find((t) => t.source === 'default');
  const numbered = tiers.map((t, i) => `(${i + 1}) ${t.label} (${t.where})`).join('; ');
  return fallback ? `${numbered}; otherwise ${fallback.label}.` : `${numbered}.`;
}

export function autopilotStepList(notes: Readonly<Record<AutopilotStepId, string>>): string {
  return AUTOPILOT_STEPS.map((s) => {
    const note = notes[s.id];
    return note ? `- ${s.label}: ${note}` : `- ${s.label}.`;
  }).join('\n');
}

// ---- screens --------------------------------------------------------------

const unstop = (s: string) => s.replace(/\.$/, '');

function rowText(r: RouteTableRow): string {
  if (r.view) {
    const { pathname } = new URL(r.href!, 'http://nav.invalid');
    return `${r.label}, a view of [${pathname}] (${unstop(r.purpose)})`;
  }
  return `${r.label} [${r.href}] (${unstop(r.purpose)})`;
}

/**
 * "## Where things are": every workspace page the navigation registry
 * offers, area by area, in sidebar order — linkable pages as [/path],
 * pages opened from a list named with that list. Platform-console pages
 * are left out (the guide answers workspace users).
 */
export function screensIndex(rows: ReadonlyArray<RouteTableRow> = routeTable()): string {
  const tenant = rows.filter((r) => r.scope === 'tenant');
  const areaIds = [...new Set(tenant.map((r) => r.areaId))];
  const lines = [
    '## Where things are',
    'The sidebar has Today, then three groups: Work, Build and Workspace. My account and Help & support are in the account menu at the top right; the Search button (or Ctrl-K / Cmd-K) jumps to any page. Area by area:',
  ];
  for (const areaId of areaIds) {
    const areaRows = tenant.filter((r) => r.areaId === areaId);
    const head = areaRows[0]!;
    const where =
      head.placement === 'menu'
        ? `Account menu › ${head.areaLabel}`
        : head.groupHeading
          ? `${head.groupHeading} › ${head.areaLabel}`
          : head.areaLabel;
    const parts: string[] = [];
    let section: string | null = null;
    for (const r of areaRows.filter((x) => x.kind === 'tab')) {
      const text = rowText(r);
      if (r.section && r.section !== section) {
        section = r.section;
        parts.push(`${section} — ${text}`);
      } else {
        parts.push(text);
      }
    }
    const also = areaRows.filter((r) => r.kind !== 'tab' && r.href !== null).map(rowText);
    const opened = areaRows
      .filter((r) => r.href === null)
      .map((r) => `${r.label} (from [${r.openedFrom}])`);
    const tail =
      (also.length > 0 ? ` Also: ${also.join('; ')}.` : '') +
      (opened.length > 0 ? ` Opened from a list: ${opened.join(', ')}.` : '');
    lines.push(`- ${where}: ${parts.join('; ')}.${tail}`);
  }
  return lines.join('\n');
}

export function generatedBlocks({
  billing,
  autopilotNotes,
}: {
  billing: BillingFacts;
  autopilotNotes: Readonly<Record<AutopilotStepId, string>>;
}): HandbookBlocks {
  return {
    screens: screensIndex(),
    pipelineStages: pipelineStagesSentence(),
    replyClasses: replyClassesList(),
    languagePrecedence: languagePrecedenceList(),
    autopilotSteps: autopilotStepList(autopilotNotes),
    billing: billingBlock(billing),
  };
}
