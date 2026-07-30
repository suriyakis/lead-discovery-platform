// Workspace secrets service. Stores encrypted values keyed by
// `<scope>.<field>` (e.g. `serpapi.apiKey`). Decryption only happens
// inside the service; values never leak into logs or audit payloads.

import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  platformSecrets,
  workspaceSecrets,
  type NewWorkspaceSecret,
  type WorkspaceSecret,
} from '@/lib/db/schema/secrets';
import { recordAuditEvent, recordPlatformAuditEvent } from './audit';
import { canAdminWorkspace, isSuperAdmin, type WorkspaceContext } from './context';
import { decryptValue, encryptValue } from './crypto';

export class SecretsServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SecretsServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new SecretsServiceError(`Permission denied: ${op}`, 'permission_denied');
const invalid = (msg: string) => new SecretsServiceError(msg, 'invalid_input');

const VALID_KEY = /^[a-z][a-z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*$/;

function parseScope(key: string): string {
  if (!VALID_KEY.test(key)) {
    throw invalid(
      `secret key must be of form '<scope>.<field>' lowercase scope, e.g. 'serpapi.apiKey'`,
    );
  }
  return key.split('.', 1)[0]!;
}

export async function setSecret(
  ctx: WorkspaceContext,
  key: string,
  value: string,
): Promise<WorkspaceSecret> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('set workspace secret');
  const trimmed = value.trim();
  if (!trimmed) throw invalid('secret value cannot be empty');
  if (trimmed.length > 4096) throw invalid('secret value too long (4096 char max)');
  const scope = parseScope(key);
  const encrypted = encryptValue(trimmed);

  const row: NewWorkspaceSecret = {
    workspaceId: ctx.workspaceId,
    key,
    encryptedValue: encrypted,
    scope,
  };

  await db
    .insert(workspaceSecrets)
    .values(row)
    .onConflictDoUpdate({
      target: [workspaceSecrets.workspaceId, workspaceSecrets.key],
      set: {
        encryptedValue: encrypted,
        scope,
        updatedAt: new Date(),
      },
    });

  await recordAuditEvent(ctx, {
    kind: 'secret.set',
    entityType: 'workspace_secret',
    entityId: key,
    payload: { scope, action: 'upsert' },
  });

  // Reload to get the canonical row (timestamps + encrypted value as
  // returned from the DB driver).
  const reloaded = await db
    .select()
    .from(workspaceSecrets)
    .where(
      and(eq(workspaceSecrets.workspaceId, ctx.workspaceId), eq(workspaceSecrets.key, key)),
    );
  if (!reloaded[0]) throw new SecretsServiceError('secret missing after upsert', 'invariant');
  return reloaded[0];
}

export async function deleteSecret(ctx: WorkspaceContext, key: string): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('delete workspace secret');
  parseScope(key); // validates key shape
  const result = await db
    .delete(workspaceSecrets)
    .where(
      and(eq(workspaceSecrets.workspaceId, ctx.workspaceId), eq(workspaceSecrets.key, key)),
    );
  void result;
  await recordAuditEvent(ctx, {
    kind: 'secret.delete',
    entityType: 'workspace_secret',
    entityId: key,
    payload: { scope: parseScope(key) },
  });
}

export async function getSecret(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  key: string,
): Promise<string | null> {
  parseScope(key);
  const rows = await db
    .select()
    .from(workspaceSecrets)
    .where(
      and(eq(workspaceSecrets.workspaceId, ctx.workspaceId), eq(workspaceSecrets.key, key)),
    );
  if (!rows[0]) return null;
  return decryptValue(rows[0].encryptedValue);
}

export async function hasSecret(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  key: string,
): Promise<boolean> {
  parseScope(key);
  const rows = await db
    .select({ k: workspaceSecrets.key })
    .from(workspaceSecrets)
    .where(
      and(eq(workspaceSecrets.workspaceId, ctx.workspaceId), eq(workspaceSecrets.key, key)),
    );
  return rows.length > 0;
}

export interface SecretListing {
  key: string;
  scope: string;
  updatedAt: Date;
}

export async function listSecretKeys(ctx: WorkspaceContext): Promise<SecretListing[]> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('list workspace secrets');
  const rows = await db
    .select({
      key: workspaceSecrets.key,
      scope: workspaceSecrets.scope,
      updatedAt: workspaceSecrets.updatedAt,
    })
    .from(workspaceSecrets)
    .where(eq(workspaceSecrets.workspaceId, ctx.workspaceId))
    .orderBy(asc(workspaceSecrets.key));
  return rows;
}

// ---- Platform-wide secrets (super-admin, /admin/providers) -------------

export async function setPlatformSecret(
  ctx: WorkspaceContext,
  key: string,
  value: string,
): Promise<void> {
  if (!isSuperAdmin(ctx)) throw permissionDenied('set platform secret');
  const trimmed = value.trim();
  if (!trimmed) throw invalid('secret value cannot be empty');
  if (trimmed.length > 4096) throw invalid('secret value too long (4096 char max)');
  const scope = parseScope(key);
  const encrypted = encryptValue(trimmed);

  await db
    .insert(platformSecrets)
    .values({
      key,
      encryptedValue: encrypted,
      scope,
      updatedByUserId: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [platformSecrets.key],
      set: {
        encryptedValue: encrypted,
        scope,
        updatedByUserId: ctx.userId,
        updatedAt: new Date(),
      },
    });

  await recordPlatformAuditEvent(ctx.userId, {
    kind: 'platform_secret.set',
    entityType: 'platform_secret',
    entityId: key,
    payload: { scope },
  });
}

export async function deletePlatformSecret(
  ctx: WorkspaceContext,
  key: string,
): Promise<void> {
  if (!isSuperAdmin(ctx)) throw permissionDenied('delete platform secret');
  parseScope(key);
  await db.delete(platformSecrets).where(eq(platformSecrets.key, key));
  await recordPlatformAuditEvent(ctx.userId, {
    kind: 'platform_secret.delete',
    entityType: 'platform_secret',
    entityId: key,
    payload: {},
  });
}

/** Internal — never expose the value to a client. */
export async function getPlatformSecret(key: string): Promise<string | null> {
  parseScope(key);
  const rows = await db
    .select()
    .from(platformSecrets)
    .where(eq(platformSecrets.key, key))
    .limit(1);
  if (!rows[0]) return null;
  return decryptValue(rows[0].encryptedValue);
}

export interface PlatformSecretListing {
  key: string;
  scope: string;
  updatedAt: Date;
  updatedByUserId: string | null;
}

export async function listPlatformSecretKeys(
  ctx: WorkspaceContext,
): Promise<PlatformSecretListing[]> {
  if (!isSuperAdmin(ctx)) throw permissionDenied('list platform secrets');
  return db
    .select({
      key: platformSecrets.key,
      scope: platformSecrets.scope,
      updatedAt: platformSecrets.updatedAt,
      updatedByUserId: platformSecrets.updatedByUserId,
    })
    .from(platformSecrets)
    .orderBy(asc(platformSecrets.key));
}

// ---- Provider key resolver --------------------------------------------

export interface ResolvedProviderKey {
  key: string;
  source: 'workspace' | 'platform';
}

/**
 * Resolve a provider API key. Order:
 *   1. workspace secret (BYOK — usage is token-free for the workspace)
 *   2. platform secret set via /admin/providers (DB, survives .env edits)
 *   3. `process.env[envVarName]` (legacy platform default)
 * Both 2 and 3 report source='platform' — billing only cares whether the
 * key is the WORKSPACE's own. Returns null when nothing is configured.
 */
export async function resolveProviderKey(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  secretKey: string,
  envVarName: string,
): Promise<ResolvedProviderKey | null> {
  const workspaceVal = await getSecret(ctx, secretKey);
  if (workspaceVal) return { key: workspaceVal, source: 'workspace' };
  const platformDbVal = await getPlatformSecret(secretKey);
  if (platformDbVal) return { key: platformDbVal, source: 'platform' };
  const platformVal = process.env[envVarName];
  if (platformVal && platformVal.trim().length > 0) {
    return { key: platformVal.trim(), source: 'platform' };
  }
  return null;
}
