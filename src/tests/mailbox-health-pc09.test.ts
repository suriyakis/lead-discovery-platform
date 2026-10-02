// PC-09 (I021, X7, I095) — mailbox health: classified, fail2ban-safe probing
// and recovery, one incident per mailbox, tenant notifications, and the
// reviewed backfill. Acceptance:
//   (1) an IMAP auth failure in sync → exactly one incident, one bell
//       notification and one webhook alert;
//   (2) a failed SMTP Test connection → the same;
//   (3) against mock SMTP / IMAP servers the connection probe sends zero
//       AUTH / LOGIN commands;
//   (4) fake clock, 7 days: an auth-class mailbox gets 0 login attempts, an
//       ambiguous one at most 4 (and a connection-class one only
//       credential-free probes on the 30 min → 6 h backoff);
//   (5) a daily verify that fails marks the mailbox failing (auth) after
//       exactly one attempt;
//   (6) recovery resolves the incident and notifies;
//   (7) the backfill dry run lists the expected mailboxes before raising
//       anything, and backfilled mailboxes are not probed;
//   (8) junk inbound (the X1 fixtures) raises no incident.

import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { mailboxes, type Mailbox } from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { opsEvents } from '@/lib/db/schema/ops';
import type {
  ConnectionCheck,
  ConnectionTestResult,
  IMailProvider,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '@/lib/mail';
import { classifyMailboxFailure } from '@/lib/mail/connection-errors';
import { probeMailServer, type ProbeEndpoint, type ProbeResult } from '@/lib/mail/probe';
import { parseRawMessage } from '@/lib/mail/smtp-imap';
import { readAlertConfig } from '@/lib/ops/alert-config';
import { runImapTick, runMailProbeTick } from '@/lib/jobs/repeatables';
import {
  applyMailboxHealthBackfill,
  planMailboxHealthBackfill,
  renderMailboxHealthBackfillReport,
} from '@/lib/remediation/mailbox-health-backfill';
import { pauseAutomation } from '@/lib/services/automation-pause';
import {
  policyPath,
  resolveAutomationPolicy,
  tickVerdict,
} from '@/lib/services/automation-policy';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { placeTenantHold } from '@/lib/services/holds';
import { safeSyncOne } from '@/lib/services/mail';
import {
  _setMailProviderFactoryForTests,
  createMailbox,
  markMailboxFailing,
  testMailboxConnection,
  updateMailbox,
} from '@/lib/services/mailbox';
import {
  AMBIGUOUS_MAX_ATTEMPTS,
  connectionBackoffMs,
  mailboxFailingFingerprint,
  planMailboxProbe,
  scheduleAfterFailedRecovery,
} from '@/lib/services/mailbox-health';
import { _setMailServerProbeForTests } from '@/lib/services/mailbox-probes';
import { _setOpsAlertDepsForTests, dispatchOpsAlerts } from '@/lib/services/ops-alerts';
import { withWorkLease } from '@/lib/services/work-leases';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The fake-clock runs drive hundreds of ticks against the database. */
const SLOW_MS = 180_000;

// ---- fixtures --------------------------------------------------------------

interface Setup {
  workspaceId: bigint;
  ownerId: string;
  c: WorkspaceContext;
}

let seq = 0;
async function setup(name = 'pc09'): Promise<Setup> {
  seq++;
  const ownerId = await seedUser({ email: `${name}-${seq}@test.local` });
  const workspaceId = await seedWorkspace({ name: `${name}-${seq}`, ownerUserId: ownerId });
  return { workspaceId, ownerId, c: makeWorkspaceContext({ workspaceId, userId: ownerId, role: 'owner' }) };
}

async function makeMailbox(
  s: Setup,
  name = 'sales',
  opts: { imap?: boolean; smtpHost?: string; smtpPort?: number } = {},
): Promise<Mailbox> {
  return createMailbox(s.c, {
    name,
    fromAddress: `${name}-${seq}@nulife.pl`,
    smtpHost: opts.smtpHost ?? `smtp-${name}.example.com`,
    smtpPort: opts.smtpPort ?? 587,
    smtpUser: `${name}@nulife.pl`,
    smtpPassword: 'secret',
    imap:
      opts.imap === false
        ? null
        : { host: `imap-${name}.example.com`, port: 993, user: `${name}@nulife.pl`, password: 'secret' },
  });
}

async function row(id: bigint): Promise<Mailbox> {
  const [r] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return r!;
}

async function incidents(workspaceId?: bigint) {
  const rows = await db.select().from(opsEvents).orderBy(opsEvents.id);
  return rows.filter((e) => e.kind === 'mailbox.failing' && (workspaceId === undefined || e.workspaceId === workspaceId));
}

async function notes(workspaceId: bigint, kind: 'mailbox.failing' | 'mailbox.recovered' = 'mailbox.failing') {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.kind, kind)));
}

const HEALTHY: ConnectionTestResult = { smtp: { ok: true }, imap: { ok: true } };
const AUTH_REFUSED: ConnectionCheck = {
  ok: false,
  detail: 'Invalid login: 535 5.7.8 Error: authentication failed',
  authFailed: true,
};

/** Scripted per-mailbox provider: every call is a login, counted. */
class ScriptedProvider implements IMailProvider {
  public readonly id = 'scripted';
  fetchCalls = 0;
  testCalls = 0;
  verifyCalls = 0;
  fetchError: unknown = null;
  inbound: InboundMessage[] = [];
  test: ConnectionTestResult = HEALTHY;
  verify: ConnectionCheck = { ok: true };

  async send(_message: OutboundMessage): Promise<SendResult> {
    throw new Error('send is not used in these tests');
  }

  async fetchInbound(): Promise<InboundMessage[]> {
    this.fetchCalls++;
    if (this.fetchError) throw this.fetchError;
    return this.inbound.splice(0);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    this.testCalls++;
    return this.test;
  }

  async verifySmtp(): Promise<ConnectionCheck> {
    this.verifyCalls++;
    return this.verify;
  }

  /** IMAP fetches, full checks and SMTP verifies all log in. */
  get logins(): number {
    return this.fetchCalls + this.testCalls + this.verifyCalls;
  }
}

const providers = new Map<string, ScriptedProvider>();
function p(mb: Pick<Mailbox, 'id'>): ScriptedProvider {
  const key = mb.id.toString();
  let found = providers.get(key);
  if (!found) {
    found = new ScriptedProvider();
    providers.set(key, found);
  }
  return found;
}

/** The credential-free probe seam: answers per host, records each call. */
const probeCalls: Array<{ at: number; endpoint: ProbeEndpoint }> = [];
const downHosts = new Set<string>();
let probeClock = 0;
function fakeProbe(endpoint: ProbeEndpoint): Promise<ProbeResult> {
  probeCalls.push({ at: probeClock, endpoint });
  const ok = !downHosts.has(endpoint.host);
  return Promise.resolve({
    ok,
    protocol: endpoint.protocol,
    host: endpoint.host,
    port: endpoint.port,
    stage: ok ? 'done' : 'connect',
    detail: ok ? '220 ready (TLS)' : `${endpoint.host}:${endpoint.port} connect: connect ECONNREFUSED`,
    encrypted: ok,
    commands: ok ? ['EHLO', 'QUIT'] : [],
  });
}
const probesOf = (host: string) => probeCalls.filter((c) => c.endpoint.host === host);

/** What imapflow throws for a refused LOGIN. */
function imapflowAuthError(): Error {
  return Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
    response: 'Authentication failed.',
  });
}

/** Both ticks, every `stepMs`, from `start` for `ms`. */
async function runClock(start: Date, ms: number, stepMs = 30 * MINUTE): Promise<void> {
  for (let t = start.getTime(); t <= start.getTime() + ms; t += stepMs) {
    probeClock = t;
    const now = new Date(t);
    await runImapTick(now);
    await runMailProbeTick(now);
  }
}

// ---- webhook (PC-08) ----------------------------------------------------------

const fetchMock = vi.fn(
  async (_url: string, _init: RequestInit): Promise<Response> => new Response('{"id":"m1"}', { status: 200 }),
);
function alertsOn(): void {
  fetchMock.mockClear();
  _setOpsAlertDepsForTests({
    now: () => new Date(),
    config: () => readAlertConfig({ NTFY_TOPIC: 'ls-owner-pc09test', APP_URL: 'https://discover.example.test/' }),
    fetch: fetchMock,
    log: () => undefined,
  });
}
function posts(): Array<{ title: string; message: string }> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as { title: string; message: string });
}

beforeEach(async () => {
  await truncateAll();
  providers.clear();
  probeCalls.length = 0;
  downHosts.clear();
  probeClock = Date.now();
  _setMailProviderFactoryForTests((mb) => p(mb));
  _setMailServerProbeForTests(fakeProbe);
});

afterEach(() => {
  _setMailProviderFactoryForTests(null);
  _setMailServerProbeForTests(null);
  _setOpsAlertDepsForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- pure rules ------------------------------------------------------------------

describe('classification and schedule (pure)', () => {
  it('classifies failures: refused logins are auth, network trouble is connection, the rest ambiguous', () => {
    expect(classifyMailboxFailure({ error: imapflowAuthError() })).toBe('auth');
    expect(classifyMailboxFailure({ message: '535 5.7.8 Error: authentication failed' })).toBe('auth');
    expect(classifyMailboxFailure({ message: 'SMTP password missing for mailbox 7' })).toBe('auth');
    expect(classifyMailboxFailure({ message: 'connect ECONNREFUSED 51.89.234.14:587' })).toBe('connection');
    expect(classifyMailboxFailure({ message: 'Socket timed out after 20000ms' })).toBe('connection');
    expect(classifyMailboxFailure({ message: 'getaddrinfo ENOTFOUND mail.nowhere.test' })).toBe('connection');
    expect(classifyMailboxFailure({ message: 'socket hang up' })).toBe('connection');
    expect(classifyMailboxFailure({ message: '421 4.3.2 Service not available' })).toBe('connection');
    expect(classifyMailboxFailure({ error: Object.assign(new Error('x'), { code: 'ECONNECTION' }) })).toBe(
      'connection',
    );
    expect(classifyMailboxFailure({ message: 'Command failed' })).toBe('ambiguous');
    expect(classifyMailboxFailure({ message: '451 4.3.0 Try again later' })).toBe('ambiguous');
  });

  it('connection backoff: 30 min doubling to a 6 h cap', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map((n) => connectionBackoffMs(n) / MINUTE)).toEqual([
      30, 60, 120, 240, 360, 360, 360,
    ]);
  });

  it('after a failed automatic attempt: auth stops, connection backs off, ambiguous counts to four', () => {
    const now = new Date('2026-10-02T10:00:00Z');
    expect(scheduleAfterFailedRecovery({ failureClass: 'connection', probeAttempts: 3 }, 'auth', now)).toEqual({
      nextProbeAt: null,
      probeAttempts: 0,
    });
    expect(scheduleAfterFailedRecovery({ failureClass: 'connection', probeAttempts: 1 }, 'connection', now)).toEqual({
      nextProbeAt: new Date(now.getTime() + 2 * HOUR),
      probeAttempts: 2,
    });
    let s = { failureClass: 'ambiguous' as const, probeAttempts: 0 };
    const seen: Array<Date | null> = [];
    for (let i = 0; i < AMBIGUOUS_MAX_ATTEMPTS; i++) {
      const next = scheduleAfterFailedRecovery(s, 'ambiguous', now);
      seen.push(next.nextProbeAt);
      s = { failureClass: 'ambiguous', probeAttempts: next.probeAttempts };
    }
    expect(seen.slice(0, 3).every((d) => d?.getTime() === now.getTime() + 6 * HOUR)).toBe(true);
    expect(seen[3]).toBeNull();
    expect(s.probeAttempts).toBe(4);
  });

  it('plans: active → verify when the daily check is due, else probe; failing by class; never an auth one unasked', () => {
    const now = new Date('2026-10-02T10:00:00Z');
    const base = { failureClass: null, probeAttempts: 0 };
    expect(planMailboxProbe({ ...base, status: 'active', nextProbeAt: null, smtpVerifiedAt: null }, now)).toBe('verify');
    expect(
      planMailboxProbe(
        { ...base, status: 'active', nextProbeAt: null, smtpVerifiedAt: new Date(now.getTime() - HOUR) },
        now,
      ),
    ).toBe('probe');
    expect(
      planMailboxProbe(
        { ...base, status: 'active', nextProbeAt: new Date(now.getTime() + MINUTE), smtpVerifiedAt: null },
        now,
      ),
    ).toBe('none');
    const failing = { status: 'failing' as const, smtpVerifiedAt: null, probeAttempts: 0 };
    expect(planMailboxProbe({ ...failing, failureClass: 'auth', nextProbeAt: null }, now)).toBe('none');
    expect(planMailboxProbe({ ...failing, failureClass: 'auth', nextProbeAt: now }, now)).toBe('recheck');
    expect(planMailboxProbe({ ...failing, failureClass: 'connection', nextProbeAt: now }, now)).toBe('probe');
    expect(planMailboxProbe({ ...failing, failureClass: 'ambiguous', nextProbeAt: now }, now)).toBe('recheck');
    expect(
      planMailboxProbe({ ...failing, failureClass: 'ambiguous', nextProbeAt: now, probeAttempts: 4 }, now),
    ).toBe('none');
    expect(planMailboxProbe({ ...failing, failureClass: null, nextProbeAt: null }, now)).toBe('none');
    expect(
      planMailboxProbe({ ...base, status: 'paused', nextProbeAt: null, smtpVerifiedAt: null }, now),
    ).toBe('none');
  });
});

// ---- (1) + (2): one incident, one notification, one alert ---------------------

describe('acceptance (1): an IMAP auth failure in sync', { timeout: SLOW_MS }, () => {
  it('gives exactly one incident, one bell notification and one webhook alert — and no further logins', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    p(mb).fetchError = imapflowAuthError();
    // Verified recently, so the probe tick has nothing to log in for.
    await db
      .update(mailboxes)
      .set({ smtpVerifiedAt: new Date(), nextProbeAt: new Date(Date.now() + 30 * MINUTE) })
      .where(eq(mailboxes.id, mb.id));

    const tick = await runImapTick();
    expect(tick).toMatchObject({ markedFailing: 1 });
    const r = await row(mb.id);
    expect(r).toMatchObject({ status: 'failing', failureClass: 'auth', nextProbeAt: null });

    // A day of both ticks afterwards: nothing logs in again.
    await runClock(new Date(), DAY);
    expect(p(mb).logins).toBe(1);

    const open = await incidents(s.workspaceId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      scope: 'workspace',
      severity: 'error',
      source: 'mailbox.health',
      occurrences: 1,
      resolvedAt: null,
      fingerprint: mailboxFailingFingerprint(s.workspaceId, mb.id),
    });
    expect(open[0]!.payload).toMatchObject({ failureClass: 'auth', protocol: 'imap', mailboxId: mb.id.toString() });
    expect(open[0]!.title).not.toContain('nulife.pl');

    const bell = await notes(s.workspaceId);
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ userId: s.ownerId, href: `/mailbox/${mb.id}#fix` });
    expect(bell[0]!.dedupeKey).toBe(`${mailboxFailingFingerprint(s.workspaceId, mb.id)}:user:${s.ownerId}`);
    expect(bell[0]!.body).toContain('Nothing retries the login automatically');

    alertsOn();
    expect((await dispatchOpsAlerts()).status).toBe('sent');
    expect((await dispatchOpsAlerts()).status).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posts()[0]!.title).toContain('A mailbox is failing: the mail server refused the login');
  });
});

describe('acceptance (2): a failed SMTP Test connection', { timeout: SLOW_MS }, () => {
  it('does the same: one incident, one notification, one alert; Test again only counts', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    p(mb).test = { smtp: AUTH_REFUSED, imap: { ok: true } };

    await testMailboxConnection(s.c, mb.id);
    alertsOn();
    await dispatchOpsAlerts();
    await testMailboxConnection(s.c, mb.id);
    await dispatchOpsAlerts();

    expect(await row(mb.id)).toMatchObject({ status: 'failing', failureClass: 'auth', nextProbeAt: null });
    const open = await incidents(s.workspaceId);
    expect(open).toHaveLength(1);
    expect(open[0]!.occurrences).toBe(2);
    expect(open[0]!.payload).toMatchObject({ failureClass: 'auth', protocol: 'smtp' });
    expect(await notes(s.workspaceId)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Only the two manual tests ever logged in.
    await runClock(new Date(), 12 * HOUR);
    expect(p(mb).logins).toBe(2);
  });
});

// ---- (3): the credential-free probe against mock servers --------------------------

interface MockServer {
  port: number;
  commands: string[];
  close: () => Promise<void>;
}

async function startMockServer(
  greeting: string,
  respond: (line: string, write: (s: string) => void, end: () => void) => void,
): Promise<MockServer> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write(greeting);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        commands.push(line);
        respond(line, (s) => socket.write(s), () => socket.end());
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function mockSmtp(opts: { starttls?: boolean } = {}): Promise<MockServer> {
  return startMockServer('220 mock.test ESMTP ready\r\n', (line, write, end) => {
    const verb = line.split(' ')[0]!.toUpperCase();
    if (verb === 'EHLO') {
      write(
        `250-mock.test hello\r\n250-SIZE 10485760\r\n250-AUTH PLAIN LOGIN\r\n${opts.starttls ? '250-STARTTLS\r\n' : ''}250 HELP\r\n`,
      );
    } else if (verb === 'STARTTLS') {
      write('454 4.7.0 TLS not available due to local problem\r\n');
    } else if (verb === 'QUIT') {
      write('221 2.0.0 bye\r\n');
      end();
    } else {
      write('502 5.5.2 not expected in this test\r\n');
    }
  });
}

function mockImap(): Promise<MockServer> {
  return startMockServer('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] mock ready\r\n', (line, write, end) => {
    const [tag, verb] = line.split(' ');
    if (verb?.toUpperCase() === 'CAPABILITY') {
      write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN IDLE\r\n${tag} OK CAPABILITY completed\r\n`);
    } else if (verb?.toUpperCase() === 'LOGOUT') {
      write(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
      end();
    } else {
      write(`${tag} BAD not expected in this test\r\n`);
    }
  });
}

async function settle(server: MockServer, last: string): Promise<void> {
  for (let i = 0; i < 100 && !server.commands.some((c) => c.toUpperCase().startsWith(last)); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

const AUTH_COMMAND = /^(?:AUTH|\S+\s+(?:LOGIN|AUTHENTICATE))\b/i;

describe('acceptance (3): the connection probe never authenticates', () => {
  it('SMTP: greeting, EHLO, QUIT — zero AUTH, although the server offers it', async () => {
    const server = await mockSmtp();
    try {
      const r = await probeMailServer({ protocol: 'smtp', host: '127.0.0.1', port: server.port, secure: false, timeoutMs: 5000 });
      await settle(server, 'QUIT');
      expect(r).toMatchObject({ ok: true, stage: 'done', commands: ['EHLO', 'QUIT'] });
      expect(server.commands.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'QUIT']);
      expect(server.commands.filter((c) => AUTH_COMMAND.test(c))).toEqual([]);
      expect(server.commands.some((c) => /^(MAIL|RCPT|DATA)\b/i.test(c))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('SMTP: a refused STARTTLS fails the probe (connection), still without AUTH', async () => {
    const server = await mockSmtp({ starttls: true });
    try {
      const r = await probeMailServer({ protocol: 'smtp', host: '127.0.0.1', port: server.port, secure: false, timeoutMs: 5000 });
      expect(r).toMatchObject({ ok: false, stage: 'starttls' });
      expect(r.detail).toContain('STARTTLS refused');
      expect(server.commands.filter((c) => AUTH_COMMAND.test(c))).toEqual([]);
      expect(classifyMailboxFailure({ message: r.detail })).toBe('connection');
    } finally {
      await server.close();
    }
  });

  it('IMAP: greeting, CAPABILITY, LOGOUT — zero LOGIN / AUTHENTICATE', async () => {
    const server = await mockImap();
    try {
      const r = await probeMailServer({ protocol: 'imap', host: '127.0.0.1', port: server.port, secure: false, timeoutMs: 5000 });
      await settle(server, 'P9');
      expect(r).toMatchObject({ ok: true, commands: ['CAPABILITY', 'LOGOUT'] });
      expect(server.commands.filter((c) => AUTH_COMMAND.test(c))).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('a closed port fails at connect', async () => {
    const server = await mockSmtp();
    const port = server.port;
    await server.close();
    const r = await probeMailServer({ protocol: 'smtp', host: '127.0.0.1', port, secure: false, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, stage: 'connect' });
    expect(classifyMailboxFailure({ message: r.detail })).toBe('connection');
  });

  it('end to end: the probe tick probes an active mailbox through the real probe, with no AUTH and no login', async () => {
    _setMailServerProbeForTests(null);
    const server = await mockSmtp();
    try {
      const s = await setup();
      const mb = await makeMailbox(s, 'live', { imap: false, smtpHost: '127.0.0.1', smtpPort: server.port });
      await db.update(mailboxes).set({ smtpVerifiedAt: new Date() }).where(eq(mailboxes.id, mb.id));
      const now = new Date();
      const tick = await runMailProbeTick(now);
      await settle(server, 'QUIT');
      expect(tick).toMatchObject({ probed: 1, verified: 0, logins: 0 });
      expect(server.commands.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'QUIT']);
      expect(p(mb).logins).toBe(0);
      const r = await row(mb.id);
      expect(r.status).toBe('active');
      expect(r.nextProbeAt!.getTime()).toBe(now.getTime() + 30 * MINUTE);
    } finally {
      await server.close();
    }
  });
});

// ---- (4): a fake week --------------------------------------------------------------

describe('acceptance (4): fake clock, 7 days', { timeout: SLOW_MS }, () => {
  it('auth: 0 logins; ambiguous: at most 4, 6 h apart; connection: only credential-free probes on the backoff', async () => {
    const s = await setup();
    const auth = await makeMailbox(s, 'refused');
    const ambiguous = await makeMailbox(s, 'unclear');
    const connection = await makeMailbox(s, 'unreachable', { imap: false });

    // auth: the sync's refused LOGIN (the one login that found it).
    p(auth).fetchError = imapflowAuthError();
    await safeSyncOne({ ...s.c, trigger: 'automation' }, await row(auth.id));
    // ambiguous: a Test that came back unclear.
    p(ambiguous).test = { smtp: { ok: false, detail: 'Command failed' }, imap: { ok: true } };
    await testMailboxConnection(s.c, ambiguous.id);
    // connection: a refused connect at send time / Test.
    p(connection).test = { smtp: { ok: false, detail: 'connect ECONNREFUSED 51.89.234.14:587' }, imap: null };
    await testMailboxConnection(s.c, connection.id);
    downHosts.add('smtp-unreachable.example.com');

    expect((await row(auth.id)).failureClass).toBe('auth');
    expect((await row(ambiguous.id)).failureClass).toBe('ambiguous');
    expect((await row(connection.id)).failureClass).toBe('connection');
    const before = {
      auth: p(auth).logins,
      ambiguous: p(ambiguous).logins,
      connection: p(connection).logins,
    };
    const start = Date.now();

    await runClock(new Date(start), 7 * DAY);

    expect(p(auth).logins - before.auth).toBe(0);
    expect(probesOf('smtp-refused.example.com')).toHaveLength(0);

    const ambiguousLogins = p(ambiguous).logins - before.ambiguous;
    expect(ambiguousLogins).toBeLessThanOrEqual(4);
    expect(ambiguousLogins).toBe(4);
    const amb = await row(ambiguous.id);
    expect(amb).toMatchObject({ status: 'failing', failureClass: 'ambiguous', probeAttempts: 4, nextProbeAt: null });

    expect(p(connection).logins - before.connection).toBe(0);
    const times = probesOf('smtp-unreachable.example.com').map((c) => c.at);
    expect(times.length).toBeGreaterThan(20);
    const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]!) / MINUTE));
    expect(Math.round((times[0]! - start) / MINUTE)).toBe(30);
    expect(gaps.slice(0, 4)).toEqual([60, 120, 240, 360]);
    expect(gaps.slice(4).every((g) => g === 360)).toBe(true);

    // One incident each, however many attempts.
    expect(await incidents(s.workspaceId)).toHaveLength(3);
    expect(await notes(s.workspaceId)).toHaveLength(3);
  });
});

// ---- (5): the daily verify -----------------------------------------------------------

describe('acceptance (5): the daily authenticated verify', { timeout: SLOW_MS }, () => {
  it('a refused login marks the mailbox failing (auth) after exactly one attempt', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    p(mb).verify = AUTH_REFUSED;

    const now = new Date();
    probeClock = now.getTime();
    const tick = await runMailProbeTick(now);
    expect(tick).toMatchObject({ verified: 1, logins: 1, markedFailing: 1 });
    expect(p(mb).verifyCalls).toBe(1);
    expect(await row(mb.id)).toMatchObject({ status: 'failing', failureClass: 'auth', nextProbeAt: null });
    expect(await incidents(s.workspaceId)).toHaveLength(1);
    expect(await notes(s.workspaceId)).toHaveLength(1);

    await runClock(new Date(now.getTime() + 5 * MINUTE), 3 * DAY);
    expect(p(mb).logins).toBe(1);
  });

  it('a passing verify runs once a day; the server is probed without credentials every 30 minutes in between', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, 'healthy', { imap: false });
    const start = Date.now();
    for (let t = start; t <= start + 48 * HOUR; t += 30 * MINUTE) {
      probeClock = t;
      await runMailProbeTick(new Date(t));
    }
    expect(p(mb).verifyCalls).toBe(3);
    expect(p(mb).testCalls).toBe(0);
    expect(probesOf('smtp-healthy.example.com')).toHaveLength(97 - 3);
    const r = await row(mb.id);
    expect(r.status).toBe('active');
    expect(r.smtpVerifiedAt!.getTime()).toBe(start + 48 * HOUR);
  });

  it('a network blip is confirmed before anyone is told: two failed probes in a row mark it failing (connection)', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, 'blip', { imap: false });
    await db.update(mailboxes).set({ smtpVerifiedAt: new Date() }).where(eq(mailboxes.id, mb.id));
    downHosts.add('smtp-blip.example.com');
    const t0 = Date.now();

    await runMailProbeTick(new Date(t0));
    let r = await row(mb.id);
    expect(r).toMatchObject({ status: 'active', probeAttempts: 1 });
    expect(r.nextProbeAt!.getTime()).toBe(t0 + 5 * MINUTE);
    expect(await notes(s.workspaceId)).toHaveLength(0);

    // Not due yet: nothing happens.
    await runMailProbeTick(new Date(t0 + 2 * MINUTE));
    expect(probesOf('smtp-blip.example.com')).toHaveLength(1);

    await runMailProbeTick(new Date(t0 + 5 * MINUTE));
    r = await row(mb.id);
    expect(r).toMatchObject({ status: 'failing', failureClass: 'connection', probeAttempts: 0 });
    expect(r.nextProbeAt!.getTime()).toBe(t0 + 35 * MINUTE);
    expect(await notes(s.workspaceId)).toHaveLength(1);
    expect(p(mb).logins).toBe(0);
  });
});

// ---- (6): recovery -------------------------------------------------------------------

describe('acceptance (6): recovery resolves the incident and notifies', { timeout: SLOW_MS }, () => {
  it('connection: once the host answers, one login; passing it brings the mailbox back online', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, 'flaky');
    p(mb).test = { smtp: { ok: false, detail: 'connect ETIMEDOUT 192.0.2.10:587' }, imap: { ok: true } };
    await testMailboxConnection(s.c, mb.id);
    downHosts.add('smtp-flaky.example.com');
    const t0 = Date.now();

    // Down: the probe at +30 min fails, no login.
    await runMailProbeTick(new Date(t0 + 30 * MINUTE));
    expect(p(mb).testCalls).toBe(1);
    expect((await row(mb.id)).probeAttempts).toBe(1);

    // Back: the next due probe (+1 h) finds both servers answering → one check.
    downHosts.clear();
    p(mb).test = HEALTHY;
    const at = new Date(t0 + 90 * MINUTE);
    const tick = await runMailProbeTick(at);
    expect(tick).toMatchObject({ probed: 1, recovered: 1, logins: 2 });
    expect(probesOf('smtp-flaky.example.com').length).toBe(2);
    expect(probesOf('imap-flaky.example.com').length).toBe(1);
    expect(p(mb).testCalls).toBe(2);

    const r = await row(mb.id);
    expect(r).toMatchObject({ status: 'active', failureClass: null, lastError: null, failingSince: null });
    expect(r.smtpVerifiedAt!.getTime()).toBe(at.getTime());
    expect(r.nextProbeAt!.getTime()).toBe(at.getTime() + 30 * MINUTE);

    const [incident] = await incidents(s.workspaceId);
    expect(incident).toMatchObject({ resolution: 'auto', resolvedBy: null });
    expect(incident!.resolvedAt).not.toBeNull();
    const failing = await notes(s.workspaceId);
    expect(failing.every((n) => n.readAt !== null)).toBe(true);
    const back = await notes(s.workspaceId, 'mailbox.recovered');
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ userId: s.ownerId, href: `/mailbox/${mb.id}`, readAt: null });
    expect(back[0]!.title).toBe('Mailbox "flaky" is back online');
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, s.workspaceId), eq(auditLog.kind, 'mailbox.recovered')));
    expect(audits).toHaveLength(1);
  });

  it('auth: an owner who saves new credentials gets ONE check; a pass recovers, a refusal waits again', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    p(mb).verify = AUTH_REFUSED;
    await runMailProbeTick(new Date());
    expect((await row(mb.id)).failureClass).toBe('auth');

    // Saving unchanged settings schedules nothing.
    await updateMailbox(s.c, mb.id, { smtpHost: (await row(mb.id)).smtpHost, name: 'renamed' });
    expect((await row(mb.id)).nextProbeAt).toBeNull();

    // A new password: one check at the next tick, still refused → waits again.
    await updateMailbox(s.c, mb.id, { smtpPassword: 'still-wrong' });
    expect((await row(mb.id)).nextProbeAt).not.toBeNull();
    p(mb).test = { smtp: AUTH_REFUSED, imap: { ok: true } };
    await runClock(new Date(), 6 * HOUR);
    expect(p(mb).testCalls).toBe(1);
    expect(await row(mb.id)).toMatchObject({ status: 'failing', failureClass: 'auth', nextProbeAt: null });
    expect(await notes(s.workspaceId)).toHaveLength(1);

    // The right one: one check, recovered, back online.
    await updateMailbox(s.c, mb.id, { smtpPassword: 'right-one' });
    p(mb).test = HEALTHY;
    await runMailProbeTick(new Date());
    expect(p(mb).testCalls).toBe(2);
    expect((await row(mb.id)).status).toBe('active');
    expect(await notes(s.workspaceId, 'mailbox.recovered')).toHaveLength(1);
    expect((await incidents(s.workspaceId)).every((e) => e.resolvedAt !== null)).toBe(true);
  });

  it('a manual Test again that passes recovers it too (resolved, back online)', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    p(mb).test = { smtp: AUTH_REFUSED, imap: { ok: true } };
    await testMailboxConnection(s.c, mb.id);
    p(mb).test = HEALTHY;
    await testMailboxConnection(s.c, mb.id);
    expect((await row(mb.id)).status).toBe('active');
    expect((await incidents(s.workspaceId))[0]!.resolvedAt).not.toBeNull();
    expect(await notes(s.workspaceId, 'mailbox.recovered')).toHaveLength(1);
  });
});

// ---- (7): the backfill ---------------------------------------------------------------

describe('acceptance (7): the reviewed backfill of mailboxes failing before PC-09', { timeout: SLOW_MS }, () => {
  async function prodAsFound() {
    const ws1 = await setup('ws1');
    const ws2 = await setup('ws2');
    const mb1 = await makeMailbox(ws1, 'kensington');
    const mb2 = await makeMailbox(ws2, 'wandizz');
    const healthy = await makeMailbox(ws2, 'healthy');
    const tracked = await makeMailbox(ws2, 'tracked');
    const may8 = new Date('2026-05-08T10:00:00Z');
    await db
      .update(mailboxes)
      .set({
        status: 'failing',
        lastError: 'SMTP connect ECONNREFUSED 51.89.234.14:587',
        lastErrorAt: may8,
        failingSince: may8,
      })
      .where(eq(mailboxes.id, mb1.id));
    await db
      .update(mailboxes)
      .set({ status: 'failing', lastError: 'Command failed', imapConsecutiveFailures: 13 })
      .where(eq(mailboxes.id, mb2.id));
    // A PC-09 failing mailbox is already tracked: not part of the backfill.
    await markMailboxFailing(ws2.c, tracked.id, { protocol: 'smtp', message: 'connect ECONNREFUSED 192.0.2.1:587' });
    return { ws1, ws2, mb1, mb2, healthy, tracked, may8 };
  }

  it('the dry run lists exactly the untracked failing mailboxes and raises nothing; the ticks leave them alone', async () => {
    const { ws1, ws2, mb1, mb2, may8 } = await prodAsFound();
    const eventsBefore = (await db.select().from(opsEvents)).length;
    const notesBefore = (await db.select().from(notifications)).length;

    const plan = await planMailboxHealthBackfill(db);
    expect(plan.rows.map((r) => [r.workspaceId, r.mailboxId, r.failureClass])).toEqual([
      [ws1.workspaceId.toString(), mb1.id.toString(), 'connection'],
      [ws2.workspaceId.toString(), mb2.id.toString(), 'ambiguous'],
    ]);
    expect(plan.rows[0]).toMatchObject({
      failingSince: may8.toISOString(),
      protocol: 'smtp',
      cause: 'refused',
      endpoint: 'smtp-kensington.example.com:587',
    });
    expect(plan.rows[1]).toMatchObject({ consecutiveFailures: 13, protocol: 'imap', cause: 'other' });
    expect(plan.totals).toEqual({ mailboxes: 2, workspaces: 2, byClass: { auth: 0, connection: 1, ambiguous: 1 } });
    const report = renderMailboxHealthBackfillReport(plan);
    expect(report).toContain(plan.fingerprint);
    expect(report).not.toMatch(/@/);

    // Nothing raised by the dry run.
    expect((await db.select().from(opsEvents)).length).toBe(eventsBefore);
    expect((await db.select().from(notifications)).length).toBe(notesBefore);
    expect(await notes(ws1.workspaceId)).toHaveLength(0);

    // Nor by a week of ticks: never probed, never logged in to.
    await runClock(new Date(), 7 * DAY, 6 * HOUR);
    expect(p(mb1).logins + p(mb2).logins).toBe(0);
    expect(probesOf('smtp-kensington.example.com')).toHaveLength(0);
    expect(probesOf('smtp-wandizz.example.com')).toHaveLength(0);
    expect(await notes(ws1.workspaceId)).toHaveLength(0);
  });

  it('--apply refuses a drifted list, then raises each incident and notification once, and still never probes them', async () => {
    const { ws1, ws2, mb1, mb2 } = await prodAsFound();
    const plan = await planMailboxHealthBackfill(db);
    await expect(applyMailboxHealthBackfill({ expectFingerprint: 'deadbeefdeadbeef' })).rejects.toMatchObject({
      code: 'drift',
    });
    expect(await incidents(ws1.workspaceId)).toHaveLength(0);

    const res = await applyMailboxHealthBackfill({ expectFingerprint: plan.fingerprint });
    expect(res).toMatchObject({ tracked: 2, notified: 2, skipped: 0 });
    expect(await row(mb1.id)).toMatchObject({ failureClass: 'connection', nextProbeAt: null, probeAttempts: 0 });
    expect(await row(mb2.id)).toMatchObject({ failureClass: 'ambiguous', nextProbeAt: null });
    expect((await row(mb2.id)).failingSince).not.toBeNull();
    const ev1 = await incidents(ws1.workspaceId);
    expect(ev1).toHaveLength(1);
    expect(ev1[0]!.payload).toMatchObject({ backfill: 'PC-09', failureClass: 'connection' });
    expect(await notes(ws1.workspaceId)).toHaveLength(1);
    expect((await notes(ws1.workspaceId))[0]!.body).toContain('port 465');
    expect(await notes(ws2.workspaceId)).toHaveLength(2); // wandizz + the already-tracked one
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws1.workspaceId), eq(auditLog.kind, 'mailbox.marked_failing')));
    // A system event: nobody in the workspace acted, so it is not the owner's.
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBeNull();
    expect(audits[0]!.payload).toMatchObject({ backfill: 'PC-09', actor: 'system' });

    // Idempotent, and still not probed.
    expect((await planMailboxHealthBackfill(db)).rows).toEqual([]);
    await runClock(new Date(), 7 * DAY, 6 * HOUR);
    expect(p(mb1).logins + p(mb2).logins).toBe(0);
    expect(probesOf('smtp-kensington.example.com')).toHaveLength(0);
    expect(await incidents(ws1.workspaceId)).toHaveLength(1);
  });
});

// ---- (8): junk inbound -----------------------------------------------------------------

describe('acceptance (8): junk inbound raises no incident', { timeout: SLOW_MS }, () => {
  it('syncing the X1 fixtures (newsletters, DSNs, notifications) opens no incident and leaves the mailbox active', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, 'inbox');
    const dir = path.resolve(__dirname, 'fixtures/mail');
    let uid = 1;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.eml')).sort()) {
      const parsed = await parseRawMessage(readFileSync(path.join(dir, file)), uid++);
      if (parsed) p(mb).inbound.push(parsed);
    }
    expect(p(mb).inbound.length).toBeGreaterThanOrEqual(8);

    const tick = await runImapTick();
    expect(tick).toMatchObject({ mailboxesSynced: 1, failed: 0, markedFailing: 0 });
    await runMailProbeTick(new Date());
    expect(await row(mb.id)).toMatchObject({ status: 'active', failureClass: null });
    expect(await db.select().from(opsEvents)).toHaveLength(0);
    expect(await notes(s.workspaceId)).toHaveLength(0);
  });
});

// ---- the tick around the probes -------------------------------------------------------

describe('mail.probe.tick: lease, gate and policy', { timeout: SLOW_MS }, () => {
  it('a mailbox whose lease is held (a sync, a Test) is busy, not probed', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    await withWorkLease(s.c, { kind: 'mailbox.sync', resource: mb.id, purpose: 'test' }, async () => {
      const tick = await runMailProbeTick(new Date());
      expect(tick).toMatchObject({ busy: 1, verified: 0, logins: 0 });
    });
    expect(p(mb).logins).toBe(0);
    expect((await runMailProbeTick(new Date())).verified).toBe(1);
  });

  it('runs under the workspace pause (it is monitoring, like inbox sync) and stops for an Inbox-sync hold', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    await pauseAutomation(s.c, { source: 'shell_banner' });
    expect((await runMailProbeTick(new Date())).verified).toBe(1);

    await db.update(mailboxes).set({ nextProbeAt: null }).where(eq(mailboxes.id, mb.id));
    await placeTenantHold(s.c, { scope: 'capabilities', capabilities: ['inbox_sync'], reason: 'mail server migration' });
    const held = await runMailProbeTick(new Date());
    expect(held).toMatchObject({ held: 1, probed: 0, verified: 0 });
    expect(probeCalls).toHaveLength(0);
  });

  it('"What runs right now" has a Mailbox health line: off, runs, partial', async () => {
    const s = await setup();
    let policy = await resolveAutomationPolicy(s.c);
    expect(policyPath(policy, 'mailbox_health').status).toBe('off');
    expect(tickVerdict(policy, 'mail.probe.tick')).toMatchObject({ run: false });

    const mb = await makeMailbox(s);
    policy = await resolveAutomationPolicy(s.c);
    expect(policyPath(policy, 'mailbox_health')).toMatchObject({ status: 'runs', ticks: ['mail.probe.tick'] });
    expect(tickVerdict(policy, 'mail.probe.tick')).toEqual({ run: true });

    await markMailboxFailing(s.c, mb.id, { protocol: 'smtp', message: '535 5.7.8 Authentication failed' });
    policy = await resolveAutomationPolicy(s.c);
    const line = policyPath(policy, 'mailbox_health');
    expect(line.status).toBe('partial');
    expect(line.detail).toContain('a refused login waits for you');
  });

  it('failing mailboxes are listed only while something is due; a failing row of another workspace is untouched', async () => {
    const a = await setup('a');
    const b = await setup('b');
    const mbA = await makeMailbox(a, 'alpha');
    const mbB = await makeMailbox(b, 'beta');
    await markMailboxFailing(a.c, mbA.id, { protocol: 'smtp', message: 'connect ECONNREFUSED 192.0.2.1:587' });
    await db.update(mailboxes).set({ smtpVerifiedAt: new Date() }).where(eq(mailboxes.id, mbB.id));
    // Inside 30 min: B gets its probe (nextProbeAt NULL), A waits.
    await runMailProbeTick(new Date(Date.now() + 10 * MINUTE));
    expect(probesOf('smtp-alpha.example.com')).toHaveLength(0);
    expect(probesOf('smtp-beta.example.com')).toHaveLength(1);
    const openA = await db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.workspaceId, a.workspaceId), isNull(opsEvents.resolvedAt)));
    expect(openA).toHaveLength(1);
    expect(await incidents(b.workspaceId)).toHaveLength(0);
  });
});
