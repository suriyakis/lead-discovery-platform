// Suppression list service. Addresses we will NEVER email — checked before
// every outbound send. Soft suppressions can have a TTL (expires_at).

import { and, desc, eq, gt, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  suppressionList,
  type NewSuppressionEntry,
  type SuppressionEntry,
  type SuppressionReason,
} from '@/lib/db/schema/mailing';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';

export class SuppressionServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SuppressionServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new SuppressionServiceError(`Permission denied: ${op}`, 'permission_denied');
const invalid = (msg: string) =>
  new SuppressionServiceError(msg, 'invalid_input');
const notFound = () =>
  new SuppressionServiceError('suppression entry not found', 'not_found');

export interface AddSuppressionInput {
  address: string;
  reason: SuppressionReason;
  note?: string | null;
  /** ISO-string or Date. Soft suppressions are typically TTL'd. */
  expiresAt?: Date | null;
}

export async function addSuppression(
  ctx: WorkspaceContext,
  input: AddSuppressionInput,
): Promise<SuppressionEntry> {
  if (!canWrite(ctx)) throw permissionDenied('suppression.add');
  const address = normalize(input.address);
  if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw invalid('invalid email address');
  }

  const row: NewSuppressionEntry = {
    workspaceId: ctx.workspaceId,
    address,
    reason: input.reason,
    note: input.note?.trim() || null,
    expiresAt: input.expiresAt ?? null,
    createdBy: ctx.userId,
  };

  // Upsert: re-suppressing an existing address replaces the reason/note/TTL.
  await db
    .insert(suppressionList)
    .values(row)
    .onConflictDoUpdate({
      target: [suppressionList.workspaceId, suppressionList.address],
      set: {
        reason: row.reason,
        note: row.note,
        expiresAt: row.expiresAt,
      },
    });

  const reloaded = await db
    .select()
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        eq(suppressionList.address, address),
      ),
    )
    .limit(1);
  if (!reloaded[0]) {
    throw new SuppressionServiceError(
      'suppression upsert returned no row',
      'invariant_violation',
    );
  }

  await recordAuditEvent(ctx, {
    kind: 'suppression.add',
    entityType: 'suppression_entry',
    entityId: reloaded[0].id,
    payload: { address, reason: input.reason },
  });

  return reloaded[0];
}

export async function removeSuppression(
  ctx: WorkspaceContext,
  address: string,
): Promise<void> {
  if (!canWrite(ctx)) throw permissionDenied('suppression.remove');
  const normalized = normalize(address);
  const existed = await db
    .select()
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        eq(suppressionList.address, normalized),
      ),
    )
    .limit(1);
  if (!existed[0]) throw notFound();
  await db
    .delete(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        eq(suppressionList.address, normalized),
      ),
    );
  await recordAuditEvent(ctx, {
    kind: 'suppression.remove',
    entityType: 'suppression_entry',
    entityId: existed[0].id,
    payload: { address: normalized },
  });
}

export async function listSuppressions(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: { reason?: SuppressionReason; limit?: number } = {},
): Promise<SuppressionEntry[]> {
  const conditions: SQL[] = [eq(suppressionList.workspaceId, ctx.workspaceId)];
  if (filter.reason) conditions.push(eq(suppressionList.reason, filter.reason));
  return db
    .select()
    .from(suppressionList)
    .where(and(...conditions))
    .orderBy(desc(suppressionList.createdAt))
    .limit(Math.min(filter.limit ?? 500, 5000));
}

/**
 * Returns true when the address is on the suppression list AND the
 * suppression is currently effective (no TTL or TTL not yet expired).
 */
export async function isSuppressed(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  address: string,
): Promise<boolean> {
  const normalized = normalize(address);
  const rows = await db
    .select()
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        eq(suppressionList.address, normalized),
        or(
          isNull(suppressionList.expiresAt),
          gt(suppressionList.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

function normalize(input: string): string {
  return input.trim().toLowerCase();
}
