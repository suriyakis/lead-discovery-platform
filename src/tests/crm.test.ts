import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { crmConnections, crmSyncLog } from '@/lib/db/schema/crm';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import { ensureQualifiedLead, transition, updateContact } from '@/lib/services/pipeline';
import {
  CrmServiceError,
  archiveCrmConnection,
  createCrmConnection,
  exportLeadsToCsv,
  listCrmConnections,
  listSyncEntries,
  pushLeadToCrm,
  testCrmConnection,
  updateCrmConnection,
} from '@/lib/services/crm';
import { reviewItems } from '@/lib/db/schema/review';
import {
  CsvCrmConnector,
  rowsToCsv,
  type ICRMConnector,
  type SyncResult,
} from '@/lib/crm';
import { LocalFileStorage, _setStorageForTests } from '@/lib/storage';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner'): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

let storageRoot: string;
let storage: LocalFileStorage;

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'lead-crm-'));
  storage = new LocalFileStorage(storageRoot);
  _setStorageForTests(storage);
  await truncateAll();
});

afterEach(async () => {
  _setStorageForTests(null);
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function seedLead(s: Setup) {
  const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
    name: 'P',
  });
  const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    name: 'r',
    selectors: { seed: 'crm', count: 1 },
  });
  await startRun(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    recipeId: r.id,
    wait: true,
  });
  const reviews = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, s.workspaceA));
  const lead = await ensureQualifiedLead(
    ctx(s.workspaceA, s.ownerA),
    reviews[0]!.id,
    product.id,
  );
  await updateContact(ctx(s.workspaceA, s.ownerA), lead.id, {
    contactName: 'Anna Kowalska',
    contactEmail: 'anna@target.com',
    contactRole: 'Procurement Lead',
  });
  return { product, lead };
}

// ============ CSV export pure ===========================================

describe('rowsToCsv (pure)', () => {
  it('renders the header even on empty input', () => {
    const out = rowsToCsv([]);
    expect(out.startsWith('lead_id,product_name')).toBe(true);
    expect(out.includes('\n')).toBe(false);
  });

  it('escapes values containing commas, quotes, newlines', () => {
    const out = rowsToCsv([
      {
        lead_id: '1',
        product_name: 'Acme, Inc',
        state: 'qualified',
        contact_name: 'A "B" C',
        contact_email: '',
        contact_role: '',
        contact_phone: '',
        tags: '',
        notes: 'line1\nline2',
        relevant_at: '',
        contacted_at: '',
        qualified_at: '',
        closed_at: '',
        close_reason: '',
        updated_at: '',
      },
    ]);
    expect(out).toContain('"Acme, Inc"');
    expect(out).toContain('"A ""B"" C"');
    expect(out).toContain('"line1\nline2"');
  });
});

// ============ CRM connection CRUD =======================================

describe('crm connection CRUD', () => {
  it('create + list + archive (admin-only)', async () => {
    const s = await setup();
    const c = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'csv',
      name: 'CSV exports',
    });
    expect(c.system).toBe('csv');
    expect(c.credentialSecretKey).toBe(null);
    const list = await listCrmConnections(ctx(s.workspaceA, s.ownerA));
    expect(list.map((x) => x.id)).toEqual([c.id]);

    await expect(
      createCrmConnection(ctx(s.workspaceA, s.ownerA, 'member'), {
        system: 'csv',
        name: 'denied',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    const archived = await archiveCrmConnection(ctx(s.workspaceA, s.ownerA), c.id);
    expect(archived.status).toBe('archived');
  });

  it('refuses unknown system', async () => {
    const s = await setup();
    await expect(
      createCrmConnection(ctx(s.workspaceA, s.ownerA), {
        system: 'salesforce',
        name: 'X',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('hubspot create stores credential as a secret key', async () => {
    const s = await setup();
    const c = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'hubspot',
      name: 'HubSpot prod',
      credential: 'pat-eu1-XXX',
    });
    expect(c.credentialSecretKey).toMatch(/^crm\.hubspot_[0-9a-f]{12}$/);
    // The cleartext token must NOT live in the row JSON.
    const raw = JSON.stringify(c, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(raw).not.toContain('pat-eu1-XXX');
  });

  it('updateCrmConnection rotates the credential without persisting cleartext', async () => {
    const s = await setup();
    const c = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'hubspot',
      name: 'HubSpot',
      credential: 'pat-original',
    });
    const updated = await updateCrmConnection(ctx(s.workspaceA, s.ownerA), c.id, {
      credential: 'pat-rotated',
    });
    const raw = JSON.stringify(updated, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(raw).not.toContain('pat-rotated');
  });

  it('testCrmConnection records status and clears error on ok', async () => {
    const s = await setup();
    const c = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'csv',
      name: 'X',
    });
    const res = await testCrmConnection(ctx(s.workspaceA, s.ownerA), c.id);
    expect(res.ok).toBe(true);
    const reloaded = await db
      .select()
      .from(crmConnections)
      .where(eq(crmConnections.id, c.id));
    expect(reloaded[0]!.status).toBe('active');
  });
});

// ============ Push lead to CRM =========================================

describe('pushLeadToCrm', () => {
  function fakeOk(externalId = 'h-123'): ICRMConnector {
    return {
      id: 'fake',
      async push(): Promise<SyncResult> {
        return {
          outcome: 'succeeded',
          externalId,
          payload: { ok: true },
          response: { id: externalId },
        };
      },
      async testConnection() {
        return { ok: true };
      },
    };
  }

  it('persists a sync entry, sets connection lastSyncedAt, captures externalId', async () => {
    const s = await setup();
    const conn = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'hubspot',
      name: 'HubSpot',
      credential: 'pat-test',
    });
    const { lead } = await seedLead(s);

    const result = await pushLeadToCrm(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      leadId: lead.id,
      connectorOverride: fakeOk('hs-001'),
    });
    expect(result.entry.outcome).toBe('succeeded');
    expect(result.entry.externalId).toBe('hs-001');
    const reloadedConn = await db
      .select()
      .from(crmConnections)
      .where(eq(crmConnections.id, conn.id));
    expect(reloadedConn[0]!.status).toBe('active');
    expect(reloadedConn[0]!.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('reuses prior externalId on second push (update path)', async () => {
    const s = await setup();
    const conn = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'hubspot',
      name: 'HubSpot',
      credential: 'pat-test',
    });
    const { lead } = await seedLead(s);
    let observedPrev: string | null = null;
    const recorder: ICRMConnector = {
      id: 'rec',
      async push(_input, prev): Promise<SyncResult> {
        observedPrev = prev;
        return {
          outcome: 'succeeded',
          externalId: prev ?? 'hs-new',
          payload: {},
          response: {},
        };
      },
      async testConnection() {
        return { ok: true };
      },
    };
    await pushLeadToCrm(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      leadId: lead.id,
      connectorOverride: recorder,
    });
    expect(observedPrev).toBe(null);
    await pushLeadToCrm(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      leadId: lead.id,
      connectorOverride: recorder,
    });
    expect(observedPrev).toBe('hs-new');
  });

  it('records failure outcome, marks connection failing', async () => {
    const s = await setup();
    const conn = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'hubspot',
      name: 'HubSpot',
      credential: 'pat-test',
    });
    const { lead } = await seedLead(s);
    const failer: ICRMConnector = {
      id: 'fail',
      async push() {
        return {
          outcome: 'failed',
          statusCode: 500,
          error: 'upstream',
          payload: {},
          response: { error: 'boom' },
        };
      },
      async testConnection() {
        return { ok: false, detail: 'no' };
      },
    };
    const r = await pushLeadToCrm(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      leadId: lead.id,
      connectorOverride: failer,
    });
    expect(r.entry.outcome).toBe('failed');
    expect(r.entry.statusCode).toBe(500);
    const reloadedConn = await db
      .select()
      .from(crmConnections)
      .where(eq(crmConnections.id, conn.id));
    expect(reloadedConn[0]!.status).toBe('failing');
    expect(reloadedConn[0]!.lastError).toBe('upstream');
  });

  it('advanceState moves the lead to synced_to_crm on success', async () => {
    const s = await setup();
    const conn = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'hubspot',
      name: 'X',
      credential: 'pat',
    });
    const { lead } = await seedLead(s);
    // Walk to qualified first so synced_to_crm is a forward move.
    await transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'contacted' });
    await transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'replied' });
    await transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'contact_identified' });
    await transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'qualified' });
    await transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'handed_over' });

    await pushLeadToCrm(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      leadId: lead.id,
      connectorOverride: fakeOk('hs-final'),
      advanceState: true,
    });
    const reloaded = await db
      .select()
      .from(qualifiedLeads)
      .where(eq(qualifiedLeads.id, lead.id));
    expect(reloaded[0]!.state).toBe('synced_to_crm');
    expect(reloaded[0]!.crmExternalId).toBe('hs-final');
    expect(reloaded[0]!.crmSystem).toBe('hubspot');
  });

  it('cross-workspace lead refused', async () => {
    const s = await setup();
    const connA = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'csv',
      name: 'X',
    });
    const { lead: leadA } = await seedLead(s);
    await expect(
      pushLeadToCrm(ctx(s.workspaceB, s.ownerB), {
        connectionId: connA.id,
        leadId: leadA.id,
        connectorOverride: new CsvCrmConnector(),
      }),
    ).rejects.toBeInstanceOf(CrmServiceError);
  });
});

// ============ CSV bulk export ==========================================

describe('exportLeadsToCsv', () => {
  it('writes a CSV file to storage and returns row count', async () => {
    const s = await setup();
    await seedLead(s);
    const result = await exportLeadsToCsv(
      ctx(s.workspaceA, s.ownerA),
      {},
      storage,
    );
    expect(result.rowCount).toBe(1);
    expect(result.csv).toContain('Anna Kowalska');
    expect(result.csv.split('\n')[0]).toContain('lead_id,product_name');
    expect(await storage.exists(result.storageKey)).toBe(true);
  });

  it('respects state filter', async () => {
    const s = await setup();
    const { lead } = await seedLead(s);
    await transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'contacted' });
    const onlyRelevant = await exportLeadsToCsv(
      ctx(s.workspaceA, s.ownerA),
      { states: ['relevant'] },
      storage,
    );
    expect(onlyRelevant.rowCount).toBe(0);
    const onlyContacted = await exportLeadsToCsv(
      ctx(s.workspaceA, s.ownerA),
      { states: ['contacted'] },
      storage,
    );
    expect(onlyContacted.rowCount).toBe(1);
  });

  it('does not include leads from another workspace', async () => {
    const s = await setup();
    await seedLead(s); // workspace A
    const inB = await exportLeadsToCsv(ctx(s.workspaceB, s.ownerB), {}, storage);
    expect(inB.rowCount).toBe(0);
  });
});

// ============ listSyncEntries ==========================================

describe('listSyncEntries', () => {
  it('returns workspace-scoped entries newest-first', async () => {
    const s = await setup();
    const conn = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'hubspot',
      name: 'X',
      credential: 'pat',
    });
    const { lead } = await seedLead(s);
    const fakeOk: ICRMConnector = {
      id: 'fake',
      async push() {
        return {
          outcome: 'succeeded',
          externalId: 'h-1',
          payload: {},
          response: {},
        };
      },
      async testConnection() {
        return { ok: true };
      },
    };
    await pushLeadToCrm(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      leadId: lead.id,
      connectorOverride: fakeOk,
    });

    const rows = await listSyncEntries(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe('succeeded');

    const inB = await listSyncEntries(ctx(s.workspaceB, s.ownerB));
    expect(inB).toEqual([]);
    void crmSyncLog;
  });
});
