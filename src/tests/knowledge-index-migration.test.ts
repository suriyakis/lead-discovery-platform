// KL-06 migration: p1_knowledge_foundation_learning_knowledge applies over
// pre-lane data — legacy runs nobody will finish are closed, the one-queued /
// one-running-per-source indexes hold, every source gets its honest
// index_status (queued / failed / stale / indexed) — and
// drizzle/rollback/…learning_knowledge.down.sql restores the previous shape.
// Runs in its own scratch database (<test db>_kl06mig), like the KL-01 …
// KL-05 migration tests.

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
const scratchName = `${baseUrl.pathname.replace(/^\//, '')}_kl06mig`.slice(0, 60);
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kl06-mig-'));
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

const TABLES = ['documents', 'knowledge_sources', 'indexing_jobs'];

async function shape() {
  const columns = await client`
    SELECT table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
           || ' default=' || coalesce(column_default, '-') AS c
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ${client(TABLES)}
    ORDER BY 1`;
  const constraints = await client`
    SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS c
    FROM pg_constraint
    WHERE conrelid IN ('public.documents'::regclass, 'public.knowledge_sources'::regclass,
                       'public.indexing_jobs'::regclass)
    ORDER BY 1`;
  const indexes = await client`
    SELECT indexdef AS c FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN ${client(TABLES)}
    ORDER BY 1`;
  const types = await client`
    SELECT 'type ' || typname AS c FROM pg_type WHERE typname = 'knowledge_index_status'`;
  return {
    columns: columns.map((r) => r.c as string),
    constraints: constraints.map((r) => r.c as string),
    indexes: indexes.map((r) => r.c as string),
    types: types.map((r) => r.c as string),
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

describe('KL-06 migration on a seeded database', () => {
  it('closes legacy runs, enforces one queued / one running run per source, backfills honest statuses, and rolls back', async () => {
    expect(migrationIdx).toBeGreaterThan(0);
    await migrateTo(migrationIdx);
    const before = await shape();
    expect(before.types).toEqual([]);

    await client`INSERT INTO users (id, email) VALUES ('u-a', 'a@kl06.test')`;
    const [ws] = await client`
      INSERT INTO workspaces (name, slug, owner_user_id) VALUES ('A', 'kl06-a', 'u-a') RETURNING id`;
    const a = String(ws!.id);
    const [doc] = await client`
      INSERT INTO documents (workspace_id, name, filename, mime_type, storage_key, status, sha256)
      VALUES (${a}, 'Spec', 'spec.pdf', 'application/pdf', 'k/spec', 'ready', 'abc') RETURNING id`;
    const d = String(doc!.id);

    const t0 = '2026-09-01T10:00:00Z';
    const later = '2026-09-01T12:00:00Z';
    const source = async (
      key: string,
      kind: 'text' | 'url' | 'document',
      extra: { status?: string; error?: string | null; indexedAt?: string | null; updatedAt?: string },
    ) => {
      const [row] = await client`
        INSERT INTO knowledge_sources (workspace_id, kind, document_id, url, text_excerpt, title,
                                       external_status, external_error,
                                       external_indexed_at, created_at, updated_at)
        VALUES (${a}, ${kind}, ${kind === 'document' ? d : null},
                ${kind === 'url' ? 'https://x.test/' + key : null},
                ${kind === 'text' ? 'text ' + key : null}, ${`Source ${key}`},
                ${extra.status ?? 'pending'}, ${extra.error ?? null}, ${extra.indexedAt ?? null},
                ${t0}, ${extra.updatedAt ?? t0})
        RETURNING id`;
      return String(row!.id);
    };
    const chunk = async (sourceId: string, at: string) => {
      await client`
        INSERT INTO document_chunks (workspace_id, knowledge_source_id, chunk_index, content,
                                     embedding_model, created_at)
        VALUES (${a}, ${sourceId}, 0, 'passage', 'text-embedding-3-small', ${at})`;
    };
    const job = async (sourceId: string | null, status: string, documentId: string | null = null) => {
      const [row] = await client`
        INSERT INTO indexing_jobs (workspace_id, knowledge_source_id, document_id, status, started_at)
        VALUES (${a}, ${sourceId}, ${documentId}, ${status}, ${t0}) RETURNING id`;
      return String(row!.id);
    };

    const indexed = await source('indexed', 'text', { status: 'indexed', indexedAt: t0 });
    await chunk(indexed, t0);
    const edited = await source('edited', 'text', { status: 'indexed', indexedAt: t0, updatedAt: later });
    await chunk(edited, t0);
    const docEdited = await source('doc', 'document', { status: 'indexed', indexedAt: t0, updatedAt: later });
    await chunk(docEdited, t0);
    const failed = await source('failed', 'url', { status: 'failed', error: 'Fetch failed: HTTP 404' });
    const never = await source('never', 'text', {});
    const queued = await source('queued', 'text', {});
    const twice = await source('twice', 'text', {});

    const crashedRun = await job(indexed, 'running'); // a request that died mid-run (I108)
    const crashedRun2 = await job(indexed, 'running');
    const docRun = await job(null, 'queued', d); // pre-KL-05 document-level row
    const queuedRun = await job(queued, 'queued');
    const olderTwice = await job(twice, 'queued');
    const newerTwice = await job(twice, 'queued');

    await migrateTo(migrationIdx + 1);
    const after = await shape();
    expect(after.types).toEqual(['type knowledge_index_status']);
    expect(after.indexes.join('\n')).toMatch(/indexing_jobs_one_queued_per_source/);
    expect(after.indexes.join('\n')).toMatch(/indexing_jobs_one_running_per_source/);

    const jobs = Object.fromEntries(
      (await client`SELECT id, status, note, error FROM indexing_jobs ORDER BY id`).map((r) => [
        String(r.id),
        r,
      ]),
    );
    for (const id of [crashedRun, crashedRun2]) {
      expect(jobs[id]).toMatchObject({ status: 'failed', note: 'timed_out' });
      expect(jobs[id]!.error).toMatch(/Interrupted before KL-06/);
    }
    expect(jobs[docRun]).toMatchObject({ status: 'failed' });
    expect(jobs[queuedRun]).toMatchObject({ status: 'queued' });
    expect(jobs[olderTwice]).toMatchObject({ status: 'failed', note: 'superseded' });
    expect(jobs[newerTwice]).toMatchObject({ status: 'queued' });

    const sources = Object.fromEntries(
      (
        await client`
          SELECT id, index_status, indexed_at, indexed_embedding_model, indexed_content_hash,
                 last_index_error
          FROM knowledge_sources ORDER BY id`
      ).map((r) => [String(r.id), r]),
    );
    expect(sources[indexed]).toMatchObject({
      index_status: 'indexed',
      indexed_embedding_model: 'text-embedding-3-small',
      indexed_content_hash: null, // the first re-index re-embeds once
      last_index_error: null,
    });
    expect(new Date(String(sources[indexed]!.indexed_at)).toISOString()).toBe(
      '2026-09-01T10:00:00.000Z',
    );
    expect(sources[edited]).toMatchObject({ index_status: 'stale' }); // I103
    expect(sources[edited]!.indexed_at).not.toBeNull();
    expect(sources[docEdited]).toMatchObject({ index_status: 'indexed' });
    expect(sources[failed]).toMatchObject({
      index_status: 'failed',
      last_index_error: 'Fetch failed: HTTP 404',
      indexed_at: null,
    });
    expect(sources[never]).toMatchObject({ index_status: 'stale', indexed_at: null });
    expect(sources[queued]).toMatchObject({ index_status: 'queued' });
    expect(sources[twice]).toMatchObject({ index_status: 'queued' });

    // One queued and one running run per source; a CHECK on the status.
    await expect(
      client`INSERT INTO indexing_jobs (workspace_id, knowledge_source_id, status) VALUES (${a}, ${queued}, 'queued')`,
    ).rejects.toThrow(/indexing_jobs_one_queued_per_source/);
    await client`INSERT INTO indexing_jobs (workspace_id, knowledge_source_id, status) VALUES (${a}, ${queued}, 'running')`;
    await expect(
      client`INSERT INTO indexing_jobs (workspace_id, knowledge_source_id, status) VALUES (${a}, ${queued}, 'running')`,
    ).rejects.toThrow(/indexing_jobs_one_running_per_source/);
    await expect(
      client`INSERT INTO indexing_jobs (workspace_id, knowledge_source_id, status) VALUES (${a}, ${never}, 'pending')`,
    ).rejects.toThrow(/indexing_jobs_status_check/);

    // ---- rollback ----
    await client`UPDATE documents SET extracted_text = 'cached', extractor = 'pdf' WHERE id = ${d}`;
    await client.unsafe(readFileSync(ROLLBACK_FILE, 'utf8'));
    expect(await shape()).toEqual(before);
    const open = await client`SELECT id FROM indexing_jobs WHERE status IN ('queued', 'running')`;
    expect(open).toEqual([]);
    const [kept] = await client`SELECT external_status, title FROM knowledge_sources WHERE id = ${failed}`;
    expect(kept).toEqual({ external_status: 'failed', title: 'Source failed' });
  }, 120_000);
});
