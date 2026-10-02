// /mailbox/queue: who sees the send-settings form, what a failed action
// shows, and how times are labelled (audit I159, deliverable ia:F-02).
//
// Before the fix the page checked canAdminWorkspace() against a
// hard-coded 'admin' role, so every member saw the settings form and
// the emergency-pause switch. Saving as a member hit updateSendSettings'
// permission check with no catch, and the user got Next's generic error
// page. Cancel and reschedule had the same missing catch. These tests
// render the page per role and run the actions from
// src/app/(app)/mailbox/queue/actions.ts against the database.

import { pauseAutomation } from '@/lib/services/automation-pause';
import { PAUSED_MESSAGE } from '@/lib/services/automation-gate';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailboxes } from '@/lib/db/schema/mailing';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { makeWorkspaceContext } from '@/lib/services/context';
import { workspaceMembers, type WorkspaceMemberRole } from '@/lib/db/schema/workspaces';
import { OutreachQueueError, getSendSettings } from '@/lib/services/outreach-queue';
import * as queueActions from '@/app/(app)/mailbox/queue/actions';
import {
  formatUtc,
  parseEntryId,
  parseQueueView,
  parseSendSettingsForm,
  parseUtcDateTimeLocal,
  queueErrorMessage,
  queueHref,
  toUtcInputValue,
} from '@/app/(app)/mailbox/queue/forms';
import QueuePage from '@/app/(app)/mailbox/queue/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { postedFromCurrentPage } from './helpers/workspace-guard';
import { expectRedirect, renderToHtml } from './helpers/next-render';

// Sign in through a plain session object instead of Auth.js;
// getWorkspaceContext() stays real, so the role comes from
// workspace_members exactly as in production.
const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

// MOB-06: the actions are guarded; each call posts from the page the
// signed-in user would see right now (their current workspace).
const currentUser = () => session.current?.user;
const cancelQueuedEmailAction = postedFromCurrentPage(queueActions.cancelQueuedEmailAction, currentUser);
const drainSendQueueAction = postedFromCurrentPage(queueActions.drainSendQueueAction, currentUser);
const rescheduleQueuedEmailAction = postedFromCurrentPage(queueActions.rescheduleQueuedEmailAction, currentUser);
const saveSendSettingsAction = postedFromCurrentPage(queueActions.saveSendSettingsAction, currentUser);

function signInAs(userId: string): void {
  session.current = { user: { id: userId, role: 'member', accountStatus: 'active' } };
}

/** Decode a redirect target into path + query for readable assertions. */
function parseTarget(target: string): { path: string; query: Record<string, string> } {
  const url = new URL(target, 'http://app.test');
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

function settingsForm(overrides: Record<string, string | undefined> = {}): FormData {
  const values: Record<string, string | undefined> = {
    dailyEmailLimit: '120',
    domainCooldownHours: '12',
    defaultDelayMode: 'fixed',
    fixedDelayMinutes: '20',
    randomDelayMinMinutes: '3',
    randomDelayMaxMinutes: '9',
    ...overrides,
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) fd.set(k, v);
  return fd;
}

function entryForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// Far enough ahead that a drain never finds it due.
const SCHEDULED = new Date(Date.UTC(2099, 9, 1, 14, 30));

async function seedQueuedEmail(workspaceId: bigint, subject: string) {
  const [mailbox] = await db
    .insert(mailboxes)
    .values({
      workspaceId,
      name: `sales-${subject}`,
      fromAddress: `sales-${workspaceId}@nulife.test`,
      smtpHost: 'smtp.example.test',
      smtpUser: `sales-${workspaceId}@nulife.test`,
      smtpPasswordSecretKey: 'mailbox.smtpPassword_fixedfortests',
      imapFolder: 'INBOX',
      status: 'active',
    })
    .returning();
  const [entry] = await db
    .insert(outreachQueue)
    .values({
      workspaceId,
      mailboxId: mailbox!.id,
      toAddresses: ['anna@target.test'],
      subject,
      bodyText: 'Hello',
      status: 'queued',
      delayMode: 'fixed',
      scheduledSendAt: SCHEDULED,
    })
    .returning();
  return entry!;
}

async function loadEntry(id: bigint) {
  const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
  return row!;
}

interface Fixture {
  workspaceId: bigint;
  users: Record<'owner' | WorkspaceMemberRole, string>;
  entryId: bigint;
}

async function setup(): Promise<Fixture> {
  const owner = await seedUser({ email: 'owner@test.local' });
  const admin = await seedUser({ email: 'admin@test.local' });
  const manager = await seedUser({ email: 'manager@test.local' });
  const member = await seedUser({ email: 'member@test.local' });
  const viewer = await seedUser({ email: 'viewer@test.local' });
  const workspaceId = await seedWorkspace({
    name: 'Queue',
    ownerUserId: owner,
    extraMembers: [
      { userId: admin, role: 'admin' },
      { userId: manager, role: 'manager' },
      { userId: member, role: 'member' },
      { userId: viewer, role: 'viewer' },
    ],
  });
  const entry = await seedQueuedEmail(workspaceId, 'Intro to Acme');
  return { workspaceId, users: { owner, admin, manager, member, viewer }, entryId: entry.id };
}

async function renderQueue(sp: { status?: string; message?: string; error?: string } = {}) {
  const tree = await QueuePage({ searchParams: Promise.resolve(sp) });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- pure helpers -------------------------------------------------------

describe('queue form helpers', () => {
  it('parses a complete settings form', () => {
    const fd = settingsForm();
    fd.set('emergencyPause', 'on');
    expect(parseSendSettingsForm(fd)).toEqual({
      ok: true,
      value: {
        dailyEmailLimit: 120,
        domainCooldownHours: 12,
        defaultDelayMode: 'fixed',
        fixedDelayMinutes: 20,
        randomDelayMinMinutes: 3,
        randomDelayMaxMinutes: 9,
      },
    });
    // PC-05: the form no longer carries a pause; a stray field is ignored
    // (pausing is the workspace pause control).
    const parsed = parseSendSettingsForm(settingsForm({ emergencyPause: 'on' }));
    expect(parsed.ok && 'emergencyPause' in parsed.value).toBe(false);
  });

  it.each([
    [{ dailyEmailLimit: 'abc' }, 'Daily email limit must be a whole number (0 or more).'],
    [{ dailyEmailLimit: '-5' }, 'Daily email limit must be a whole number (0 or more).'],
    [{ dailyEmailLimit: '' }, 'Daily email limit is required.'],
    [{ dailyEmailLimit: undefined }, 'Daily email limit is required.'],
    [{ dailyEmailLimit: '10001' }, 'Daily email limit can be at most 10,000.'],
    [{ domainCooldownHours: '721' }, 'Domain cooldown hours can be at most 720.'],
    [{ fixedDelayMinutes: '2.5' }, 'Fixed delay must be a whole number (0 or more).'],
    [{ defaultDelayMode: 'whenever' }, 'Choose a delay mode: immediate, fixed or random.'],
    [
      { randomDelayMinMinutes: '30', randomDelayMaxMinutes: '10' },
      'Random min cannot be more than random max.',
    ],
  ])('rejects %o with a readable message', (overrides, message) => {
    expect(parseSendSettingsForm(settingsForm(overrides))).toEqual({ ok: false, error: message });
  });

  it('reads datetime-local values as UTC and rejects impossible dates', () => {
    expect(parseUtcDateTimeLocal('2026-10-01T14:30')).toEqual(
      new Date(Date.UTC(2026, 9, 1, 14, 30)),
    );
    expect(parseUtcDateTimeLocal('2026-10-01T14:30:15')).toEqual(
      new Date(Date.UTC(2026, 9, 1, 14, 30, 15)),
    );
    expect(parseUtcDateTimeLocal('2026-06-31T10:00')).toBeNull();
    expect(parseUtcDateTimeLocal('2026-10-01T25:00')).toBeNull();
    expect(parseUtcDateTimeLocal('next tuesday')).toBeNull();
    expect(parseUtcDateTimeLocal('')).toBeNull();
    expect(parseUtcDateTimeLocal(null)).toBeNull();
  });

  it('formats times in UTC and round-trips through the reschedule input', () => {
    const d = new Date(Date.UTC(2026, 9, 1, 14, 30));
    expect(formatUtc(d)).toBe('2026-10-01 14:30 UTC');
    expect(toUtcInputValue(d)).toBe('2026-10-01T14:30');
    expect(parseUtcDateTimeLocal(toUtcInputValue(d))).toEqual(d);
  });

  it('accepts only known views and positive integer ids', () => {
    expect(parseQueueView('failed')).toBe('failed');
    expect(parseQueueView('all')).toBe('all');
    expect(parseQueueView('javascript:alert(1)')).toBe('queued');
    expect(parseQueueView(null)).toBe('queued');
    expect(parseEntryId('42')).toBe(42n);
    expect(parseEntryId('0')).toBeNull();
    expect(parseEntryId('-1')).toBeNull();
    expect(parseEntryId('1e3')).toBeNull();
    expect(parseEntryId(null)).toBeNull();
  });

  it('builds queue links that keep the view and encode the flash', () => {
    expect(queueHref('queued')).toBe('/mailbox/queue');
    expect(queueHref('failed', { kind: 'error', text: 'a & b' })).toBe(
      '/mailbox/queue?status=failed&error=a+%26+b',
    );
  });

  it('maps service errors to operator wording', () => {
    const e = (code: string) => new OutreachQueueError(`dev text for ${code}`, code);
    expect(queueErrorMessage(e('permission_denied'), 'settings')).toBe(
      'Only workspace admins can change the send settings.',
    );
    expect(queueErrorMessage(e('permission_denied'), 'cancel')).toBe(
      'Your role can view the send queue but not change it.',
    );
    expect(queueErrorMessage(e('not_found'), 'reschedule')).toBe(
      'That email is no longer in the queue.',
    );
    expect(queueErrorMessage(e('conflict'), 'cancel')).toMatch(/no longer waiting to be sent/);
    expect(queueErrorMessage(e('invalid_input'), 'drain')).toBe('dev text for invalid_input');
    expect(queueErrorMessage(new Error('connection reset'), 'settings')).toBe(
      'Could not save the send settings. Please try again.',
    );
  });
});

// ---- page -----------------------------------------------------------

describe('/mailbox/queue page', () => {
  it.each(['owner', 'admin'] as const)('shows the send-settings form to an %s', async (role) => {
    const f = await setup();
    signInAs(f.users[role]);

    const html = await renderQueue();

    expect(html).toContain('name="dailyEmailLimit"');
    // PC-05: the pause is its own control, not a field of this form.
    expect(html).not.toContain('name="emergencyPause"');
    expect(html).toContain('Pause all automation');
    expect(html).toContain('Save settings');
    expect(html).not.toContain('Only workspace admins can change these settings.');
  });

  it.each(['manager', 'member', 'viewer'] as const)(
    'shows a %s the settings read-only, without the form',
    async (role) => {
      const f = await setup();
      signInAs(f.users[role]);

      const html = await renderQueue();

      expect(html).not.toContain('name="dailyEmailLimit"');
      expect(html).not.toContain('name="emergencyPause"');
      expect(html).not.toContain('Save settings');
      expect(html).toContain(
        'Up to 50 emails a day, 24 h between emails to the same domain, a random 5–30-minute delay before sending.',
      );
      expect(html).toContain('Only workspace admins can change these settings.');
    },
  );

  it('lets a member act on queued emails but gives a viewer a read-only list', async () => {
    const f = await setup();

    signInAs(f.users.member);
    const memberHtml = await renderQueue();
    expect(memberHtml).toContain('Send due emails now');
    expect(memberHtml).toContain('Cancel');
    expect(memberHtml).toContain('Reschedule (UTC)');

    signInAs(f.users.viewer);
    const viewerHtml = await renderQueue();
    expect(viewerHtml).toContain('Intro to Acme');
    expect(viewerHtml).not.toContain('Send due emails now');
    expect(viewerHtml).not.toContain('name="scheduledSendAt"');
    expect(viewerHtml).not.toContain('>Cancel<');
  });

  it('labels every time UTC and pre-fills the reschedule input in UTC', async () => {
    const f = await setup();
    signInAs(f.users.member);

    const html = await renderQueue();

    expect(html).toContain('All times are in UTC.');
    expect(html).toContain('scheduled 2099-10-01 14:30 UTC');
    expect(html).toContain('value="2099-10-01T14:30"');
  });

  it('PC-05: shows the workspace pause (who, what waits) without internal function names, and a member cannot resume', async () => {
    const f = await setup();
    await pauseAutomation(
      makeWorkspaceContext({ workspaceId: f.workspaceId, userId: f.users.member, role: 'member' }),
      { source: 'send_queue_page', reason: 'wrong list' },
    );
    signInAs(f.users.member);

    const html = await renderQueue();

    expect(html).toContain('Automation is paused');
    expect(html).toContain('Reason: wrong list');
    expect(html).toContain('1 queued email');
    expect(html).toContain('Only owners and admins can resume automation.');
    expect(html).not.toContain('Resume automation');
    expect(html).not.toContain('drainQueue');
    expect(html).not.toContain('no-op');

    signInAs(f.users.admin);
    expect(await renderQueue()).toContain('Resume automation');
  });

  it('carries the current view into every form so actions return to it', async () => {
    const f = await setup();
    signInAs(f.users.owner);

    const html = await renderQueue({ status: 'all' });

    // settings, send now, cancel, reschedule
    expect(html.match(/name="status" value="all"/g)).toHaveLength(4);
  });
});

// ---- actions --------------------------------------------------------

describe('/mailbox/queue actions', () => {
  it('saves the settings for an admin and says so', async () => {
    const f = await setup();
    signInAs(f.users.admin);
    const fd = settingsForm();

    const target = await expectRedirect(() => saveSendSettingsAction(fd));

    expect(parseTarget(target)).toEqual({
      path: '/mailbox/queue',
      query: { message: 'Send settings saved.' },
    });
    const s = await getSendSettings({ workspaceId: f.workspaceId });
    expect(s).toMatchObject({
      dailyEmailLimit: 120,
      domainCooldownHours: 12,
      defaultDelayMode: 'fixed',
      fixedDelayMinutes: 20,
      randomDelayMinMinutes: 3,
      randomDelayMaxMinutes: 9,
      updatedBy: f.users.admin,
    });
  });

  it.each(['manager', 'member', 'viewer'] as const)(
    'refuses a %s with a flash instead of an error page',
    async (role) => {
      const f = await setup();
      signInAs(f.users[role]);
      const fd = settingsForm();
      fd.set('emergencyPause', 'on');

      const target = await expectRedirect(() => saveSendSettingsAction(fd));

      expect(parseTarget(target).query).toEqual({
        error: 'Only workspace admins can change the send settings.',
      });
      const s = await getSendSettings({ workspaceId: f.workspaceId });
      expect(s.emergencyPause).toBe(false);
      expect(s.dailyEmailLimit).toBe(50);
    },
  );

  it('shows an invalid save as an error and changes nothing', async () => {
    const f = await setup();
    signInAs(f.users.owner);
    const fd = settingsForm({ dailyEmailLimit: 'lots', domainCooldownHours: '1' });
    fd.set('status', 'failed');

    const target = await expectRedirect(() => saveSendSettingsAction(fd));

    expect(parseTarget(target).query).toEqual({
      status: 'failed',
      error: 'Daily email limit must be a whole number (0 or more).',
    });
    const s = await getSendSettings({ workspaceId: f.workspaceId });
    expect(s.dailyEmailLimit).toBe(50);
    expect(s.domainCooldownHours).toBe(24);
  });

  it('cancels a queued email for a member', async () => {
    const f = await setup();
    signInAs(f.users.member);

    const target = await expectRedirect(() =>
      cancelQueuedEmailAction(entryForm({ id: f.entryId.toString(), status: 'all' })),
    );

    expect(parseTarget(target).query).toEqual({
      status: 'all',
      message: 'Email cancelled. It will not be sent.',
    });
    expect((await loadEntry(f.entryId)).status).toBe('cancelled');
  });

  it('explains why an email cannot be cancelled instead of crashing', async () => {
    const f = await setup();
    signInAs(f.users.member);
    await expectRedirect(() => cancelQueuedEmailAction(entryForm({ id: f.entryId.toString() })));

    const again = await expectRedirect(() =>
      cancelQueuedEmailAction(entryForm({ id: f.entryId.toString() })),
    );
    const bogus = await expectRedirect(() => cancelQueuedEmailAction(entryForm({ id: 'x' })));

    expect(parseTarget(again).query.error).toBe(
      'That email is no longer waiting to be sent: it has already been sent, cancelled or picked up for sending.',
    );
    expect(parseTarget(bogus).query.error).toBe('That email is no longer in the queue.');
  });

  it('cannot cancel another workspace’s email', async () => {
    const f = await setup();
    const outsider = await seedUser({ email: 'outsider@test.local' });
    await seedWorkspace({ name: 'Other', ownerUserId: outsider });
    signInAs(outsider);

    const target = await expectRedirect(() =>
      cancelQueuedEmailAction(entryForm({ id: f.entryId.toString() })),
    );

    expect(parseTarget(target).query.error).toBe('That email is no longer in the queue.');
    expect((await loadEntry(f.entryId)).status).toBe('queued');
  });

  it('refuses a viewer’s cancel with a flash', async () => {
    const f = await setup();
    signInAs(f.users.viewer);

    const target = await expectRedirect(() =>
      cancelQueuedEmailAction(entryForm({ id: f.entryId.toString() })),
    );

    expect(parseTarget(target).query.error).toBe(
      'Your role can view the send queue but not change it.',
    );
    expect((await loadEntry(f.entryId)).status).toBe('queued');
  });

  it('reschedules to the UTC time that was typed', async () => {
    const f = await setup();
    signInAs(f.users.member);

    const target = await expectRedirect(() =>
      rescheduleQueuedEmailAction(
        entryForm({ id: f.entryId.toString(), scheduledSendAt: '2099-11-02T08:15' }),
      ),
    );

    expect(parseTarget(target).query).toEqual({
      message: 'Rescheduled for 2099-11-02 08:15 UTC.',
    });
    expect((await loadEntry(f.entryId)).scheduledSendAt).toEqual(
      new Date(Date.UTC(2099, 10, 2, 8, 15)),
    );
  });

  it('rejects an invalid reschedule time and keeps the old one', async () => {
    const f = await setup();
    signInAs(f.users.member);

    const target = await expectRedirect(() =>
      rescheduleQueuedEmailAction(
        entryForm({ id: f.entryId.toString(), scheduledSendAt: '2099-02-30T08:15' }),
      ),
    );

    expect(parseTarget(target).query.error).toBe('Enter a valid date and time (UTC).');
    expect((await loadEntry(f.entryId)).scheduledSendAt).toEqual(SCHEDULED);
  });

  it('refuses a viewer’s reschedule with a flash', async () => {
    const f = await setup();
    signInAs(f.users.viewer);

    const target = await expectRedirect(() =>
      rescheduleQueuedEmailAction(
        entryForm({ id: f.entryId.toString(), scheduledSendAt: '2099-11-02T08:15' }),
      ),
    );

    expect(parseTarget(target).query.error).toBe(
      'Your role can view the send queue but not change it.',
    );
    expect((await loadEntry(f.entryId)).scheduledSendAt).toEqual(SCHEDULED);
  });

  it('send-now reports when nothing is due', async () => {
    const f = await setup();
    signInAs(f.users.member);

    const target = await expectRedirect(() => drainSendQueueAction(entryForm({})));

    expect(parseTarget(target).query.message).toBe(
      "Nothing was sent: no emails are due yet.",
    );
    expect((await loadEntry(f.entryId)).status).toBe('queued');
  });

  it('send-now says why nothing was sent while automation is paused (PC-05)', async () => {
    const f = await setup();
    signInAs(f.users.owner);
    await pauseAutomation(
      makeWorkspaceContext({ workspaceId: f.workspaceId, userId: f.users.owner, role: 'owner' }),
      { source: 'send_queue_page' },
    );

    const target = await expectRedirect(() => drainSendQueueAction(entryForm({})));

    expect(parseTarget(target).query.message).toBe(`Nothing was sent. ${PAUSED_MESSAGE}`);
  });

  it('refuses a viewer’s send-now with a flash', async () => {
    const f = await setup();
    signInAs(f.users.viewer);

    const target = await expectRedirect(() =>
      drainSendQueueAction(entryForm({ status: 'sent' })),
    );

    expect(parseTarget(target).query).toEqual({
      status: 'sent',
      error: 'Your role can view the send queue but not change it.',
    });
  });

  it('sends a signed-out user home', async () => {
    await setup();
    session.current = null;

    await expect(expectRedirect(() => saveSendSettingsAction(settingsForm()))).resolves.toBe('/');
  });

  it('keeps workspace membership authoritative over a role claim', async () => {
    // The member row, not the session, decides: demoting the admin takes
    // the form away on the next request.
    const f = await setup();
    await db
      .update(workspaceMembers)
      .set({ role: 'member' })
      .where(eq(workspaceMembers.userId, f.users.admin));
    signInAs(f.users.admin);

    const html = await renderQueue();
    const target = await expectRedirect(() => saveSendSettingsAction(settingsForm()));

    expect(html).not.toContain('name="dailyEmailLimit"');
    expect(parseTarget(target).query.error).toBe(
      'Only workspace admins can change the send settings.',
    );
  });
});
