// PC-06 — the thread reply route answers a held send with 409 and the
// gate's sentence (it names the hold and why), not a 500. Wiring test:
// session, context and the mail service are stubbed; sendMessage throws
// the real AutomationGateError the gate raises under a Sending hold.

import { describe, expect, it, vi } from 'vitest';
import { AutomationGateError } from '@/lib/services/automation-gate';

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
  sendMessage: async () => {
    throw new AutomationGateError({
      allowed: false,
      reason: 'hold',
      capability: 'sending',
      message: 'Sending is on hold (placed by the platform): spam complaints',
    });
  },
}));

import { POST } from '@/app/api/communication/reply/route';

describe('POST /api/communication/reply under a Sending hold', () => {
  it('answers 409 with the hold reason', async () => {
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
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'automation_held',
      reason: 'hold',
      detail: 'Sending is on hold (placed by the platform): spam complaints',
      // PC-05: a hold cannot be overridden by "send anyway" (the pause can).
      overridable: false,
    });
  });
});
