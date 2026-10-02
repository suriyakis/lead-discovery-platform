// PC-08: owner alerting through the ntfy sink.
//
// Acceptance:
//   (1) a new incident at or above the minimum severity produces exactly
//       one POST in the ntfy format (mocked fetch); a repeat within 6 h
//       produces none;
//   (3) the digest groups open incidents (daily digest, burst digest);
//   (4) scanner noise ("Failed to find Server Action") produces no alert;
//   (5) the topic and the token are never rendered back into the page.
// (2), the two-consecutive-checks rule for stale ticks, is in
// ops-watchdog.test.ts.
// Plus: config parsing, the severity → priority mapping, the hourly
// budget, failed deliveries and their retry, control-change alerts and
// the console's test alert.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { opsAlertDeliveries, opsAlertState, opsEvents } from '@/lib/db/schema/ops';
import { settleDetached } from '@/lib/detached';
import {
  DEFAULT_NTFY_URL,
  _resetAlertsDisabledLogForTests,
  describeAlertConfig,
  logAlertsDisabledOnce,
  readAlertConfig,
  severitiesAtOrAbove,
} from '@/lib/ops/alert-config';
import {
  SEVERITY_PRIORITY,
  containsPattern,
  controlChangeKey,
  formatIncidentAlert,
  groupEvents,
  isAlertNoise,
  type AlertMessage,
  type AlertableEvent,
} from '@/lib/ops/alert-messages';
import {
  NTFY_MAX_MESSAGE_BYTES,
  buildNtfyRequest,
  scrubSinkError,
  sendNtfy,
  truncateUtf8,
} from '@/lib/ops/ntfy';
import {
  ALERT_BUDGET_PER_WINDOW,
  ALERT_DELIVERY_FAILED_FINGERPRINT,
  ALERT_DELIVERY_FAILED_KIND,
  DAILY_DIGEST_KEY,
  MAX_DUE_PER_PASS,
  OpsAlertError,
  REALERT_AFTER_MS,
  _setOpsAlertDepsForTests,
  alertControlChange,
  dailyDigestSlot,
  dispatchOpsAlerts,
  getOwnerAlertStatus,
  notifyControlChange,
  sendDailyDigestIfDue,
  sendTestAlert,
} from '@/lib/services/ops-alerts';
import { raiseOpsEvent, resolveOpsEvent, type RaiseOpsEventInput } from '@/lib/services/ops-events';
import { makePlatformContext } from '@/lib/services/platform-context';
import { OwnerAlertsPanel } from '@/components/OwnerAlertsPanel';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const TOPIC = 'ls-owner-K9q2Zr';
const TOKEN = 'tk_live0123456789abcdefXYZ';
const ENV = { NTFY_TOPIC: TOPIC, NTFY_TOKEN: TOKEN, APP_URL: 'https://discover.example.test/' };

let clock: Date;
let env: Record<string, string | undefined>;
const fetchMock = vi.fn(
  async (_url: string, _init: RequestInit): Promise<Response> =>
    new Response('{"id":"m1"}', { status: 200 }),
);
const logMock = vi.fn((_m: string) => undefined);

interface Post {
  url: string;
  headers: Record<string, string>;
  body: {
    topic: string;
    title: string;
    message: string;
    priority: number;
    tags: string[];
    click?: string;
  };
}

function posts(): Post[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as Post['body'],
  }));
}

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

function raise(over: Partial<RaiseOpsEventInput> = {}) {
  return raiseOpsEvent(
    {
      scope: 'platform',
      kind: 'tick.failed',
      severity: 'error',
      source: 'autopilot.tick',
      dedupeKey: 'autopilot.tick',
      title: 'Autopilot failed',
      message: 'connection reset',
      ...over,
    } as RaiseOpsEventInput,
    clock,
  );
}

async function seedWs(name: string): Promise<bigint> {
  const owner = await seedUser({ email: `${name.toLowerCase().replace(/\s+/g, '')}@alerts.test` });
  return seedWorkspace({ name, ownerUserId: owner });
}

async function deliveries() {
  return db.select().from(opsAlertDeliveries).orderBy(opsAlertDeliveries.id);
}

beforeEach(async () => {
  await truncateAll();
  clock = new Date('2026-10-02T09:00:00.000Z');
  env = { ...ENV };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response('{"id":"m1"}', { status: 200 }));
  logMock.mockReset();
  _setOpsAlertDepsForTests({
    now: () => clock,
    config: () => readAlertConfig(env),
    fetch: fetchMock,
    log: logMock,
  });
});

afterEach(() => {
  _setOpsAlertDepsForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---------------------------------------------------------------------------

describe('configuration (server env)', () => {
  it('is off without NTFY_TOPIC, and says so once', () => {
    const cfg = readAlertConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.disabledReason).toBe('NTFY_TOPIC is not set');
    _resetAlertsDisabledLogForTests();
    const log = vi.fn();
    logAlertsDisabledOnce(cfg, log);
    logAlertsDisabledOnce(cfg, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('Owner alerts are off: NTFY_TOPIC is not set');
  });

  it('defaults NTFY_URL to ntfy.sh, trims trailing slashes and reads the token', () => {
    const cfg = readAlertConfig({ NTFY_TOPIC: TOPIC, NTFY_TOKEN: ` ${TOKEN} ` });
    expect(DEFAULT_NTFY_URL).toBe('https://ntfy.sh');
    expect(cfg.enabled).toBe(true);
    expect(cfg.ntfy).toEqual({ serverUrl: 'https://ntfy.sh', topic: TOPIC, token: TOKEN });
    const self = readAlertConfig({
      NTFY_TOPIC: TOPIC,
      NTFY_URL: 'https://push.example.test/ntfy/',
    });
    expect(self.ntfy?.serverUrl).toBe('https://push.example.test/ntfy');
    expect(self.ntfy?.token).toBeNull();
  });

  it('refuses an invalid topic, a non-http URL and credentials in the URL', () => {
    expect(readAlertConfig({ NTFY_TOPIC: 'has space' }).disabledReason).toMatch(
      /not a valid ntfy topic/,
    );
    expect(readAlertConfig({ NTFY_TOPIC: 'x'.repeat(65) }).enabled).toBe(false);
    expect(
      readAlertConfig({ NTFY_TOPIC: TOPIC, NTFY_URL: 'ftp://ntfy.sh' }).disabledReason,
    ).toMatch(/not an http\(s\) URL/);
    const creds = readAlertConfig({
      NTFY_TOPIC: TOPIC,
      NTFY_URL: 'https://me:pw@ntfy.example.test',
    });
    expect(creds.enabled).toBe(false);
    expect(creds.disabledReason).toMatch(/must not carry credentials/);
    expect(JSON.stringify(describeAlertConfig(creds))).not.toMatch(/me:pw|pw@/);
  });

  it('reads the minimum severity, ignoring unknown values', () => {
    expect(readAlertConfig({ NTFY_TOPIC: TOPIC }).minSeverity).toBe('error');
    expect(
      readAlertConfig({ NTFY_TOPIC: TOPIC, OPS_ALERT_MIN_SEVERITY: 'Critical' }).minSeverity,
    ).toBe('critical');
    const bad = readAlertConfig({ NTFY_TOPIC: TOPIC, OPS_ALERT_MIN_SEVERITY: 'info' });
    expect(bad.minSeverity).toBe('error');
    expect(bad.minSeverityIgnored).toBe(true);
    expect(severitiesAtOrAbove('error')).toEqual(['error', 'critical']);
    expect(severitiesAtOrAbove('warning')).toEqual(['warning', 'error', 'critical']);
  });

  it('a disabled dispatch sends nothing and logs once', async () => {
    env = {};
    _resetAlertsDisabledLogForTests();
    await raise();
    expect((await dispatchOpsAlerts()).status).toBe('disabled');
    expect((await dispatchOpsAlerts()).status).toBe('disabled');
    expect((await sendDailyDigestIfDue()).status).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledTimes(1);
  });
});

describe('the ntfy sink', () => {
  const target = { serverUrl: 'https://ntfy.sh', topic: TOPIC, token: TOKEN };
  const message: AlertMessage = {
    title: 'Leadsonar: Autopilot failed',
    body: 'boom',
    priority: 4,
    tags: ['red_circle', 'error'],
    click: 'https://discover.example.test/admin',
  };

  it('publishes JSON to the server root with the topic in the body and a bearer token', () => {
    const req = buildNtfyRequest(target, message);
    expect(req.url).toBe('https://ntfy.sh/');
    expect(req.init.method).toBe('POST');
    expect(req.init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(req.init.body)).toEqual({
      topic: TOPIC,
      title: 'Leadsonar: Autopilot failed',
      message: 'boom',
      priority: 4,
      tags: ['red_circle', 'error'],
      click: 'https://discover.example.test/admin',
    });
    const anon = buildNtfyRequest({ ...target, token: null }, { ...message, click: null });
    expect(anon.init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(anon.init.body).click).toBeUndefined();
  });

  it('maps severity to ntfy priority', () => {
    expect(SEVERITY_PRIORITY).toEqual({ info: 2, warning: 3, error: 4, critical: 5 });
  });

  it('keeps the message under ntfy’s 4096-byte limit on a character boundary', () => {
    const long = 'zażółć gęślą jaźń '.repeat(400);
    const cut = truncateUtf8(long, NTFY_MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(NTFY_MAX_MESSAGE_BYTES);
    expect(cut.endsWith('…')).toBe(true);
    const req = buildNtfyRequest(target, { ...message, body: long });
    expect(Buffer.byteLength(JSON.parse(req.init.body).message, 'utf8')).toBeLessThan(4096);
  });

  it('a refusal or a network error comes back without the topic or the token', async () => {
    const refused = await sendNtfy(target, message, {
      fetch: async () =>
        new Response(`{"error":"unauthorized for topic ${TOPIC} with token ${TOKEN}"}`, {
          status: 403,
        }),
    });
    expect(refused).toMatchObject({ ok: false, httpStatus: 403 });
    expect(refused.error).toContain('ntfy answered 403');
    expect(refused.error).not.toContain(TOPIC);
    expect(refused.error).not.toContain(TOKEN);

    const down = await sendNtfy(target, message, {
      fetch: async () => {
        throw Object.assign(new TypeError(`fetch failed for https://ntfy.sh/${TOPIC}`), {
          cause: { code: 'ECONNREFUSED' },
        });
      },
    });
    expect(down).toMatchObject({ ok: false, httpStatus: null });
    expect(down.error).toContain('ECONNREFUSED');
    expect(down.error).not.toContain(TOPIC);
    expect(scrubSinkError(`x ${TOKEN} y ${TOPIC}`, target)).toBe('x [token] y [topic]');
  });

  it('a server that does not answer times out', async () => {
    const slow = await sendNtfy(target, message, {
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    });
    expect(slow).toEqual({ ok: false, httpStatus: null, error: 'ntfy did not answer within 0 s' });
  });
});

describe('acceptance (1): one POST per new incident, none for repeats within 6 h', () => {
  it('alerts a new error once, in the ntfy format', async () => {
    await raise();
    const r = await dispatchOpsAlerts();
    expect(r).toMatchObject({ status: 'sent', messages: 1, alerted: 1, mode: 'individual' });
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://ntfy.sh/');
    expect(sent[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]!.body).toMatchObject({
      topic: TOPIC,
      title: 'Leadsonar: Autopilot failed',
      priority: 4,
      tags: ['red_circle', 'error'],
      click: 'https://discover.example.test/admin',
    });
    expect(sent[0]!.body.message).toContain('connection reset');
    expect(sent[0]!.body.message).toContain('Platform-wide');
    const [d] = await deliveries();
    expect(d).toMatchObject({
      kind: 'incident',
      status: 'sent',
      priority: 4,
      eventCount: 1,
      httpStatus: 200,
    });
  });

  it('a repeat within 6 h sends nothing; still open after 6 h sends one reminder', async () => {
    const first = await raise();
    await dispatchOpsAlerts();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advance(1 * HOUR);
    const again = await raise({ message: 'connection reset again' });
    expect(again.opened).toBe(false);
    expect(again.occurrences).toBe(2);
    expect((await dispatchOpsAlerts()).status).toBe('idle');
    advance(5 * HOUR - MIN);
    expect((await dispatchOpsAlerts()).status).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advance(MIN); // exactly 6 h after the first alert
    expect((await dispatchOpsAlerts()).status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posts()[1]!.body.title).toBe('Leadsonar: still open: Autopilot failed');
    expect(posts()[1]!.body.message).toContain('2 occurrences');

    const [state] = await db
      .select()
      .from(opsAlertState)
      .where(eq(opsAlertState.alertKey, first.fingerprint));
    expect(state).toMatchObject({ alertCount: 2, lastEventId: first.id });
    expect(REALERT_AFTER_MS).toBe(6 * HOUR);
  });

  it('an incident that resolves and reopens within 6 h does not page again', async () => {
    const first = await raise();
    await dispatchOpsAlerts();
    advance(10 * MIN);
    await resolveOpsEvent(first.fingerprint, { now: clock });
    advance(10 * MIN);
    const reopened = await raise();
    expect(reopened.opened).toBe(true);
    expect((await dispatchOpsAlerts()).status).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 6 h after the first alert the reopened incident is a fresh one.
    advance(6 * HOUR - 20 * MIN);
    await dispatchOpsAlerts();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posts()[1]!.body.title).toBe('Leadsonar: Autopilot failed');
  });

  it('respects the minimum severity and maps critical to the top priority', async () => {
    await raise({ severity: 'warning', kind: 'w', dedupeKey: 'w', title: 'Just a warning' });
    await raise({ severity: 'info', kind: 'i', dedupeKey: 'i', title: 'Just info' });
    expect((await dispatchOpsAlerts()).status).toBe('idle');
    await raise({
      severity: 'critical',
      kind: 'worker.error',
      dedupeKey: 'w2',
      title: 'Worker error',
    });
    await dispatchOpsAlerts();
    expect(posts().map((p) => [p.body.title, p.body.priority])).toEqual([
      ['Leadsonar: Worker error', 5],
    ]);
    expect(posts()[0]!.body.tags).toEqual(['rotating_light', 'critical']);

    env = { ...ENV, OPS_ALERT_MIN_SEVERITY: 'critical' };
    await raise({ dedupeKey: 'other', title: 'Another error' });
    expect((await dispatchOpsAlerts()).status).toBe('idle');
  });

  it('names the workspace of a workspace incident', async () => {
    const ws = await seedWs('Ecobeton UK');
    await raise({
      scope: 'workspace',
      workspaceId: ws,
      kind: 'tick.workspace_failed',
      source: 'mail.imap.tick',
      dedupeKey: `mail.imap.tick:ws=${ws}`,
      title: 'Inbox sync failed for this workspace',
    });
    await dispatchOpsAlerts();
    expect(posts()[0]!.body.message).toContain(`Workspace: Ecobeton UK (#${ws})`);
  });

  it('two overlapping passes still send exactly one POST', async () => {
    await raise();
    const results = await Promise.all([dispatchOpsAlerts(), dispatchOpsAlerts()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.messages).sort()).toEqual([0, 1]);
  });
});

describe('when many fire: digest and hourly budget', () => {
  it('up to 3 due incidents go out one by one, most severe first', async () => {
    await raise({ dedupeKey: 'a', title: 'A failed' });
    advance(MIN);
    await raise({ dedupeKey: 'b', title: 'B failed', severity: 'critical' });
    advance(MIN);
    await raise({ dedupeKey: 'c', title: 'C failed' });
    const r = await dispatchOpsAlerts();
    expect(r).toMatchObject({ status: 'sent', messages: 3, alerted: 3, mode: 'individual' });
    expect(posts().map((p) => p.body.title)).toEqual([
      'Leadsonar: B failed',
      'Leadsonar: A failed',
      'Leadsonar: C failed',
    ]);
  });

  it('more than 3 at once become ONE digest that groups them, then nothing repeats', async () => {
    const wsA = await seedWs('Alpha');
    const wsB = await seedWs('Beta');
    for (const ws of [wsA, wsB]) {
      await raise({
        scope: 'workspace',
        workspaceId: ws,
        kind: 'tick.workspace_failed',
        source: 'mail.imap.tick',
        dedupeKey: `mail.imap.tick:ws=${ws}`,
        title: 'Inbox sync failed for this workspace',
      });
    }
    await raise({ dedupeKey: 'x', title: 'Autopilot failed' });
    await raise({
      kind: 'worker.error',
      severity: 'critical',
      source: 'bullmq.worker',
      dedupeKey: 'bullmq.worker',
      title: 'The background job worker reported an error',
    });
    await raise({
      kind: 'job.failed',
      source: 'connector.run',
      dedupeKey: 'connector.run',
      title: 'Discovery run failed',
    });

    const r = await dispatchOpsAlerts();
    expect(r).toMatchObject({ status: 'sent', messages: 1, alerted: 5, mode: 'digest' });
    const [digest] = posts();
    expect(digest!.body.title).toBe('Leadsonar: 5 new incidents');
    expect(digest!.body.priority).toBe(5);
    expect(digest!.body.tags).toContain('digest');
    const lines = digest!.body.message.split('\n');
    expect(lines[0]).toBe(
      '5 incidents opened at once (1 critical, 4 error), folded into one message.',
    );
    // Critical group first; the two inbox failures are ONE line.
    expect(lines[1]).toMatch(/^• 1× The background job worker reported an error \[critical\]/);
    const inbox = lines.filter((l) => l.includes('Inbox sync failed'));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatch(
      /^• 2× Inbox sync failed for this workspace \[error\] · mail\.imap\.tick \(tick\.workspace_failed\) · 2 workspaces · 2 occurrences/,
    );

    const [d] = await deliveries();
    expect(d).toMatchObject({ kind: 'digest', status: 'sent', eventCount: 5 });
    expect((await db.select().from(opsAlertState)).length).toBe(5);

    advance(HOUR);
    expect((await dispatchOpsAlerts()).status).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('over the hourly budget, errors wait and critical ones still go out', async () => {
    await db.insert(opsAlertDeliveries).values(
      Array.from({ length: ALERT_BUDGET_PER_WINDOW }, (_, i) => ({
        kind: 'incident',
        status: 'sent',
        title: `earlier ${i}`,
        priority: 4,
        createdAt: new Date(clock.getTime() - 30 * MIN),
      })),
    );
    await raise({ dedupeKey: 'late', title: 'Late error' });
    expect(await dispatchOpsAlerts()).toMatchObject({ status: 'held', due: 1 });
    expect(fetchMock).not.toHaveBeenCalled();

    await raise({
      severity: 'critical',
      kind: 'worker.error',
      dedupeKey: 'crit',
      title: 'Worker down',
    });
    expect(await dispatchOpsAlerts()).toMatchObject({ status: 'sent', messages: 1, alerted: 1 });
    expect(posts()[0]!.body.title).toBe('Leadsonar: Worker down');

    // The window frees 30 min later: the waiting error goes out.
    advance(31 * MIN);
    expect(await dispatchOpsAlerts()).toMatchObject({ status: 'sent', alerted: 1 });
    expect(posts()[1]!.body.title).toBe('Leadsonar: Late error');
  });

  it('a failed delivery gives the claim back, records the failure and is retried', async () => {
    env = { ...ENV, OPS_ALERT_MIN_SEVERITY: 'warning' };
    fetchMock.mockImplementation(async () => new Response('boom', { status: 502 }));
    const ev = await raise();
    expect(await dispatchOpsAlerts()).toMatchObject({ status: 'failed', messages: 0 });
    expect(await db.select().from(opsAlertState)).toEqual([]);
    const [failed] = await deliveries();
    expect(failed).toMatchObject({ kind: 'incident', status: 'failed', httpStatus: 502 });
    expect(failed!.error).toContain('ntfy answered 502');
    const [sinkDown] = await db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.kind, ALERT_DELIVERY_FAILED_KIND), isNull(opsEvents.resolvedAt)));
    expect(sinkDown).toMatchObject({
      severity: 'warning',
      fingerprint: ALERT_DELIVERY_FAILED_FINGERPRINT,
    });

    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    advance(MIN);
    const r = await dispatchOpsAlerts();
    // The incident is delivered; the delivery failure itself never is.
    expect(r).toMatchObject({ status: 'sent', alerted: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posts().every((p) => p.body.title === 'Leadsonar: Autopilot failed')).toBe(true);
    const [state] = await db.select().from(opsAlertState);
    expect(state).toMatchObject({ alertKey: ev.fingerprint, alertCount: 1 });
    const stillDown = await db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.kind, ALERT_DELIVERY_FAILED_KIND), isNull(opsEvents.resolvedAt)));
    expect(stillDown).toEqual([]);
  });

  it('stops at the first failure and keeps the rest due', async () => {
    let n = 0;
    fetchMock.mockImplementation(async () =>
      ++n === 2 ? new Response('no', { status: 500 }) : new Response('{}', { status: 200 }),
    );
    await raise({ dedupeKey: 'a', title: 'A failed' });
    advance(MIN);
    await raise({ dedupeKey: 'b', title: 'B failed' });
    advance(MIN);
    await raise({ dedupeKey: 'c', title: 'C failed' });
    expect(await dispatchOpsAlerts()).toMatchObject({ status: 'failed', messages: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await db.select().from(opsAlertState)).toHaveLength(1);
    advance(MIN);
    expect(await dispatchOpsAlerts()).toMatchObject({ status: 'sent', messages: 2 });
    expect(
      posts()
        .slice(2)
        .map((p) => p.body.title),
    ).toEqual(['Leadsonar: B failed', 'Leadsonar: C failed']);
  });
});

describe('acceptance (3): the daily digest groups open incidents', () => {
  async function seedOpenIncidents() {
    const ws = [await seedWs('One'), await seedWs('Two'), await seedWs('Three')];
    clock = new Date('2026-10-01T22:00:00.000Z');
    for (const id of ws) {
      await raise({
        scope: 'workspace',
        workspaceId: id,
        kind: 'tick.workspace_failed',
        source: 'mail.imap.tick',
        dedupeKey: `mail.imap.tick:ws=${id}`,
        title: 'Inbox sync failed for this workspace',
      });
    }
    await raise({
      kind: 'worker.error',
      severity: 'critical',
      source: 'bullmq.worker',
      dedupeKey: 'bullmq.worker',
      title: 'The background job worker reported an error',
    });
    await raise({
      kind: 'slow',
      severity: 'warning',
      source: 'health.check.tick',
      dedupeKey: 'slow',
      title: 'Health check slow',
    });
    await raise({
      kind: 'note',
      severity: 'info',
      source: 'x',
      dedupeKey: 'note',
      title: 'Info only',
    });
    await raise({
      kind: 'request.error',
      source: 'next',
      dedupeKey: 'scanner',
      title: 'Request error',
      message:
        'Error: Failed to find Server Action "7f1e". This request might be from an older or newer deployment.',
    });
    const gone = await raise({ dedupeKey: 'gone', title: 'Already fixed' });
    await resolveOpsEvent(gone.fingerprint, { now: clock });
  }

  it('sends one digest at 07:00 UTC, grouped, without info, noise or resolved incidents', async () => {
    await seedOpenIncidents();
    clock = new Date('2026-10-02T06:59:00.000Z');
    expect((await sendDailyDigestIfDue()).status).toBe('not_due');
    expect(fetchMock).not.toHaveBeenCalled();

    clock = new Date('2026-10-02T07:00:30.000Z');
    expect(await sendDailyDigestIfDue()).toEqual({ status: 'sent', incidents: 5, groups: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [digest] = posts();
    expect(digest!.body.title).toBe('Leadsonar: daily digest, 5 open incidents');
    expect(digest!.body.priority).toBe(3);
    const lines = digest!.body.message.split('\n');
    expect(lines[0]).toBe('Open incidents: 5 (1 critical, 3 error, 1 warning).');
    expect(lines[1]).toMatch(
      /^• 1× The background job worker reported an error \[critical\] · bullmq\.worker/,
    );
    expect(lines[2]).toMatch(
      /^• 3× Inbox sync failed for this workspace \[error\] · mail\.imap\.tick \(tick\.workspace_failed\) · 3 workspaces · 3 occurrences · since 2026-10-01 22:00 UTC$/,
    );
    expect(lines[3]).toMatch(/^• 1× Health check slow \[warning\]/);
    expect(digest!.body.message).not.toMatch(
      /Info only|Failed to find Server Action|Already fixed/,
    );
    const [d] = await deliveries();
    expect(d).toMatchObject({ kind: 'daily_digest', status: 'sent', eventCount: 5 });

    // Once a day.
    clock = new Date('2026-10-02T15:00:00.000Z');
    expect((await sendDailyDigestIfDue()).status).toBe('not_due');
    clock = new Date('2026-10-03T07:01:00.000Z');
    expect((await sendDailyDigestIfDue()).status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('with nothing open sends nothing, and does not try again that day', async () => {
    clock = new Date('2026-10-02T07:00:00.000Z');
    expect((await sendDailyDigestIfDue()).status).toBe('nothing_open');
    await raise();
    clock = new Date('2026-10-02T09:00:00.000Z');
    expect((await sendDailyDigestIfDue()).status).toBe('not_due');
    expect(fetchMock).not.toHaveBeenCalled();
    const [state] = await db
      .select()
      .from(opsAlertState)
      .where(eq(opsAlertState.alertKey, DAILY_DIGEST_KEY));
    expect(state?.lastAlertedAt.toISOString()).toBe('2026-10-02T07:00:00.000Z');
  });

  it('a failed digest is retried on the next pass', async () => {
    await raise();
    clock = new Date('2026-10-02T07:00:00.000Z');
    fetchMock.mockImplementationOnce(async () => new Response('down', { status: 503 }));
    expect((await sendDailyDigestIfDue()).status).toBe('failed');
    clock = new Date('2026-10-02T07:01:00.000Z');
    expect((await sendDailyDigestIfDue()).status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dailyDigestSlot is today at 07:00 UTC', () => {
    expect(dailyDigestSlot(new Date('2026-10-02T23:59:00Z')).toISOString()).toBe(
      '2026-10-02T07:00:00.000Z',
    );
  });

  it('groupEvents folds incidents per kind and source', () => {
    const base: AlertableEvent = {
      id: 1n,
      fingerprint: 'f1',
      scope: 'workspace',
      workspaceId: 1n,
      kind: 'k',
      severity: 'error',
      source: 's',
      title: 'T',
      message: null,
      occurrences: 2,
      firstSeenAt: new Date('2026-10-02T08:00:00Z'),
      lastSeenAt: new Date('2026-10-02T08:00:00Z'),
    };
    const groups = groupEvents([
      base,
      {
        ...base,
        id: 2n,
        fingerprint: 'f2',
        workspaceId: 2n,
        occurrences: 3,
        firstSeenAt: new Date('2026-10-01T08:00:00Z'),
      },
      { ...base, id: 3n, fingerprint: 'f3', workspaceId: 2n, kind: 'other' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ kind: 'k', incidents: 2, occurrences: 5, workspaces: 2 });
    expect(groups[0]!.oldest.toISOString()).toBe('2026-10-01T08:00:00.000Z');
  });
});

describe('acceptance (4): scanner noise produces no alert', () => {
  it('"Failed to find Server Action" errors are never alerted', async () => {
    await raise({
      kind: 'request.error',
      source: 'next',
      dedupeKey: 'scanner-1',
      title: 'Unhandled request error',
      message:
        'Error: Failed to find Server Action "00a1b2". This request might be from an older or newer deployment.',
    });
    await raise({
      kind: 'request.error',
      source: 'next',
      dedupeKey: 'scanner-2',
      severity: 'critical',
      title: 'Failed to find Server Action "ff00"',
    });
    expect(await dispatchOpsAlerts()).toMatchObject({ status: 'idle', due: 0 });
    clock = new Date('2026-10-02T07:30:00.000Z');
    expect((await sendDailyDigestIfDue()).status).toBe('nothing_open');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isAlertNoise matches the title or the message, case-insensitively', () => {
    expect(isAlertNoise({ title: 'x', message: 'failed to find server action "a"' })).toBe(true);
    expect(isAlertNoise({ title: 'Failed to find Server Action', message: null })).toBe(true);
    expect(isAlertNoise({ title: 'Autopilot failed', message: 'Server Action threw' })).toBe(false);
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('a pile of noise cannot crowd a real incident out of a pass', async () => {
    const old = new Date(clock.getTime() - 2 * HOUR);
    await db.insert(opsEvents).values(
      Array.from({ length: MAX_DUE_PER_PASS + 5 }, (_, i) => ({
        scope: 'platform',
        kind: 'request.error',
        severity: 'critical',
        source: 'next',
        dedupeKey: `probe-${i}`,
        fingerprint: `probe-fingerprint-${i}`,
        title: 'Unhandled request error',
        message: `Error: Failed to find Server Action "${i}"`,
        firstSeenAt: old,
        lastSeenAt: old,
      })),
    );
    await raise({ title: 'Real failure' });
    expect(await dispatchOpsAlerts()).toMatchObject({ status: 'sent', due: 1, alerted: 1 });
    expect(posts().map((p) => p.body.title)).toEqual(['Leadsonar: Real failure']);
  });
});

describe('acceptance (5): the topic and the token are never rendered back', () => {
  it('the console status and the rendered panel carry neither', async () => {
    const admin = await seedUser({ email: 'root@alerts.test', role: 'super_admin' });
    const pctx = makePlatformContext(admin);
    // A refusal that echoed both secrets is in the log.
    fetchMock.mockImplementationOnce(
      async () => new Response(`topic ${TOPIC} token ${TOKEN} rejected`, { status: 401 }),
    );
    await raise();
    await dispatchOpsAlerts();
    advance(MIN);
    await dispatchOpsAlerts();

    const status = await getOwnerAlertStatus(pctx);
    const json = JSON.stringify(status, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(json).not.toContain(TOPIC);
    expect(json).not.toContain(TOKEN);
    expect(status.config).toMatchObject({
      enabled: true,
      server: 'ntfy.sh',
      topicSet: true,
      topicLength: TOPIC.length,
      tokenSet: true,
      minSeverity: 'error',
    });
    expect(status.history?.recent.map((r) => r.status)).toEqual(['sent', 'failed']);
    expect(status.history?.sentLastHour).toBe(1);

    const html = renderToStaticMarkup(
      createElement(OwnerAlertsPanel, { status, sendTestAction: async () => undefined }),
    );
    expect(html).not.toContain(TOPIC);
    expect(html).not.toContain(TOKEN);
    expect(html).toContain(`set (${TOPIC.length} characters, hidden)`);
    expect(html).toContain('set (hidden)');
    expect(html).toContain('Send test alert');
    expect(html).toContain('[topic]');
    expect(html).not.toContain('style=');

    // Nothing stored anywhere holds them either.
    const stored = JSON.stringify(
      [await deliveries(), await db.select().from(opsEvents)],
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    );
    expect(stored).not.toContain(TOPIC);
    expect(stored).not.toContain(TOKEN);
  });

  it('a disabled sink renders off with its reason and a disabled test button', async () => {
    env = {};
    const admin = await seedUser({ email: 'root2@alerts.test', role: 'super_admin' });
    const status = await getOwnerAlertStatus(makePlatformContext(admin));
    const html = renderToStaticMarkup(
      createElement(OwnerAlertsPanel, { status, sendTestAction: async () => undefined }),
    );
    expect(html).toContain('NTFY_TOPIC is not set');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send test alert<\/button>/);
    expect(html).toContain('No alert has been sent yet.');
  });

  it('the console status needs a PlatformContext', async () => {
    await expect(
      getOwnerAlertStatus({ scope: 'platform', actorUserId: 'u', workspaceId: 1n } as never),
    ).rejects.toBeInstanceOf(OpsAlertError);
  });
});

describe('platform stop / hold / pause changes', () => {
  it('the outbound stop alerts at high priority; a double submit alerts once', async () => {
    const change = {
      control: 'platform_outbound_stop' as const,
      action: 'set' as const,
      reason: 'Bounce spike, ask jan.kowalski@example.com',
    };
    expect(await alertControlChange(change)).toEqual({ status: 'sent' });
    expect(await alertControlChange(change)).toEqual({ status: 'duplicate' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [p] = posts();
    expect(p!.body).toMatchObject({
      title: 'Leadsonar: outbound email stopped for every workspace',
      priority: 4,
      tags: ['octagonal_sign', 'control'],
    });
    expect(p!.body.message).toContain('Reason: Bounce spike, ask ***@example.com');
    expect(p!.body.message).not.toContain('jan.kowalski');

    advance(61 * 1000);
    expect(await alertControlChange(change)).toEqual({ status: 'sent' });
    expect(
      await alertControlChange({ control: 'platform_outbound_stop', action: 'cleared' }),
    ).toEqual({
      status: 'sent',
    });
    expect(posts()[2]!.body).toMatchObject({
      title: 'Leadsonar: outbound email stop cleared',
      priority: 3,
    });
    const kinds = (await deliveries()).map((d) => d.kind);
    expect(kinds).toEqual(['control', 'control', 'control']);
  });

  it('holds and pauses name the workspace and what is held', async () => {
    const ws = await seedWs('Acme Ltd');
    await alertControlChange({
      control: 'workspace_hold',
      action: 'placed',
      source: 'platform',
      workspaceId: ws,
      holdId: 7n,
      scopeLabel: 'Sending, Inbox sync',
      reason: 'Spam complaints',
    });
    await alertControlChange({
      control: 'workspace_hold',
      action: 'released',
      source: 'tenant',
      workspaceId: ws,
      holdId: 7n,
      scopeLabel: 'Sending, Inbox sync',
    });
    await alertControlChange({ control: 'automation_pause', action: 'paused', workspaceId: ws });
    expect(posts().map((p) => [p.body.title, p.body.priority])).toEqual([
      [`Leadsonar: Sending, Inbox sync on hold in Acme Ltd (#${ws})`, 3],
      [`Leadsonar: hold on Sending, Inbox sync released in Acme Ltd (#${ws})`, 2],
      [`Leadsonar: Acme Ltd (#${ws}) paused all automation`, 3],
    ]);
    expect(posts()[0]!.body.message).toBe(
      'Placed by the platform console.\nReason: Spam complaints',
    );
    expect(
      controlChangeKey({
        control: 'workspace_hold',
        action: 'placed',
        source: 'platform',
        workspaceId: ws,
        holdId: 7n,
        scopeLabel: 'x',
      }),
    ).toBe(`control:workspace_hold:${ws}:7:placed`);
  });

  it('refuses malformed input, does nothing while alerts are off, never throws', async () => {
    expect(await alertControlChange({ control: 'workspace_hold', action: 'placed' })).toEqual({
      status: 'invalid',
    });
    expect(await alertControlChange({ control: 'nuke' })).toEqual({ status: 'invalid' });
    env = {};
    expect(await alertControlChange({ control: 'platform_outbound_stop', action: 'set' })).toEqual({
      status: 'disabled',
    });
    env = { ...ENV };
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('socket hang up');
    });
    expect(await alertControlChange({ control: 'platform_outbound_stop', action: 'set' })).toEqual({
      status: 'failed',
    });
    // The failed claim was given back: an immediate retry goes out.
    expect(await alertControlChange({ control: 'platform_outbound_stop', action: 'set' })).toEqual({
      status: 'sent',
    });
  });

  it('is not held back by the hourly budget', async () => {
    await db.insert(opsAlertDeliveries).values(
      Array.from({ length: ALERT_BUDGET_PER_WINDOW }, (_, i) => ({
        kind: 'digest',
        status: 'sent',
        title: `earlier ${i}`,
        priority: 4,
        createdAt: new Date(clock.getTime() - MIN),
      })),
    );
    expect(await alertControlChange({ control: 'platform_outbound_stop', action: 'set' })).toEqual({
      status: 'sent',
    });
  });

  it('notifyControlChange runs detached', async () => {
    notifyControlChange({ control: 'platform_outbound_stop', action: 'set' });
    await settleDetached();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Send test alert (platform console)', () => {
  it('needs a PlatformContext', async () => {
    await expect(
      sendTestAlert({ scope: 'workspace', actorUserId: 'u' } as never),
    ).rejects.toBeInstanceOf(OpsAlertError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains how to switch alerts on when they are off', async () => {
    env = {};
    const admin = await seedUser({ email: 'root@alerts.test', role: 'super_admin' });
    const r = await sendTestAlert(makePlatformContext(admin));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('NTFY_TOPIC is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one message, records it and audits at platform scope', async () => {
    const admin = await seedUser({ email: 'root@alerts.test', role: 'super_admin' });
    const r = await sendTestAlert(makePlatformContext(admin));
    expect(r).toEqual({
      ok: true,
      message: 'Test alert sent to the ntfy topic on ntfy.sh. Check the ntfy app subscribed to it.',
    });
    expect(posts()[0]!.body).toMatchObject({
      topic: TOPIC,
      title: 'Leadsonar: test alert',
      priority: 3,
      tags: ['white_check_mark', 'test'],
    });
    const [d] = await deliveries();
    expect(d).toMatchObject({ kind: 'test', status: 'sent' });
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.kind, 'ops.alert.test'));
    expect(audit).toMatchObject({ workspaceId: null, userId: admin });
    expect(audit!.payload).toMatchObject({ status: 'sent', httpStatus: 200, server: 'ntfy.sh' });
  });

  it('reports a failure without the topic or the token', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(`bad topic ${TOPIC} / ${TOKEN}`, { status: 400 }),
    );
    const admin = await seedUser({ email: 'root@alerts.test', role: 'super_admin' });
    const r = await sendTestAlert(makePlatformContext(admin));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Test alert failed: ntfy answered 400');
    expect(r.message).not.toContain(TOPIC);
    expect(r.message).not.toContain(TOKEN);
  });
});

describe('incident message format', () => {
  it('says how often it happened and that repeats are not re-sent', () => {
    const msg = formatIncidentAlert(
      {
        id: 1n,
        fingerprint: 'f',
        scope: 'platform',
        workspaceId: null,
        kind: 'tick.failed',
        severity: 'error',
        source: 'autopilot.tick',
        title: 'Autopilot failed',
        message: 'boom',
        occurrences: 1,
        firstSeenAt: new Date('2026-10-02T08:00:00Z'),
        lastSeenAt: new Date('2026-10-02T08:00:00Z'),
      },
      { appUrl: null, reminder: false },
    );
    expect(msg).toEqual({
      title: 'Leadsonar: Autopilot failed',
      body: [
        'boom',
        'Platform-wide',
        'error · tick.failed · autopilot.tick',
        '1 occurrence since 2026-10-02 08:00 UTC, last 2026-10-02 08:00 UTC',
        'Repeats are counted, not re-sent; a reminder follows after 6 h if it is still open.',
      ].join('\n'),
      priority: 4,
      tags: ['red_circle', 'error'],
      click: null,
    });
  });
});
