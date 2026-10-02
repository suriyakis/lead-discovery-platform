// PC-09 — the mailbox-health probes: what the mail.probe.tick does to one
// mailbox, following the rules in services/mailbox-health.ts.
//
//   active   'probe'   credential-free SMTP probe (lib/mail/probe.ts): pass
//                      → next in 30 min; fail → again in 5 min, and the
//                      second failure in a row marks it failing
//                      ('connection')
//            'verify'  the daily authenticated SMTP check (one login): pass
//                      → smtp_verified_at; a refused login or an unclear
//                      error marks it failing after that ONE attempt; a
//                      network failure counts like a failed probe
//   failing  'probe'   ('connection') credential-free probes of every
//                      configured server: one fails → back off (30 min →
//                      6 h); all answer → ONE authenticated SMTP + IMAP
//                      check
//            'recheck' ('ambiguous' within its budget, or a check an owner
//                      asked for by editing the settings) ONE authenticated
//                      SMTP + IMAP check
//
// Every probe holds the mailbox's 'mailbox.sync' work lease (PC-12), the
// same one a sync, a manual Sync and Test connection take: a mailbox is
// never probed while something else is talking to its server, and a held
// lease means "busy, try next tick" — not a failure. The row is re-read
// and re-planned under the lease.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailboxes, type Mailbox } from '@/lib/db/schema/mailing';
import {
  classifyMailboxFailure,
  describeConnectionError,
  isAuthFailure,
  type MailboxFailureClass,
  type MailProtocol,
} from '@/lib/mail/connection-errors';
import type { ConnectionCheck, IMailProvider } from '@/lib/mail';
import { probeMailServer, type ProbeEndpoint, type ProbeResult } from '@/lib/mail/probe';
import type { WorkspaceContext } from './context';
import {
  ACTIVE_PROBE_FAILURES_TO_FAIL,
  ACTIVE_PROBE_RETRY_MS,
  healthySchedule,
  planMailboxProbe,
  scheduleAfterFailedRecovery,
  type ProbeAction,
} from './mailbox-health';
import {
  buildProviderFor,
  checkFailureClass,
  markMailboxFailing,
  recordMailboxConnectionCheck,
  runConnectionTest,
} from './mailbox';
import { withWorkLease } from './work-leases';

// ---- seams --------------------------------------------------------------------

export type MailServerProbe = (endpoint: ProbeEndpoint) => Promise<ProbeResult>;

let probeForTests: MailServerProbe | null = null;

/** Tests: replace the network probe (null restores the real one). */
export function _setMailServerProbeForTests(probe: MailServerProbe | null): void {
  probeForTests = probe;
}

function probeServer(endpoint: ProbeEndpoint): Promise<ProbeResult> {
  return (probeForTests ?? probeMailServer)(endpoint);
}

// ---- endpoints ----------------------------------------------------------------

type ProbeRow = Pick<
  Mailbox,
  | 'id'
  | 'status'
  | 'failureClass'
  | 'nextProbeAt'
  | 'probeAttempts'
  | 'smtpVerifiedAt'
  | 'smtpHost'
  | 'smtpPort'
  | 'smtpSecure'
  | 'imapHost'
  | 'imapPort'
  | 'imapSecure'
  | 'imapUser'
  | 'imapPasswordSecretKey'
>;

function smtpEndpoint(m: ProbeRow): ProbeEndpoint {
  return { protocol: 'smtp', host: m.smtpHost, port: m.smtpPort, secure: m.smtpSecure };
}

/** The servers a full check logs in to: SMTP, and IMAP when configured
 *  (the same rule as the provider's resolveConfig). */
function configuredEndpoints(m: ProbeRow): ProbeEndpoint[] {
  const out = [smtpEndpoint(m)];
  if (m.imapHost && m.imapPort && m.imapUser && m.imapPasswordSecretKey) {
    out.push({ protocol: 'imap', host: m.imapHost, port: m.imapPort, secure: m.imapSecure });
  }
  return out;
}

const storedError = (protocol: MailProtocol, message: string) =>
  `${protocol === 'smtp' ? 'SMTP' : 'IMAP'}: ${message}`.slice(0, 2000);

// ---- one mailbox ----------------------------------------------------------------

export interface MailboxProbeOutcome {
  /** What was done; 'busy' = the mailbox's lease was held, nothing done. */
  action: ProbeAction | 'busy';
  /** Credential-free probes run. */
  probes: number;
  /** Authenticated checks run (each is a login per protocol checked). */
  logins: number;
  /** The probe / check passed. */
  ok: boolean;
  /** A failing mailbox is active again. */
  recovered: boolean;
  /** It is failing now with this class after this call (null: not failing
   *  or not changed by this call). */
  failing: MailboxFailureClass | null;
}

const NOTHING: MailboxProbeOutcome = {
  action: 'none',
  probes: 0,
  logins: 0,
  ok: true,
  recovered: false,
  failing: null,
};

/**
 * Run whatever is due for one mailbox, under its lease. `now` is the
 * tick's clock: due-ness and every schedule written are computed from it.
 */
export async function probeMailbox(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  now: Date = new Date(),
): Promise<MailboxProbeOutcome> {
  const leased = await withWorkLease(
    ctx,
    { kind: 'mailbox.sync', resource: mailboxId, purpose: 'health probe' },
    async () => {
      const [row] = await db
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, mailboxId)))
        .limit(1);
      if (!row) return NOTHING;
      const action = planMailboxProbe(row, now);
      switch (action) {
        case 'none':
          return NOTHING;
        case 'probe':
          return row.status === 'active'
            ? probeActive(ctx, row, now)
            : probeFailing(ctx, row, now);
        case 'verify':
          return verifyActive(ctx, row, now);
        case 'recheck':
          return recheckFailing(ctx, row, now);
      }
    },
  );
  if (leased.status === 'ran') return leased.value;
  return { ...NOTHING, action: 'busy' };
}

/** An active mailbox's probe or verify failed with a network problem: try
 *  again in 5 minutes; the second failure in a row marks it failing. */
async function activeConnectionFailure(
  ctx: WorkspaceContext,
  row: Mailbox,
  now: Date,
  protocol: MailProtocol,
  message: string,
  base: Omit<MailboxProbeOutcome, 'ok' | 'failing' | 'recovered'>,
): Promise<MailboxProbeOutcome> {
  const attempts = row.probeAttempts + 1;
  if (attempts >= ACTIVE_PROBE_FAILURES_TO_FAIL) {
    const marked = await markMailboxFailing(ctx, row.id, {
      protocol,
      message,
      failureClass: 'connection',
      now,
    });
    return { ...base, ok: false, recovered: false, failing: marked.marked ? 'connection' : null };
  }
  await db
    .update(mailboxes)
    .set({
      probeAttempts: attempts,
      nextProbeAt: new Date(now.getTime() + ACTIVE_PROBE_RETRY_MS),
      updatedAt: now,
    })
    .where(and(eq(mailboxes.id, row.id), eq(mailboxes.status, 'active')));
  return { ...base, ok: false, recovered: false, failing: null };
}

async function probeActive(ctx: WorkspaceContext, row: Mailbox, now: Date): Promise<MailboxProbeOutcome> {
  const r = await probeServer(smtpEndpoint(row));
  const base = { action: 'probe' as const, probes: 1, logins: 0 };
  if (!r.ok) return activeConnectionFailure(ctx, row, now, 'smtp', r.detail, base);
  await db
    .update(mailboxes)
    .set({ ...healthySchedule(now), updatedAt: now })
    .where(and(eq(mailboxes.id, row.id), eq(mailboxes.status, 'active')));
  return { ...base, ok: true, recovered: false, failing: null };
}

/** provider.verifySmtp() that never throws (and works for providers
 *  without it: testConnection's SMTP half). */
async function verifySmtpOnce(provider: IMailProvider): Promise<ConnectionCheck> {
  try {
    if (provider.verifySmtp) return await provider.verifySmtp();
    return (await provider.testConnection()).smtp;
  } catch (err) {
    return {
      ok: false,
      detail: describeConnectionError(err),
      authFailed: isAuthFailure(err),
      failureClass: classifyMailboxFailure({ error: err }),
    };
  }
}

async function verifyActive(ctx: WorkspaceContext, row: Mailbox, now: Date): Promise<MailboxProbeOutcome> {
  const base = { action: 'verify' as const, probes: 0, logins: 1 };
  let provider: IMailProvider;
  try {
    ({ provider } = await buildProviderFor(ctx, row.id));
  } catch (err) {
    // A missing password: nothing to log in with — the owner's to fix.
    const marked = await markMailboxFailing(ctx, row.id, {
      protocol: 'smtp',
      message: describeConnectionError(err),
      failureClass: classifyMailboxFailure({ error: err }),
      now,
    });
    return { ...base, logins: 0, ok: false, recovered: false, failing: marked.failureClass };
  }
  const check = await verifySmtpOnce(provider);
  if (check.ok) {
    const smtpErrorShown = (row.lastError ?? '').startsWith('SMTP:');
    await db
      .update(mailboxes)
      .set({
        ...healthySchedule(now),
        smtpVerifiedAt: now,
        ...(smtpErrorShown ? { lastError: null, lastErrorAt: null } : {}),
        updatedAt: now,
      })
      .where(and(eq(mailboxes.id, row.id), eq(mailboxes.status, 'active')));
    return { ...base, ok: true, recovered: false, failing: null };
  }
  const message = check.detail?.trim() || 'failed';
  const cls = checkFailureClass(check);
  if (cls === 'connection') return activeConnectionFailure(ctx, row, now, 'smtp', message, base);
  // A refused login (or an unclear answer to one): failing after this ONE
  // attempt. 'auth' is never retried; for 'ambiguous' this attempt is the
  // first of its four.
  const marked = await markMailboxFailing(ctx, row.id, {
    protocol: 'smtp',
    message,
    failureClass: cls,
    schedule: scheduleAfterFailedRecovery({ failureClass: null, probeAttempts: 0 }, cls, now),
    now,
  });
  return { ...base, ok: false, recovered: false, failing: marked.marked ? cls : null };
}

/** A 'connection' mailbox: probe every configured server without logging
 *  in; only when all answer, one authenticated check. */
async function probeFailing(ctx: WorkspaceContext, row: Mailbox, now: Date): Promise<MailboxProbeOutcome> {
  let probes = 0;
  for (const endpoint of configuredEndpoints(row)) {
    const r = await probeServer(endpoint);
    probes++;
    if (!r.ok) {
      const schedule = scheduleAfterFailedRecovery(
        { failureClass: row.failureClass, probeAttempts: row.probeAttempts },
        'connection',
        now,
      );
      await db
        .update(mailboxes)
        .set({
          ...schedule,
          lastError: storedError(endpoint.protocol, r.detail),
          lastErrorAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(mailboxes.id, row.id),
            eq(mailboxes.status, 'failing'),
            eq(mailboxes.failureClass, 'connection'),
          ),
        );
      return { action: 'probe', probes, logins: 0, ok: false, recovered: false, failing: 'connection' };
    }
  }
  // The host answers: the one authenticated check.
  const checked = await authenticatedCheck(ctx, row, now);
  return { ...checked, action: 'probe', probes };
}

async function recheckFailing(ctx: WorkspaceContext, row: Mailbox, now: Date): Promise<MailboxProbeOutcome> {
  return authenticatedCheck(ctx, row, now);
}

/** One full SMTP + IMAP check of a failing mailbox, recorded with the
 *  automatic schedule (recordMailboxConnectionCheck automatic: true). */
async function authenticatedCheck(
  ctx: WorkspaceContext,
  row: Mailbox,
  now: Date,
): Promise<MailboxProbeOutcome> {
  const logins = configuredEndpoints(row).length;
  let provider: IMailProvider;
  try {
    ({ provider } = await buildProviderFor(ctx, row.id));
  } catch (err) {
    const message = describeConnectionError(err);
    const cls = classifyMailboxFailure({ error: err });
    const marked = await markMailboxFailing(ctx, row.id, {
      protocol: /\bIMAP\b/.test(message) ? 'imap' : 'smtp',
      message,
      failureClass: cls,
      schedule: scheduleAfterFailedRecovery(
        { failureClass: row.failureClass, probeAttempts: row.probeAttempts },
        cls,
        now,
      ),
      now,
    });
    return { action: 'recheck', probes: 0, logins: 0, ok: false, recovered: false, failing: marked.failureClass };
  }
  const result = await runConnectionTest(provider);
  const outcome = await recordMailboxConnectionCheck(ctx, row, result, { automatic: true, now });
  return {
    action: 'recheck',
    probes: 0,
    logins,
    ok: outcome.ok,
    recovered: outcome.recovered,
    failing: outcome.ok ? null : outcome.failureClass,
  };
}

// ---- one workspace ------------------------------------------------------------

/** The workspace's mailboxes with something due now (no network). */
export async function listMailboxesDueForProbe(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  now: Date = new Date(),
): Promise<Array<{ id: bigint; status: Mailbox['status']; action: ProbeAction }>> {
  const rows = await db
    .select({
      id: mailboxes.id,
      status: mailboxes.status,
      failureClass: mailboxes.failureClass,
      nextProbeAt: mailboxes.nextProbeAt,
      probeAttempts: mailboxes.probeAttempts,
      smtpVerifiedAt: mailboxes.smtpVerifiedAt,
    })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        inArray(mailboxes.status, ['active', 'failing']),
      ),
    )
    .orderBy(mailboxes.id);
  return rows
    .map((r) => ({ id: r.id, status: r.status, action: planMailboxProbe(r, now) }))
    .filter((r) => r.action !== 'none');
}
