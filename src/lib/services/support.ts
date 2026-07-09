// Customer ↔ platform-admin support messaging.
//
// Two symmetric halves:
//   Customer side (workspace-scoped): open a thread, read it (clears the
//     customer-unread flag), reply (sets the admin-unread flag; reopens a
//     closed thread — a customer must always be able to say "it's still
//     broken").
//   Admin side (super-admin only, /admin console): inbox across ALL
//     workspaces, read (clears admin-unread), reply (sets customer-unread
//     + drops a workspace notification linking to /support/<id>), close /
//     reopen.
//
// Any workspace member — including viewers — can contact support: asking
// for help is not a write to workspace data.

import { and, asc, count, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  supportMessages,
  supportThreads,
  type SupportMessage,
  type SupportThread,
} from '@/lib/db/schema/support';
import { workspaces } from '@/lib/db/schema/workspaces';
import { users } from '@/lib/db/schema/auth';
import { recordAuditEvent } from './audit';
import { isSuperAdmin, type WorkspaceContext } from './context';

export class SupportServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SupportServiceError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new SupportServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new SupportServiceError('support thread not found', 'not_found');
const invalid = (msg: string) => new SupportServiceError(msg, 'invalid_input');

const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;

function validateBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw invalid('message body is required');
  if (trimmed.length > BODY_MAX) throw invalid(`message too long (${BODY_MAX} char max)`);
  return trimmed;
}

// ─── customer side ────────────────────────────────────────────────────

export async function createSupportThread(
  ctx: WorkspaceContext,
  input: { subject: string; body: string },
): Promise<SupportThread> {
  const subject = input.subject.trim();
  if (!subject) throw invalid('subject is required');
  if (subject.length > SUBJECT_MAX) throw invalid(`subject too long (${SUBJECT_MAX} char max)`);
  const body = validateBody(input.body);

  const thread = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(supportThreads)
      .values({
        workspaceId: ctx.workspaceId,
        subject,
        createdByUserId: ctx.userId,
        adminUnread: true,
        customerUnread: false,
      })
      .returning();
    if (!t) throw new SupportServiceError('thread insert returned no row', 'invariant');
    await tx.insert(supportMessages).values({
      threadId: t.id,
      workspaceId: ctx.workspaceId,
      senderKind: 'customer',
      senderUserId: ctx.userId,
      body,
    });
    return t;
  });

  await recordAuditEvent(ctx, {
    kind: 'support.thread.create',
    entityType: 'support_thread',
    entityId: thread.id,
    payload: { subject },
  });
  return thread;
}

export async function listSupportThreads(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<SupportThread[]> {
  return db
    .select()
    .from(supportThreads)
    .where(eq(supportThreads.workspaceId, ctx.workspaceId))
    .orderBy(desc(supportThreads.lastMessageAt))
    .limit(100);
}

export interface ThreadWithMessages {
  thread: SupportThread;
  messages: SupportMessage[];
}

/** Read a thread (customer view). Marks the customer side as read. */
export async function getSupportThread(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<ThreadWithMessages> {
  const rows = await db
    .select()
    .from(supportThreads)
    .where(
      and(eq(supportThreads.workspaceId, ctx.workspaceId), eq(supportThreads.id, id)),
    )
    .limit(1);
  const thread = rows[0];
  if (!thread) throw notFound();

  if (thread.customerUnread) {
    await db
      .update(supportThreads)
      .set({ customerUnread: false, updatedAt: new Date() })
      .where(eq(supportThreads.id, thread.id));
    thread.customerUnread = false;
  }

  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.threadId, thread.id))
    .orderBy(asc(supportMessages.id));
  return { thread, messages };
}

/** Customer reply. Reopens a closed thread. */
export async function replyToSupportThread(
  ctx: WorkspaceContext,
  id: bigint,
  body: string,
): Promise<SupportMessage> {
  const text = validateBody(body);
  const rows = await db
    .select()
    .from(supportThreads)
    .where(
      and(eq(supportThreads.workspaceId, ctx.workspaceId), eq(supportThreads.id, id)),
    )
    .limit(1);
  if (!rows[0]) throw notFound();

  const message = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(supportMessages)
      .values({
        threadId: id,
        workspaceId: ctx.workspaceId,
        senderKind: 'customer',
        senderUserId: ctx.userId,
        body: text,
      })
      .returning();
    if (!m) throw new SupportServiceError('message insert returned no row', 'invariant');
    await tx
      .update(supportThreads)
      .set({
        lastMessageAt: new Date(),
        adminUnread: true,
        status: 'open',
        updatedAt: new Date(),
      })
      .where(eq(supportThreads.id, id));
    return m;
  });

  await recordAuditEvent(ctx, {
    kind: 'support.message.customer',
    entityType: 'support_thread',
    entityId: id,
    payload: {},
  });
  return message;
}

/** Unread-for-customer count — powers the sidebar badge. */
export async function workspaceSupportUnreadCount(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(supportThreads)
    .where(
      and(
        eq(supportThreads.workspaceId, ctx.workspaceId),
        eq(supportThreads.customerUnread, true),
      ),
    );
  return Number(rows[0]?.c ?? 0);
}

// ─── admin side ───────────────────────────────────────────────────────

export interface AdminThreadRow extends SupportThread {
  workspaceName: string;
  workspaceSlug: string;
}

export async function adminListSupportThreads(
  ctx: WorkspaceContext,
  filter: { status?: 'open' | 'closed' } = {},
): Promise<AdminThreadRow[]> {
  if (!isSuperAdmin(ctx)) throw denied('support.admin.list');
  const conds = filter.status ? [eq(supportThreads.status, filter.status)] : [];
  const rows = await db
    .select({
      thread: supportThreads,
      workspaceName: workspaces.name,
      workspaceSlug: workspaces.slug,
    })
    .from(supportThreads)
    .innerJoin(workspaces, eq(workspaces.id, supportThreads.workspaceId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(supportThreads.adminUnread), desc(supportThreads.lastMessageAt))
    .limit(200);
  return rows.map((r) => ({
    ...r.thread,
    workspaceName: r.workspaceName,
    workspaceSlug: r.workspaceSlug,
  }));
}

export interface AdminThreadDetail extends ThreadWithMessages {
  workspaceName: string;
  senderNames: Map<string, string>;
}

/** Read a thread (admin view, any workspace). Marks the admin side read. */
export async function adminGetSupportThread(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<AdminThreadDetail> {
  if (!isSuperAdmin(ctx)) throw denied('support.admin.read');
  const rows = await db
    .select({ thread: supportThreads, workspaceName: workspaces.name })
    .from(supportThreads)
    .innerJoin(workspaces, eq(workspaces.id, supportThreads.workspaceId))
    .where(eq(supportThreads.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound();
  const thread = row.thread;

  if (thread.adminUnread) {
    await db
      .update(supportThreads)
      .set({ adminUnread: false, updatedAt: new Date() })
      .where(eq(supportThreads.id, thread.id));
    thread.adminUnread = false;
  }

  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.threadId, thread.id))
    .orderBy(asc(supportMessages.id));

  const senderIds = Array.from(
    new Set(messages.map((m) => m.senderUserId).filter((v): v is string => Boolean(v))),
  );
  const senderNames = new Map<string, string>();
  if (senderIds.length > 0) {
    const { inArray } = await import('drizzle-orm');
    const userRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, senderIds));
    for (const u of userRows) senderNames.set(u.id, u.name ?? u.email ?? u.id);
  }

  return { thread, messages, workspaceName: row.workspaceName, senderNames };
}

/** Admin reply — notifies the customer workspace. */
export async function adminReplySupportThread(
  ctx: WorkspaceContext,
  id: bigint,
  body: string,
): Promise<SupportMessage> {
  if (!isSuperAdmin(ctx)) throw denied('support.admin.reply');
  const text = validateBody(body);
  const rows = await db
    .select()
    .from(supportThreads)
    .where(eq(supportThreads.id, id))
    .limit(1);
  const thread = rows[0];
  if (!thread) throw notFound();

  const message = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(supportMessages)
      .values({
        threadId: id,
        workspaceId: thread.workspaceId,
        senderKind: 'admin',
        senderUserId: ctx.userId,
        body: text,
      })
      .returning();
    if (!m) throw new SupportServiceError('message insert returned no row', 'invariant');
    await tx
      .update(supportThreads)
      .set({
        lastMessageAt: new Date(),
        customerUnread: true,
        updatedAt: new Date(),
      })
      .where(eq(supportThreads.id, id));
    return m;
  });

  try {
    const { notify } = await import('./notifications');
    await notify(thread.workspaceId, {
      kind: 'support.reply',
      title: `Support replied: ${thread.subject.slice(0, 80)}`,
      href: `/support/${thread.id}`,
      dedupeKey: `support.reply:${thread.id}`,
    });
  } catch (err) {
    console.error('[support] notify failed:', err);
  }

  await recordAuditEvent(ctx, {
    kind: 'support.message.admin',
    entityType: 'support_thread',
    entityId: id,
    payload: { workspaceId: thread.workspaceId.toString() },
  });
  return message;
}

export async function adminSetSupportThreadStatus(
  ctx: WorkspaceContext,
  id: bigint,
  status: 'open' | 'closed',
): Promise<SupportThread> {
  if (!isSuperAdmin(ctx)) throw denied('support.admin.status');
  const [updated] = await db
    .update(supportThreads)
    .set({ status, updatedAt: new Date() })
    .where(eq(supportThreads.id, id))
    .returning();
  if (!updated) throw notFound();
  await recordAuditEvent(ctx, {
    kind: `support.thread.${status === 'closed' ? 'close' : 'reopen'}`,
    entityType: 'support_thread',
    entityId: id,
    payload: { workspaceId: updated.workspaceId.toString() },
  });
  return updated;
}

/** Unread-for-admin count — powers the console badge. No ctx gate: the
 *  count leaks nothing and the console layout already guards access. */
export async function adminSupportUnreadCount(): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(supportThreads)
    .where(eq(supportThreads.adminUnread, true));
  return Number(rows[0]?.c ?? 0);
}
