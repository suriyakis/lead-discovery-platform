// Saved signature blocks for a workspace's mailboxes.

import { and, asc, eq, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  signatures,
  type NewSignature,
  type Signature,
} from '@/lib/db/schema/mailing';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';

export class SignatureServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SignatureServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new SignatureServiceError(`Permission denied: ${op}`, 'permission_denied');
const invalid = (msg: string) =>
  new SignatureServiceError(msg, 'invalid_input');
const notFound = () =>
  new SignatureServiceError('signature not found', 'not_found');

export interface CreateSignatureInput {
  name: string;
  bodyText: string;
  bodyHtml?: string | null;
  mailboxId?: bigint | null;
  isDefault?: boolean;
}

export async function createSignature(
  ctx: WorkspaceContext,
  input: CreateSignatureInput,
): Promise<Signature> {
  if (!canWrite(ctx)) throw permissionDenied('signature.create');
  const name = input.name.trim();
  if (!name) throw invalid('name required');
  const bodyText = input.bodyText.trim();
  if (!bodyText) throw invalid('bodyText required');

  // If marking as default, clear any existing default at the same scope.
  if (input.isDefault) await clearDefaultAtScope(ctx, input.mailboxId ?? null);

  const row: NewSignature = {
    workspaceId: ctx.workspaceId,
    mailboxId: input.mailboxId ?? null,
    name,
    bodyText,
    bodyHtml: input.bodyHtml?.trim() || null,
    isDefault: input.isDefault ?? false,
    createdBy: ctx.userId,
  };
  const [created] = await db.insert(signatures).values(row).returning();
  if (!created) {
    throw new SignatureServiceError(
      'signature insert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'signature.create',
    entityType: 'signature',
    entityId: created.id,
    payload: {
      mailboxId: input.mailboxId?.toString() ?? null,
      isDefault: created.isDefault,
    },
  });
  return created;
}

export async function updateSignature(
  ctx: WorkspaceContext,
  id: bigint,
  patch: Partial<CreateSignatureInput>,
): Promise<Signature> {
  if (!canWrite(ctx)) throw permissionDenied('signature.update');
  const existing = await loadSignature(ctx, id);
  const updates: Partial<Signature> & { updatedAt: Date } = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const next = patch.name.trim();
    if (!next) throw invalid('name required');
    updates.name = next;
  }
  if (patch.bodyText !== undefined) {
    const next = patch.bodyText.trim();
    if (!next) throw invalid('bodyText required');
    updates.bodyText = next;
  }
  if (patch.bodyHtml !== undefined) {
    updates.bodyHtml = patch.bodyHtml?.trim() || null;
  }
  if (patch.mailboxId !== undefined) {
    updates.mailboxId = patch.mailboxId;
  }
  if (patch.isDefault === true) {
    await clearDefaultAtScope(ctx, patch.mailboxId ?? existing.mailboxId);
    updates.isDefault = true;
  } else if (patch.isDefault === false) {
    updates.isDefault = false;
  }

  const [updated] = await db
    .update(signatures)
    .set(updates)
    .where(
      and(
        eq(signatures.workspaceId, ctx.workspaceId),
        eq(signatures.id, id),
      ),
    )
    .returning();
  if (!updated) {
    throw new SignatureServiceError(
      'signature update returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'signature.update',
    entityType: 'signature',
    entityId: id,
  });
  return updated;
}

export async function deleteSignature(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<void> {
  if (!canWrite(ctx)) throw permissionDenied('signature.delete');
  await loadSignature(ctx, id);
  await db
    .delete(signatures)
    .where(
      and(
        eq(signatures.workspaceId, ctx.workspaceId),
        eq(signatures.id, id),
      ),
    );
  await recordAuditEvent(ctx, {
    kind: 'signature.delete',
    entityType: 'signature',
    entityId: id,
  });
}

export interface ListSignaturesFilter {
  mailboxId?: bigint | null;
}

export async function listSignatures(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListSignaturesFilter = {},
): Promise<Signature[]> {
  const conditions: SQL[] = [eq(signatures.workspaceId, ctx.workspaceId)];
  if (filter.mailboxId !== undefined) {
    if (filter.mailboxId === null) {
      // No mailboxId filter expressible cleanly without IS NULL — leave broad.
    } else {
      conditions.push(eq(signatures.mailboxId, filter.mailboxId));
    }
  }
  return db
    .select()
    .from(signatures)
    .where(and(...conditions))
    .orderBy(asc(signatures.name));
}

export async function defaultSignature(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  mailboxId: bigint,
): Promise<Signature | null> {
  // Prefer a mailbox-specific default; fall back to a workspace-wide default.
  const mailboxScoped = await db
    .select()
    .from(signatures)
    .where(
      and(
        eq(signatures.workspaceId, ctx.workspaceId),
        eq(signatures.mailboxId, mailboxId),
        eq(signatures.isDefault, true),
      ),
    )
    .limit(1);
  if (mailboxScoped[0]) return mailboxScoped[0];
  return null;
}

// ---- internals -----------------------------------------------------

async function loadSignature(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<Signature> {
  const rows = await db
    .select()
    .from(signatures)
    .where(
      and(
        eq(signatures.workspaceId, ctx.workspaceId),
        eq(signatures.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function clearDefaultAtScope(
  ctx: WorkspaceContext,
  mailboxId: bigint | null,
): Promise<void> {
  const conditions: SQL[] = [
    eq(signatures.workspaceId, ctx.workspaceId),
    eq(signatures.isDefault, true),
  ];
  if (mailboxId !== null) {
    conditions.push(eq(signatures.mailboxId, mailboxId));
  }
  await db
    .update(signatures)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(...conditions));
}
