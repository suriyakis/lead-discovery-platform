// KL-01 acceptance 6: the two migrations apply on a seeded database with
// workspace and product rules (backfilling scope, lifecycle, polarity and
// retiring removed categories), and the rollback SQL restores the previous
// shape. Runs in its own scratch database (<test db>_kl01mig): migrations
// up to just before KL-01, seed rows in the OLD shape, apply KL-01 (expand +
// contract), check, run drizzle/rollback/…down.sql, compare with the shape
// captured before KL-01.

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
const EXPAND_TAG = '_p1_knowledge_foundation_lesson_scopes';
const CONTRACT_TAG = '_p1_knowledge_foundation_lesson_scopes_contract';
const ROLLBACK_FILE = path.join(
  drizzleDir,
  'rollback',
  'p1_knowledge_foundation_lesson_scopes.down.sql',
);

const baseUrl = new URL(
  process.env.DATABASE_URL ?? 'postgres://lead:lead@localhost:5432/lead_test',
);
const scratchName = `${baseUrl.pathname.replace(/^\//, '')}_kl01mig`.slice(0, 60);
const scratchUrl = new URL(baseUrl.toString());
scratchUrl.pathname = `/${scratchName}`;
const adminUrl = new URL(baseUrl.toString());
adminUrl.pathname = '/postgres';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

const journal = JSON.parse(
  readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
) as {
  entries: JournalEntry[];
};
const expandIdx = journal.entries.findIndex((e) => e.tag.endsWith(EXPAND_TAG));
const contractIdx = journal.entries.findIndex((e) => e.tag.endsWith(CONTRACT_TAG));

const tempDirs: string[] = [];
/** A copy of drizzle/ whose journal stops after the first `count` entries. */
function migrationsUpTo(count: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kl01-mig-'));
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

interface Shape {
  columns: string[];
  constraints: string[];
  indexes: string[];
  types: string[];
}

async function shape(): Promise<Shape> {
  const columns = await client`
    SELECT table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
           || ' default=' || coalesce(column_default, '-') AS c
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('learning_lessons', 'product_profiles')
    ORDER BY 1`;
  const constraints = await client`
    SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS c
    FROM pg_constraint
    WHERE conrelid IN ('public.learning_lessons'::regclass, 'public.product_profiles'::regclass)
    ORDER BY 1`;
  const indexes = await client`
    SELECT indexdef AS c FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN ('learning_lessons', 'product_profiles')
    ORDER BY 1`;
  const types = await client`
    SELECT typname AS c FROM pg_type WHERE typname LIKE 'lesson\\_%' ORDER BY 1`;
  const tables = await client`
    SELECT 'table ' || table_name AS c FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'lesson_scopes'`;
  return {
    columns: columns.map((r) => r.c as string),
    constraints: constraints.map((r) => r.c as string),
    indexes: indexes.map((r) => r.c as string),
    types: [...types, ...tables].map((r) => r.c as string),
  };
}

interface Seeded {
  wsA: string;
  wsB: string;
  p1: string;
  p2: string;
  pB: string;
  lessons: Record<string, string>;
}

/** Rows in the PRE-KL-01 shape (product_profile_id + enabled). */
async function seedOldShape(): Promise<Seeded> {
  await client`INSERT INTO users (id, email) VALUES ('u-a', 'a@kl01.test'), ('u-b', 'b@kl01.test')`;
  const [wsA] = await client`
    INSERT INTO workspaces (name, slug, owner_user_id) VALUES ('A', 'kl01-a', 'u-a') RETURNING id`;
  const [wsB] = await client`
    INSERT INTO workspaces (name, slug, owner_user_id) VALUES ('B', 'kl01-b', 'u-b') RETURNING id`;
  const a = String(wsA!.id);
  const b = String(wsB!.id);
  const [p1] =
    await client`INSERT INTO product_profiles (workspace_id, name) VALUES (${a}, 'P1') RETURNING id`;
  const [p2] =
    await client`INSERT INTO product_profiles (workspace_id, name) VALUES (${a}, 'P2') RETURNING id`;
  const [pB] =
    await client`INSERT INTO product_profiles (workspace_id, name) VALUES (${b}, 'PB') RETURNING id`;
  const specs: Array<[string, string, string | null, boolean, string, string]> = [
    // key, workspace, product, enabled, category, rule
    ['wsWide', a, null, true, 'qualification_positive', 'Installers with a fleet are a fit.'],
    ['p1Avoid', a, String(p1!.id), true, 'sector_preference', 'Avoid councils for P1.'],
    ['p1Prefer', a, String(p1!.id), true, 'contact_role', 'Contracts managers decide.'],
    ['p2Disabled', a, String(p2!.id), false, 'qualification_negative', 'Skip retailers.'],
    ['foreign', a, String(pB!.id), true, 'general_instruction', 'Pointed at B’s product (I167).'],
    ['dedupe', a, null, true, 'dedupe_hint', 'Branches are duplicates.'],
    ['connector', a, null, false, 'connector_quality', 'This directory is stale.'],
    ['style', a, null, true, 'outreach_style', 'Keep it under 70 words.'],
    ['bRule', b, String(pB!.id), true, 'qualification_negative', 'B skips resellers.'],
  ];
  const lessons: Record<string, string> = {};
  for (const [key, ws, product, enabled, category, rule] of specs) {
    const [row] = await client`
      INSERT INTO learning_lessons (workspace_id, product_profile_id, enabled, category, rule)
      VALUES (${ws}, ${product}, ${enabled}, ${category}, ${rule})
      RETURNING id`;
    lessons[key] = String(row!.id);
  }
  return { wsA: a, wsB: b, p1: String(p1!.id), p2: String(p2!.id), pB: String(pB!.id), lessons };
}

// The scratch database is created once and then reused: each run empties
// it by dropping its schemas. DROP / CREATE DATABASE force a checkpoint,
// which on a Postgres shared by several busy test runs can stall for
// minutes.
beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratchName) || !scratchName.includes('lead_test')) {
    throw new Error(`refusing scratch database name ${scratchName}`);
  }
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  const existing = await admin`
    SELECT datconnlimit FROM pg_database WHERE datname = ${scratchName}`;
  // -2 = left invalid by an interrupted DROP DATABASE: it cannot be
  // connected to, only dropped (the one slow path).
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

describe('KL-01 migrations on a seeded database', () => {
  it('expand + contract backfill the old rows, and the rollback restores the previous shape', async () => {
    expect(expandIdx).toBeGreaterThan(0);
    expect(contractIdx).toBe(expandIdx + 1);

    await migrateTo(expandIdx);
    const before = await shape();
    expect(before.columns.some((c) => c.startsWith('learning_lessons.enabled '))).toBe(true);
    const seeded = await seedOldShape();
    const L = seeded.lessons;

    await migrateTo(contractIdx + 1);

    // ---- shape after KL-01 ----
    const after = await shape();
    expect(after.columns.some((c) => c.startsWith('learning_lessons.enabled '))).toBe(false);
    expect(after.columns.some((c) => c.startsWith('learning_lessons.product_profile_id '))).toBe(
      false,
    );
    for (const col of ['scope_kind', 'lifecycle', 'polarity', 'retired_reason', 'merged_into_id']) {
      expect(
        after.columns.some((c) => c.startsWith(`learning_lessons.${col} `)),
        col,
      ).toBe(true);
    }
    expect(after.types).toEqual(
      expect.arrayContaining([
        'lesson_lifecycle',
        'lesson_retired_reason',
        'lesson_scope_kind',
        'table lesson_scopes',
      ]),
    );

    // ---- backfilled data ----
    const rows = await client`
      SELECT id::text, scope_kind::text, lifecycle::text, polarity, retired_reason::text
      FROM learning_lessons ORDER BY id`;
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    const expectRow = (
      key: string,
      want: { scope: string; lifecycle: string; polarity: number; reason?: string | null },
    ) => {
      const r = byId.get(L[key]!)!;
      expect([r.scope_kind, r.lifecycle, r.polarity, r.retired_reason ?? null], key).toEqual([
        want.scope,
        want.lifecycle,
        want.polarity,
        want.reason ?? null,
      ]);
    };
    expectRow('wsWide', { scope: 'workspace', lifecycle: 'active', polarity: 1 });
    expectRow('p1Avoid', { scope: 'products', lifecycle: 'active', polarity: -1 });
    expectRow('p1Prefer', { scope: 'products', lifecycle: 'active', polarity: 1 });
    expectRow('p2Disabled', { scope: 'products', lifecycle: 'disabled', polarity: -1 });
    expectRow('foreign', { scope: 'products', lifecycle: 'active', polarity: 0 });
    expectRow('dedupe', {
      scope: 'workspace',
      lifecycle: 'retired',
      polarity: 0,
      reason: 'category_removed',
    });
    expectRow('connector', {
      scope: 'workspace',
      lifecycle: 'retired',
      polarity: 0,
      reason: 'category_removed',
    });
    expectRow('style', { scope: 'workspace', lifecycle: 'active', polarity: 0 });
    expectRow('bRule', { scope: 'products', lifecycle: 'active', polarity: -1 });

    const scopes = await client`
      SELECT lesson_id::text AS l, workspace_id::text AS w, product_profile_id::text AS p
      FROM lesson_scopes ORDER BY lesson_id, product_profile_id`;
    expect(scopes.map((s) => [s.l, s.w, s.p])).toEqual([
      [L.p1Avoid, seeded.wsA, seeded.p1],
      [L.p1Prefer, seeded.wsA, seeded.p1],
      [L.p2Disabled, seeded.wsA, seeded.p2],
      // No row for 'foreign': it pointed at another tenant's product, so
      // it now applies nowhere ("Needs a scope") instead of leaking.
      [L.bRule, seeded.wsB, seeded.pB],
    ]);

    // ---- rollback ----
    await client.unsafe(readFileSync(ROLLBACK_FILE, 'utf8'));
    const restored = await shape();
    expect(restored).toEqual(before);

    const back = await client`
      SELECT id::text, product_profile_id::text AS p, enabled FROM learning_lessons ORDER BY id`;
    const backById = new Map(back.map((r) => [r.id as string, [r.p ?? null, r.enabled]]));
    expect(backById.get(L.wsWide!)).toEqual([null, true]);
    expect(backById.get(L.p1Avoid!)).toEqual([seeded.p1, true]);
    expect(backById.get(L.p2Disabled!)).toEqual([seeded.p2, false]);
    // NULL meant workspace-wide: a rule with no product comes back disabled.
    expect(backById.get(L.foreign!)).toEqual([null, false]);
    expect(backById.get(L.dedupe!)).toEqual([null, false]);
    expect(backById.get(L.bRule!)).toEqual([seeded.pB, true]);
  }, 120_000);
});
