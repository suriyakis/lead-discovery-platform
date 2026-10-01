// Suppression list service. Phase 17: matches an outbound by EMAIL or
// DOMAIN or COMPANY. The legacy email-only API still works — addSuppression
// without `kind` defaults to email; isSuppressed(email) checks email +
// derived-domain. Soft suppressions can have a TTL (expires_at).
//
// F-03 (X1, I088): every add declares its provenance (`source` +
// `sourceRef`), the upsert never downgrades a row (see mergeSuppression),
// and rows are revoked — never deleted — so the history survives. A
// revoked row does not suppress; a new add re-activates it. Every add,
// including one that loses the merge, writes a 'suppression.add' audit
// event carrying its source, source_ref, the outcome and the prior state.

import { and, desc, eq, gt, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import {
  mailMessages,
  suppressionList,
  type NewSuppressionEntry,
  type SuppressionEntry,
  type SuppressionKind,
  type SuppressionReason,
  type SuppressionSource,
} from '@/lib/db/schema/mailing';
import { contacts } from '@/lib/db/schema/contacts';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';

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

/**
 * Sources a writer may declare. legacy_auto / legacy_unknown exist only
 * for rows that predate provenance (migration backfill) and are refused
 * on new adds.
 */
export type SuppressionAddSource = Exclude<
  SuppressionSource,
  'legacy_auto' | 'legacy_unknown'
>;

const ADD_SOURCES: ReadonlySet<SuppressionSource> = new Set<SuppressionAddSource>([
  'unsubscribe_link',
  'reply',
  'dsn',
  'smtp',
  'manual',
  'import',
]);

/** Human labels for the provenance column (UI + exports). */
export const SUPPRESSION_SOURCE_LABELS: Readonly<Record<SuppressionSource, string>> = {
  unsubscribe_link: 'Unsubscribe link',
  reply: 'Reply classifier (automatic)',
  dsn: 'Bounce report (automatic)',
  smtp: 'Send rejected (automatic)',
  manual: 'Added manually',
  import: 'Imported list',
  legacy_auto: 'Legacy · reply classifier (automatic)',
  legacy_unknown: 'Legacy · origin unknown',
};

export interface AddSuppressionInput {
  /** Phase 17: defaults to 'email'. */
  kind?: SuppressionKind;
  /** Either the value (preferred) or `address` for back-compat. */
  value?: string;
  /** Back-compat: kind=email + value=address. */
  address?: string;
  reason: SuppressionReason;
  /** F-03: which path produced this add. Required — there is no default. */
  source: SuppressionAddSource;
  /** F-03: evidence pointer, e.g. `mail_message:123`. */
  sourceRef?: string | null;
  note?: string | null;
  expiresAt?: Date | null;
}

// ---- merge rules (pure) --------------------------------------------

/**
 * Strength of a reason. A row's reason is never replaced by a weaker one:
 * opt-outs, complaints and manual blocks first, then hard bounces, then
 * soft bounces.
 */
const REASON_RANK: Readonly<Record<SuppressionReason, number>> = {
  unsubscribe: 3,
  complaint: 3,
  manual: 3,
  bounce_hard: 2,
  bounce_soft: 1,
};

/**
 * Sources that are inferred (heuristics or unknown origin) rather than
 * explicit (a person acted) or verified (a mail server said so). At equal
 * reason strength, an explicit/verified add takes over an inferred row so
 * its provenance reflects the stronger evidence — that keeps an operator-
 * confirmed row out of any later sweep of automatic suppressions.
 */
const INFERRED_SOURCES: ReadonlySet<SuppressionSource> = new Set<SuppressionSource>([
  'reply',
  'legacy_auto',
  'legacy_unknown',
]);

export type SuppressionAddOutcome =
  /** no row existed */
  | 'created'
  /** the row was revoked; the add re-activated it */
  | 'reactivated'
  /** the row's expiry had passed; the add started it afresh */
  | 'renewed'
  /** the add was stronger (reason, or equal reason + better evidence) */
  | 'upgraded'
  /** the row kept its reason/source; only its expiry got longer */
  | 'extended'
  /** the add changed nothing (weaker or equal) — still audited */
  | 'unchanged';

export interface SuppressionIncoming {
  reason: SuppressionReason;
  source: SuppressionSource;
  sourceRef: string | null;
  note: string | null;
  expiresAt: Date | null;
}

export type SuppressionMergeState = Pick<
  SuppressionEntry,
  'reason' | 'source' | 'sourceRef' | 'note' | 'expiresAt' | 'revokedAt'
>;

export interface SuppressionMergeResult {
  outcome: Exclude<SuppressionAddOutcome, 'created'>;
  /** Columns to write; null when the row stays as it is. */
  patch: Partial<NewSuppressionEntry> | null;
}

/**
 * Decide what a new add does to an existing row. Rules (F-03):
 * - a revoked row is re-activated by the add (it takes the add's values);
 * - an expired row is inactive, so the add starts it afresh;
 * - otherwise a stronger reason is never downgraded, and an expiry is
 *   never added to a permanent row or shortened: the later expiry wins,
 *   with "no expiry" counting as forever;
 * - the reason/source/source_ref/note move only when the add takes over
 *   (stronger reason, or equal reason with explicit-over-inferred
 *   evidence); otherwise they stay and only the audit event records the add.
 */
export function mergeSuppression(
  existing: SuppressionMergeState,
  incoming: SuppressionIncoming,
  now: Date = new Date(),
): SuppressionMergeResult {
  const takeover = {
    reason: incoming.reason,
    source: incoming.source,
    sourceRef: incoming.sourceRef,
    note: incoming.note,
  };

  if (existing.revokedAt) {
    return {
      outcome: 'reactivated',
      patch: {
        ...takeover,
        expiresAt: incoming.expiresAt,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
      },
    };
  }

  if (existing.expiresAt && existing.expiresAt.getTime() <= now.getTime()) {
    return {
      outcome: 'renewed',
      patch: { ...takeover, expiresAt: incoming.expiresAt },
    };
  }

  const expiresAt = laterExpiry(existing.expiresAt, incoming.expiresAt);
  const inRank = REASON_RANK[incoming.reason];
  const exRank = REASON_RANK[existing.reason];
  const takesOver =
    inRank > exRank ||
    (inRank === exRank &&
      INFERRED_SOURCES.has(existing.source) &&
      !INFERRED_SOURCES.has(incoming.source));

  if (takesOver) {
    return { outcome: 'upgraded', patch: { ...takeover, expiresAt } };
  }
  if (!sameInstant(expiresAt, existing.expiresAt)) {
    return { outcome: 'extended', patch: { expiresAt } };
  }
  return { outcome: 'unchanged', patch: null };
}

/** null = permanent = later than any date. */
function laterExpiry(a: Date | null, b: Date | null): Date | null {
  if (a === null || b === null) return null;
  return a.getTime() >= b.getTime() ? a : b;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

// ---- add -------------------------------------------------------------

interface NormalizedAdd extends SuppressionIncoming {
  kind: SuppressionKind;
  value: string;
}

interface UpsertResult {
  entry: SuppressionEntry;
  prior: SuppressionEntry | null;
  outcome: SuppressionAddOutcome;
}

function normalizeAddInput(input: AddSuppressionInput): NormalizedAdd {
  const kind: SuppressionKind = input.kind ?? 'email';
  const rawValue = (input.value ?? input.address ?? '').trim();
  if (!rawValue) throw invalid(`${kind} value required`);
  const value = normalizeFor(kind, rawValue);
  if (!isValidFor(kind, value)) {
    throw invalid(`invalid ${kind}: ${rawValue}`);
  }
  if (!ADD_SOURCES.has(input.source)) {
    throw invalid(`invalid suppression source: ${String(input.source)}`);
  }
  const sourceRef = input.sourceRef?.trim() || null;
  if (sourceRef && sourceRef.length > 200) {
    throw invalid('sourceRef must be at most 200 characters');
  }
  return {
    kind,
    value,
    reason: input.reason,
    source: input.source,
    sourceRef,
    note: input.note?.trim() || null,
    expiresAt: input.expiresAt ?? null,
  };
}

/**
 * Upsert on the canonical (workspace, kind, value) key under a row lock so
 * concurrent adds (a sync tick and an operator, say) merge instead of
 * racing last-writer-wins.
 */
async function upsertSuppression(
  workspaceId: bigint,
  actorUserId: string | null,
  add: NormalizedAdd,
): Promise<UpsertResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(suppressionList)
      .values({
        workspaceId,
        kind: add.kind,
        // address mirrors `value` so the legacy (workspace, address) UNIQUE
        // keeps working for every kind.
        address: add.value,
        value: add.value,
        reason: add.reason,
        source: add.source,
        sourceRef: add.sourceRef,
        note: add.note,
        expiresAt: add.expiresAt,
        createdBy: actorUserId,
      })
      .onConflictDoNothing({
        target: [
          suppressionList.workspaceId,
          suppressionList.kind,
          suppressionList.value,
        ],
      })
      .returning();
    if (inserted[0]) {
      return { entry: inserted[0], prior: null, outcome: 'created' as const };
    }

    const locked = await tx
      .select()
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, workspaceId),
          eq(suppressionList.kind, add.kind),
          eq(suppressionList.value, add.value),
        ),
      )
      .limit(1)
      .for('update');
    const prior = locked[0];
    if (!prior) {
      throw new SuppressionServiceError(
        'suppression upsert found no row after conflict',
        'invariant_violation',
      );
    }

    const merged = mergeSuppression(prior, add);
    if (!merged.patch) {
      return { entry: prior, prior, outcome: merged.outcome };
    }
    const updated = await tx
      .update(suppressionList)
      .set(merged.patch)
      .where(
        and(
          eq(suppressionList.workspaceId, workspaceId),
          eq(suppressionList.id, prior.id),
        ),
      )
      .returning();
    if (!updated[0]) {
      throw new SuppressionServiceError(
        'suppression update returned no row',
        'invariant_violation',
      );
    }
    return { entry: updated[0], prior, outcome: merged.outcome };
  });
}

function addAuditPayload(add: NormalizedAdd, result: UpsertResult): Record<string, unknown> {
  return {
    kind: add.kind,
    value: add.value,
    // What this add asked for…
    reason: add.reason,
    source: add.source,
    sourceRef: add.sourceRef,
    note: add.note,
    expiresAt: iso(add.expiresAt),
    // …what it did, and what the row looked like before / after.
    outcome: result.outcome,
    prior: result.prior ? stateSnapshot(result.prior) : null,
    result: stateSnapshot(result.entry),
  };
}

function stateSnapshot(e: SuppressionEntry): Record<string, unknown> {
  return {
    reason: e.reason,
    source: e.source,
    sourceRef: e.sourceRef,
    note: e.note,
    expiresAt: iso(e.expiresAt),
    revokedAt: iso(e.revokedAt),
    revokedBy: e.revokedBy,
    revokeReason: e.revokeReason,
    createdBy: e.createdBy,
    createdAt: iso(e.createdAt),
  };
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Phase 35: token-backed unsubscribe. Public unsubscribe endpoints don't
 * carry a session, so we resolve the request to a workspace via the
 * outbound mail_message's trackingToken and add the recipient(s) to
 * the suppression list without going through the canWrite gate.
 *
 * F-03: goes through the same non-downgrading merge as every other add
 * (source unsubscribe_link, source_ref = the outbound message) and writes
 * one 'suppression.add' audit event per address with a null actor.
 *
 * Returns the addresses that were suppressed (or already suppressed).
 * Returns an empty array if the token is unknown or malformed — the
 * public endpoint always responds 200 either way to avoid leaking
 * token validity.
 */
export async function recordUnsubscribeByToken(
  trackingToken: string,
): Promise<{ workspaceId: bigint | null; addresses: string[] }> {
  if (!/^[a-f0-9]{16,64}$/i.test(trackingToken)) {
    return { workspaceId: null, addresses: [] };
  }
  const rows = await db
    .select({
      id: mailMessages.id,
      workspaceId: mailMessages.workspaceId,
      toAddresses: mailMessages.toAddresses,
    })
    .from(mailMessages)
    .where(eq(mailMessages.trackingToken, trackingToken))
    .limit(1);
  const msg = rows[0];
  if (!msg) return { workspaceId: null, addresses: [] };

  const suppressed: string[] = [];
  for (const raw of msg.toAddresses ?? []) {
    const value = (raw ?? '').trim().toLowerCase();
    if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) continue;
    try {
      const add = normalizeAddInput({
        kind: 'email',
        value,
        reason: 'unsubscribe',
        source: 'unsubscribe_link',
        sourceRef: `mail_message:${msg.id}`,
        note: 'one-click unsubscribe via List-Unsubscribe',
        expiresAt: null,
      });
      const result = await upsertSuppression(msg.workspaceId, null, add);
      suppressed.push(value);
      // The actor is unauthenticated, so insert directly with
      // userId=null (recordAuditEvent requires a user id).
      try {
        await db.insert(auditLog).values({
          workspaceId: msg.workspaceId,
          userId: null,
          kind: 'suppression.add',
          entityType: 'suppression_entry',
          entityId: result.entry.id.toString(),
          payload: addAuditPayload(add, result),
        });
      } catch (err) {
        console.error('[unsubscribe] audit log insert failed:', err);
      }
    } catch (err) {
      // best-effort — keep going on any per-address failure
      console.error(`[unsubscribe] insert failed for ${value}:`, err);
    }
  }

  if (suppressed.length > 0) {
    // One summary event per request, alongside the per-address
    // 'suppression.add' provenance events above.
    try {
      await db.insert(auditLog).values({
        workspaceId: msg.workspaceId,
        userId: null,
        kind: 'suppression.unsubscribe_via_token',
        entityType: 'mail_message',
        entityId: trackingToken,
        payload: { addresses: suppressed },
      });
    } catch (err) {
      console.error('[unsubscribe] audit log insert failed:', err);
    }
  }

  return { workspaceId: msg.workspaceId, addresses: suppressed };
}

export async function addSuppression(
  ctx: WorkspaceContext,
  input: AddSuppressionInput,
): Promise<SuppressionEntry> {
  if (!canWrite(ctx)) throw permissionDenied('suppression.add');
  const add = normalizeAddInput(input);
  const result = await upsertSuppression(ctx.workspaceId, ctx.userId, add);

  await recordAuditEvent(ctx, {
    kind: 'suppression.add',
    entityType: 'suppression_entry',
    entityId: result.entry.id,
    payload: addAuditPayload(add, result),
  });

  return result.entry;
}

// ---- revoke ----------------------------------------------------------

export type SuppressionTarget =
  | bigint
  | { kind?: SuppressionKind; value: string };

/**
 * F-03: revoke instead of delete. The row stays (with who/when/why) so its
 * provenance and history survive; isSuppressed ignores it from now on. A
 * later add re-activates the same row. Admin-only: lifting a suppression
 * lets mail reach someone who may have opted out.
 */
export async function revokeSuppression(
  ctx: WorkspaceContext,
  target: SuppressionTarget,
  reason: string,
): Promise<SuppressionEntry> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('suppression.revoke');
  const revokeReason = (reason ?? '').trim();
  if (!revokeReason) throw invalid('a reason is required to revoke a suppression');
  if (revokeReason.length > 500) {
    throw invalid('revoke reason must be at most 500 characters');
  }

  const where =
    typeof target === 'bigint'
      ? and(
          eq(suppressionList.workspaceId, ctx.workspaceId),
          eq(suppressionList.id, target),
        )
      : and(
          eq(suppressionList.workspaceId, ctx.workspaceId),
          eq(suppressionList.kind, target.kind ?? 'email'),
          eq(suppressionList.value, normalizeFor(target.kind ?? 'email', target.value)),
        );

  const existing = (
    await db.select().from(suppressionList).where(where).limit(1)
  )[0];
  if (!existing) throw notFound();
  if (existing.revokedAt) {
    throw new SuppressionServiceError(
      'suppression entry is already revoked',
      'already_revoked',
    );
  }

  // Guard on revoked_at IS NULL so two concurrent revokes can't both win.
  const updated = await db
    .update(suppressionList)
    .set({
      revokedAt: new Date(),
      revokedBy: ctx.userId,
      revokeReason,
    })
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        eq(suppressionList.id, existing.id),
        isNull(suppressionList.revokedAt),
      ),
    )
    .returning();
  const revoked = updated[0];
  if (!revoked) {
    throw new SuppressionServiceError(
      'suppression entry is already revoked',
      'already_revoked',
    );
  }

  await recordAuditEvent(ctx, {
    kind: 'suppression.revoke',
    entityType: 'suppression_entry',
    entityId: revoked.id,
    payload: {
      kind: revoked.kind,
      value: revoked.value,
      revokeReason,
      prior: stateSnapshot(existing),
    },
  });

  return revoked;
}

// ---- read ------------------------------------------------------------

export async function listSuppressions(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: {
    reason?: SuppressionReason;
    kind?: SuppressionKind;
    /** F-03: revoked rows are history; include them only when asked. */
    includeRevoked?: boolean;
    limit?: number;
  } = {},
): Promise<SuppressionEntry[]> {
  const conditions: SQL[] = [eq(suppressionList.workspaceId, ctx.workspaceId)];
  if (filter.reason) conditions.push(eq(suppressionList.reason, filter.reason));
  if (filter.kind) conditions.push(eq(suppressionList.kind, filter.kind));
  if (!filter.includeRevoked) conditions.push(isNull(suppressionList.revokedAt));
  return db
    .select()
    .from(suppressionList)
    .where(and(...conditions))
    .orderBy(desc(suppressionList.createdAt), desc(suppressionList.id))
    .limit(Math.min(filter.limit ?? 500, 5000));
}

/**
 * Phase 17: matches the recipient against EMAIL, DOMAIN, and COMPANY
 * suppressions. Email and domain checks are direct table lookups; company
 * matching looks at the contact's stored companyName (case-insensitive
 * exact match). F-03: revoked and expired rows never match.
 */
export async function isSuppressed(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  email: string,
): Promise<boolean> {
  const normalized = normalizeFor('email', email);
  const domain = deriveDomain(normalized);
  const active = and(
    isNull(suppressionList.revokedAt),
    or(
      isNull(suppressionList.expiresAt),
      gt(suppressionList.expiresAt, new Date()),
    ),
  );

  // 1) email-direct match.
  const emailRows = await db
    .select({ id: suppressionList.id })
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        eq(suppressionList.kind, 'email'),
        eq(suppressionList.value, normalized),
        active,
      ),
    )
    .limit(1);
  if (emailRows[0]) return true;

  // 2) domain match.
  if (domain) {
    const domainRows = await db
      .select({ id: suppressionList.id })
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, ctx.workspaceId),
          eq(suppressionList.kind, 'domain'),
          eq(suppressionList.value, domain),
          active,
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
      .select({ id: suppressionList.id })
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, ctx.workspaceId),
          eq(suppressionList.kind, 'company'),
          eq(suppressionList.value, company),
          active,
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
 * can be retried later without manual intervention. F-03: a soft bounce
 * never weakens a stronger row (an opt-out stays an opt-out, no expiry).
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
    source: 'smtp',
    note: detail,
    expiresAt:
      kind === 'soft'
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null,
  });
}
