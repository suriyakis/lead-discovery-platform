// flow:F-04 (X7, I095, I021) — failing-mailbox visibility and backoff.
//   - every failed sync leaves a non-null imap_next_sync_after;
//   - crossing the failure threshold (or a refused login) marks the
//     mailbox failing and raises exactly one mailbox.failing
//     notification; repeats are deduped while it is unread;
//   - a failing mailbox is re-checked (SMTP + IMAP) on a gate that grows
//     with the episode (1 h / 6 h after a refused login, cap 24 h) and
//     recovers on a pass, resolving its notification;
//   - the IMAP tick adopts legacy failing rows (no gate) without a
//     connection attempt — one notification each, within one tick;
//   - the health check lists every failing mailbox by name with a link.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { mailboxes, type Mailbox } from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { workspaces } from '@/lib/db/schema/workspaces';
import type {
  ConnectionTestResult,
  IMailProvider,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '@/lib/mail';
import { runImapTick } from '@/lib/jobs/repeatables';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { collectRuleFindings } from '@/lib/services/health-check';
import { safeSyncOne } from '@/lib/services/mail';
import {
  _setMailProviderFactoryForTests,
  createMailbox,
  markMailboxFailing,
  pauseMailbox,
  reactivateMailbox,
  testMailboxConnection,
} from '@/lib/services/mailbox';
import {
  listNotifications,
  markNotificationsRead,
} from '@/lib/services/notifications';
import { TRANSIENT_FAILURE_PAUSE_THRESHOLD } from '@/lib/services/imap-backoff';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// ---- fixtures --------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

interface Setup {
  workspaceId: bigint;
  ownerId: string;
  c: WorkspaceContext;
}

let seq = 0;
async function setup(name = 'f04'): Promise<Setup> {
  seq++;
  const ownerId = await seedUser({ email: `${name}-${seq}@test.local` });
  const workspaceId = await seedWorkspace({ name: `${name}-${seq}`, ownerUserId: ownerId });
  return { workspaceId, ownerId, c: ctx(workspaceId, ownerId) };
}

async function makeMailbox(s: Setup, name = 'sales', opts: { imap?: boolean; smtpPort?: number } = {}): Promise<Mailbox> {
  return createMailbox(s.c, {
    name,
    fromAddress: `${name}-${seq}@nulife.pl`,
    smtpHost: 'mail.example.com',
    smtpPort: opts.smtpPort ?? 587,
    smtpUser: `${name}@nulife.pl`,
    smtpPassword: 'secret',
    imap:
      opts.imap === false
        ? null
        : { host: 'mail.example.com', port: 993, user: `${name}@nulife.pl`, password: 'secret' },
  });
}

async function row(id: bigint): Promise<Mailbox> {
  const [r] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return r!;
}

async function failingNotices(workspaceId: bigint) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.kind, 'mailbox.failing')));
}

async function auditKinds(workspaceId: bigint, kind: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.kind, kind)));
}

const HEALTHY: ConnectionTestResult = { smtp: { ok: true }, imap: { ok: true } };

/** fetchInbound / testConnection behave as scripted; counts calls. */
class ScriptedProvider implements IMailProvider {
  public readonly id = 'scripted';
  fetchCalls = 0;
  testCalls = 0;
  fetchError: unknown = null;
  test: ConnectionTestResult = HEALTHY;

  async send(_message: OutboundMessage): Promise<SendResult> {
    throw new Error('send is not used in these tests');
  }

  async fetchInbound(): Promise<InboundMessage[]> {
    this.fetchCalls++;
    if (this.fetchError) throw this.fetchError;
    return [];
  }

  async testConnection(): Promise<ConnectionTestResult> {
    this.testCalls++;
    return this.test;
  }
}

/** What imapflow throws for a refused LOGIN: a bare "Command failed". */
function imapflowAuthError(): Error {
  return Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
    response: 'Authentication failed.',
  });
}

function expectGate(mb: Mailbox, fromNowMs: number, slackMs = 2 * MINUTE): void {
  expect(mb.imapNextSyncAfter).not.toBeNull();
  const delta = mb.imapNextSyncAfter!.getTime() - Date.now();
  expect(delta).toBeGreaterThan(fromNowMs - slackMs);
  expect(delta).toBeLessThan(fromNowMs + slackMs);
}

let provider: ScriptedProvider;

beforeEach(async () => {
  await truncateAll();
  provider = new ScriptedProvider();
  _setMailProviderFactoryForTests(() => provider);
});

afterEach(() => {
  _setMailProviderFactoryForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- safeSyncOne -----------------------------------------------------

describe('safeSyncOne failure bookkeeping (F-04)', () => {
  it('every failed sync leaves a gate; crossing the threshold notifies exactly once, repeats are deduped', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    provider.fetchError = new Error('Socket timed out after 20000ms');

    for (let i = 1; i < TRANSIENT_FAILURE_PAUSE_THRESHOLD; i++) {
      const outcome = await safeSyncOne(s.c, await row(mb.id));
      expect(outcome.kind).toBe('transient_failed');
      const r = await row(mb.id);
      expect(r.status).toBe('active');
      expect(r.imapConsecutiveFailures).toBe(i);
      expect(r.imapNextSyncAfter).not.toBeNull();
      expect(r.lastError).toBe('IMAP: Socket timed out after 20000ms');
      expect(r.lastErrorAt).not.toBeNull();
    }
    expect(await failingNotices(s.workspaceId)).toHaveLength(0);

    // The threshold-th failure pauses it.
    const paused = await safeSyncOne(s.c, await row(mb.id));
    expect(paused.kind).toBe('failing');
    let r = await row(mb.id);
    expect(r.status).toBe('failing');
    expect(r.failingSince).not.toBeNull();
    expectGate(r, HOUR);
    let notes = await failingNotices(s.workspaceId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.href).toBe(`/mailbox/${mb.id}`);
    // Targeted at the workspace's only admin (its owner), deduped per admin.
    expect(notes[0]!.userId).toBe(s.ownerId);
    expect(notes[0]!.dedupeKey).toBe(`mailbox.failing:${mb.id}:user:${s.ownerId}`);
    expect(notes[0]!.title).toBe('Mailbox "sales" is failing');
    expect(notes[0]!.body).toContain('Replies to it are not read');

    // A failing mailbox is re-checked, not synced; the failed re-check
    // refreshes the gate but the unread notification is not repeated.
    provider.test = { smtp: { ok: true }, imap: { ok: false, detail: 'Socket timed out after 20000ms' } };
    const fetchesBefore = provider.fetchCalls;
    const again = await safeSyncOne(s.c, r);
    expect(again.kind).toBe('failing');
    if (again.kind === 'failing') expect(again.notified).toBe(false);
    expect(provider.fetchCalls).toBe(fetchesBefore);
    expect(provider.testCalls).toBe(1);
    r = await row(mb.id);
    expect(r.status).toBe('failing');
    expect(r.imapConsecutiveFailures).toBe(TRANSIENT_FAILURE_PAUSE_THRESHOLD + 1);
    expect(r.imapNextSyncAfter).not.toBeNull();
    notes = await failingNotices(s.workspaceId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.readAt).toBeNull();
    expect(await auditKinds(s.workspaceId, 'mailbox.marked_failing')).toHaveLength(1);
  });

  it('an imapflow refused LOGIN ("Command failed") pauses at once, keeps the server text and waits 6 h', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    provider.fetchError = imapflowAuthError();

    const outcome = await safeSyncOne(s.c, await row(mb.id));
    expect(outcome.kind).toBe('failing');
    const r = await row(mb.id);
    expect(r.status).toBe('failing');
    expect(r.imapConsecutiveFailures).toBe(1);
    expect(r.lastError).toBe('IMAP: Command failed: [AUTHENTICATIONFAILED] Authentication failed.');
    expectGate(r, 6 * HOUR);
    const notes = await failingNotices(s.workspaceId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain('refused the login');
  });

  it('a passing re-check recovers the mailbox, resolves the notification and syncs; the next failure notifies again', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    provider.fetchError = imapflowAuthError();
    await safeSyncOne(s.c, await row(mb.id));
    expect((await row(mb.id)).status).toBe('failing');

    provider.fetchError = null;
    provider.test = HEALTHY;
    const outcome = await safeSyncOne(s.c, await row(mb.id));
    expect(outcome).toMatchObject({ kind: 'synced', recovered: true });
    expect(provider.testCalls).toBe(1);
    const r = await row(mb.id);
    expect(r.status).toBe('active');
    expect(r.imapConsecutiveFailures).toBe(0);
    expect(r.lastError).toBeNull();
    expect(r.lastErrorAt).toBeNull();
    expect(r.failingSince).toBeNull();
    expect(r.lastSyncedAt).not.toBeNull();
    let notes = await failingNotices(s.workspaceId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.readAt).not.toBeNull();
    expect(await auditKinds(s.workspaceId, 'mailbox.recovered')).toHaveLength(1);

    provider.fetchError = imapflowAuthError();
    await safeSyncOne(s.c, await row(mb.id));
    notes = await failingNotices(s.workspaceId);
    expect(notes).toHaveLength(2);
    expect(notes.filter((n) => n.readAt === null)).toHaveLength(1);
  });

  it('a viewer cannot sync, and the refusal is not counted as a mailbox failure', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const viewer = makeWorkspaceContext({ workspaceId: s.workspaceId, userId: s.ownerId, role: 'viewer' });
    await expect(safeSyncOne(viewer, await row(mb.id))).rejects.toMatchObject({ code: 'permission_denied' });
    const r = await row(mb.id);
    expect(r.imapConsecutiveFailures).toBe(0);
    expect(r.lastError).toBeNull();
    expect(provider.fetchCalls).toBe(0);
  });
});

// ---- markMailboxFailing ---------------------------------------------

describe('markMailboxFailing (F-04)', () => {
  it('dedupes while unread; a read notification is raised again by the next failure', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const failure = { protocol: 'imap' as const, message: 'Socket timed out after 20000ms' };

    expect((await markMailboxFailing(s.c, mb.id, failure)).notified).toBe(true);
    expect((await markMailboxFailing(s.c, mb.id, failure)).notified).toBe(false);
    let notes = await failingNotices(s.workspaceId);
    expect(notes).toHaveLength(1);

    await markNotificationsRead(s.c, [notes[0]!.id]);
    expect((await markMailboxFailing(s.c, mb.id, failure)).notified).toBe(true);
    notes = await failingNotices(s.workspaceId);
    expect(notes).toHaveLength(2);
    expect(notes.filter((n) => n.readAt === null)).toHaveLength(1);
  });

  it('the gate grows with the age of the episode, capped at 24 h; repeats keep failing_since', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const failure = { protocol: 'imap' as const, message: 'Socket timed out after 20000ms' };

    await markMailboxFailing(s.c, mb.id, failure);
    expectGate(await row(mb.id), HOUR);

    const fiveHoursAgo = new Date(Date.now() - 5 * HOUR);
    await db.update(mailboxes).set({ failingSince: fiveHoursAgo }).where(eq(mailboxes.id, mb.id));
    await markMailboxFailing(s.c, mb.id, failure);
    let r = await row(mb.id);
    expectGate(r, 5 * HOUR);
    expect(r.failingSince!.getTime()).toBe(fiveHoursAgo.getTime());

    const threeDaysAgo = new Date(Date.now() - 72 * HOUR);
    await db.update(mailboxes).set({ failingSince: threeDaysAgo }).where(eq(mailboxes.id, mb.id));
    await markMailboxFailing(s.c, mb.id, failure);
    r = await row(mb.id);
    expectGate(r, 24 * HOUR);
    expect(r.failingSince!.getTime()).toBe(threeDaysAgo.getTime());
  });

  it('a refused SMTP connection on 587 explains that 465 (TLS on connect) is the fix', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    await markMailboxFailing(s.c, mb.id, {
      protocol: 'smtp',
      message: 'connect ECONNREFUSED 51.89.234.14:587',
    });
    const r = await row(mb.id);
    expect(r.lastError).toBe('SMTP: connect ECONNREFUSED 51.89.234.14:587');
    expectGate(r, HOUR);
    const [note] = await failingNotices(s.workspaceId);
    expect(note!.body).toContain('port 465');
    expect(note!.body).toContain('Nothing can be sent from it');
    expect(note!.body).toContain('No recipient was suppressed.');
  });

  it('leaves paused mailboxes and other workspaces alone', async () => {
    const s = await setup();
    const other = await setup('f04-other');
    const mb = await makeMailbox(s);
    const failure = { protocol: 'imap' as const, message: 'x' };

    expect(await markMailboxFailing(other.c, mb.id, failure)).toMatchObject({ marked: false });
    expect((await row(mb.id)).status).toBe('active');

    await pauseMailbox(s.c, mb.id);
    expect(await markMailboxFailing(s.c, mb.id, failure)).toMatchObject({ marked: false, notified: false });
    expect((await row(mb.id)).status).toBe('paused');
    expect(await failingNotices(s.workspaceId)).toHaveLength(0);
    expect(await failingNotices(other.workspaceId)).toHaveLength(0);
  });

  it('Reactivate ends the episode and resolves the notification', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    await markMailboxFailing(s.c, mb.id, { protocol: 'imap', message: 'x' });
    await reactivateMailbox(s.c, mb.id);
    const r = await row(mb.id);
    expect(r).toMatchObject({ status: 'active', lastError: null, lastErrorAt: null, failingSince: null });
    const notes = await failingNotices(s.workspaceId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.readAt).not.toBeNull();
  });
});

// ---- Test again -------------------------------------------------------

describe('testMailboxConnection / Test again (F-04)', () => {
  it('a failed test marks the mailbox failing with a gate, the error and one notification', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    provider.test = {
      smtp: { ok: false, detail: 'connect ECONNREFUSED 51.89.234.14:587' },
      imap: { ok: true },
    };
    await testMailboxConnection(s.c, mb.id);
    await testMailboxConnection(s.c, mb.id);
    const r = await row(mb.id);
    expect(r.status).toBe('failing');
    expect(r.lastError).toBe('SMTP: connect ECONNREFUSED 51.89.234.14:587');
    expect(r.lastErrorAt).not.toBeNull();
    expect(r.imapNextSyncAfter).not.toBeNull();
    expect(await failingNotices(s.workspaceId)).toHaveLength(1);
  });

  it('a passing test recovers a failing mailbox but never un-pauses a paused one', async () => {
    const s = await setup();
    const failing = await makeMailbox(s, 'failing-box');
    const paused = await makeMailbox(s, 'paused-box');
    await markMailboxFailing(s.c, failing.id, { protocol: 'smtp', message: 'Invalid login: 535 5.7.8' });
    await pauseMailbox(s.c, paused.id);
    await db
      .update(mailboxes)
      .set({ lastError: 'IMAP: old', lastErrorAt: new Date() })
      .where(eq(mailboxes.id, paused.id));

    provider.test = HEALTHY;
    await testMailboxConnection(s.c, failing.id);
    await testMailboxConnection(s.c, paused.id);

    expect(await row(failing.id)).toMatchObject({ status: 'active', lastError: null, imapNextSyncAfter: null });
    expect(await row(paused.id)).toMatchObject({ status: 'paused', lastError: null, lastErrorAt: null });
    const [note] = await failingNotices(s.workspaceId);
    expect(note!.readAt).not.toBeNull();
  });
});

// ---- IMAP tick ---------------------------------------------------------

describe('runImapTick (F-04)', () => {
  /** Prod as found (X7): failing rows with no gate, errors from before F-04. */
  async function legacyProd() {
    const ws1 = await setup('ws1');
    const ws2 = await setup('ws2');
    await db.update(workspaces).set({ imapAutoSyncEnabled: false }).where(eq(workspaces.id, ws2.workspaceId));
    const mb1 = await makeMailbox(ws1, 'kensington');
    const mb2 = await makeMailbox(ws2, 'wandizz');
    const may8 = new Date('2026-05-08T10:00:00Z');
    await db
      .update(mailboxes)
      .set({
        status: 'failing',
        lastError: 'SMTP connect ECONNREFUSED 51.89.234.14:587',
        lastErrorAt: may8,
        failingSince: may8,
        imapNextSyncAfter: null,
      })
      .where(eq(mailboxes.id, mb1.id));
    await db
      .update(mailboxes)
      .set({
        status: 'failing',
        lastError: 'Command failed',
        imapConsecutiveFailures: 13,
        imapNextSyncAfter: null,
      })
      .where(eq(mailboxes.id, mb2.id));
    return { ws1, ws2, mb1, mb2, may8 };
  }

  it('announces every failing mailbox within one tick without touching the servers, then stays quiet', async () => {
    const { ws1, ws2, mb1, mb2, may8 } = await legacyProd();

    const first = await runImapTick();
    expect(first.adopted).toBe(2);
    expect(provider.testCalls).toBe(0);
    expect(provider.fetchCalls).toBe(0);

    const n1 = await failingNotices(ws1.workspaceId);
    const n2 = await failingNotices(ws2.workspaceId);
    expect(n1).toHaveLength(1);
    expect(n2).toHaveLength(1);
    expect(n1[0]!.href).toBe(`/mailbox/${mb1.id}`);
    expect(n1[0]!.body).toContain('port 465');
    expect(n2[0]!.title).toBe('Mailbox "wandizz" is failing');

    const r1 = await row(mb1.id);
    expect(r1.lastError).toBe('SMTP: connect ECONNREFUSED 51.89.234.14:587');
    expect(r1.lastErrorAt!.getTime()).toBe(may8.getTime());
    expect(r1.failingSince!.getTime()).toBe(may8.getTime());
    // Failing since May: the re-check waits the 24 h cap.
    expectGate(r1, 24 * HOUR);
    expect((await row(mb2.id)).imapNextSyncAfter).not.toBeNull();

    const second = await runImapTick();
    expect(second.adopted).toBe(0);
    expect(provider.testCalls).toBe(0);
    expect(await failingNotices(ws1.workspaceId)).toHaveLength(1);
    expect(await failingNotices(ws2.workspaceId)).toHaveLength(1);
  });

  it('re-checks a failing mailbox once its gate passes (auto-sync workspaces only) and recovers it', async () => {
    const { mb1, mb2, ws1 } = await legacyProd();
    await runImapTick();
    const past = new Date(Date.now() - MINUTE);
    await db.update(mailboxes).set({ imapNextSyncAfter: past }).where(eq(mailboxes.id, mb1.id));
    await db.update(mailboxes).set({ imapNextSyncAfter: past }).where(eq(mailboxes.id, mb2.id));

    provider.test = HEALTHY;
    const tick = await runImapTick();
    expect(tick).toMatchObject({ rechecked: 1, recovered: 1, mailboxesSynced: 1 });
    expect(provider.testCalls).toBe(1);
    expect(provider.fetchCalls).toBe(1);
    expect((await row(mb1.id)).status).toBe('active');
    // ws2 has IMAP auto-sync off: nobody touches its mailbox.
    expect((await row(mb2.id)).status).toBe('failing');
    const [note] = await failingNotices(ws1.workspaceId);
    expect(note!.readAt).not.toBeNull();
  });

  it('a failed re-check keeps the mailbox failing with a later gate and no second unread notification', async () => {
    const { mb1, ws1 } = await legacyProd();
    await runImapTick();
    await db
      .update(mailboxes)
      .set({ imapNextSyncAfter: new Date(Date.now() - MINUTE) })
      .where(eq(mailboxes.id, mb1.id));

    provider.test = { smtp: { ok: false, detail: 'connect ECONNREFUSED 51.89.234.14:587' }, imap: { ok: true } };
    const tick = await runImapTick();
    expect(tick).toMatchObject({ rechecked: 1, recovered: 0, failed: 1, markedFailing: 0 });
    const r = await row(mb1.id);
    expect(r.status).toBe('failing');
    expectGate(r, 24 * HOUR);
    expect(r.lastErrorAt!.getTime()).toBeGreaterThan(Date.now() - 5 * MINUTE);
    const notes = await failingNotices(ws1.workspaceId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.readAt).toBeNull();
  });

  it('syncs active mailboxes as before and records a failure gate for them', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    provider.fetchError = new Error('Socket timed out after 20000ms');
    const tick = await runImapTick();
    expect(tick).toMatchObject({ mailboxesSynced: 0, failed: 1, rechecked: 0 });
    const r = await row(mb.id);
    expect(r.status).toBe('active');
    expect(r.imapNextSyncAfter).not.toBeNull();
    // Gated: the next tick leaves it alone.
    await runImapTick();
    expect(provider.fetchCalls).toBe(1);
  });
});

// ---- who is told ---------------------------------------------------------

describe('mailbox.failing goes to workspace admins only (F-04)', () => {
  it('one row per owner / admin; managers, members and viewers see nothing', async () => {
    seq++;
    const ownerId = await seedUser({ email: `own-${seq}@test.local` });
    const adminId = await seedUser({ email: `adm-${seq}@test.local` });
    const managerId = await seedUser({ email: `mgr-${seq}@test.local` });
    const memberId = await seedUser({ email: `mem-${seq}@test.local` });
    const viewerId = await seedUser({ email: `view-${seq}@test.local` });
    const workspaceId = await seedWorkspace({
      name: `roles-${seq}`,
      ownerUserId: ownerId,
      extraMembers: [
        { userId: adminId, role: 'admin' },
        { userId: managerId, role: 'manager' },
        { userId: memberId, role: 'member' },
        { userId: viewerId, role: 'viewer' },
      ],
    });
    const s: Setup = { workspaceId, ownerId, c: ctx(workspaceId, ownerId) };
    const mb = await makeMailbox(s);
    const as = (userId: string, role: WorkspaceContext['role']) =>
      makeWorkspaceContext({ workspaceId, userId, role });

    const first = await markMailboxFailing(s.c, mb.id, {
      protocol: 'smtp',
      message: 'Invalid login: 535 5.7.8 Error: authentication failed',
    });
    expect(first.notified).toBe(true);
    let notes = await failingNotices(workspaceId);
    expect(notes.map((n) => n.userId).sort()).toEqual([adminId, ownerId].sort());
    for (const n of notes) {
      expect(n.dedupeKey).toBe(`mailbox.failing:${mb.id}:user:${n.userId}`);
    }
    for (const [userId, role] of [
      [managerId, 'manager'],
      [memberId, 'member'],
      [viewerId, 'viewer'],
    ] as const) {
      const seen = await listNotifications(as(userId, role));
      expect(seen.filter((n) => n.kind === 'mailbox.failing'), role).toHaveLength(0);
    }
    expect(
      (await listNotifications(as(adminId, 'admin'))).filter((n) => n.kind === 'mailbox.failing'),
    ).toHaveLength(1);

    // A repeat failure while both are unread adds nothing.
    const repeat = await markMailboxFailing(s.c, mb.id, { protocol: 'smtp', message: 'again' });
    expect(repeat.notified).toBe(false);
    expect(await failingNotices(workspaceId)).toHaveLength(2);

    // The admin reads theirs: the next failure re-notifies only them.
    const adminNote = notes.find((n) => n.userId === adminId)!;
    await markNotificationsRead(as(adminId, 'admin'), [adminNote.id]);
    const third = await markMailboxFailing(s.c, mb.id, { protocol: 'smtp', message: 'again' });
    expect(third.notified).toBe(true);
    notes = await failingNotices(workspaceId);
    expect(notes).toHaveLength(3);
    expect(notes.filter((n) => n.readAt === null).map((n) => n.userId).sort()).toEqual(
      [adminId, ownerId].sort(),
    );

    // Recovery resolves every admin's copy.
    provider.test = HEALTHY;
    await testMailboxConnection(s.c, mb.id);
    expect((await row(mb.id)).status).toBe('active');
    notes = await failingNotices(workspaceId);
    expect(notes.every((n) => n.readAt !== null)).toBe(true);
  });

  it('quotes at most 200 characters of the server error', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    await markMailboxFailing(s.c, mb.id, { protocol: 'imap', message: `Socket timed out ${'x'.repeat(600)}` });
    const [note] = await failingNotices(s.workspaceId);
    const quoted = note!.body!.split('Last error — ')[1]!;
    expect(quoted.length).toBeLessThanOrEqual(200);
    expect(quoted.startsWith('IMAP: Socket timed out')).toBe(true);
  });
});

// ---- health check -------------------------------------------------------

describe('health check: failing mailboxes (F-04)', () => {
  it('lists every failing mailbox by name with a fix link, and says accurately that none is active', async () => {
    const s = await setup();
    const a = await makeMailbox(s, 'alpha');
    const b = await makeMailbox(s, 'beta');
    const p = await makeMailbox(s, 'gamma');
    await markMailboxFailing(s.c, a.id, { protocol: 'smtp', message: 'connect ECONNREFUSED 51.89.234.14:587' });
    await markMailboxFailing(s.c, b.id, { protocol: 'imap', message: 'Command failed: [AUTHENTICATIONFAILED] Authentication failed.' });
    await pauseMailbox(s.c, p.id);

    const findings = await collectRuleFindings(s.c);
    const failing = findings.filter((f) => f.code === 'mailbox.failing');
    expect(failing).toHaveLength(2);
    expect(failing.map((f) => f.href)).toEqual([`/mailbox/${a.id}`, `/mailbox/${b.id}`]);
    // AP-06: a failing mailbox is critical — its inbox is not read.
    expect(failing[0]!.severity).toBe('critical');
    expect(failing[0]!.message).toContain('Mailbox "alpha" is failing. It has been failing since');
    expect(failing[0]!.message).toContain('port 465');
    expect(failing[1]!.message).toContain('Mailbox "beta"');
    expect(failing[1]!.message).toContain('refused the login');

    const none = findings.find((f) => f.code === 'mailbox.none');
    expect(none?.message).toContain('failing or paused');
    expect(none?.message).toContain('queued on a failing mailbox are held');
    // PC-05 (P0-F08): a paused mailbox now holds its due sends too.
    expect(none?.message).toContain('on a paused mailbox are held (not sent, not failed)');
    expect(none?.message).not.toContain('approved drafts cannot be sent');
    expect(none?.href).toBe('/mailbox');
  });

  it('only paused mailboxes: their due sends are held until re-enabled (PC-05, P0-F08)', async () => {
    const s = await setup();
    const p = await makeMailbox(s, 'resting');
    await pauseMailbox(s.c, p.id);
    const none = (await collectRuleFindings(s.c)).find((f) => f.code === 'mailbox.none');
    expect(none?.message).toContain('(each one is paused)');
    expect(none?.message).toContain('held (not sent, not failed) until you re-enable it');
    expect(none?.message).not.toContain('marked failed');
    // Only a failing mailbox stops reading replies.
    expect(none?.message).not.toContain('queued on a failing mailbox');
  });

  it('only failing mailboxes: the queue is held', async () => {
    const s = await setup();
    const a = await makeMailbox(s, 'broken');
    await markMailboxFailing(s.c, a.id, { protocol: 'imap', message: 'Socket timed out' });
    const none = (await collectRuleFindings(s.c)).find((f) => f.code === 'mailbox.none');
    expect(none?.message).toContain('(each one is failing)');
    expect(none?.message).toContain('held until it works again');
    expect(none?.message).not.toContain('paused');
  });

  it('one failing mailbox among active ones is still reported, with no mailbox.none', async () => {
    const s = await setup();
    await makeMailbox(s, 'healthy');
    const bad = await makeMailbox(s, 'broken');
    await markMailboxFailing(s.c, bad.id, { protocol: 'imap', message: 'Socket timed out' });
    const findings = await collectRuleFindings(s.c);
    expect(findings.filter((f) => f.code === 'mailbox.failing').map((f) => f.href)).toEqual([`/mailbox/${bad.id}`]);
    expect(findings.some((f) => f.code === 'mailbox.none')).toBe(false);
  });
});
