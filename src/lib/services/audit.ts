import { and, desc, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog, type AuditLogEntry, type NewAuditLogEntry } from '@/lib/db/schema/audit';
import type { WorkspaceContext } from './context';

export interface AuditEventInput {
  kind: string;
  entityType?: string | null;
  entityId?: string | bigint | number | null;
  payload?: Record<string, unknown>;
}

/**
 * Record an audit event tied to a workspace + user. Append-only.
 *
 * The context only needs `workspaceId` and `userId`. We accept a partial
 * context so platform-level events (no workspace yet) can pass `null` via
 * `recordPlatformAuditEvent` below.
 */
export async function recordAuditEvent(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  event: AuditEventInput,
): Promise<AuditLogEntry> {
  const row: NewAuditLogEntry = {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    kind: event.kind,
    entityType: event.entityType ?? null,
    entityId: serializeEntityId(event.entityId),
    payload: (event.payload ?? {}) as NewAuditLogEntry['payload'],
  };
  const inserted = await db.insert(auditLog).values(row).returning();
  if (!inserted[0]) {
    throw new Error('audit_log insert returned no row');
  }
  return inserted[0];
}

/**
 * Record an audit event without a workspace (e.g., super-admin platform
 * actions, the very first user signup before a workspace exists).
 */
export async function recordPlatformAuditEvent(
  userId: string | null,
  event: AuditEventInput,
): Promise<AuditLogEntry> {
  const row: NewAuditLogEntry = {
    workspaceId: null,
    userId,
    kind: event.kind,
    entityType: event.entityType ?? null,
    entityId: serializeEntityId(event.entityId),
    payload: (event.payload ?? {}) as NewAuditLogEntry['payload'],
  };
  const inserted = await db.insert(auditLog).values(row).returning();
  if (!inserted[0]) {
    throw new Error('audit_log insert returned no row');
  }
  return inserted[0];
}

export interface ListAuditFilter {
  kind?: string | readonly string[];
  since?: Date;
  until?: Date;
  limit?: number;
}

/**
 * List audit events for a workspace, newest first.
 */
export async function listAuditEvents(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListAuditFilter = {},
): Promise<AuditLogEntry[]> {
  const limit = clampLimit(filter.limit, 100);
  const conds: SQL[] = [eq(auditLog.workspaceId, ctx.workspaceId)];
  if (filter.kind !== undefined) {
    if (Array.isArray(filter.kind)) {
      if (filter.kind.length === 0) return [];
      conds.push(inArray(auditLog.kind, filter.kind as string[]));
    } else {
      conds.push(eq(auditLog.kind, filter.kind as string));
    }
  }
  if (filter.since) conds.push(gte(auditLog.createdAt, filter.since));
  if (filter.until) conds.push(lte(auditLog.createdAt, filter.until));

  return db
    .select()
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

function serializeEntityId(input: AuditEventInput['entityId']): string | null {
  if (input === undefined || input === null) return null;
  return String(input);
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), 1000);
}
