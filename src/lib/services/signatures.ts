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

// Pure rendering lives in src/lib/signature-render.ts so client
// components can import it without dragging server-only modules into
// the browser bundle. Re-exported here so existing call sites keep
// importing from '@/lib/services/signatures'.
export {
  renderSignatureHtml,
  renderSignatureText,
} from '@/lib/signature-render';

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

export interface SignaturePhone {
  label: string;
  number: string;
}

export interface CreateSignatureInput {
  name: string;
  bodyText: string;
  bodyHtml?: string | null;
  mailboxId?: bigint | null;
  isDefault?: boolean;
  /** Phase 17 structured fields. */
  greeting?: string | null;
  fullName?: string | null;
  title?: string | null;
  company?: string | null;
  tagline?: string | null;
  website?: string | null;
  email?: string | null;
  phones?: ReadonlyArray<SignaturePhone>;
  logoStorageKey?: string | null;
  /** Phase 53: externally hosted logo URL. */
  logoUrl?: string | null;
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
    greeting: input.greeting?.trim() || null,
    fullName: input.fullName?.trim() || null,
    title: input.title?.trim() || null,
    company: input.company?.trim() || null,
    tagline: input.tagline?.trim() || null,
    website: input.website?.trim() || null,
    email: input.email?.trim() || null,
    phones: input.phones ? sanitizePhones(input.phones) : [],
    logoStorageKey: input.logoStorageKey?.trim() || null,
    logoUrl: validateLogoUrl(input.logoUrl),
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
  if (patch.greeting !== undefined) updates.greeting = patch.greeting?.trim() || null;
  if (patch.fullName !== undefined) updates.fullName = patch.fullName?.trim() || null;
  if (patch.title !== undefined) updates.title = patch.title?.trim() || null;
  if (patch.company !== undefined) updates.company = patch.company?.trim() || null;
  if (patch.tagline !== undefined) updates.tagline = patch.tagline?.trim() || null;
  if (patch.website !== undefined) updates.website = patch.website?.trim() || null;
  if (patch.email !== undefined) updates.email = patch.email?.trim() || null;
  if (patch.phones !== undefined) updates.phones = sanitizePhones(patch.phones);
  if (patch.logoStorageKey !== undefined) {
    updates.logoStorageKey = patch.logoStorageKey?.trim() || null;
  }
  if (patch.logoUrl !== undefined) {
    updates.logoUrl = validateLogoUrl(patch.logoUrl);
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

/** Phase 53: accept null / blank / http(s) URL up to 2 KB; everything
 *  else is rejected so a malformed URL doesn't slip into the rendered
 *  <img src=…>. */
function validateLogoUrl(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048) throw invalid('logoUrl too long (max 2048)');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw invalid('logoUrl must start with http:// or https://');
  }
  return trimmed;
}

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

/**
 * Trim, drop empties, and cap at 6 entries. Used by createSignature /
 * updateSignature before persist. Phone-shape coercion at render time
 * lives in `signature-render.ts` and is concerned with defensive jsonb
 * decoding rather than input validation.
 */
function sanitizePhones(input: ReadonlyArray<SignaturePhone>): SignaturePhone[] {
  const out: SignaturePhone[] = [];
  for (const p of input) {
    const number = (p?.number ?? '').trim();
    if (!number) continue;
    out.push({
      label: (p.label ?? '').trim().slice(0, 40),
      number: number.slice(0, 60),
    });
    if (out.length >= 6) break;
  }
  return out;
}
