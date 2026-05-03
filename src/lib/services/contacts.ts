// Contacts service. First-class entity (workspace-scoped, deduplicated by
// lowercased email). Polymorphic associations let one contact attach to
// multiple qualified_leads, mail_threads, mail_messages, source_records.

import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  contactAssociations,
  contacts,
  type Contact,
  type ContactAssociation,
  type NewContact,
  type NewContactAssociation,
} from '@/lib/db/schema/contacts';
import { mailMessages, mailThreads, type MailMessage, type MailThread } from '@/lib/db/schema/mailing';
import { qualifiedLeads, type QualifiedLead } from '@/lib/db/schema/pipeline';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';

export class ContactServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ContactServiceError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new ContactServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) =>
  new ContactServiceError(`${kind} not found`, 'not_found');
const invalid = (msg: string) =>
  new ContactServiceError(msg, 'invalid_input');
const conflict = (msg: string) =>
  new ContactServiceError(msg, 'conflict');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LEN = 200;
const MAX_TAGS = 32;

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

function deriveDomain(email: string): string | null {
  const at = email.indexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

function sanitizeTags(input: ReadonlyArray<string> | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ---- create / upsert -----------------------------------------------

export interface UpsertContactInput {
  email: string;
  name?: string | null;
  role?: string | null;
  phone?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  notes?: string | null;
  tags?: ReadonlyArray<string>;
  metadata?: Record<string, unknown>;
}

/**
 * Upsert a contact by (workspace, lowercased email). The first call inserts;
 * subsequent calls fill in any null fields without overwriting present
 * values (so passive data from a connector doesn't clobber human input).
 * Returns the merged row.
 */
export async function upsertContact(
  ctx: WorkspaceContext,
  input: UpsertContactInput,
): Promise<Contact> {
  if (!canWrite(ctx)) throw denied('contacts.upsert');
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw invalid('invalid email');
  const domain =
    (input.companyDomain ? input.companyDomain.trim().toLowerCase() : null) ??
    deriveDomain(email);

  const existing = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, ctx.workspaceId),
        eq(contacts.email, email),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const merged = mergeContactFields(existing[0], input, domain);
    if (Object.keys(merged).length === 0) return existing[0];
    const [updated] = await db
      .update(contacts)
      .set({ ...merged, updatedAt: new Date() })
      .where(eq(contacts.id, existing[0].id))
      .returning();
    if (!updated) {
      throw new ContactServiceError(
        'contact merge update returned no row',
        'invariant_violation',
      );
    }
    return updated;
  }

  const row: NewContact = {
    workspaceId: ctx.workspaceId,
    email,
    name: input.name?.trim() || null,
    role: input.role?.trim() || null,
    phone: input.phone?.trim() || null,
    companyName: input.companyName?.trim() || null,
    companyDomain: domain,
    status: 'active',
    notes: input.notes?.trim() || null,
    tags: sanitizeTags(input.tags),
    metadata: input.metadata ?? {},
    createdBy: ctx.userId,
  };
  const [created] = await db.insert(contacts).values(row).returning();
  if (!created) {
    throw new ContactServiceError(
      'contact insert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'contact.create',
    entityType: 'contact',
    entityId: created.id,
    payload: { email, source: 'manual' },
  });
  return created;
}

function mergeContactFields(
  existing: Contact,
  input: UpsertContactInput,
  derivedDomain: string | null,
): Partial<NewContact> {
  const out: Partial<NewContact> = {};
  if (!existing.name && input.name) out.name = input.name.trim();
  if (!existing.role && input.role) out.role = input.role.trim();
  if (!existing.phone && input.phone) out.phone = input.phone.trim();
  if (!existing.companyName && input.companyName) {
    out.companyName = input.companyName.trim();
  }
  if (!existing.companyDomain && derivedDomain) {
    out.companyDomain = derivedDomain;
  }
  if (input.notes && !existing.notes) out.notes = input.notes.trim();
  if (input.tags) {
    const next = sanitizeTags([...existing.tags, ...input.tags]);
    if (next.length !== existing.tags.length) out.tags = next;
  }
  return out;
}

// ---- update / archive ----------------------------------------------

export interface UpdateContactInput {
  name?: string | null;
  role?: string | null;
  phone?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  notes?: string | null;
  tags?: ReadonlyArray<string>;
  metadata?: Record<string, unknown>;
}

export async function updateContact(
  ctx: WorkspaceContext,
  id: bigint,
  input: UpdateContactInput,
): Promise<Contact> {
  if (!canWrite(ctx)) throw denied('contacts.update');
  await loadContact(ctx, id);
  const updates: Partial<NewContact> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) updates.name = input.name?.trim() || null;
  if (input.role !== undefined) updates.role = input.role?.trim() || null;
  if (input.phone !== undefined) updates.phone = input.phone?.trim() || null;
  if (input.companyName !== undefined) {
    updates.companyName = input.companyName?.trim() || null;
  }
  if (input.companyDomain !== undefined) {
    updates.companyDomain = input.companyDomain?.trim().toLowerCase() || null;
  }
  if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;
  if (input.tags !== undefined) updates.tags = sanitizeTags(input.tags);
  if (input.metadata !== undefined) updates.metadata = input.metadata;

  const [updated] = await db
    .update(contacts)
    .set(updates)
    .where(
      and(
        eq(contacts.workspaceId, ctx.workspaceId),
        eq(contacts.id, id),
      ),
    )
    .returning();
  if (!updated) {
    throw new ContactServiceError(
      'contact update returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'contact.update',
    entityType: 'contact',
    entityId: id,
  });
  return updated;
}

export async function archiveContact(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<Contact> {
  if (!canAdminWorkspace(ctx)) throw denied('contacts.archive');
  await loadContact(ctx, id);
  const [updated] = await db
    .update(contacts)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(
      and(
        eq(contacts.workspaceId, ctx.workspaceId),
        eq(contacts.id, id),
      ),
    )
    .returning();
  if (!updated) {
    throw new ContactServiceError(
      'contact archive returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'contact.archive',
    entityType: 'contact',
    entityId: id,
  });
  return updated;
}

/**
 * Merge two contacts in the same workspace into one. Source's associations
 * are re-pointed to target; source row is archived. Helpful when the same
 * person was harvested under two different addresses (e.g., personal +
 * work email).
 */
export async function mergeContacts(
  ctx: WorkspaceContext,
  targetId: bigint,
  sourceId: bigint,
): Promise<Contact> {
  if (!canAdminWorkspace(ctx)) throw denied('contacts.merge');
  if (targetId === sourceId) throw invalid('cannot merge a contact into itself');
  const [target, source] = await Promise.all([
    loadContact(ctx, targetId),
    loadContact(ctx, sourceId),
  ]);
  if (target.workspaceId !== source.workspaceId) {
    throw conflict('contacts in different workspaces');
  }

  await db.transaction(async (tx) => {
    // Re-point associations. Use a temporary entity_id swap to avoid the
    // unique constraint on (contact_id, entity_type, entity_id) when the
    // target already has the same association.
    const sourceAssocs = await tx
      .select()
      .from(contactAssociations)
      .where(
        and(
          eq(contactAssociations.workspaceId, ctx.workspaceId),
          eq(contactAssociations.contactId, sourceId),
        ),
      );
    for (const a of sourceAssocs) {
      const existsOnTarget = await tx
        .select()
        .from(contactAssociations)
        .where(
          and(
            eq(contactAssociations.contactId, targetId),
            eq(contactAssociations.entityType, a.entityType),
            eq(contactAssociations.entityId, a.entityId),
          ),
        )
        .limit(1);
      if (existsOnTarget[0]) {
        // target already has it — drop the source duplicate
        await tx
          .delete(contactAssociations)
          .where(eq(contactAssociations.id, a.id));
      } else {
        await tx
          .update(contactAssociations)
          .set({ contactId: targetId })
          .where(eq(contactAssociations.id, a.id));
      }
    }
    // Re-point mail_messages.contact_id.
    await tx
      .update(mailMessages)
      .set({ contactId: targetId })
      .where(
        and(
          eq(mailMessages.workspaceId, ctx.workspaceId),
          eq(mailMessages.contactId, sourceId),
        ),
      );
    // Archive source.
    await tx
      .update(contacts)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(contacts.id, sourceId));
    // Merge sparse fields onto target.
    const merge: Partial<NewContact> = {};
    if (!target.name && source.name) merge.name = source.name;
    if (!target.role && source.role) merge.role = source.role;
    if (!target.phone && source.phone) merge.phone = source.phone;
    if (!target.companyName && source.companyName) {
      merge.companyName = source.companyName;
    }
    if (!target.companyDomain && source.companyDomain) {
      merge.companyDomain = source.companyDomain;
    }
    const tags = sanitizeTags([...target.tags, ...source.tags]);
    if (tags.length !== target.tags.length) merge.tags = tags;
    if (Object.keys(merge).length > 0) {
      await tx
        .update(contacts)
        .set({ ...merge, updatedAt: new Date() })
        .where(eq(contacts.id, targetId));
    }
  });

  await recordAuditEvent(ctx, {
    kind: 'contact.merge',
    entityType: 'contact',
    entityId: targetId,
    payload: { sourceId: sourceId.toString() },
  });
  return loadContact(ctx, targetId);
}

// ---- associations --------------------------------------------------

export async function attachContact(
  ctx: WorkspaceContext,
  contactId: bigint,
  entity: { type: string; id: string; relation?: string },
): Promise<ContactAssociation> {
  if (!canWrite(ctx)) throw denied('contacts.attach');
  await loadContact(ctx, contactId);
  const row: NewContactAssociation = {
    workspaceId: ctx.workspaceId,
    contactId,
    entityType: entity.type,
    entityId: entity.id,
    relation: entity.relation ?? null,
  };
  await db
    .insert(contactAssociations)
    .values(row)
    .onConflictDoNothing({
      target: [
        contactAssociations.contactId,
        contactAssociations.entityType,
        contactAssociations.entityId,
      ],
    });
  const reloaded = await db
    .select()
    .from(contactAssociations)
    .where(
      and(
        eq(contactAssociations.contactId, contactId),
        eq(contactAssociations.entityType, entity.type),
        eq(contactAssociations.entityId, entity.id),
      ),
    )
    .limit(1);
  if (!reloaded[0]) {
    throw new ContactServiceError(
      'contact_association upsert returned no row',
      'invariant_violation',
    );
  }
  return reloaded[0];
}

// ---- read ----------------------------------------------------------

export interface ListContactsFilter {
  q?: string;
  companyDomain?: string;
  status?: 'active' | 'archived';
  tag?: string;
  limit?: number;
}

export async function listContacts(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListContactsFilter = {},
): Promise<Contact[]> {
  const conditions: SQL[] = [eq(contacts.workspaceId, ctx.workspaceId)];
  if (filter.status) conditions.push(eq(contacts.status, filter.status));
  if (filter.companyDomain) {
    conditions.push(
      eq(contacts.companyDomain, filter.companyDomain.trim().toLowerCase()),
    );
  }
  const limit = Math.min(filter.limit ?? 200, 1000);
  let rows = await db
    .select()
    .from(contacts)
    .where(and(...conditions))
    .orderBy(asc(contacts.email))
    .limit(limit);
  if (filter.q) {
    const q = filter.q.trim().toLowerCase();
    rows = rows.filter(
      (c) =>
        c.email.includes(q) ||
        (c.name?.toLowerCase().includes(q) ?? false) ||
        (c.companyName?.toLowerCase().includes(q) ?? false),
    );
  }
  if (filter.tag) {
    rows = rows.filter((c) => c.tags.includes(filter.tag!));
  }
  return rows;
}

export interface ContactDetail {
  contact: Contact;
  leads: QualifiedLead[];
  threads: MailThread[];
  recentMessages: MailMessage[];
}

export async function getContactDetail(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<ContactDetail> {
  const contact = await loadContact(ctx, id);
  const associations = await db
    .select()
    .from(contactAssociations)
    .where(
      and(
        eq(contactAssociations.workspaceId, ctx.workspaceId),
        eq(contactAssociations.contactId, id),
      ),
    );
  const leadIds = associations
    .filter((a) => a.entityType === 'qualified_lead')
    .map((a) => BigInt(a.entityId));
  const threadIds = associations
    .filter((a) => a.entityType === 'mail_thread')
    .map((a) => BigInt(a.entityId));

  const [leads, threads, recentMessages] = await Promise.all([
    leadIds.length > 0
      ? db
          .select()
          .from(qualifiedLeads)
          .where(
            and(
              eq(qualifiedLeads.workspaceId, ctx.workspaceId),
              inArray(qualifiedLeads.id, leadIds),
            ),
          )
          .orderBy(desc(qualifiedLeads.updatedAt))
      : Promise.resolve([] as QualifiedLead[]),
    threadIds.length > 0
      ? db
          .select()
          .from(mailThreads)
          .where(
            and(
              eq(mailThreads.workspaceId, ctx.workspaceId),
              inArray(mailThreads.id, threadIds),
            ),
          )
          .orderBy(desc(mailThreads.lastMessageAt))
      : Promise.resolve([] as MailThread[]),
    db
      .select()
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, ctx.workspaceId),
          eq(mailMessages.contactId, id),
        ),
      )
      .orderBy(desc(mailMessages.createdAt))
      .limit(20),
  ]);

  return { contact, leads, threads, recentMessages };
}

export async function getContactByEmail(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  email: string,
): Promise<Contact | null> {
  const rows = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, ctx.workspaceId),
        eq(contacts.email, normalizeEmail(email)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---- internals -----------------------------------------------------

async function loadContact(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<Contact> {
  const rows = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, ctx.workspaceId),
        eq(contacts.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('contact');
  return rows[0];
}

void MAX_NAME_LEN;
