// PC-08: owner-alert configuration, read from the server environment.
//
//   NTFY_TOPIC              required to enable alerts; unset = alerts off
//                           (logged once per process, never an error)
//   NTFY_URL                ntfy server, default https://ntfy.sh
//   NTFY_TOKEN              optional access token (a reserved topic on
//                           ntfy.sh, or a self-hosted server with ACLs)
//   OPS_ALERT_MIN_SEVERITY  warning | error (default) | critical
//
// On the public ntfy.sh server the topic name IS the secret: anyone who
// knows it can subscribe. So neither the topic nor the token is ever
// rendered, logged or stored; describeAlertConfig() is the only view of
// this configuration that may reach a page.

import { configuredAppOrigin } from '@/lib/app-origin';
import type { OpsEventSeverity } from '@/lib/services/ops-events';

export const DEFAULT_NTFY_URL = 'https://ntfy.sh';

/** Severities an operator may choose as the alert threshold. */
export const ALERT_MIN_SEVERITIES = ['warning', 'error', 'critical'] as const;
export type AlertMinSeverity = (typeof ALERT_MIN_SEVERITIES)[number];
export const DEFAULT_ALERT_MIN_SEVERITY: AlertMinSeverity = 'error';

/** ntfy's own topic rule. */
const NTFY_TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

export interface NtfyTarget {
  /** Server base URL, no trailing slash, no credentials. */
  serverUrl: string;
  topic: string;
  token: string | null;
}

export interface AlertConfig {
  enabled: boolean;
  /** Why alerts are off; null when enabled. Never contains the topic or token. */
  disabledReason: string | null;
  sink: 'ntfy';
  /** The delivery target. Set only when enabled. */
  ntfy: NtfyTarget | null;
  /** Host (and path) of the configured server, e.g. "ntfy.sh"; null when
   *  NTFY_URL is not a usable URL. Safe to show. */
  serverDisplay: string | null;
  /** Length of NTFY_TOPIC when set (the name itself is never shown). */
  topicLength: number | null;
  tokenSet: boolean;
  minSeverity: AlertMinSeverity;
  /** OPS_ALERT_MIN_SEVERITY was set to something unknown and was ignored. */
  minSeverityIgnored: boolean;
  /** Public origin of the app (APP_URL, else AUTH_URL), for the notification's link. */
  appUrl: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

const trimPath = (url: URL) => url.pathname.replace(/\/+$/, '');

/** Pure: the alert configuration of an environment. */
export function readAlertConfig(env: Env = process.env): AlertConfig {
  const rawSeverity = env.OPS_ALERT_MIN_SEVERITY?.trim().toLowerCase() ?? '';
  const knownSeverity = (ALERT_MIN_SEVERITIES as readonly string[]).includes(rawSeverity);
  // The same origin rule as sent mail and Stripe (app-origin.ts): APP_URL,
  // else AUTH_URL / NEXTAUTH_URL, never a loopback one in production.
  const appUrl = configuredAppOrigin(env);
  const topic = env.NTFY_TOPIC?.trim() ?? '';
  const token = env.NTFY_TOKEN?.trim() || null;
  const server = parseHttpUrl(env.NTFY_URL?.trim() || DEFAULT_NTFY_URL);

  const base = {
    sink: 'ntfy' as const,
    serverDisplay: server ? server.host + trimPath(server) : null,
    topicLength: topic ? topic.length : null,
    tokenSet: token !== null,
    minSeverity: knownSeverity ? (rawSeverity as AlertMinSeverity) : DEFAULT_ALERT_MIN_SEVERITY,
    minSeverityIgnored: rawSeverity !== '' && !knownSeverity,
    appUrl: appUrl ? appUrl.origin : null,
  };
  const off = (reason: string): AlertConfig => ({
    ...base,
    enabled: false,
    disabledReason: reason,
    ntfy: null,
  });

  if (!topic) return off('NTFY_TOPIC is not set');
  if (!NTFY_TOPIC_RE.test(topic)) {
    return off('NTFY_TOPIC is not a valid ntfy topic (letters, digits, - and _, at most 64)');
  }
  if (!server) return off('NTFY_URL is not an http(s) URL');
  if (server.username || server.password) {
    return off('NTFY_URL must not carry credentials; set NTFY_TOKEN instead');
  }
  if (server.search || server.hash) {
    return off('NTFY_URL must be the server base URL, without a query or fragment');
  }

  return {
    ...base,
    enabled: true,
    disabledReason: null,
    ntfy: { serverUrl: server.origin + trimPath(server), topic, token },
  };
}

/** What the console may show: the topic and the token cannot leak from it. */
export interface AlertConfigSummary {
  enabled: boolean;
  disabledReason: string | null;
  sink: 'ntfy';
  /** e.g. "ntfy.sh"; null when NTFY_URL is unusable. */
  server: string | null;
  topicSet: boolean;
  /** Length only: on ntfy.sh, a topic's name is its password. */
  topicLength: number | null;
  tokenSet: boolean;
  minSeverity: AlertMinSeverity;
  minSeverityIgnored: boolean;
}

export function describeAlertConfig(config: AlertConfig): AlertConfigSummary {
  return {
    enabled: config.enabled,
    disabledReason: config.disabledReason,
    sink: config.sink,
    // URL.host never includes the user-info part, so even a refused
    // NTFY_URL with credentials shows only its host.
    server: config.serverDisplay,
    topicSet: config.topicLength !== null,
    topicLength: config.topicLength,
    tokenSet: config.tokenSet,
    minSeverity: config.minSeverity,
    minSeverityIgnored: config.minSeverityIgnored,
  };
}

const holder = globalThis as unknown as { __leadPlatformAlertsOffLogged?: boolean };

/** "Absent = disabled, logged once": one log line per process. */
export function logAlertsDisabledOnce(
  config: AlertConfig,
  log: (message: string) => void = (m) => console.info(m),
): void {
  if (config.enabled || holder.__leadPlatformAlertsOffLogged) return;
  holder.__leadPlatformAlertsOffLogged = true;
  log(`[ops] Owner alerts are off: ${config.disabledReason}. See docs/OPS_MONITORING.md.`);
}

/** Tests: forget that the disabled line was logged. */
export function _resetAlertsDisabledLogForTests(): void {
  delete holder.__leadPlatformAlertsOffLogged;
}

/** Severity order, lowest first. */
const SEVERITY_RANK: Record<OpsEventSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity as OpsEventSeverity] ?? -1;
}

/** The severities at or above a threshold, e.g. 'error' → error, critical. */
export function severitiesAtOrAbove(min: OpsEventSeverity): OpsEventSeverity[] {
  const floor = SEVERITY_RANK[min];
  return (Object.keys(SEVERITY_RANK) as OpsEventSeverity[]).filter(
    (s) => SEVERITY_RANK[s] >= floor,
  );
}
