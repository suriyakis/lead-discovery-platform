import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { workspaceSettings } from '@/lib/db/schema/workspaces';
import { makeWorkspaceContext } from '@/lib/services/context';
import {
  WorkspaceServiceError,
  getWorkspaceNativeLanguage,
  getWorkspaceOutreachLanguage,
  getWorkspaceSettings,
  updateWorkspaceNativeLanguage,
  updateWorkspaceOutreachLanguage,
} from '@/lib/services/workspace';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceId: bigint;
  ownerId: string;
  viewerId: string;
}

async function setup(): Promise<Setup> {
  const ownerId = await seedUser({ email: 'owner-natlang@test.local' });
  const viewerId = await seedUser({ email: 'viewer-natlang@test.local' });
  const workspaceId = await seedWorkspace({
    name: 'NatLang',
    ownerUserId: ownerId,
    extraMembers: [{ userId: viewerId, role: 'viewer' }],
  });
  return { workspaceId, ownerId, viewerId };
}

function ctx(s: Setup, who: 'owner' | 'viewer') {
  return makeWorkspaceContext({
    workspaceId: s.workspaceId,
    userId: who === 'owner' ? s.ownerId : s.viewerId,
    role: who,
  });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('getWorkspaceNativeLanguage', () => {
  it('defaults to en when unset', async () => {
    const s = await setup();
    expect(await getWorkspaceNativeLanguage(ctx(s, 'owner'))).toBe('en');
  });

  it('falls back to en when the stored value is no longer enabled', async () => {
    const s = await setup();
    // Write a non-enabled code directly into the blob.
    await db
      .update(workspaceSettings)
      .set({ settings: { nativeLanguage: 'fr' } })
      .where(eq(workspaceSettings.workspaceId, s.workspaceId));
    expect(await getWorkspaceNativeLanguage(ctx(s, 'owner'))).toBe('en');
  });
});

describe('updateWorkspaceNativeLanguage', () => {
  it('owner can set the native language and it round-trips', async () => {
    const s = await setup();
    const stored = await updateWorkspaceNativeLanguage(ctx(s, 'owner'), 'pl');
    expect(stored).toBe('pl');
    expect(await getWorkspaceNativeLanguage(ctx(s, 'owner'))).toBe('pl');
    const settings = await getWorkspaceSettings(ctx(s, 'owner'));
    expect(settings.nativeLanguage).toBe('pl');
  });

  it('normalises region tags and casing', async () => {
    const s = await setup();
    expect(await updateWorkspaceNativeLanguage(ctx(s, 'owner'), 'EN-GB')).toBe('en');
    expect(await updateWorkspaceNativeLanguage(ctx(s, 'owner'), 'DE')).toBe('de');
    expect(await getWorkspaceNativeLanguage(ctx(s, 'owner'))).toBe('de');
  });

  it('rejects a known-but-not-enabled language', async () => {
    const s = await setup();
    await expect(
      updateWorkspaceNativeLanguage(ctx(s, 'owner'), 'fr'),
    ).rejects.toThrow(WorkspaceServiceError);
  });

  it('rejects an unknown language', async () => {
    const s = await setup();
    await expect(
      updateWorkspaceNativeLanguage(ctx(s, 'owner'), 'xx'),
    ).rejects.toThrow(/unsupported native language/);
  });

  it('denies non-admins', async () => {
    const s = await setup();
    await expect(
      updateWorkspaceNativeLanguage(ctx(s, 'viewer'), 'pl'),
    ).rejects.toThrow(/Permission denied/);
  });

  it('emits an audit event', async () => {
    const s = await setup();
    await updateWorkspaceNativeLanguage(ctx(s, 'owner'), 'it');
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceId));
    const row = audits.find((a) => a.kind === 'workspace.update_native_language');
    expect(row).toBeTruthy();
    expect((row!.payload as Record<string, unknown>).nativeLanguage).toBe('it');
  });
});

describe('workspace default outreach language', () => {
  it('defaults to null (unset)', async () => {
    const s = await setup();
    expect(await getWorkspaceOutreachLanguage(ctx(s, 'owner'))).toBeNull();
  });

  it('owner can set + clear, round-trips, normalises', async () => {
    const s = await setup();
    expect(await updateWorkspaceOutreachLanguage(ctx(s, 'owner'), 'DE')).toBe('de');
    expect(await getWorkspaceOutreachLanguage(ctx(s, 'owner'))).toBe('de');
    // Clearing with '' resets to the cascade.
    expect(await updateWorkspaceOutreachLanguage(ctx(s, 'owner'), '')).toBeNull();
    expect(await getWorkspaceOutreachLanguage(ctx(s, 'owner'))).toBeNull();
  });

  it('rejects a known-but-not-enabled language', async () => {
    const s = await setup();
    await expect(
      updateWorkspaceOutreachLanguage(ctx(s, 'owner'), 'fr'),
    ).rejects.toThrow(WorkspaceServiceError);
  });

  it('denies non-admins', async () => {
    const s = await setup();
    await expect(
      updateWorkspaceOutreachLanguage(ctx(s, 'viewer'), 'pl'),
    ).rejects.toThrow(/Permission denied/);
  });

  it('does not disturb the native language', async () => {
    const s = await setup();
    await updateWorkspaceNativeLanguage(ctx(s, 'owner'), 'pl');
    await updateWorkspaceOutreachLanguage(ctx(s, 'owner'), 'de');
    expect(await getWorkspaceNativeLanguage(ctx(s, 'owner'))).toBe('pl');
    expect(await getWorkspaceOutreachLanguage(ctx(s, 'owner'))).toBe('de');
  });
});
