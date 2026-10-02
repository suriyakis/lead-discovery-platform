// MOB-02: the attention summary's vocabulary — what needs a person in the
// active workspace right now, as ONE object. The sidebar badges, Today's
// tiles and Needs-you tabs, the bell, the assistant's counts and (later)
// the phone tab bar all read it, from the server (getAttentionSummary) or
// in the browser (GET /api/attention through useAttention), so no two of
// them can disagree. Pure module: client components import it.
//
// Every count key has ONE definition (ATTENTION_KEY_DEFINITIONS) and one
// destination page whose default list it equals. A later PR that changes a
// definition changes the destination page in the same PR (MOB-14 moves
// review.open to review.decide, MOB-16 folds follow-ups into drafts,
// MOB-17 replaces replies.awaiting with the handled state).

import type { FindingSeverity } from '@/lib/diagnostics/types';

/** Bumped when a key's meaning or the JSON shape changes incompatibly. */
export const ATTENTION_VERSION = 1 as const;

export const ATTENTION_COUNT_KEYS = [
  'review.open',
  'review.needsReview',
  'review.mine',
  'drafts.approve',
  'followUps.approve',
  'replies.awaiting',
  'replies.overdue',
  'notifications.unread',
  'support.unread',
  'problems',
] as const;
export type AttentionCountKey = (typeof ATTENTION_COUNT_KEYS)[number];

/** Parts of the summary that are not counts but can fail on their own. */
export const ATTENTION_SECTIONS = ['outreach', 'wallet', 'health', 'platform'] as const;
export type AttentionSection = (typeof ATTENTION_SECTIONS)[number];

export interface AttentionKeyDefinition {
  /** The rows counted, in words (docs, the handbook, tests). */
  counts: string;
  /** The page whose default list equals the number. */
  destination: string;
  /** 'user' = differs per viewer; 'workspace' = the same for every member. */
  scope: 'workspace' | 'user';
}

/**
 * The honest current definition of every key (v1). Destinations are the
 * pages a badge or tile opens; `src/tests/attention.test.ts` pins each
 * number against its destination's default list.
 */
export const ATTENTION_KEY_DEFINITIONS: Readonly<
  Record<AttentionCountKey, AttentionKeyDefinition>
> = {
  'review.open': {
    counts: 'Review items nobody has decided on: state new or needs_review.',
    destination: '/today?tab=review',
    scope: 'workspace',
  },
  'review.needsReview': {
    counts:
      'Review items in needs_review only (the qualifier or the geo gate asked for a person). The Review badge turns amber only while this is above 0.',
    destination: '/review?state=needs_review',
    scope: 'workspace',
  },
  'review.mine': {
    counts: 'Open review items (new or needs_review) assigned to the viewer.',
    destination: '/today?tab=review',
    scope: 'user',
  },
  'drafts.approve': {
    counts: 'Outreach drafts waiting for a person: status draft or needs_edit.',
    destination: '/drafts',
    scope: 'workspace',
  },
  'followUps.approve': {
    counts: 'Follow-ups composed and waiting for approval (status awaiting_approval).',
    destination: '/today?tab=followups',
    scope: 'workspace',
  },
  'replies.awaiting': {
    counts:
      'Mail threads whose latest message (trash and spam left out) is a prospect reply (inbound, relevance prospect_reply) that nobody has answered: no sent outbound message in the thread after it.',
    destination: '/today?tab=replies',
    scope: 'workspace',
  },
  'replies.overdue': {
    counts: 'The replies.awaiting threads whose prospect reply is more than 24 hours old.',
    destination: '/today?tab=replies',
    scope: 'workspace',
  },
  'notifications.unread': {
    counts: "The viewer's unread notifications (the bell).",
    destination: '/notifications',
    scope: 'user',
  },
  'support.unread': {
    counts: 'Support threads with a reply from the platform team the workspace has not read.',
    destination: '/support',
    scope: 'workspace',
  },
  problems: {
    counts:
      'Problems the workspace checks find: critical and warning findings of the diagnostics engine (info and advisory left out).',
    destination: '/health',
    scope: 'workspace',
  },
};

/** A problem finding, as the summary carries it (the same fields /health
 *  and the assistant show: code, severity, title, link). */
export interface AttentionFinding {
  code: string;
  severity: FindingSeverity;
  title: string;
  href: string | null;
  entity?: { type: string; id: string; label?: string };
  /** ISO time the condition started, when known. */
  since: string | null;
}

/** The automation pill as the summary carries it (from Ops' policy). */
export interface AttentionOutreach {
  /** AutomationStateKind: stopped_by_platform | paused | blocked | autopilot_on | manual. */
  state: string;
  label: string;
  /** The workspace pause (PC-05) is on. */
  paused: boolean;
  /** The go-live hold is lifted. */
  live: boolean;
  partlyPaused: boolean;
  /** Something degrades what runs (no tokens, failing mailboxes). */
  degraded: boolean;
  /** Send-queue rows waiting to go out (status queued). */
  queued: number;
  /** Send-queue rows that failed in the last 24 hours. */
  failed24h: number;
}

export interface AttentionWallet {
  /** Token balance (may be negative after a debit race). */
  balance: number;
  billingExempt: boolean;
  /** Not exempt and no tokens left: AI work and automation stop. */
  empty: boolean;
}

export interface AttentionHealth {
  /** 0–100, the diagnostics score (no AI review). */
  score: number;
  critical: number;
  warning: number;
  /** Some checks could not run this time. */
  partial: boolean;
  /** When the findings were evaluated (they are memoised for up to a few
   *  minutes for polling; /health always evaluates afresh). */
  evaluatedAt: string;
}

export interface AttentionSummary {
  version: typeof ATTENTION_VERSION;
  /** The workspace the counts are for (the same resolution as pages). */
  workspaceId: string;
  generatedAt: string;
  /** null = the number could not be loaded: render "—", never 0. */
  counts: Record<AttentionCountKey, number | null>;
  /** Keys and sections that failed to load this time. */
  failed: Array<AttentionCountKey | AttentionSection>;
  /** Something failed: some numbers are unknown. */
  degraded: boolean;
  /** Problems, most severe first (at most ATTENTION_MAX_FINDINGS). */
  findings: AttentionFinding[];
  outreach: AttentionOutreach | null;
  wallet: AttentionWallet | null;
  health: AttentionHealth | null;
  /** Super-admins only: the Platform console's unread support threads. */
  platform: { supportUnread: number | null } | null;
}

/** At most this many problems travel in the summary (the rest: /health). */
export const ATTENTION_MAX_FINDINGS = 20;

/** What every surface prints for a number that could not be loaded. */
export const UNKNOWN_COUNT_TEXT = '—';

/** A count for display: the number, or "—" when unknown (never 0). */
export function formatAttentionCount(value: number | null | undefined): string {
  return value === null || value === undefined ? UNKNOWN_COUNT_TEXT : String(value);
}

/** The newer of two summaries by generatedAt; on a tie the second (the
 *  later read) wins. */
export function newerSummary(
  a: AttentionSummary | null | undefined,
  b: AttentionSummary | null | undefined,
): AttentionSummary | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b.generatedAt) >= Date.parse(a.generatedAt) ? b : a;
}

/** Shape check for a summary that crossed the network (the hook keeps the
 *  last good one when the response is anything else). */
export function isAttentionSummary(value: unknown): value is AttentionSummary {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<AttentionSummary>;
  return (
    v.version === ATTENTION_VERSION &&
    typeof v.workspaceId === 'string' &&
    typeof v.generatedAt === 'string' &&
    !!v.counts &&
    typeof v.counts === 'object' &&
    ATTENTION_COUNT_KEYS.every((k) => {
      const n = (v.counts as Record<string, unknown>)[k];
      return n === null || (typeof n === 'number' && Number.isFinite(n));
    }) &&
    Array.isArray(v.findings) &&
    Array.isArray(v.failed)
  );
}
