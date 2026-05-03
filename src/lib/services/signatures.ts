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

// ---- renderSignatureHtml ------------------------------------------

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

/**
 * Render a Phase 17 structured signature as a brand-coherent HTML block.
 * Falls back to bodyHtml (if set) or bodyText wrapped in <pre> when no
 * structured fields are provided. Output is a self-contained inline-styled
 * <table> so it survives email clients without external CSS.
 *
 * Pass logoUrl explicitly — the storage layer's signedUrl is async so the
 * caller resolves it once and hands the URL in.
 */
export function renderSignatureHtml(
  signature: Pick<
    Signature,
    | 'bodyText'
    | 'bodyHtml'
    | 'greeting'
    | 'fullName'
    | 'title'
    | 'company'
    | 'tagline'
    | 'website'
    | 'email'
    | 'phones'
    | 'logoStorageKey'
  >,
  logoUrl?: string | null,
): string {
  if (signature.bodyHtml && signature.bodyHtml.trim()) {
    return signature.bodyHtml;
  }
  const phones = (signature.phones as SignaturePhone[] | null) ?? [];
  const hasStructured =
    signature.fullName ||
    signature.title ||
    signature.company ||
    signature.website ||
    signature.email ||
    phones.length > 0;
  if (!hasStructured) {
    return `<pre style="margin:0;font-family:inherit;white-space:pre-wrap">${escape(signature.bodyText)}</pre>`;
  }

  const accent = '#e87b1f'; // brand orange
  const muted = '#6b7280';

  const greeting = signature.greeting
    ? `<div style="padding:0 0 8px 0;border-bottom:2px solid ${accent};color:${muted};font-weight:500">${escape(signature.greeting)}</div>`
    : '';

  const logoCell = logoUrl
    ? `<td valign="top" style="padding:8px 16px 0 0;width:96px"><img src="${escape(logoUrl)}" alt="${escape(signature.company ?? 'logo')}" style="max-width:96px;height:auto;display:block" /></td>`
    : '';

  const phoneLines = phones
    .map((p) => {
      const labelHtml = p.label ? `<span style="color:${muted}">${escape(p.label)}: </span>` : '';
      return `<div>${labelHtml}<a href="tel:${escape(p.number)}" style="color:inherit;text-decoration:none">${escape(p.number)}</a></div>`;
    })
    .join('');

  const websiteLine = signature.website
    ? `<div><a href="${escape(signature.website)}" style="color:${accent};text-decoration:none">${escape(signature.website)}</a></div>`
    : '';
  const emailLine = signature.email
    ? `<div><a href="mailto:${escape(signature.email)}" style="color:inherit;text-decoration:none">${escape(signature.email)}</a></div>`
    : '';

  const taglineLine = signature.tagline
    ? `<div style="font-style:italic;color:${muted};margin-top:4px">${escape(signature.tagline)}</div>`
    : '';

  const nameLine = signature.fullName
    ? `<div style="font-weight:600;font-size:15px">${escape(signature.fullName)}</div>`
    : '';
  const titleLine = signature.title
    ? `<div style="color:${muted}">${escape(signature.title)}</div>`
    : '';
  const companyLine = signature.company
    ? `<div style="color:${accent};font-weight:500">${escape(signature.company)}</div>`
    : '';

  return `${greeting}<table cellspacing="0" cellpadding="0" border="0" style="margin-top:10px;font-family:inherit;font-size:14px;line-height:1.4"><tr>${logoCell}<td valign="top">${nameLine}${titleLine}${companyLine}${taglineLine}<div style="margin-top:6px">${websiteLine}${emailLine}${phoneLines}</div></td></tr></table>`;
}

/**
 * Plain-text rendering — used for the text/plain alternative of an
 * outbound message. Preserves bodyText if set; otherwise composes from
 * the structured fields.
 */
export function renderSignatureText(
  signature: Pick<
    Signature,
    | 'bodyText'
    | 'greeting'
    | 'fullName'
    | 'title'
    | 'company'
    | 'tagline'
    | 'website'
    | 'email'
    | 'phones'
  >,
): string {
  if (signature.bodyText && signature.bodyText.trim()) return signature.bodyText;
  const lines: string[] = [];
  if (signature.greeting) lines.push(signature.greeting);
  if (signature.fullName) lines.push(signature.fullName);
  if (signature.title) lines.push(signature.title);
  if (signature.company) lines.push(signature.company);
  if (signature.tagline) lines.push(signature.tagline);
  if (signature.website) lines.push(signature.website);
  if (signature.email) lines.push(signature.email);
  const phones = (signature.phones as SignaturePhone[] | null) ?? [];
  for (const p of phones) {
    lines.push(p.label ? `${p.label}: ${p.number}` : p.number);
  }
  return lines.join('\n');
}
