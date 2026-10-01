// Server actions and stale sessions (review of the Phase 0 hotfixes).
//
// A session can stop resolving between rendering a form and submitting
// it: the user signed out elsewhere, an admin deactivated the account, or
// the user lost their last workspace. The new action modules called
// getWorkspaceContext() bare, so those users landed on Next's generic
// error page. requireActionContext() (src/lib/action-context.ts) sends
// them where the pages would: signed out to '/', inactive to '/pending',
// no workspace to the no-workspace screen on '/dashboard'.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { requireActionContext } from '@/lib/action-context';
import {
  addMemberAction,
  changeMemberRoleAction,
  removeMemberAction,
} from '@/app/settings/members/actions';
import { saveFollowUp } from '@/app/settings/outreach/follow-up-actions';
import { saveReplyAutoActions } from '@/app/settings/outreach/actions';
import {
  archiveCrmConnectionAction,
  restoreCrmConnectionAction,
  saveCrmConnectionAction,
  testCrmConnectionAction,
} from '@/app/settings/crm/[id]/actions';
import {
  deleteMailboxMessages,
  restoreMailboxMessages,
  retryMailboxMessages,
  spamMailboxMessages,
  trashMailboxMessages,
  unspamMailboxMessages,
} from '@/app/mailbox/[id]/actions';
import {
  cancelQueuedEmailAction,
  drainSendQueueAction,
  rescheduleQueuedEmailAction,
  saveSendSettingsAction,
} from '@/app/mailbox/queue/actions';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect } from './helpers/next-render';

type AccountStatus = 'pending' | 'active' | 'suspended' | 'rejected';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member' | 'super_admin'; accountStatus: AccountStatus };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));

function signInAs(userId: string, accountStatus: AccountStatus = 'active'): void {
  session.current = { user: { id: userId, role: 'member', accountStatus } };
}

function form(fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Every workspace action added or moved by the Phase 0 lanes (hotfixes,
 *  and mail-safety's reply auto-actions), with input that gets past any
 *  parsing done before the context is resolved. */
const ACTIONS: ReadonlyArray<[string, () => Promise<unknown>]> = [
  ['settings/members add', () => addMemberAction(form({ userId: 'u', role: 'member' }))],
  ['settings/members change role', () => changeMemberRoleAction(form({ userId: 'u', role: 'member' }))],
  ['settings/members remove', () => removeMemberAction(form({ userId: 'u' }))],
  ['settings/outreach follow-up', () => saveFollowUp(form())],
  ['settings/outreach reply auto-actions', () => saveReplyAutoActions(form())],
  ['settings/crm save', () => saveCrmConnectionAction('1', form({ name: 'CRM' }))],
  ['settings/crm test', () => testCrmConnectionAction('1')],
  ['settings/crm archive', () => archiveCrmConnectionAction('1')],
  ['settings/crm restore', () => restoreCrmConnectionAction('1')],
  ['mailbox trash', () => trashMailboxMessages('1', form())],
  ['mailbox restore', () => restoreMailboxMessages('1', form())],
  ['mailbox spam', () => spamMailboxMessages('1', form())],
  ['mailbox not-spam', () => unspamMailboxMessages('1', form())],
  ['mailbox delete', () => deleteMailboxMessages('1', form())],
  ['mailbox retry', () => retryMailboxMessages('1', form())],
  ['mailbox/queue settings', () => saveSendSettingsAction(form())],
  ['mailbox/queue cancel', () => cancelQueuedEmailAction(form({ id: '1' }))],
  ['mailbox/queue reschedule', () => rescheduleQueuedEmailAction(form({ id: '1' }))],
  ['mailbox/queue drain', () => drainSendQueueAction(form())],
];

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('requireActionContext', () => {
  it('returns the context of an active member', async () => {
    const owner = await seedUser({ email: 'owner@test.local' });
    const workspaceId = await seedWorkspace({ name: 'Acme', ownerUserId: owner });
    signInAs(owner);
    const ctx = await requireActionContext();
    expect(ctx.workspaceId).toBe(workspaceId);
    expect(ctx.userId).toBe(owner);
  });

  it('sends a signed-out visitor to sign in', async () => {
    expect(await expectRedirect(() => requireActionContext())).toBe('/');
  });

  it.each(['pending', 'suspended', 'rejected'] as const)(
    'sends a %s account to /pending',
    async (status) => {
      const user = await seedUser({ email: `${status}@test.local`, accountStatus: status });
      signInAs(user, status);
      expect(await expectRedirect(() => requireActionContext())).toBe('/pending');
    },
  );

  it('sends a user without a workspace to the no-workspace screen', async () => {
    const user = await seedUser({ email: 'alone@test.local' });
    signInAs(user);
    expect(await expectRedirect(() => requireActionContext())).toBe('/dashboard');
  });
});

describe('lane actions redirect a stale session instead of erroring', () => {
  it.each(ACTIONS)('%s: no workspace -> /dashboard', async (_name, run) => {
    const user = await seedUser({ email: 'alone@test.local' });
    signInAs(user);
    expect(await expectRedirect(run)).toBe('/dashboard');
  });

  it.each(ACTIONS)('%s: account suspended -> /pending', async (_name, run) => {
    const owner = await seedUser({ email: 'owner@test.local', accountStatus: 'suspended' });
    await seedWorkspace({ name: 'Acme', ownerUserId: owner });
    signInAs(owner, 'suspended');
    expect(await expectRedirect(run)).toBe('/pending');
  });

  it.each(ACTIONS)('%s: signed out -> /', async (_name, run) => {
    expect(await expectRedirect(run)).toBe('/');
  });
});
