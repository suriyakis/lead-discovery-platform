// flow:F-05 — the thread reply route sends one-to-one mail (no bulk
// unsubscribe footer / List-Unsubscribe). Wiring test: the session, the
// workspace context and the mail service are stubbed; what is asserted is
// the input the route hands to sendMessage. sendMessage's own one-to-one
// behaviour is covered in mail-safety-f05.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ inputs: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'user-1' } }),
}));
vi.mock('@/lib/services/auth-context', () => ({
  AuthRequiredError: class AuthRequiredError extends Error {},
  NoWorkspaceError: class NoWorkspaceError extends Error {},
  getWorkspaceContext: async () => ({ workspaceId: 1n, userId: 'user-1', role: 'owner' }),
}));
vi.mock('@/lib/services/workspace', () => ({
  getWorkspaceNativeLanguage: async () => 'en',
}));
vi.mock('@/lib/services/mail', () => ({
  MailServiceError: class MailServiceError extends Error {
    code = 'stub';
  },
  sendMessage: async (_ctx: unknown, input: Record<string, unknown>) => {
    sent.inputs.push(input);
    return { messageId: '<stub@nulife.pl>', threadId: 7n };
  },
}));

import { POST } from '@/app/api/communication/reply/route';

beforeEach(() => {
  sent.inputs.length = 0;
});

describe('POST /api/communication/reply', () => {
  it('sends the reply in one-to-one mode', async () => {
    const res = await POST(
      new Request('http://localhost/api/communication/reply', {
        method: 'POST',
        // MOB-06: the composer sends its page's workspace (the stub's 1).
        headers: { 'Content-Type': 'application/json', 'x-expected-workspace': '1' },
        body: JSON.stringify({
          threadId: '1',
          mailboxId: '2',
          to: 'anna@target.com',
          subject: 'Re: Quick question',
          body: 'Tuesday works.',
          inReplyTo: '<prospect-1@target.com>',
          references: ['<prospect-1@target.com>'],
          signatureId: '__default__',
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(sent.inputs).toHaveLength(1);
    expect(sent.inputs[0]).toMatchObject({
      mode: 'one_to_one',
      inReplyTo: '<prospect-1@target.com>',
    });
  });
});
