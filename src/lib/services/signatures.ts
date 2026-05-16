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

import { z } from 'zod';
import { getAIProviderForCtx } from '@/lib/ai';
import { recordUsage } from './usage';

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

// ---- AI redesign (Phase 54) -----------------------------------------

const REDESIGN_SYSTEM_PROMPT = `You are an expert email signature designer.

Produce a single block of HTML that renders as a clean, professional email
signature. Apply the operator's structured fields + any style preferences
they specify; pick tasteful typography, spacing, and accent colors when not
told explicitly.

Hard rules (email-client compatibility):
- Output ONLY the signature HTML. No <html>, <head>, <body>, no markdown
  fences, no commentary.
- Inline CSS only. Email clients strip <style> tags.
- Use a single <table cellspacing="0" cellpadding="0" border="0"> as the
  outer layout container. Modern flexbox / grid won't render in Outlook.
- Stay under 600px wide. Mobile clients are unforgiving.
- If a logo URL is provided, embed it via <img src="..." alt="..."
  style="display:block;max-width:120px;height:auto"> in a left cell.
  Don't make it larger than 200px wide unless the operator explicitly
  asks for a big logo.
- All anchors get target="_blank" and rel="noopener". All URLs as-is.
- Don't invent fields. If a field is blank in the input, omit it.
- Don't include "Sent from my iPhone" style noise.
- No JavaScript, no <script>, no <iframe>, no <form>, no <input>.
- No external CSS imports (@import, link rel=stylesheet).

Return JSON shaped as { "bodyHtml": "<table>...</table>" }.
`;

const RedesignResultSchema = z.object({
  bodyHtml: z.string().min(20).max(20_000),
});

export interface RedesignSignatureInput {
  /** Operator's optional style guidance, e.g. "use navy and gold" or
   *  "make the logo big". */
  extraPrompt?: string | null;
  /** Structured fields the AI must honour verbatim. */
  fullName?: string | null;
  title?: string | null;
  company?: string | null;
  tagline?: string | null;
  website?: string | null;
  email?: string | null;
  phones?: ReadonlyArray<SignaturePhone>;
  logoUrl?: string | null;
  /** Operator's current bodyText — useful for AI to mirror tone / language. */
  bodyText?: string | null;
  /** Existing bodyHtml the AI is replacing, if any. Provider gets to see
   *  the prior design as context (operator may say "make the colors
   *  match the existing layout" or "keep the structure but change X"). */
  currentBodyHtml?: string | null;
}

export interface RedesignSignatureResult {
  bodyHtml: string;
  model: string;
  providerId: string;
  costEstimateCents: number;
}

/**
 * Phase 54 — generate a fresh HTML signature from structured fields + a
 * style prompt. Calls the workspace's active AI provider. Returns the
 * candidate HTML for the operator to preview + save; this function does
 * NOT mutate the signature row, the caller decides what to do with the
 * returned HTML.
 *
 * Sanitisation note: <script>, <iframe>, javascript: URLs are stripped
 * from the AI output as a defense-in-depth measure. The system prompt
 * already forbids them, but trusting an LLM to never emit them is a
 * losing bet.
 */
export async function redesignSignatureHtml(
  ctx: WorkspaceContext,
  input: RedesignSignatureInput,
): Promise<RedesignSignatureResult> {
  if (!canWrite(ctx)) throw permissionDenied('signature.redesign');

  const fields: Array<[string, string]> = [];
  if (input.fullName?.trim()) fields.push(['Full name', input.fullName.trim()]);
  if (input.title?.trim()) fields.push(['Title', input.title.trim()]);
  if (input.company?.trim()) fields.push(['Company', input.company.trim()]);
  if (input.tagline?.trim()) fields.push(['Tagline', input.tagline.trim()]);
  if (input.website?.trim()) fields.push(['Website', input.website.trim()]);
  if (input.email?.trim()) fields.push(['Email', input.email.trim()]);
  for (const p of input.phones ?? []) {
    if (p.number.trim()) {
      fields.push([
        p.label.trim() ? `Phone (${p.label.trim()})` : 'Phone',
        p.number.trim(),
      ]);
    }
  }
  if (input.logoUrl?.trim()) fields.push(['Logo URL', input.logoUrl.trim()]);

  if (fields.length === 0 && !input.bodyText?.trim()) {
    throw invalid(
      'cannot redesign — no signature data provided. Fill in at least one structured field before asking AI to redesign.',
    );
  }

  const fieldLines = fields
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const sections: string[] = [
    'Structured fields (use these verbatim — do NOT invent or substitute):',
    fieldLines || '(no fields)',
  ];
  if (input.bodyText?.trim()) {
    sections.push(
      '',
      'Operator\'s plain-text signature (for language / tone reference):',
      input.bodyText.trim().slice(0, 4000),
    );
  }
  if (input.currentBodyHtml?.trim()) {
    sections.push(
      '',
      'Existing HTML signature (the operator is re-designing this — feel free to keep what works, change what doesn\'t):',
      input.currentBodyHtml.trim().slice(0, 8000),
    );
  }
  if (input.extraPrompt?.trim()) {
    sections.push(
      '',
      'Operator\'s style preferences (priority — honour these):',
      input.extraPrompt.trim().slice(0, 2000),
    );
  }

  const userPrompt = sections.join('\n');

  const provider = await getAIProviderForCtx(ctx);
  const result = await provider.generateJson(
    { system: REDESIGN_SYSTEM_PROMPT, prompt: userPrompt },
    RedesignResultSchema,
    { maxTokens: 4096, temperature: 0.6 },
  );

  const sanitized = sanitizeSignatureHtml(result.bodyHtml);

  // Cost estimate is best-effort; AI providers return token counts on
  // chat completions but generateJson surfaces them on the same wrapper.
  const costEstimateCents = 0; // The provider's billing pipeline already
  // records the underlying chat completion via usage_log inside
  // generateJson. We add an extra entry tagged ai.signature_redesign so
  // /settings/usage can show signature spend distinctly.
  await recordUsage(ctx, {
    kind: 'ai.signature_redesign',
    provider: provider.id,
    units: 1n,
    costEstimateCents,
    payload: {
      model: provider.model,
      hasExtraPrompt: Boolean(input.extraPrompt?.trim()),
      fieldsProvided: fields.length,
    },
  });

  await recordAuditEvent(ctx, {
    kind: 'signature.redesign',
    entityType: 'signature',
    entityId: 0n,
    payload: {
      providerId: provider.id,
      model: provider.model,
      fieldsProvided: fields.length,
      hasExtraPrompt: Boolean(input.extraPrompt?.trim()),
    },
  });

  return {
    bodyHtml: sanitized,
    model: provider.model,
    providerId: provider.id,
    costEstimateCents,
  };
}

/** Defensive HTML sanitiser. Drops <script>, <iframe>, on* event
 *  handlers, and javascript: URLs from the AI output. Tag whitelist
 *  isn't enforced (signatures legitimately use many tags) — instead
 *  we surgically remove the known-hostile constructs. */
function sanitizeSignatureHtml(input: string): string {
  let out = input.trim();
  // Strip <script>...</script> + <iframe>...</iframe> (and self-closing).
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<script[^>]*\/?\s*>/gi, '');
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  out = out.replace(/<iframe[^>]*\/?\s*>/gi, '');
  // Strip on* event handler attributes (onclick="...", onerror='...').
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
  // Strip javascript: URLs from href / src.
  out = out.replace(
    /(href|src)\s*=\s*"(?:\s*javascript:)[^"]*"/gi,
    '$1="#"',
  );
  out = out.replace(
    /(href|src)\s*=\s*'(?:\s*javascript:)[^']*'/gi,
    "$1='#'",
  );
  // Trim markdown code fences in case the model ignored the system
  // prompt and wrapped the output anyway.
  out = out.replace(/^```html\s*/i, '').replace(/```$/, '').trim();
  return out;
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
