// CRM service. CRUD on crm_connections + the push pipeline that bundles
// qualified_leads into a CRM via the configured ICRMConnector. CSV exports
// are bundled and dropped into IStorage so the UI can offer a download link.

import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { db } from '@/lib/db/client';
import { productProfiles, type ProductProfile } from '@/lib/db/schema/products';
import {
  pipelineEvents,
  qualifiedLeads,
  type QualifiedLead,
  type PipelineState,
} from '@/lib/db/schema/pipeline';
import {
  crmConnections,
  crmSyncLog,
  type CrmConnection,
  type CrmConnectionStatus,
  type CrmSyncEntry,
  type NewCrmConnection,
  type NewCrmSyncEntry,
} from '@/lib/db/schema/crm';
import {
  mailMessages,
  mailThreads,
  type MailThread,
} from '@/lib/db/schema/mailing';
import { contactAssociations } from '@/lib/db/schema/contacts';
import { recordAuditEvent } from './audit';
import { assertGate } from './automation-gate';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import { getSecret, setSecret } from './secrets';
import {
  CSV_COLUMNS,
  createCrmConnector,
  csvRowFor,
  rowsToCsv,
  type CrmLeadPayload,
  type ICRMConnector,
  type SyncResult,
} from '@/lib/crm';
import {
  StorageObjectNotFoundError,
  getStorage,
  type IStorage,
} from '@/lib/storage';

export class CrmServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'CrmServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new CrmServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) =>
  new CrmServiceError(`${kind} not found`, 'not_found');
const invariant = (msg: string) =>
  new CrmServiceError(msg, 'invariant_violation');
const invalid = (msg: string) =>
  new CrmServiceError(msg, 'invalid_input');
const conflict = (msg: string) =>
  new CrmServiceError(msg, 'conflict');
const archivedConnection = () =>
  new CrmServiceError(
    'This connection is archived. Restore it before testing it.',
    'archived',
  );

const SUPPORTED_SYSTEMS = new Set(['csv', 'hubspot']);

// ---- connection CRUD -----------------------------------------------

export interface CreateCrmConnectionInput {
  system: string;
  name: string;
  /** Cleartext credential — encrypted into workspace_secrets. */
  credential?: string | null;
  config?: Record<string, unknown>;
}

export async function createCrmConnection(
  ctx: WorkspaceContext,
  input: CreateCrmConnectionInput,
): Promise<CrmConnection> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('crm.create_connection');
  if (!SUPPORTED_SYSTEMS.has(input.system)) {
    throw invalid(`unsupported CRM system: ${input.system}`);
  }
  const name = input.name.trim();
  if (!name) throw invalid('name required');

  let credentialSecretKey: string | null = null;
  if (input.credential) {
    const slot = randomUUID().replace(/-/g, '').slice(0, 12);
    credentialSecretKey = `crm.${input.system}_${slot}`;
    await setSecret(ctx, credentialSecretKey, input.credential);
  }

  const row: NewCrmConnection = {
    workspaceId: ctx.workspaceId,
    system: input.system,
    name,
    credentialSecretKey,
    config: input.config ?? {},
    status: 'active',
    createdBy: ctx.userId,
  };
  const [created] = await db.insert(crmConnections).values(row).returning();
  if (!created) throw invariant('crm_connection insert returned no row');
  await recordAuditEvent(ctx, {
    kind: 'crm.create_connection',
    entityType: 'crm_connection',
    entityId: created.id,
    payload: { system: input.system },
  });
  return created;
}

export interface UpdateCrmConnectionInput {
  name?: string;
  credential?: string;
  config?: Record<string, unknown>;
  status?: CrmConnectionStatus;
}

export async function updateCrmConnection(
  ctx: WorkspaceContext,
  id: bigint,
  input: UpdateCrmConnectionInput,
): Promise<CrmConnection> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('crm.update_connection');
  const existing = await loadConnection(ctx, id);
  const updates: Partial<CrmConnection> & { updatedAt: Date } = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const next = input.name.trim();
    if (!next) throw invalid('name required');
    updates.name = next;
  }
  if (input.config !== undefined) updates.config = input.config;
  if (input.status !== undefined) updates.status = input.status;
  if (input.credential !== undefined && input.credential) {
    let key = existing.credentialSecretKey;
    if (!key) {
      const slot = randomUUID().replace(/-/g, '').slice(0, 12);
      key = `crm.${existing.system}_${slot}`;
      updates.credentialSecretKey = key;
    }
    await setSecret(ctx, key, input.credential);
  }

  const [updated] = await db
    .update(crmConnections)
    .set(updates)
    .where(
      and(
        eq(crmConnections.workspaceId, ctx.workspaceId),
        eq(crmConnections.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('crm_connection update returned no row');
  await recordAuditEvent(ctx, {
    kind: 'crm.update_connection',
    entityType: 'crm_connection',
    entityId: id,
  });
  return updated;
}

export async function archiveCrmConnection(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<CrmConnection> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('crm.archive_connection');
  const [updated] = await db
    .update(crmConnections)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(
      and(
        eq(crmConnections.workspaceId, ctx.workspaceId),
        eq(crmConnections.id, id),
      ),
    )
    .returning();
  if (!updated) throw notFound('crm_connection');
  await recordAuditEvent(ctx, {
    kind: 'crm.archive_connection',
    entityType: 'crm_connection',
    entityId: id,
  });
  return updated;
}

/**
 * Undo an archive: the connection becomes active again and its last
 * error is cleared (the next test or push sets the real status). A
 * connection that is not archived is returned unchanged, so a repeated
 * click is harmless and writes no audit event.
 */
export async function restoreCrmConnection(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<CrmConnection> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('crm.restore_connection');
  const [restored] = await db
    .update(crmConnections)
    .set({ status: 'active', lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(crmConnections.workspaceId, ctx.workspaceId),
        eq(crmConnections.id, id),
        eq(crmConnections.status, 'archived'),
      ),
    )
    .returning();
  if (!restored) return loadConnection(ctx, id);
  await recordAuditEvent(ctx, {
    kind: 'crm.restore_connection',
    entityType: 'crm_connection',
    entityId: id,
  });
  return restored;
}

export async function listCrmConnections(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<CrmConnection[]> {
  return db
    .select()
    .from(crmConnections)
    .where(eq(crmConnections.workspaceId, ctx.workspaceId))
    .orderBy(asc(crmConnections.name));
}

export async function getCrmConnection(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<CrmConnection> {
  return loadConnection(ctx, id);
}

export async function testCrmConnection(
  ctx: WorkspaceContext,
  id: bigint,
  connectorOverride?: ICRMConnector,
): Promise<{ ok: boolean; detail?: string }> {
  if (!canWrite(ctx)) throw permissionDenied('crm.test');
  const conn = await loadConnection(ctx, id);
  // A test used to overwrite the status with active/failing, which
  // silently un-archived the connection (I115). Archived connections are
  // not tested; restore first.
  if (conn.status === 'archived') throw archivedConnection();
  // A connector that cannot even be built (e.g. HubSpot with no stored
  // token) is a failed test with a reason, not an unexpected error.
  let result: { ok: boolean; detail?: string };
  try {
    const connector = connectorOverride ?? (await buildConnector(ctx, conn));
    result = await connector.testConnection();
  } catch (err) {
    result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  // Guarded on status too, so an archive that lands while the test is
  // in flight is not undone by the result.
  await db
    .update(crmConnections)
    .set({
      status: result.ok ? 'active' : 'failing',
      lastError: result.ok ? null : result.detail ?? 'failed',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(crmConnections.workspaceId, ctx.workspaceId),
        eq(crmConnections.id, id),
        ne(crmConnections.status, 'archived'),
      ),
    );
  return result;
}

// ---- push ----------------------------------------------------------

/** Who pushed: a person (the lead's page) or autopilot's CRM steps. */
export type CrmPushOrigin = 'operator' | 'autopilot';

export interface PushLeadInput {
  connectionId: bigint;
  leadId: bigint;
  /** Test seam — bypass the real connector. */
  connectorOverride?: ICRMConnector;
  /** When true, transition the lead to synced_to_crm on success. */
  advanceState?: boolean;
  /** Default 'operator'. */
  origin?: CrmPushOrigin;
}

/**
 * PC-11: a succeeded push is on the lead's timeline (pipeline_events) — a
 * `transition` to synced_to_crm when the push advanced the lead, otherwise
 * `crm_contact_sync` / `crm_deal_sync` with the state unchanged. An
 * autopilot push has no person as its actor. Writing the event never
 * touches the lead row, so it does not count as a change that would make
 * autopilot push the lead again.
 */
async function logCrmPushEvent(
  ctx: WorkspaceContext,
  lead: QualifiedLead,
  input: {
    kind: 'contact' | 'deal';
    advancedTo: PipelineState | null;
    connection: CrmConnection;
    externalId: string | null;
    origin: CrmPushOrigin;
  },
): Promise<void> {
  await db.insert(pipelineEvents).values({
    workspaceId: ctx.workspaceId,
    qualifiedLeadId: lead.id,
    fromState: lead.state,
    toState: input.advancedTo ?? lead.state,
    eventKind: input.advancedTo
      ? 'transition'
      : input.kind === 'contact'
        ? 'crm_contact_sync'
        : 'crm_deal_sync',
    payload: {
      crm: input.kind,
      connectionId: input.connection.id.toString(),
      system: input.connection.system,
      externalId: input.externalId,
      origin: input.origin,
    },
    actorUserId: input.origin === 'autopilot' ? null : ctx.userId,
  });
}

export async function pushLeadToCrm(
  ctx: WorkspaceContext,
  input: PushLeadInput,
): Promise<{ entry: CrmSyncEntry; result: SyncResult }> {
  if (!canWrite(ctx)) throw permissionDenied('crm.push');
  // PC-06: manual pushes and autopilot's CRM steps alike.
  await assertGate(ctx, 'crm_sync');
  const conn = await loadConnection(ctx, input.connectionId);
  if (conn.status === 'archived') throw invalid('connection is archived');

  const leadRow = await loadLead(ctx, input.leadId);
  const productRow = await loadProduct(ctx, leadRow.productProfileId);

  const connector = input.connectorOverride ?? (await buildConnector(ctx, conn));

  // Find the most-recent succeeded CONTACT sync to reuse the externalId (a
  // deal push logs its deal id on the same lead and connection; reusing
  // that would PATCH the contact with a deal id).
  const prior = await db
    .select()
    .from(crmSyncLog)
    .where(
      and(
        eq(crmSyncLog.workspaceId, ctx.workspaceId),
        eq(crmSyncLog.qualifiedLeadId, input.leadId),
        eq(crmSyncLog.crmConnectionId, input.connectionId),
        eq(crmSyncLog.kind, 'contact'),
        eq(crmSyncLog.outcome, 'succeeded'),
      ),
    )
    .orderBy(desc(crmSyncLog.createdAt))
    .limit(1);
  const prevExternalId = prior[0]?.externalId ?? null;
  const origin = input.origin ?? 'operator';

  const payload: CrmLeadPayload = {
    lead: leadRow,
    product: productRow,
    metadata: {},
  };

  const startedAt = new Date();
  let result: SyncResult;
  try {
    result = await connector.push(payload, prevExternalId);
  } catch (err) {
    result = {
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
      payload: {},
      response: {},
    };
  }
  const finishedAt = new Date();

  const row: NewCrmSyncEntry = {
    workspaceId: ctx.workspaceId,
    crmConnectionId: input.connectionId,
    qualifiedLeadId: input.leadId,
    kind: 'contact',
    outcome: result.outcome,
    externalId: result.externalId ?? prevExternalId,
    statusCode: result.statusCode ?? null,
    error: result.error ?? null,
    payload: result.payload,
    response: result.response,
    triggeredBy: ctx.userId,
    startedAt,
    finishedAt,
  };
  const [entry] = await db.insert(crmSyncLog).values(row).returning();
  if (!entry) throw invariant('crm_sync_log insert returned no row');

  // Update connection status on outcome — unless it was archived while
  // the push was in flight (an archive must not be undone by a result).
  await db
    .update(crmConnections)
    .set({
      status: result.outcome === 'succeeded' ? 'active' : 'failing',
      lastError: result.outcome === 'succeeded' ? null : result.error ?? 'failed',
      lastSyncedAt: result.outcome === 'succeeded' ? new Date() : conn.lastSyncedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(crmConnections.workspaceId, ctx.workspaceId),
        eq(crmConnections.id, input.connectionId),
        ne(crmConnections.status, 'archived'),
      ),
    );

  // Optional state advance.
  if (result.outcome === 'succeeded') {
    const advance =
      input.advanceState === true &&
      leadRow.state !== 'synced_to_crm' &&
      leadRow.state !== 'closed';
    if (advance) {
      await db
        .update(qualifiedLeads)
        .set({
          state: 'synced_to_crm',
          syncedAt: new Date(),
          crmExternalId: entry.externalId ?? leadRow.crmExternalId,
          crmSystem: conn.system,
          updatedAt: new Date(),
        })
        .where(
          and(eq(qualifiedLeads.workspaceId, ctx.workspaceId), eq(qualifiedLeads.id, input.leadId)),
        );
    }
    await logCrmPushEvent(ctx, leadRow, {
      kind: 'contact',
      advancedTo: advance ? 'synced_to_crm' : null,
      connection: conn,
      externalId: entry.externalId ?? null,
      origin,
    });
  }

  await recordAuditEvent(ctx, {
    kind: 'crm.push',
    entityType: 'qualified_lead',
    entityId: input.leadId,
    payload: {
      connectionId: input.connectionId.toString(),
      outcome: result.outcome,
      externalId: entry.externalId ?? null,
      origin,
    },
  });

  return { entry, result };
}

// ---- notes + deals (Phase 18) -------------------------------------

export interface PushThreadAsNotesInput {
  connectionId: bigint;
  threadId: bigint;
  /** Test seam. */
  connectorOverride?: ICRMConnector;
}

export async function pushThreadAsNotes(
  ctx: WorkspaceContext,
  input: PushThreadAsNotesInput,
): Promise<{ inserted: number; skipped: number; failed: number }> {
  if (!canWrite(ctx)) throw permissionDenied('crm.push_notes');
  await assertGate(ctx, 'crm_sync');
  const conn = await loadConnection(ctx, input.connectionId);
  if (conn.status === 'archived') throw invalid('connection is archived');

  const threadRows = await db
    .select()
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.workspaceId, ctx.workspaceId),
        eq(mailThreads.id, input.threadId),
      ),
    )
    .limit(1);
  if (!threadRows[0]) throw notFound('mail_thread');
  const thread: MailThread = threadRows[0];

  const messages = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, thread.id),
      ),
    )
    .orderBy(asc(mailMessages.createdAt));

  if (messages.length === 0) {
    return { inserted: 0, skipped: 0, failed: 0 };
  }

  // Find a qualified_lead via mail_messages.contact_id ↔ contact_associations.
  // For simplicity here we take the first message's contact and look up its
  // most-recent qualified_lead association.
  const firstContactId = messages.find((m) => m.contactId !== null)?.contactId ?? null;
  if (!firstContactId) {
    return { inserted: 0, skipped: messages.length, failed: 0 };
  }

  const leadAssoc = await db
    .select({ lead: qualifiedLeads })
    .from(qualifiedLeads)
    .innerJoin(
      contactAssociations,
      and(
        eq(contactAssociations.entityType, 'qualified_lead'),
        sql`${contactAssociations.entityId} = ${qualifiedLeads.id}::text`,
      ),
    )
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(contactAssociations.contactId, firstContactId),
      ),
    )
    .limit(1);
  const lead = leadAssoc[0]?.lead;
  if (!lead) {
    return { inserted: 0, skipped: messages.length, failed: 0 };
  }

  // The contact's CRM externalId is required — look up via the most-recent
  // succeeded contact-kind sync for this lead.
  const contactSync = await db
    .select()
    .from(crmSyncLog)
    .where(
      and(
        eq(crmSyncLog.workspaceId, ctx.workspaceId),
        eq(crmSyncLog.crmConnectionId, input.connectionId),
        eq(crmSyncLog.qualifiedLeadId, lead.id),
        eq(crmSyncLog.kind, 'contact'),
        eq(crmSyncLog.outcome, 'succeeded'),
      ),
    )
    .orderBy(desc(crmSyncLog.createdAt))
    .limit(1);
  const contactExternalId = contactSync[0]?.externalId ?? null;
  if (!contactExternalId) {
    throw conflict('push contact first — no externalId for this lead on this CRM');
  }

  const dealSync = await db
    .select()
    .from(crmSyncLog)
    .where(
      and(
        eq(crmSyncLog.workspaceId, ctx.workspaceId),
        eq(crmSyncLog.crmConnectionId, input.connectionId),
        eq(crmSyncLog.qualifiedLeadId, lead.id),
        eq(crmSyncLog.kind, 'deal'),
        eq(crmSyncLog.outcome, 'succeeded'),
      ),
    )
    .orderBy(desc(crmSyncLog.createdAt))
    .limit(1);
  const dealExternalId = dealSync[0]?.externalId ?? undefined;

  const connector = input.connectorOverride ?? (await buildConnector(ctx, conn));
  if (!connector.pushNote) {
    return { inserted: 0, skipped: messages.length, failed: 0 };
  }

  let inserted = 0;
  let failed = 0;
  let skipped = 0;
  for (const msg of messages) {
    // De-dup: skip messages we've already pushed as notes for this connection.
    const prior = await db
      .select()
      .from(crmSyncLog)
      .where(
        and(
          eq(crmSyncLog.workspaceId, ctx.workspaceId),
          eq(crmSyncLog.crmConnectionId, input.connectionId),
          eq(crmSyncLog.kind, 'note'),
          eq(crmSyncLog.relatedMessageId, msg.id),
          eq(crmSyncLog.outcome, 'succeeded'),
        ),
      )
      .limit(1);
    if (prior[0]) {
      skipped++;
      continue;
    }
    const startedAt = new Date();
    const result = await connector.pushNote({
      contactExternalId,
      dealExternalId,
      message: msg,
      thread,
    });
    const finishedAt = new Date();
    await db.insert(crmSyncLog).values({
      workspaceId: ctx.workspaceId,
      crmConnectionId: input.connectionId,
      qualifiedLeadId: lead.id,
      kind: 'note',
      relatedMessageId: msg.id,
      outcome: result.outcome,
      externalId: result.externalId ?? null,
      statusCode: result.statusCode ?? null,
      error: result.error ?? null,
      payload: result.payload,
      response: result.response,
      triggeredBy: ctx.userId,
      startedAt,
      finishedAt,
    } satisfies NewCrmSyncEntry);
    if (result.outcome === 'succeeded') inserted++;
    else if (result.outcome === 'skipped') skipped++;
    else failed++;
  }

  await recordAuditEvent(ctx, {
    kind: 'crm.push_notes',
    entityType: 'mail_thread',
    entityId: thread.id,
    payload: {
      connectionId: input.connectionId.toString(),
      messageCount: messages.length,
      inserted,
      skipped,
      failed,
    },
  });

  return { inserted, skipped, failed };
}

export interface PushDealInput {
  connectionId: bigint;
  leadId: bigint;
  connectorOverride?: ICRMConnector;
  /** Default 'operator'. */
  origin?: CrmPushOrigin;
}

export async function pushDeal(
  ctx: WorkspaceContext,
  input: PushDealInput,
): Promise<{ entry: CrmSyncEntry; result: SyncResult }> {
  if (!canWrite(ctx)) throw permissionDenied('crm.push_deal');
  await assertGate(ctx, 'crm_sync');
  const conn = await loadConnection(ctx, input.connectionId);
  if (conn.status === 'archived') throw invalid('connection is archived');
  const lead = await loadLead(ctx, input.leadId);
  const product = await loadProduct(ctx, lead.productProfileId);

  // Need a contact externalId — look up the latest successful contact push.
  const contactSync = await db
    .select()
    .from(crmSyncLog)
    .where(
      and(
        eq(crmSyncLog.workspaceId, ctx.workspaceId),
        eq(crmSyncLog.crmConnectionId, input.connectionId),
        eq(crmSyncLog.qualifiedLeadId, lead.id),
        eq(crmSyncLog.kind, 'contact'),
        eq(crmSyncLog.outcome, 'succeeded'),
      ),
    )
    .orderBy(desc(crmSyncLog.createdAt))
    .limit(1);
  const contactExternalId = contactSync[0]?.externalId ?? null;
  if (!contactExternalId) {
    throw conflict('push contact first — no externalId for this lead on this CRM');
  }

  const prior = await db
    .select()
    .from(crmSyncLog)
    .where(
      and(
        eq(crmSyncLog.workspaceId, ctx.workspaceId),
        eq(crmSyncLog.crmConnectionId, input.connectionId),
        eq(crmSyncLog.qualifiedLeadId, lead.id),
        eq(crmSyncLog.kind, 'deal'),
        eq(crmSyncLog.outcome, 'succeeded'),
      ),
    )
    .orderBy(desc(crmSyncLog.createdAt))
    .limit(1);
  const prevDealId = prior[0]?.externalId ?? null;

  const connector = input.connectorOverride ?? (await buildConnector(ctx, conn));
  if (!connector.pushDeal) {
    throw invalid(`adapter ${conn.system} does not support deals`);
  }

  const startedAt = new Date();
  let result: SyncResult;
  try {
    result = await connector.pushDeal(
      { lead, product, contactExternalId },
      prevDealId,
    );
  } catch (err) {
    result = {
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
      payload: {},
      response: {},
    };
  }
  const finishedAt = new Date();

  const [entry] = await db
    .insert(crmSyncLog)
    .values({
      workspaceId: ctx.workspaceId,
      crmConnectionId: input.connectionId,
      qualifiedLeadId: lead.id,
      kind: 'deal',
      outcome: result.outcome,
      externalId: result.externalId ?? prevDealId,
      statusCode: result.statusCode ?? null,
      error: result.error ?? null,
      payload: result.payload,
      response: result.response,
      triggeredBy: ctx.userId,
      startedAt,
      finishedAt,
    } satisfies NewCrmSyncEntry)
    .returning();
  if (!entry) throw invariant('crm_sync_log insert returned no row');

  const origin = input.origin ?? 'operator';
  if (result.outcome === 'succeeded') {
    await logCrmPushEvent(ctx, lead, {
      kind: 'deal',
      advancedTo: null,
      connection: conn,
      externalId: entry.externalId ?? null,
      origin,
    });
  }

  await recordAuditEvent(ctx, {
    kind: 'crm.push_deal',
    entityType: 'qualified_lead',
    entityId: lead.id,
    payload: {
      connectionId: input.connectionId.toString(),
      outcome: result.outcome,
      externalId: entry.externalId,
      origin,
    },
  });

  return { entry, result };
}

// ---- CSV bulk export ----------------------------------------------

export interface BulkExportInput {
  /** Optional: limit by state. Default exports everything. */
  states?: ReadonlyArray<PipelineState>;
  productProfileId?: bigint;
}

export interface BulkExportResult {
  csv: string;
  storageKey: string;
  /** The export's file name inside this workspace's exports folder. */
  fileName: string;
  /** Download link (csvExportDownloadPath) the caller can offer. */
  url: string;
  rowCount: number;
}

// `leads-<epoch ms>-<8 hex>.csv`, exactly what exportLeadsToCsv writes.
// Anything else is refused before it can reach a storage key.
const CSV_EXPORT_FILE_RE = /^leads-\d{1,16}-[0-9a-f]{8}\.csv$/;

/** True for a file name exportLeadsToCsv could have produced. */
export function isCsvExportFileName(value: unknown): value is string {
  return typeof value === 'string' && CSV_EXPORT_FILE_RE.test(value);
}

/** The authenticated download link for a CSV export of the caller's
 *  workspace. The route re-derives the storage key from the session's
 *  workspace, so the link is useless outside that workspace. */
export function csvExportDownloadPath(fileName: string): string {
  return `/api/crm/exports/${encodeURIComponent(fileName)}`;
}

function csvExportKey(workspaceId: bigint, fileName: string): string {
  return `workspaces/${workspaceId}/exports/${fileName}`;
}

export async function exportLeadsToCsv(
  ctx: WorkspaceContext,
  input: BulkExportInput = {},
  storageOverride?: IStorage,
): Promise<BulkExportResult> {
  if (!canWrite(ctx)) throw permissionDenied('crm.export_csv');
  const conditions: SQL[] = [eq(qualifiedLeads.workspaceId, ctx.workspaceId)];
  if (input.states && input.states.length > 0) {
    conditions.push(inArray(qualifiedLeads.state, input.states as PipelineState[]));
  }
  if (input.productProfileId !== undefined) {
    conditions.push(eq(qualifiedLeads.productProfileId, input.productProfileId));
  }
  const rows = await db
    .select({ lead: qualifiedLeads, product: productProfiles })
    .from(qualifiedLeads)
    .innerJoin(productProfiles, eq(productProfiles.id, qualifiedLeads.productProfileId))
    .where(and(...conditions))
    .orderBy(desc(qualifiedLeads.updatedAt));

  const records = rows.map((r) =>
    csvRowFor({ lead: r.lead, product: r.product, metadata: {} }),
  );
  const csv = rowsToCsv(records);

  const storage = storageOverride ?? getStorage();
  const fileName = `leads-${Date.now()}-${randomUUID().slice(0, 8)}.csv`;
  const key = csvExportKey(ctx.workspaceId, fileName);
  await storage.put(key, Buffer.from(csv, 'utf8'), { contentType: 'text/csv' });

  await recordAuditEvent(ctx, {
    kind: 'crm.export_csv',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: {
      rowCount: records.length,
      storageKey: key,
      states: input.states ?? [],
    },
  });

  return {
    csv,
    storageKey: key,
    fileName,
    url: csvExportDownloadPath(fileName),
    rowCount: records.length,
  };
}

/**
 * Stream a CSV export back for GET /api/crm/exports/[file]. Same
 * permission as creating one. The key is built from ctx.workspaceId, so
 * another workspace's file name resolves to nothing here: `not_found`,
 * the same as a name that never existed.
 */
export async function streamCsvExport(
  ctx: WorkspaceContext,
  fileName: string,
  storageOverride?: IStorage,
): Promise<{ fileName: string; stream: Readable }> {
  if (!canWrite(ctx)) throw permissionDenied('crm.export_csv');
  if (!isCsvExportFileName(fileName)) throw notFound('csv export');
  const storage = storageOverride ?? getStorage();
  try {
    const stream = await storage.get(csvExportKey(ctx.workspaceId, fileName));
    return { fileName, stream };
  } catch (err) {
    if (err instanceof StorageObjectNotFoundError) throw notFound('csv export');
    throw err;
  }
}

// ---- read ---------------------------------------------------------

export async function listSyncEntries(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: { connectionId?: bigint; leadId?: bigint; limit?: number } = {},
): Promise<CrmSyncEntry[]> {
  const conditions: SQL[] = [eq(crmSyncLog.workspaceId, ctx.workspaceId)];
  if (filter.connectionId !== undefined) {
    conditions.push(eq(crmSyncLog.crmConnectionId, filter.connectionId));
  }
  if (filter.leadId !== undefined) {
    conditions.push(eq(crmSyncLog.qualifiedLeadId, filter.leadId));
  }
  return db
    .select()
    .from(crmSyncLog)
    .where(and(...conditions))
    .orderBy(desc(crmSyncLog.createdAt))
    .limit(Math.min(filter.limit ?? 100, 1000));
}

// ---- internals ----------------------------------------------------

async function loadConnection(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<CrmConnection> {
  const rows = await db
    .select()
    .from(crmConnections)
    .where(
      and(
        eq(crmConnections.workspaceId, ctx.workspaceId),
        eq(crmConnections.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('crm_connection');
  return rows[0];
}

async function loadLead(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<QualifiedLead> {
  const rows = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('qualified_lead');
  return rows[0];
}

async function loadProduct(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<ProductProfile> {
  const rows = await db
    .select()
    .from(productProfiles)
    .where(
      and(
        eq(productProfiles.workspaceId, ctx.workspaceId),
        eq(productProfiles.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('product_profile');
  return rows[0];
}

async function buildConnector(
  ctx: WorkspaceContext,
  conn: CrmConnection,
): Promise<ICRMConnector> {
  const credential = conn.credentialSecretKey
    ? (await getSecret(ctx, conn.credentialSecretKey)) ?? null
    : null;
  return createCrmConnector(conn.system, {
    config: conn.config as Record<string, unknown>,
    credential,
  });
}

void CSV_COLUMNS;
