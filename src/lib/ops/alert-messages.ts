// PC-08: what an owner alert says. Pure functions: an incident, a digest
// of many, a platform stop / hold / pause change, or the console's test
// message becomes an AlertMessage (title, body, ntfy priority, tags,
// click link). The sink (ntfy.ts) only transports it.
//
// Everything here is built from data that is already masked (ops_events
// titles and messages are masked when stored, mask.ts) or is masked here
// (workspace names, reasons typed by people).

import { z } from 'zod';
import { BRAND_NAME } from '@/lib/brand';
import { formatUtc } from '@/lib/format-utc';
import type { OpsEventSeverity } from '@/lib/services/ops-events';
import { severityRank } from './alert-config';
import { maskSensitive } from './mask';

/** ntfy priorities: 1 min, 2 low, 3 default, 4 high, 5 max (urgent). */
export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

export interface AlertMessage {
  title: string;
  body: string;
  priority: NtfyPriority;
  /** ntfy tags; emoji short codes render as icons. */
  tags: string[];
  /** Opened when the notification is tapped. */
  click: string | null;
}

/** Severity → ntfy priority. */
export const SEVERITY_PRIORITY: Readonly<Record<OpsEventSeverity, NtfyPriority>> = {
  info: 2,
  warning: 3,
  error: 4,
  critical: 5,
};

const SEVERITY_EMOJI: Readonly<Record<OpsEventSeverity, string>> = {
  info: 'information_source',
  warning: 'warning',
  error: 'red_circle',
  critical: 'rotating_light',
};

export function priorityForSeverity(severity: string): NtfyPriority {
  return SEVERITY_PRIORITY[severity as OpsEventSeverity] ?? 3;
}

function severityTags(severity: string): string[] {
  const emoji = SEVERITY_EMOJI[severity as OpsEventSeverity];
  return emoji ? [emoji, severity] : [severity];
}

// ---- noise -----------------------------------------------------------------

/**
 * Errors that are noise, never an owner alert (and never in a digest):
 * an incident whose title or message contains one of these phrases
 * (case-insensitive). Plain phrases, not regexes, so the dispatcher can
 * apply the same rule in SQL (ILIKE) before its per-pass limit.
 * X10: scanners probe server actions all day; Next.js answers each probe
 * with "Failed to find Server Action". Production runs a patched Next.js,
 * so these are not an incident.
 */
export const ALERT_NOISE_PHRASES: readonly string[] = ['Failed to find Server Action'];

export function isAlertNoise(event: { title: string; message: string | null }): boolean {
  const text = `${event.title}\n${event.message ?? ''}`.toLowerCase();
  return ALERT_NOISE_PHRASES.some((phrase) => text.includes(phrase.toLowerCase()));
}

/** An ILIKE pattern matching `phrase` anywhere, with LIKE wildcards escaped. */
export function containsPattern(phrase: string): string {
  return `%${phrase.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---- incidents ---------------------------------------------------------------

/** The slice of an ops_events row an alert needs. */
export interface AlertableEvent {
  id: bigint;
  fingerprint: string;
  scope: string;
  workspaceId: bigint | null;
  kind: string;
  severity: string;
  source: string;
  title: string;
  message: string | null;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface FormatOptions {
  appUrl: string | null;
  /** workspace id → name, for readable lines. */
  workspaceNames?: ReadonlyMap<string, string>;
}

const TITLE_MAX = 180;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function title(text: string): string {
  return clip(`${BRAND_NAME}: ${text}`, TITLE_MAX);
}

function consoleLink(appUrl: string | null): string | null {
  return appUrl ? `${appUrl}/admin` : null;
}

export function workspaceLabel(workspaceId: bigint, names?: ReadonlyMap<string, string>): string {
  const name = names?.get(workspaceId.toString());
  return name ? `${maskSensitive(name, 80)} (#${workspaceId})` : `workspace #${workspaceId}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatIncidentAlert(
  event: AlertableEvent,
  options: FormatOptions & { reminder: boolean },
): AlertMessage {
  const where =
    event.workspaceId !== null
      ? `Workspace: ${workspaceLabel(event.workspaceId, options.workspaceNames)}`
      : 'Platform-wide';
  const lines = [
    event.message ?? '',
    where,
    `${event.severity} · ${event.kind} · ${event.source}`,
    `${plural(event.occurrences, 'occurrence')} since ${formatUtc(event.firstSeenAt)}, last ${formatUtc(event.lastSeenAt)}`,
    options.reminder
      ? 'Still open. This reminder repeats every 6 h until it resolves.'
      : 'Repeats are counted, not re-sent; a reminder follows after 6 h if it is still open.',
  ].filter((l) => l !== '');
  return {
    title: title(`${options.reminder ? 'still open: ' : ''}${event.title}`),
    body: lines.join('\n'),
    priority: priorityForSeverity(event.severity),
    tags: severityTags(event.severity),
    click: consoleLink(options.appUrl),
  };
}

// ---- digests -------------------------------------------------------------------

export interface EventGroup {
  kind: string;
  source: string;
  title: string;
  /** Highest severity in the group. */
  severity: string;
  incidents: number;
  occurrences: number;
  workspaces: number;
  oldest: Date;
}

/** Open incidents grouped by (kind, source): what a digest lists. Most
 *  severe first, then the largest groups. */
export function groupEvents(events: readonly AlertableEvent[]): EventGroup[] {
  const groups = new Map<string, EventGroup & { ws: Set<string> }>();
  for (const e of events) {
    const key = `${e.kind}\u001f${e.source}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        kind: e.kind,
        source: e.source,
        title: e.title,
        severity: e.severity,
        incidents: 0,
        occurrences: 0,
        workspaces: 0,
        oldest: e.firstSeenAt,
        ws: new Set(),
      };
      groups.set(key, g);
    }
    g.incidents += 1;
    g.occurrences += e.occurrences;
    if (e.workspaceId !== null) g.ws.add(e.workspaceId.toString());
    if (severityRank(e.severity) > severityRank(g.severity)) {
      g.severity = e.severity;
      g.title = e.title;
    }
    if (e.firstSeenAt < g.oldest) g.oldest = e.firstSeenAt;
  }
  return [...groups.values()]
    .map(({ ws, ...g }) => ({ ...g, workspaces: ws.size }))
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        b.incidents - a.incidents ||
        a.oldest.getTime() - b.oldest.getTime(),
    );
}

/** Counts per severity, most severe first: "1 critical, 3 error". */
export function severityCounts(events: readonly { severity: string }[]): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.severity, (counts.get(e.severity) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => severityRank(b[0]) - severityRank(a[0]))
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');
}

/** Groups listed in a digest; the rest are summed up in one line. */
export const DIGEST_MAX_GROUPS = 20;

export function formatGroupLine(g: EventGroup): string {
  const parts = [
    `${g.incidents}× ${g.title} [${g.severity}]`,
    `${g.source} (${g.kind})`,
    ...(g.workspaces > 0 ? [plural(g.workspaces, 'workspace')] : []),
    plural(g.occurrences, 'occurrence'),
    `since ${formatUtc(g.oldest)}`,
  ];
  return `• ${parts.join(' · ')}`;
}

export function formatDigestAlert(
  events: readonly AlertableEvent[],
  options: FormatOptions & { variant: 'burst' | 'daily' },
): AlertMessage {
  const groups = groupEvents(events);
  const shown = groups.slice(0, DIGEST_MAX_GROUPS).map(formatGroupLine);
  const hidden = groups.length - shown.length;
  const top = events.reduce(
    (best, e) => (severityRank(e.severity) > severityRank(best) ? e.severity : best),
    'info',
  );
  const lines =
    options.variant === 'burst'
      ? [
          `${plural(events.length, 'incident')} opened at once (${severityCounts(events)}), folded into one message.`,
          ...shown,
        ]
      : [`Open incidents: ${events.length} (${severityCounts(events)}).`, ...shown];
  if (hidden > 0) lines.push(`…and ${plural(hidden, 'more group')}.`);
  return {
    title: title(
      options.variant === 'burst'
        ? `${plural(events.length, 'new incident')}`
        : `daily digest, ${plural(events.length, 'open incident')}`,
    ),
    body: lines.join('\n'),
    // The daily digest is a summary: the individual alerts already went out.
    priority: options.variant === 'burst' ? priorityForSeverity(top) : 3,
    tags: options.variant === 'burst' ? [...severityTags(top), 'digest'] : ['clipboard', 'digest'],
    click: consoleLink(options.appUrl),
  };
}

// ---- platform stop / hold / pause changes ----------------------------------

const ReasonSchema = z.string().max(2000).optional();

/**
 * A change to what is allowed to run. Raised by the controls themselves
 * (the platform-wide outbound stop, workspace holds, the workspace
 * automation pause; src/lib/services/holds.ts and automation-gate.ts) right
 * after the change is committed. Who acted is in the audit log; the alert
 * carries no personal data.
 */
export const ControlChangeSchema = z.discriminatedUnion('control', [
  z.object({
    control: z.literal('platform_outbound_stop'),
    action: z.enum(['set', 'cleared']),
    reason: ReasonSchema,
  }),
  z.object({
    control: z.literal('workspace_hold'),
    action: z.enum(['placed', 'released', 'expired', 'confirmed', 'discarded']),
    /** Who placed the hold: the platform console or the workspace itself. */
    source: z.enum(['platform', 'tenant']),
    workspaceId: z.bigint().positive(),
    holdId: z.bigint().positive().optional(),
    /** What it covers, e.g. "All automation" or "Sending, Inbox sync". */
    scopeLabel: z.string().trim().min(1).max(200),
    reason: ReasonSchema,
  }),
  z.object({
    control: z.literal('automation_pause'),
    action: z.enum(['paused', 'resumed']),
    workspaceId: z.bigint().positive(),
    reason: ReasonSchema,
  }),
]);

export type ControlChange = z.infer<typeof ControlChangeSchema>;

/** Identity of one change, for the double-submit dedupe. */
export function controlChangeKey(change: ControlChange): string {
  const ws = 'workspaceId' in change ? change.workspaceId.toString() : '-';
  const hold = change.control === 'workspace_hold' ? (change.holdId?.toString() ?? '-') : '-';
  return `control:${change.control}:${ws}:${hold}:${change.action}`;
}

export function formatControlAlert(change: ControlChange, options: FormatOptions): AlertMessage {
  const reason = change.reason?.trim() ? `Reason: ${maskSensitive(change.reason, 300)}` : '';
  const click = consoleLink(options.appUrl);
  const msg = (
    t: string,
    lines: string[],
    priority: NtfyPriority,
    tags: string[],
  ): AlertMessage => ({
    title: title(t),
    body: [...lines, reason].filter((l) => l !== '').join('\n'),
    priority,
    tags,
    click,
  });

  if (change.control === 'platform_outbound_stop') {
    return change.action === 'set'
      ? msg(
          'outbound email stopped for every workspace',
          [
            'No workspace sends mail, manual sends included, until the stop is cleared in the platform console. Inbox sync keeps reading.',
          ],
          4,
          ['octagonal_sign', 'control'],
        )
      : msg(
          'outbound email stop cleared',
          ['Workspaces send again. Their own pauses and holds still apply.'],
          3,
          ['arrow_forward', 'control'],
        );
  }

  const ws = workspaceLabel(change.workspaceId, options.workspaceNames);
  if (change.control === 'automation_pause') {
    return change.action === 'paused'
      ? msg(
          `${ws} paused all automation`,
          [
            'Sending, follow-ups, autopilot, scheduled discovery and background AI stop for this workspace; inbox sync keeps reading.',
          ],
          3,
          ['pause_button', 'control'],
        )
      : msg(`${ws} resumed automation`, [], 2, ['arrow_forward', 'control']);
  }

  const by = change.source === 'platform' ? 'the platform console' : 'the workspace';
  const scope = change.scopeLabel;
  switch (change.action) {
    case 'placed':
      return msg(`${scope} on hold in ${ws}`, [`Placed by ${by}.`], 3, ['pause_button', 'control']);
    case 'released':
      return msg(`hold on ${scope} released in ${ws}`, [`It was placed by ${by}.`], 2, [
        'arrow_forward',
        'control',
      ]);
    case 'expired':
      return msg(`hold on ${scope} expired in ${ws}`, [`It was placed by ${by}.`], 2, [
        'arrow_forward',
        'control',
      ]);
    case 'confirmed':
      return msg(
        `legacy hold on ${scope} confirmed in ${ws}`,
        ['A disabled legacy feature flag is now an enforced hold.'],
        3,
        ['pause_button', 'control'],
      );
    case 'discarded':
      return msg(
        `legacy hold on ${scope} discarded in ${ws}`,
        ['The disabled legacy feature flag will not be enforced.'],
        2,
        ['wastebasket', 'control'],
      );
  }
}

// ---- test message --------------------------------------------------------------

export function formatTestAlert(options: {
  now: Date;
  appUrl: string | null;
  minSeverity: string;
}): AlertMessage {
  return {
    title: title('test alert'),
    body: [
      `Sent from the platform console at ${formatUtc(options.now)}. If you can read this, owner alerts reach this topic.`,
      `You will be alerted about incidents of severity ${options.minSeverity} and above, background ticks that stop running, and platform stop / hold changes.`,
    ].join('\n'),
    priority: 3,
    tags: ['white_check_mark', 'test'],
    click: consoleLink(options.appUrl),
  };
}
