// KL-03 migration: p1_knowledge_foundation_learning_knowledge applies on a
// database with pre-lane learning events and lessons (they keep their data),
// the ledger's constraints hold (one forward row per (event, rule), one
// compensation per row, delta = after - before, same-tenant rule), and
// drizzle/rollback/…learning_knowledge.down.sql restores the previous
// shape. Runs in its own scratch database (<test db>_kl03mig), like the
// KL-01 / KL-02 migration tests.

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
const scratchName = `${baseUrl.pathname.replace(/^\//, '')}_kl03mig`.slice(0, 60);
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kl03-mig-'));
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
  const tables = ['learning_events', 'learning_lessons'];
  const columns = await client`
    SELECT table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
           || ' default=' || coalesce(column_default, '-') AS c
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ${client(tables)}
    ORDER BY 1`;
  const constraints = await client`
    SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS c
    FROM pg_constraint
    WHERE conrelid IN ('public.learning_events'::regclass, 'public.learning_lessons'::regclass)
    ORDER BY 1`;
  const indexes = await client`
    SELECT indexdef AS c FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN ${client(tables)}
    ORDER BY 1`;
  const extra = await client`
    SELECT 'table ' || table_name AS c FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'lesson_reinforcements'`;
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

describe('KL-03 migration on a seeded database', () => {
  it('applies over pre-lane rows, enforces the ledger constraints, and the rollback restores the previous shape', async () => {
    expect(migrationIdx).toBeGreaterThan(0);
    await migrateTo(migrationIdx);
    const before = await shape();
    expect(before.tables).toEqual([]);

    // Pre-lane rows: two workspaces, a review event and a rule in each.
    await client`INSERT INTO users (id, email) VALUES ('u-a', 'a@kl03.test'), ('u-b', 'b@kl03.test')`;
    const [wsA] = await client`
      INSERT INTO workspaces (name, slug, owner_user_id) VALUES ('A', 'kl03-a', 'u-a') RETURNING id`;
    const [wsB] = await client`
      INSERT INTO workspaces (name, slug, owner_user_id) VALUES ('B', 'kl03-b', 'u-b') RETURNING id`;
    const a = String(wsA!.id);
    const b = String(wsB!.id);
    const [ev] = await client`
      INSERT INTO learning_events (workspace_id, user_id, entity_type, entity_id, action_type,
                                   original_comment)
      VALUES (${a}, 'u-a', 'review_item', '1', 'qualification_positive', 'good')
      RETURNING id`;
    const [lessonA] = await client`
      INSERT INTO learning_lessons (workspace_id, category, rule, confidence)
      VALUES (${a}, 'qualification_positive', 'Prefer roofers.', 60) RETURNING id`;
    const [lessonB] = await client`
      INSERT INTO learning_lessons (workspace_id, category, rule, confidence)
      VALUES (${b}, 'qualification_positive', 'Prefer roofers.', 60) RETURNING id`;
    const e = String(ev!.id);
    const la = String(lessonA!.id);
    const lb = String(lessonB!.id);

    await migrateTo(migrationIdx + 1);
    const after = await shape();
    expect(after.tables).toEqual(['table lesson_reinforcements']);
    const [kept] = await client`
      SELECT processing_status, claimed_at, processing_note, original_comment
      FROM learning_events WHERE id = ${e}`;
    // Processed inline before the lane: the column default 'done'.
    expect(kept).toEqual({
      processing_status: 'done',
      claimed_at: null,
      processing_note: null,
      original_comment: 'good',
    });

    // One forward row per (event, rule).
    const [fwd] = await client`
      INSERT INTO lesson_reinforcements (workspace_id, lesson_id, event_id, kind, delta_requested,
                                         delta_applied, confidence_before, confidence_after, reason)
      VALUES (${a}, ${la}, ${e}, 'cited', 2, 2, 60, 62, 'cited_agrees') RETURNING id`;
    await expect(
      client`INSERT INTO lesson_reinforcements (workspace_id, lesson_id, event_id, kind, delta_requested,
                                                delta_applied, confidence_before, confidence_after, reason)
             VALUES (${a}, ${la}, ${e}, 'dedup_match', 5, 5, 62, 67, 'dedup_match')`,
    ).rejects.toThrow(/lesson_reinforcements_event_lesson_unique/);
    // A compensation reverses one row, once.
    await client`
      INSERT INTO lesson_reinforcements (workspace_id, lesson_id, event_id, kind, delta_requested,
                                         delta_applied, confidence_before, confidence_after,
                                         compensates_id, reason)
      VALUES (${a}, ${la}, ${e}, 'compensation', -2, -2, 62, 60, ${String(fwd!.id)}, 'void:changed_mind')`;
    await expect(
      client`INSERT INTO lesson_reinforcements (workspace_id, lesson_id, event_id, kind, delta_requested,
                                                delta_applied, confidence_before, confidence_after,
                                                compensates_id, reason)
             VALUES (${a}, ${la}, ${e}, 'compensation', -2, -2, 62, 60, ${String(fwd!.id)}, 'void:undo')`,
    ).rejects.toThrow(/lesson_reinforcements_compensates_unique/);
    // The checks hold.
    await expect(
      client`INSERT INTO lesson_reinforcements (workspace_id, lesson_id, event_id, kind, delta_requested,
                                                delta_applied, confidence_before, confidence_after, reason)
             VALUES (${a}, ${la}, ${e}, 'compensation', -2, -2, 62, 60, 'void')`,
    ).rejects.toThrow(/lesson_reinforcements_compensation_check/);
    await expect(
      client`INSERT INTO lesson_reinforcements (workspace_id, lesson_id, event_id, kind, delta_requested,
                                                delta_applied, confidence_before, confidence_after, reason)
             VALUES (${a}, ${la}, ${e}, 'bogus', 1, 1, 60, 61, 'x')`,
    ).rejects.toThrow(/lesson_reinforcements_kind_check/);
    await expect(
      client`INSERT INTO lesson_reinforcements (workspace_id, lesson_id, event_id, kind, delta_requested,
                                                delta_applied, confidence_before, confidence_after, reason)
             VALUES (${b}, ${lb}, ${e}, 'cited', 2, 2, 60, 63, 'cited_agrees')`,
    ).rejects.toThrow(/lesson_reinforcements_confidence_check/);
    // A ledger row cannot move another tenant's rule.
    await expect(
      client`INSERT INTO lesson_reinforcements (workspace_id, lesson_id, event_id, kind, delta_requested,
                                                delta_applied, confidence_before, confidence_after, reason)
             VALUES (${a}, ${lb}, ${e}, 'cited', 2, 2, 60, 62, 'cited_agrees')`,
    ).rejects.toThrow(/lesson_reinforcements_lesson_fk/);

    // ---- rollback ----
    await client.unsafe(readFileSync(ROLLBACK_FILE, 'utf8'));
    expect(await shape()).toEqual(before);
    const [stillThere] = await client`
      SELECT action_type, original_comment FROM learning_events WHERE id = ${e}`;
    expect(stillThere).toEqual({ action_type: 'qualification_positive', original_comment: 'good' });
  }, 120_000);
});
