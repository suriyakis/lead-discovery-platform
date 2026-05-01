import { describe, expect, it } from 'vitest';
import {
  WorkspaceContextError,
  type WorkspaceContext,
  type WorkspaceRole,
  canAdminWorkspace,
  canOwnWorkspace,
  canWrite,
  makeWorkspaceContext,
} from '@/lib/services/context';

describe('makeWorkspaceContext', () => {
  it('accepts a valid input', () => {
    const ctx = makeWorkspaceContext({
      workspaceId: 1n,
      userId: 'user-uuid-1',
      role: 'owner',
    });
    expect(ctx).toEqual<WorkspaceContext>({
      workspaceId: 1n,
      userId: 'user-uuid-1',
      role: 'owner',
    });
  });

  it('rejects missing workspaceId', () => {
    expect(() =>
      makeWorkspaceContext({
        workspaceId: undefined,
        userId: 'u',
        role: 'owner',
      }),
    ).toThrow(WorkspaceContextError);
  });

  it('rejects non-bigint workspaceId (number)', () => {
    expect(() =>
      makeWorkspaceContext({
        workspaceId: 1,
        userId: 'u',
        role: 'owner',
      }),
    ).toThrow(/workspaceId/);
  });

  it('rejects empty userId', () => {
    expect(() =>
      makeWorkspaceContext({
        workspaceId: 1n,
        userId: '',
        role: 'owner',
      }),
    ).toThrow(/userId/);
  });

  it('rejects unknown role', () => {
    expect(() =>
      makeWorkspaceContext({
        workspaceId: 1n,
        userId: 'u',
        role: 'admin_typo',
      }),
    ).toThrow(/role must be one of/);
  });

  it('accepts each documented role', () => {
    const roles: WorkspaceRole[] = [
      'owner',
      'admin',
      'manager',
      'member',
      'viewer',
      'super_admin',
    ];
    for (const role of roles) {
      const ctx = makeWorkspaceContext({ workspaceId: 1n, userId: 'u', role });
      expect(ctx.role).toBe(role);
    }
  });
});

describe('role helpers', () => {
  const base = { workspaceId: 1n, userId: 'u' } as const;

  it('canWrite is true for everything except viewer', () => {
    const writers: WorkspaceRole[] = ['owner', 'admin', 'manager', 'member', 'super_admin'];
    for (const role of writers) {
      expect(canWrite({ ...base, role })).toBe(true);
    }
    expect(canWrite({ ...base, role: 'viewer' })).toBe(false);
  });

  it('canAdminWorkspace is only owner/admin/super_admin', () => {
    expect(canAdminWorkspace({ ...base, role: 'owner' })).toBe(true);
    expect(canAdminWorkspace({ ...base, role: 'admin' })).toBe(true);
    expect(canAdminWorkspace({ ...base, role: 'super_admin' })).toBe(true);
    expect(canAdminWorkspace({ ...base, role: 'manager' })).toBe(false);
    expect(canAdminWorkspace({ ...base, role: 'member' })).toBe(false);
    expect(canAdminWorkspace({ ...base, role: 'viewer' })).toBe(false);
  });

  it('canOwnWorkspace is only owner/super_admin', () => {
    expect(canOwnWorkspace({ ...base, role: 'owner' })).toBe(true);
    expect(canOwnWorkspace({ ...base, role: 'super_admin' })).toBe(true);
    expect(canOwnWorkspace({ ...base, role: 'admin' })).toBe(false);
    expect(canOwnWorkspace({ ...base, role: 'manager' })).toBe(false);
    expect(canOwnWorkspace({ ...base, role: 'member' })).toBe(false);
    expect(canOwnWorkspace({ ...base, role: 'viewer' })).toBe(false);
  });
});
