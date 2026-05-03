// Suppression list service. Phase 17: matches an outbound by EMAIL or
// DOMAIN or COMPANY. The legacy email-only API still works — addSuppression
// without `kind` defaults to email; isSuppressed(email) checks email +
// derived-domain. Soft suppressions can have a TTL (expires_at).

import { and, desc, eq, gt, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  suppressionList,
  type NewSuppressionEntry,
  type SuppressionEntry,
  type SuppressionKind,
  type SuppressionReason,
} from '@/lib/db/schema/mailing';
import { contacts } from '@/lib/db/schema/contacts';
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
  /** Phase 17: defaults to 'email'. */
  kind?: SuppressionKind;
  /** Either the value (preferred) or `address` for back-compat. */
  value?: string;
  /** Back-compat: kind=email + value=address. */
  address?: string;
  reason: SuppressionReason;
  note?: string | null;
  expiresAt?: Date | null;
}

export async function addSuppression(
  ctx: WorkspaceContext,
  input: AddSuppressionInput,
): Promise<SuppressionEntry> {
  if (!canWrite(ctx)) throw permissionDenied('suppression.add');
  const kind: SuppressionKind = input.kind ?? 'email';
  const rawValue = (input.value ?? input.address ?? '').trim();
  if (!rawValue) throw invalid(`${kind} value required`);
  const value = normalizeFor(kind, rawValue);
  if (!isValidFor(kind, value)) {
    throw invalid(`invalid ${kind}: ${rawValue}`);
  }

  const row: NewSuppressionEntry = {
    workspaceId: ctx.workspaceId,
    kind,
    // address mirrors `value` for kind=email so the legacy
    // (workspace, address) UNIQUE keeps working; for domain/company we
    // also stamp address=value so any pre-existing email row with the same
    // string can't collide with a new domain row of the same string (rare,
    // but the schema allows it).
    address: value,
    value,
    reason: input.reason,
    note: input.note?.trim() || null,
    expiresAt: input.expiresAt ?? null,
    createdBy: ctx.userId,
  };

  // Upsert on the canonical (workspace, kind, value) key.
  await db
    .insert(suppressionList)
    .values(row)
    .onConflictDoUpdate({
      target: [
        suppressionList.workspaceId,
        suppressionList.kind,
        suppressionList.value,
      ],
      set: {
        reason: row.reason,
        note: row.note,
        expiresAt: row.expiresAt,
        address: row.address,
      },
    });

  const reloaded = await db
    .select()
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        eq(suppressionList.kind, kind),
        eq(suppressionList.value, value),
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
    payload: { kind, value, reason: input.reason },
  });

  return reloaded[0];
}

export async function removeSuppression(
  ctx: WorkspaceContext,
  /** Either the row id or — back-compat — the email address (kind=email lookup). */
  identifier: bigint | string,
  kind: SuppressionKind = 'email',
): Promise<void> {
  if (!canWrite(ctx)) throw permissionDenied('suppression.remove');

  let existing: SuppressionEntry | undefined;
  if (typeof identifier === 'bigint') {
    const rows = await db
      .select()
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, ctx.workspaceId),
          eq(suppressionList.id, identifier),
        ),
      )
      .limit(1);
    existing = rows[0];
  } else {
    const value = normalizeFor(kind, identifier);
    const rows = await db
      .select()
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, ctx.workspaceId),
          eq(suppressionList.kind, kind),
          eq(suppressionList.value, value),
        ),
      )
      .limit(1);
    existing = rows[0];
  }
  if (!existing) throw notFound();
  await db
    .delete(suppressionList)
    .where(eq(suppressionList.id, existing.id));
  await recordAuditEvent(ctx, {
    kind: 'suppression.remove',
    entityType: 'suppression_entry',
    entityId: existing.id,
    payload: { kind: existing.kind, value: existing.value },
  });
}

export async function listSuppressions(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: {
    reason?: SuppressionReason;
    kind?: SuppressionKind;
    limit?: number;
  } = {},
): Promise<SuppressionEntry[]> {
  const conditions: SQL[] = [eq(suppressionList.workspaceId, ctx.workspaceId)];
  if (filter.reason) conditions.push(eq(suppressionList.reason, filter.reason));
  if (filter.kind) conditions.push(eq(suppressionList.kind, filter.kind));
  return db
    .select()
    .from(suppressionList)
    .where(and(...conditions))
    .orderBy(desc(suppressionList.createdAt))
    .limit(Math.min(filter.limit ?? 500, 5000));
}

/**
 * Phase 17: matches the recipient against EMAIL, DOMAIN, and COMPANY
 * suppressions. Email and domain checks are direct table lookups; company
 * matching looks at the contact's stored companyName (case-insensitive
 * exact match).
 */
export async function isSuppressed(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  email: string,
): Promise<boolean> {
  const normalized = normalizeFor('email', email);
  const domain = deriveDomain(normalized);
  const ttlOk = or(
    isNull(suppressionList.expiresAt),
    gt(suppressionList.expiresAt, new Date()),
  );

  // 1) email-direct match.
  const emailRows = await db
    .select()
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        eq(suppressionList.kind, 'email'),
        eq(suppressionList.value, normalized),
        ttlOk,
      ),
    )
    .limit(1);
  if (emailRows[0]) return true;

  // 2) domain match.
  if (domain) {
    const domainRows = await db
      .select()
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, ctx.workspaceId),
          eq(suppressionList.kind, 'domain'),
          eq(suppressionList.value, domain),
          ttlOk,
        ),
      )
      .limit(1);
    if (domainRows[0]) return true;
  }

  // 3) company match — only if we have a contact for this email with a
  //    companyName, and there's an active company-kind suppression on it.
  const contactRows = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, ctx.workspaceId),
        eq(contacts.email, normalized),
      ),
    )
    .limit(1);
  const company = contactRows[0]?.companyName?.trim().toLowerCase() ?? null;
  if (company) {
    const companyRows = await db
      .select()
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, ctx.workspaceId),
          eq(suppressionList.kind, 'company'),
          eq(suppressionList.value, company),
          ttlOk,
        ),
      )
      .limit(1);
    if (companyRows[0]) return true;
  }

  return false;
}

// ---- internals -----------------------------------------------------

function normalizeFor(kind: SuppressionKind, input: string): string {
  const v = input.trim().toLowerCase();
  if (kind === 'company') return v; // preserve spaces; just lowercase
  return v.replace(/\s+/g, '');
}

function isValidFor(kind: SuppressionKind, value: string): boolean {
  if (!value) return false;
  if (kind === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (kind === 'domain') return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value);
  // company: free-form non-empty, capped 200 chars
  return value.length <= 200;
}

function deriveDomain(email: string): string | null {
  const at = email.indexOf('@');
  if (at < 0) return null;
  const d = email.slice(at + 1);
  return d || null;
}

/**
 * Auto-suppress on bounce. Called from the mail-send error path when the
 * SMTP layer returns a 5xx (hard bounce) or persistent 4xx (soft bounce).
 * Hard bounces have no TTL; soft bounces expire in 7 days so the address
 * can be retried later without manual intervention.
 */
export async function recordBounce(
  ctx: WorkspaceContext,
  email: string,
  kind: 'hard' | 'soft' = 'hard',
  detail: string | null = null,
): Promise<SuppressionEntry> {
  return addSuppression(ctx, {
    kind: 'email',
    value: email,
    reason: kind === 'hard' ? 'bounce_hard' : 'bounce_soft',
    note: detail,
    expiresAt:
      kind === 'soft'
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null,
  });
}
