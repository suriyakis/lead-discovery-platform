import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { decryptValue, encryptValue } from '@/lib/services/crypto';
import {
  SecretsServiceError,
  deleteSecret,
  getSecret,
  hasSecret,
  listSecretKeys,
  resolveProviderKey,
  setSecret,
} from '@/lib/services/secrets';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  managerA: string;
  viewerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const managerA = await seedUser({ email: 'managerA@test.local' });
  const viewerA = await seedUser({ email: 'viewerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({
    name: 'A',
    ownerUserId: ownerA,
    extraMembers: [
      { userId: managerA, role: 'manager' },
      { userId: viewerA, role: 'viewer' },
    ],
  });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, managerA, viewerA, ownerB };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'],
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
  // Truncate doesn't include workspace_secrets. Cascade from workspaces
  // handles it, but be explicit here for safety.
  // Actually truncateAll TRUNCATEs workspaces CASCADE, so secrets go too.
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- crypto round-trip ------------------------------------------------

describe('crypto round-trip', () => {
  it('encryptValue + decryptValue is a round-trip', () => {
    const blob = encryptValue('hello world');
    const back = decryptValue(blob);
    expect(back).toBe('hello world');
  });

  it('produces different ciphertext for the same input each call (random nonce)', () => {
    const a = encryptValue('same');
    const b = encryptValue('same');
    expect(a.equals(b)).toBe(false);
    expect(decryptValue(a)).toBe('same');
    expect(decryptValue(b)).toBe('same');
  });

  it('decrypt rejects tampered ciphertext', () => {
    const blob = encryptValue('plain');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff; // flip a tag byte
    expect(() => decryptValue(blob)).toThrow();
  });

  it('decrypt rejects too-short blobs', () => {
    expect(() => decryptValue(Buffer.alloc(8))).toThrow();
  });
});

// ---- service ----------------------------------------------------------

describe('secrets service', () => {
  it('owner can set + get a secret; round-trips clean', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey', 'super-secret-key');
    const back = await getSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey');
    expect(back).toBe('super-secret-key');
  });

  it('manager and viewer cannot set secrets', async () => {
    const s = await setup();
    await expect(
      setSecret(ctx(s.workspaceA, s.managerA, 'manager'), 'serpapi.apiKey', 'X'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(
      setSecret(ctx(s.workspaceA, s.viewerA, 'viewer'), 'serpapi.apiKey', 'X'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects malformed key names', async () => {
    const s = await setup();
    await expect(
      setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'no-dot', 'v'),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'UPPERSCOPE.x', 'v'),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'ok.', 'v'),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects empty + over-long values', async () => {
    const s = await setup();
    await expect(
      setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey', '   '),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey', 'x'.repeat(5000)),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('upsert: setting the same key twice updates rather than inserting', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey', 'first');
    await setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey', 'second');
    const back = await getSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey');
    expect(back).toBe('second');
    const list = await listSecretKeys(ctx(s.workspaceA, s.ownerA, 'owner'));
    expect(list).toHaveLength(1);
  });

  it('hasSecret returns boolean without leaking value', async () => {
    const s = await setup();
    expect(await hasSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey')).toBe(false);
    await setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey', 'v');
    expect(await hasSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey')).toBe(true);
  });

  it('delete removes the row and survives missing key', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey', 'v');
    await deleteSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey');
    expect(await getSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey')).toBeNull();
    // Idempotent.
    await deleteSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey');
  });

  it('listSecretKeys never returns the cleartext value', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey', 'super-secret');
    const list = await listSecretKeys(ctx(s.workspaceA, s.ownerA, 'owner'));
    expect(list).toHaveLength(1);
    expect((list[0] as unknown as Record<string, unknown>)['encryptedValue']).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain('super-secret');
  });

  it('viewer cannot list secret keys', async () => {
    const s = await setup();
    await expect(listSecretKeys(ctx(s.workspaceA, s.viewerA, 'viewer'))).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  it('isolation: secret in workspace A invisible to workspace B', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'serpapi.apiKey', 'A-secret');
    expect(await getSecret(ctx(s.workspaceB, s.ownerB, 'owner'), 'serpapi.apiKey')).toBeNull();
  });
});

// ---- resolver ---------------------------------------------------------

describe('resolveProviderKey', () => {
  const ENV_NAME = 'TEST_PROVIDER_KEY_FOR_RESOLVER';

  beforeEach(() => {
    delete process.env[ENV_NAME];
  });

  it('returns workspace key with source=workspace when set', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'test.apiKey', 'WS-KEY');
    const r = await resolveProviderKey(
      ctx(s.workspaceA, s.ownerA, 'owner'),
      'test.apiKey',
      ENV_NAME,
    );
    expect(r).toEqual({ key: 'WS-KEY', source: 'workspace' });
  });

  it('falls back to platform env when no workspace secret', async () => {
    const s = await setup();
    process.env[ENV_NAME] = 'PLATFORM-KEY';
    const r = await resolveProviderKey(
      ctx(s.workspaceA, s.ownerA, 'owner'),
      'test.apiKey',
      ENV_NAME,
    );
    expect(r).toEqual({ key: 'PLATFORM-KEY', source: 'platform' });
    delete process.env[ENV_NAME];
  });

  it('returns null when neither set', async () => {
    const s = await setup();
    const r = await resolveProviderKey(
      ctx(s.workspaceA, s.ownerA, 'owner'),
      'test.apiKey',
      ENV_NAME,
    );
    expect(r).toBeNull();
  });

  it('workspace key wins when both set', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA, 'owner'), 'test.apiKey', 'WS-KEY');
    process.env[ENV_NAME] = 'PLATFORM-KEY';
    const r = await resolveProviderKey(
      ctx(s.workspaceA, s.ownerA, 'owner'),
      'test.apiKey',
      ENV_NAME,
    );
    expect(r?.source).toBe('workspace');
    expect(r?.key).toBe('WS-KEY');
    delete process.env[ENV_NAME];
  });
});

// ---- error shape ------------------------------------------------------

describe('error shape', () => {
  it('all thrown errors are SecretsServiceError instances', async () => {
    const s = await setup();
    try {
      await setSecret(ctx(s.workspaceA, s.viewerA, 'viewer'), 'serpapi.apiKey', 'X');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsServiceError);
    }
  });
});
