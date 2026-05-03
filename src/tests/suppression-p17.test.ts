import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { upsertContact } from '@/lib/services/contacts';
import {
  addSuppression,
  isSuppressed,
  listSuppressions,
  recordBounce,
  removeSuppression,
} from '@/lib/services/suppression';
import { renderSignatureHtml, renderSignatureText } from '@/lib/services/signatures';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ kind-aware suppression ===============================

describe('suppression kinds (email/domain/company)', () => {
  it('domain suppression blocks every address in that domain', async () => {
    const s = await setup();
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      kind: 'domain',
      value: 'BlockedCo.com',
      reason: 'manual',
    });
    expect(
      await isSuppressed(ctx(s.workspaceA, s.ownerA), 'anyone@blockedco.com'),
    ).toBe(true);
    expect(
      await isSuppressed(ctx(s.workspaceA, s.ownerA), 'someone@otherco.com'),
    ).toBe(false);
  });

  it('company suppression blocks emails of contacts at that company', async () => {
    const s = await setup();
    await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'anna@personal.com',
      companyName: 'Acme Inc',
    });
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      kind: 'company',
      value: 'Acme Inc',
      reason: 'manual',
    });
    expect(
      await isSuppressed(ctx(s.workspaceA, s.ownerA), 'anna@personal.com'),
    ).toBe(true);
    // No contact attached -> not suppressed.
    expect(
      await isSuppressed(ctx(s.workspaceA, s.ownerA), 'unrelated@personal.com'),
    ).toBe(false);
  });

  it('email-kind suppression still works (back-compat path)', async () => {
    const s = await setup();
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'No.Send@Example.com',
      reason: 'unsubscribe',
    });
    expect(
      await isSuppressed(ctx(s.workspaceA, s.ownerA), 'no.send@example.com'),
    ).toBe(true);
  });

  it('rejects invalid domain shape', async () => {
    const s = await setup();
    await expect(
      addSuppression(ctx(s.workspaceA, s.ownerA), {
        kind: 'domain',
        value: 'not_a_domain',
        reason: 'manual',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('listSuppressions filters by kind', async () => {
    const s = await setup();
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      kind: 'domain',
      value: 'a.com',
      reason: 'manual',
    });
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'x@b.com',
      reason: 'manual',
    });
    const onlyDomains = await listSuppressions(
      ctx(s.workspaceA, s.ownerA),
      { kind: 'domain' },
    );
    expect(onlyDomains.map((e) => e.value)).toEqual(['a.com']);
  });

  it('removeSuppression accepts a row id', async () => {
    const s = await setup();
    const e = await addSuppression(ctx(s.workspaceA, s.ownerA), {
      kind: 'domain',
      value: 'gone.com',
      reason: 'manual',
    });
    await removeSuppression(ctx(s.workspaceA, s.ownerA), e.id);
    const list = await listSuppressions(ctx(s.workspaceA, s.ownerA));
    expect(list).toHaveLength(0);
  });
});

// ============ recordBounce ==========================================

describe('recordBounce', () => {
  it('hard bounce creates a permanent email suppression', async () => {
    const s = await setup();
    await recordBounce(ctx(s.workspaceA, s.ownerA), 'gone@x.com', 'hard', 'mailbox unavailable');
    expect(await isSuppressed(ctx(s.workspaceA, s.ownerA), 'gone@x.com')).toBe(true);
    const all = await listSuppressions(ctx(s.workspaceA, s.ownerA));
    expect(all[0]!.expiresAt).toBe(null);
    expect(all[0]!.reason).toBe('bounce_hard');
  });

  it('soft bounce sets a 7-day TTL', async () => {
    const s = await setup();
    const start = Date.now();
    await recordBounce(ctx(s.workspaceA, s.ownerA), 'maybe@x.com', 'soft', '4xx response');
    const all = await listSuppressions(ctx(s.workspaceA, s.ownerA));
    const ttl = all[0]!.expiresAt!.getTime() - start;
    // ~7 days, with a couple of seconds of slack.
    expect(ttl).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(ttl).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    expect(all[0]!.reason).toBe('bounce_soft');
  });
});

// ============ renderSignatureHtml ===================================

describe('renderSignatureHtml', () => {
  function blank() {
    return {
      bodyText: '',
      bodyHtml: null,
      greeting: null,
      fullName: null,
      title: null,
      company: null,
      tagline: null,
      website: null,
      email: null,
      phones: [],
      logoStorageKey: null,
    } as const;
  }

  it('falls back to bodyHtml verbatim when present', () => {
    const out = renderSignatureHtml({
      ...blank(),
      bodyText: 'fallback',
      bodyHtml: '<p>custom html</p>',
    });
    expect(out).toBe('<p>custom html</p>');
  });

  it('falls back to bodyText pre-block when no structured fields', () => {
    const out = renderSignatureHtml({
      ...blank(),
      bodyText: '— Sales\nteam',
    });
    expect(out).toContain('— Sales');
    expect(out.startsWith('<pre')).toBe(true);
  });

  it('renders structured fields with brand colour + tel/mailto links', () => {
    const out = renderSignatureHtml({
      ...blank(),
      bodyText: 'unused',
      greeting: 'Pozdrawiam,',
      fullName: 'Anna Kowalska',
      title: 'COO',
      company: 'Acme Inc',
      tagline: 'glass that works',
      website: 'https://acme.example',
      email: 'anna@acme.example',
      phones: [{ label: 'mob', number: '+48 555 123 456' }],
    });
    expect(out).toContain('Anna Kowalska');
    expect(out).toContain('Acme Inc');
    expect(out).toContain('mailto:anna@acme.example');
    expect(out).toContain('tel:+48 555 123 456');
    expect(out).toContain('Pozdrawiam,');
  });

  it('escapes user-provided html in fields', () => {
    const out = renderSignatureHtml({
      ...blank(),
      bodyText: 'unused',
      fullName: 'Anna <script>alert(1)</script>',
      email: 'a@b.c',
    });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('uses logoUrl when supplied', () => {
    const out = renderSignatureHtml(
      {
        ...blank(),
        bodyText: 'unused',
        fullName: 'Anna',
        company: 'Acme',
        logoStorageKey: 'workspaces/1/logo.png',
      },
      'https://cdn.example/logo.png',
    );
    expect(out).toContain('<img src="https://cdn.example/logo.png"');
  });
});

describe('renderSignatureText', () => {
  it('returns bodyText when set', () => {
    expect(
      renderSignatureText({
        bodyText: '— Anna',
        greeting: null,
        fullName: 'X',
        title: null,
        company: null,
        tagline: null,
        website: null,
        email: null,
        phones: [],
      }),
    ).toBe('— Anna');
  });

  it('composes from structured fields when bodyText is empty', () => {
    const out = renderSignatureText({
      bodyText: '',
      greeting: 'Cheers',
      fullName: 'Anna',
      title: 'COO',
      company: 'Acme',
      tagline: null,
      website: 'https://acme.example',
      email: 'a@acme.example',
      phones: [{ label: 'mob', number: '+48 555' }],
    });
    expect(out.split('\n')).toEqual([
      'Cheers',
      'Anna',
      'COO',
      'Acme',
      'https://acme.example',
      'a@acme.example',
      'mob: +48 555',
    ]);
  });
});
