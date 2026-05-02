// Mailbox service. CRUD on the mailboxes table, secret-key wiring through
// workspace_secrets, connection testing, and a builder that hands the
// outreach service a ready IMailProvider per mailbox.

import { and, desc, eq, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db/client';
import {
  mailboxes,
  type Mailbox,
  type MailboxStatus,
  type NewMailbox,
} from '@/lib/db/schema/mailing';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import { getSecret, setSecret } from './secrets';
import {
  createMailProvider,
  type ConnectionTestResult,
  type IMailProvider,
  type MailboxConfig,
} from '@/lib/mail';

export class MailboxServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'MailboxServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new MailboxServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new MailboxServiceError('mailbox not found', 'not_found');
const invariant = (msg: string) =>
  new MailboxServiceError(msg, 'invariant_violation');
const invalid = (msg: string) =>
  new MailboxServiceError(msg, 'invalid_input');

// ---- create / update -----------------------------------------------

export interface CreateMailboxInput {
  name: string;
  fromAddress: string;
  fromName?: string | null;
  replyTo?: string | null;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser: string;
  /** Cleartext password — encrypted into workspace_secrets, never stored on the row. */
  smtpPassword: string;
  imap?: {
    host: string;
    port?: number;
    secure?: boolean;
    user: string;
    password: string;
    folder?: string;
  } | null;
  isDefault?: boolean;
}

export async function createMailbox(
  ctx: WorkspaceContext,
  input: CreateMailboxInput,
): Promise<Mailbox> {
  if (!canWrite(ctx)) throw permissionDenied('mailbox.create');
  const fromAddress = normalizeAddress(input.fromAddress);
  if (!isValidEmail(fromAddress)) throw invalid('invalid fromAddress');
  if (!input.smtpHost.trim() || !input.smtpUser.trim() || !input.smtpPassword) {
    throw invalid('smtp host/user/password required');
  }
  if (input.imap) {
    if (!input.imap.host.trim() || !input.imap.user.trim() || !input.imap.password) {
      throw invalid('imap host/user/password required when imap is set');
    }
  }

  // Ensure only one default per workspace.
  if (input.isDefault) {
    await db
      .update(mailboxes)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(mailboxes.workspaceId, ctx.workspaceId),
          eq(mailboxes.isDefault, true),
        ),
      );
  }

  // Reserve secret keys via a per-mailbox slot id. The secrets layer
  // requires keys of the form `<lowercase-scope>.<field>` so we cannot
  // embed the email address verbatim — use a 12-char hex slot per mailbox.
  const slot = randomUUID().replace(/-/g, '').slice(0, 12);
  const smtpSecretKey = `mailbox.smtpPassword_${slot}`;
  const imapSecretKey = input.imap ? `mailbox.imapPassword_${slot}` : null;

  await setSecret(ctx, smtpSecretKey, input.smtpPassword);
  if (imapSecretKey && input.imap) {
    await setSecret(ctx, imapSecretKey, input.imap.password);
  }

  const row: NewMailbox = {
    workspaceId: ctx.workspaceId,
    name: input.name.trim() || fromAddress,
    fromAddress,
    fromName: input.fromName?.trim() || null,
    replyTo: input.replyTo ? normalizeAddress(input.replyTo) : null,
    smtpHost: input.smtpHost.trim(),
    smtpPort: input.smtpPort ?? 587,
    smtpSecure: input.smtpSecure ?? false,
    smtpUser: input.smtpUser.trim(),
    smtpPasswordSecretKey: smtpSecretKey,
    imapHost: input.imap?.host.trim() ?? null,
    imapPort: input.imap?.port ?? (input.imap ? 993 : null),
    imapSecure: input.imap?.secure ?? true,
    imapUser: input.imap?.user.trim() ?? null,
    imapPasswordSecretKey: imapSecretKey,
    imapFolder: input.imap?.folder?.trim() || 'INBOX',
    status: 'active',
    isDefault: input.isDefault ?? false,
    createdBy: ctx.userId,
  };

  const [created] = await db.insert(mailboxes).values(row).returning();
  if (!created) throw invariant('mailbox insert returned no row');

  await recordAuditEvent(ctx, {
    kind: 'mailbox.create',
    entityType: 'mailbox',
    entityId: created.id,
    payload: {
      fromAddress,
      smtpHost: created.smtpHost,
      imapHost: created.imapHost,
    },
  });

  return created;
}

export interface UpdateMailboxInput {
  name?: string;
  fromName?: string | null;
  replyTo?: string | null;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  imap?: {
    host: string;
    port?: number;
    secure?: boolean;
    user: string;
    password?: string;
    folder?: string;
  } | null;
  status?: MailboxStatus;
  isDefault?: boolean;
}

export async function updateMailbox(
  ctx: WorkspaceContext,
  id: bigint,
  input: UpdateMailboxInput,
): Promise<Mailbox> {
  if (!canWrite(ctx)) throw permissionDenied('mailbox.update');
  const existing = await loadMailbox(ctx, id);
  const updates: Partial<Mailbox> & { updatedAt: Date } = { updatedAt: new Date() };

  if (input.name !== undefined) updates.name = input.name.trim() || existing.name;
  if (input.fromName !== undefined) updates.fromName = input.fromName?.trim() || null;
  if (input.replyTo !== undefined) {
    updates.replyTo = input.replyTo ? normalizeAddress(input.replyTo) : null;
  }
  if (input.smtpHost !== undefined) updates.smtpHost = input.smtpHost.trim();
  if (input.smtpPort !== undefined) updates.smtpPort = input.smtpPort;
  if (input.smtpSecure !== undefined) updates.smtpSecure = input.smtpSecure;
  if (input.smtpUser !== undefined) updates.smtpUser = input.smtpUser.trim();
  if (input.smtpPassword !== undefined && input.smtpPassword) {
    await setSecret(ctx, existing.smtpPasswordSecretKey, input.smtpPassword);
  }
  if (input.imap === null) {
    updates.imapHost = null;
    updates.imapPort = null;
    updates.imapUser = null;
    updates.imapPasswordSecretKey = null;
  } else if (input.imap !== undefined) {
    updates.imapHost = input.imap.host.trim();
    updates.imapPort = input.imap.port ?? 993;
    updates.imapSecure = input.imap.secure ?? true;
    updates.imapUser = input.imap.user.trim();
    updates.imapFolder = input.imap.folder?.trim() || 'INBOX';
    if (!existing.imapPasswordSecretKey) {
      const slot = randomUUID().replace(/-/g, '').slice(0, 12);
      updates.imapPasswordSecretKey = `mailbox.imapPassword_${slot}`;
    }
    if (input.imap.password) {
      const key = updates.imapPasswordSecretKey ?? existing.imapPasswordSecretKey;
      if (key) await setSecret(ctx, key, input.imap.password);
    }
  }
  if (input.status !== undefined) updates.status = input.status;
  if (input.isDefault === true) {
    await db
      .update(mailboxes)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(mailboxes.workspaceId, ctx.workspaceId),
          eq(mailboxes.isDefault, true),
        ),
      );
    updates.isDefault = true;
  } else if (input.isDefault === false) {
    updates.isDefault = false;
  }

  const [updated] = await db
    .update(mailboxes)
    .set(updates)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('mailbox update returned no row');

  await recordAuditEvent(ctx, {
    kind: 'mailbox.update',
    entityType: 'mailbox',
    entityId: id,
  });

  return updated;
}

export async function archiveMailbox(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<Mailbox> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('mailbox.archive');
  const existing = await loadMailbox(ctx, id);
  if (existing.status === 'archived') return existing;
  const [updated] = await db
    .update(mailboxes)
    .set({ status: 'archived', isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('mailbox archive returned no row');
  await recordAuditEvent(ctx, {
    kind: 'mailbox.archive',
    entityType: 'mailbox',
    entityId: id,
  });
  return updated;
}

// ---- read ----------------------------------------------------------

export async function listMailboxes(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: { includeArchived?: boolean } = {},
): Promise<Mailbox[]> {
  const conditions: SQL[] = [eq(mailboxes.workspaceId, ctx.workspaceId)];
  // (We exclude archived by default via a status filter, post-query for
  // simplicity — the table is tiny per workspace.)
  const rows = await db
    .select()
    .from(mailboxes)
    .where(and(...conditions))
    .orderBy(desc(mailboxes.createdAt));
  if (filter.includeArchived) return rows;
  return rows.filter((m) => m.status !== 'archived');
}

export async function getMailbox(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<Mailbox> {
  return loadMailbox(ctx, id);
}

export async function defaultMailbox(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<Mailbox | null> {
  const rows = await db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.isDefault, true),
        eq(mailboxes.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---- provider construction -----------------------------------------

/**
 * Resolve all secrets and return an IMailProvider ready to send/fetch.
 * The caller can pass `providerOverride` (the test seam used by the
 * mail service tests) — when set, we return that and skip the secret +
 * config lookup entirely.
 */
export async function buildProviderFor(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  providerOverride?: IMailProvider,
): Promise<{ mailbox: Mailbox; provider: IMailProvider }> {
  const mailbox = await loadMailbox(ctx, mailboxId);
  if (providerOverride) return { mailbox, provider: providerOverride };

  const config = await resolveConfig(ctx, mailbox);
  const provider = createMailProvider(config);
  return { mailbox, provider };
}

export async function testMailboxConnection(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  providerOverride?: IMailProvider,
): Promise<ConnectionTestResult> {
  if (!canWrite(ctx)) throw permissionDenied('mailbox.test_connection');
  const { provider, mailbox } = await buildProviderFor(ctx, mailboxId, providerOverride);
  const result = await provider.testConnection();
  // Update mailbox status on outcome.
  const allOk = result.smtp.ok && (result.imap === null || result.imap.ok);
  await db
    .update(mailboxes)
    .set({
      status: allOk ? 'active' : 'failing',
      lastError: allOk
        ? null
        : (!result.smtp.ok
            ? `SMTP: ${result.smtp.detail ?? 'failed'}`
            : `IMAP: ${result.imap?.detail ?? 'failed'}`),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, mailbox.id),
      ),
    );
  await recordAuditEvent(ctx, {
    kind: 'mailbox.test_connection',
    entityType: 'mailbox',
    entityId: mailbox.id,
    payload: { allOk, smtp: result.smtp.ok, imap: result.imap?.ok ?? null },
  });
  return result;
}

// ---- internals -----------------------------------------------------

async function loadMailbox(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<Mailbox> {
  const rows = await db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function resolveConfig(
  ctx: WorkspaceContext,
  mailbox: Mailbox,
): Promise<MailboxConfig> {
  const smtpPassword = await getSecret(ctx, mailbox.smtpPasswordSecretKey);
  if (!smtpPassword) {
    throw new MailboxServiceError(
      `SMTP password missing for mailbox ${mailbox.id}`,
      'secret_missing',
    );
  }
  const imap = mailbox.imapHost && mailbox.imapPort && mailbox.imapUser && mailbox.imapPasswordSecretKey
    ? {
        host: mailbox.imapHost,
        port: mailbox.imapPort,
        secure: mailbox.imapSecure,
        user: mailbox.imapUser,
        password: (await getSecret(ctx, mailbox.imapPasswordSecretKey)) ?? '',
        folder: mailbox.imapFolder,
      }
    : null;
  if (imap && !imap.password) {
    throw new MailboxServiceError(
      `IMAP password missing for mailbox ${mailbox.id}`,
      'secret_missing',
    );
  }
  return {
    smtpHost: mailbox.smtpHost,
    smtpPort: mailbox.smtpPort,
    smtpSecure: mailbox.smtpSecure,
    smtpUser: mailbox.smtpUser,
    smtpPassword,
    imap,
  };
}

function normalizeAddress(input: string): string {
  return input.trim().toLowerCase();
}

function isValidEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}
