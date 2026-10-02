// KL-02 migration: p1_knowledge_foundation_learning_knowledge applies on a
// database with pre-KL-02 learning events and qualifications (they keep
// their data and take the documented defaults), its CHECK constraints hold,
// and drizzle/rollback/…learning_knowledge.down.sql restores the previous
// shape. Runs in its own scratch database (<test db>_kl02mig), like the
// KL-01 migration test.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const drizzleDir = path.join(repoRoot, 'drizzle');
const TAG = '_p1_knowledge_foundation_learning_knowledge';
const ROLLBACK_FILE = path.join(
  drizzleDir,
  'rollback',
  'p1_knowledge_foundation_learning_knowledge.down.sql',
);

const baseUrl = new URL(
  process.env.DATABASE_URL ?? 'postgres://lead:lead@localhost:5432/lead_test',
);
const scratchName = `${baseUrl.pathname.replace(/^\//, '')}_kl02mig`.slice(0, 60);
const scratchUrl = new URL(baseUrl.toString());
scratchUrl.pathname = `/${scratchName}`;
const adminUrl = new URL(baseUrl.toString());
adminUrl.pathname = '/postgres';

const journal = JSON.parse(
  readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string; when: number }> };
const migrationIdx = journal.entries.findIndex((e) => e.tag.endsWith(TAG));

const tempDirs: string[] = [];
function migrationsUpTo(count: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kl02-mig-'));
  tempDirs.push(dir);
  cpSync(drizzleDir, dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }, null, 2),
  );
  return dir;
}

let admin: postgres.Sql;
let client: postgres.Sql;

async function migrateTo(count: number): Promise<void> {
  await migrate(drizzle(client), { migrationsFolder: migrationsUpTo(count) });
}

async function shape() {
  const tables = ['learning_events', 'qualifications'];
  const columns = await client`
    SELECT table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
           || ' default=' || coalesce(column_default, '-') AS c
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ${client(tables)}
    ORDER BY 1`;
  const constraints = await client`
    SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS c
    FROM pg_constraint
    WHERE conrelid IN ('public.learning_events'::regclass, 'public.qualifications'::regclass)
    ORDER BY 1`;
  const indexes = await client`
    SELECT indexdef AS c FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN ${client(tables)}
    ORDER BY 1`;
  const extra = await client`
    SELECT 'table ' || table_name AS c FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'learning_decisions'`;
  return {
    columns: columns.map((r) => r.c as string),
    constraints: constraints.map((r) => r.c as string),
    indexes: indexes.map((r) => r.c as string),
    tables: extra.map((r) => r.c as string),
  };
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratchName) || !scratchName.includes('lead_test')) {
    throw new Error(`refusing scratch database name ${scratchName}`);
  }
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  const existing = await admin`
    SELECT datconnlimit FROM pg_database WHERE datname = ${scratchName}`;
  if (existing[0]?.datconnlimit === -2) {
    await admin.unsafe(`DROP DATABASE "${scratchName}"`);
  }
  if (existing.length === 0 || existing[0]?.datconnlimit === -2) {
    await admin.unsafe(`CREATE DATABASE "${scratchName}"`);
  }
  await admin.end({ timeout: 5 });
  client = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
  await client.unsafe(
    'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
  );
}, 120_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}, 30_000);

describe('KL-02 migration on a seeded database', () => {
  it('applies over pre-KL-02 rows, enforces its checks, and the rollback restores the previous shape', async () => {
    expect(migrationIdx).toBeGreaterThan(0);
    await migrateTo(migrationIdx);
    const before = await shape();
    expect(before.tables).toEqual([]);

    // Pre-KL-02 rows: a review event and a qualification.
    await client`INSERT INTO users (id, email) VALUES ('u-a', 'a@kl02.test')`;
    const [ws] = await client`
      INSERT INTO workspaces (name, slug, owner_user_id) VALUES ('A', 'kl02-a', 'u-a') RETURNING id`;
    const wsId = String(ws!.id);
    const [p] = await client`
      INSERT INTO product_profiles (workspace_id, name) VALUES (${wsId}, 'P') RETURNING id`;
    const [sr] = await client`
      INSERT INTO source_records (workspace_id, source_system, source_id, raw_data, normalized_data)
      VALUES (${wsId}, 'mock', 'kl02-1', '{}'::jsonb, '{}'::jsonb) RETURNING id`;
    const [q] = await client`
      INSERT INTO qualifications (workspace_id, source_record_id, product_profile_id, is_relevant,
                                  relevance_score, confidence, method)
      VALUES (${wsId}, ${String(sr!.id)}, ${String(p!.id)}, true, 80, 70, 'ai') RETURNING id`;
    const [ev] = await client`
      INSERT INTO learning_events (workspace_id, user_id, entity_type, entity_id,
                                   product_profile_id, action_type, original_comment)
      VALUES (${wsId}, 'u-a', 'review_item', '1', ${String(p!.id)}, 'qualification_positive', 'good')
      RETURNING id`;

    await migrateTo(migrationIdx + 1);
    const after = await shape();
    expect(after.tables).toEqual(['table learning_decisions']);

    const [legacy] = await client`
      SELECT decision_id, origin, verdict, polarity, weight::text AS weight, explicit,
             reason_codes, context, processing_status, attempts, voided_at, overrides_autopilot
      FROM learning_events WHERE id = ${String(ev!.id)}`;
    expect(legacy).toMatchObject({
      decision_id: null,
      origin: 'operator',
      verdict: null,
      polarity: 0,
      weight: '1.00',
      explicit: false,
      reason_codes: [],
      context: {},
      processing_status: 'done',
      attempts: 0,
      voided_at: null,
      overrides_autopilot: false,
    });
    const [qual] = await client`
      SELECT operator_verdict, operator_decided_at, geo_confirmed_at
      FROM qualifications WHERE id = ${String(q!.id)}`;
    expect(qual).toEqual({
      operator_verdict: null,
      operator_decided_at: null,
      geo_confirmed_at: null,
    });

    // The checks hold.
    await expect(
      client`UPDATE learning_events SET processing_status = 'bogus' WHERE id = ${String(ev!.id)}`,
    ).rejects.toThrow(/learning_events_processing_status_check/);
    await expect(
      client`UPDATE learning_events SET void_reason = 'changed_mind' WHERE id = ${String(ev!.id)}`,
    ).rejects.toThrow(/learning_events_voided_check/);
    await expect(
      client`UPDATE learning_events SET weight = 0 WHERE id = ${String(ev!.id)}`,
    ).rejects.toThrow(/learning_events_weight_check/);
    await expect(
      client`UPDATE qualifications SET operator_verdict = 'maybe', operator_decided_at = now()
             WHERE id = ${String(q!.id)}`,
    ).rejects.toThrow(/qualifications_operator_verdict_check/);
    await expect(
      client`UPDATE qualifications SET operator_verdict = 'fit' WHERE id = ${String(q!.id)}`,
    ).rejects.toThrow(/qualifications_operator_decided_check/);
    // A decision key is unique per workspace; an event joins only a
    // decision of its own workspace.
    const [d] = await client`
      INSERT INTO learning_decisions (workspace_id, decision_key, kind, origin, subject_type)
      VALUES (${wsId}, 'key-00000001', 'review.approve', 'operator', 'review_item') RETURNING id`;
    await expect(
      client`INSERT INTO learning_decisions (workspace_id, decision_key, kind, origin, subject_type)
             VALUES (${wsId}, 'key-00000001', 'review.reject', 'operator', 'review_item')`,
    ).rejects.toThrow(/learning_decisions_ws_key_unique/);
    await client`
      INSERT INTO learning_events (workspace_id, action_type, decision_id, origin, processing_status)
      VALUES (${wsId}, 'qualification_positive', ${d!.id as string}, 'operator', 'pending')`;

    // ---- rollback ----
    await client.unsafe(readFileSync(ROLLBACK_FILE, 'utf8'));
    expect(await shape()).toEqual(before);
    const [kept] = await client`
      SELECT action_type, original_comment FROM learning_events WHERE id = ${String(ev!.id)}`;
    expect(kept).toEqual({ action_type: 'qualification_positive', original_comment: 'good' });
  }, 120_000);
});
