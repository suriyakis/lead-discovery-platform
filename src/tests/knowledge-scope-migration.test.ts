// KL-05 acceptance 5: the lane migration's knowledge-scope part (custom
// block C of p1_knowledge_foundation_learning_knowledge) on a fixture with
// document-level, source-level and shadowed chunks. Runs in its own
// scratch database (<test db>_kl05mig): migrations up to just before the
// lane, rows seeded in the OLD shape, the read-only owner report, then
// the migration (whose guard first refuses a chunk it cannot give an
// owner, rolling everything back), the post-migration report, and finally
// drizzle/rollback/…down.sql compared with the shape captured before.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildKnowledgeScopeReport,
  renderKnowledgeScopeReport,
} from '@/lib/remediation/knowledge-scope-report';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const drizzleDir = path.join(repoRoot, 'drizzle');
const TAG = '_p1_knowledge_foundation_learning_knowledge';
const MIGRATION = 'p1_knowledge_foundation_learning_knowledge';
const ROLLBACK_FILE = path.join(drizzleDir, 'rollback', `${MIGRATION}.down.sql`);

const baseUrl = new URL(
  process.env.DATABASE_URL ?? 'postgres://lead:lead@localhost:5432/lead_test',
);
const scratchName = `${baseUrl.pathname.replace(/^\//, '')}_kl05mig`.slice(0, 60);
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
) as { entries: JournalEntry[] };
const migrationIdx = journal.entries.findIndex((e) => e.tag.endsWith(TAG));

const tempDirs: string[] = [];
/** A copy of drizzle/ whose journal stops after the first `count` entries. */
function migrationsUpTo(count: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kl05-mig-'));
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

const TABLES = [
  'knowledge_sources',
  'knowledge_source_products',
  'document_chunks',
  'product_profiles',
  'documents',
];

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
    WHERE table_schema = 'public' AND table_name IN ${client(TABLES)}
    ORDER BY 1`;
  const constraints = await client`
    SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS c
    FROM pg_constraint
    WHERE conrelid::regclass::text IN ${client(TABLES)}
    ORDER BY 1`;
  const indexes = await client`
    SELECT indexdef AS c FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN ${client(TABLES)}
    ORDER BY 1`;
  const types = await client`
    SELECT typname AS c FROM pg_type WHERE typname = 'knowledge_scope_kind'`;
  const tables = await client`
    SELECT 'table ' || table_name AS c FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'knowledge_source_products'`;
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
  docs: Record<string, string>;
  sources: Record<string, string>;
  chunks: Record<string, string[]>;
}

const MISSING_PRODUCT = '999999';

/** Rows in the PRE-KL-05 shape (product_profile_ids arrays, NULL-source chunks). */
async function seedOldShape(): Promise<Seeded> {
  await client`INSERT INTO users (id, email) VALUES ('u-a', 'a@kl05.test'), ('u-b', 'b@kl05.test')`;
  const [wsA] = await client`
    INSERT INTO workspaces (name, slug, owner_user_id) VALUES ('Alpha', 'kl05-a', 'u-a') RETURNING id`;
  const [wsB] = await client`
    INSERT INTO workspaces (name, slug, owner_user_id) VALUES ('Beta', 'kl05-b', 'u-b') RETURNING id`;
  const a = String(wsA!.id);
  const b = String(wsB!.id);
  const product = async (ws: string, name: string) =>
    String(
      (
        await client`INSERT INTO product_profiles (workspace_id, name) VALUES (${ws}, ${name}) RETURNING id`
      )[0]!.id,
    );
  const p1 = await product(a, 'P1');
  const p2 = await product(a, 'P2');
  const pB = await product(b, 'PB');

  const docs: Record<string, string> = {};
  const doc = async (key: string, ws: string, status = 'ready') => {
    const [row] = await client`
      INSERT INTO documents (workspace_id, name, filename, mime_type, storage_key, status, tags)
      VALUES (${ws}, ${`Doc ${key}`}, ${`${key}.txt`}, 'text/plain', ${`k/${key}`}, ${status}, ${['t-' + key]})
      RETURNING id`;
    docs[key] = String(row!.id);
    return docs[key]!;
  };
  const sources: Record<string, string> = {};
  const source = async (
    key: string,
    ws: string,
    kind: 'document' | 'url' | 'text',
    productIds: string[],
    documentId: string | null = null,
  ) => {
    const [row] = await client`
      INSERT INTO knowledge_sources (workspace_id, kind, document_id, url, text_excerpt, title, product_profile_ids)
      VALUES (${ws}, ${kind}, ${documentId}, ${kind === 'url' ? 'https://x.test/' + key : null},
              ${kind === 'text' ? 'text ' + key : null}, ${`Source ${key}`}, ${productIds}::bigint[])
      RETURNING id`;
    sources[key] = String(row!.id);
    return sources[key]!;
  };
  const chunks: Record<string, string[]> = {};
  const chunk = async (
    key: string,
    ws: string,
    owner: { documentId?: string | null; sourceId?: string | null },
    n: number,
  ) => {
    for (let i = 0; i < n; i++) {
      const [row] = await client`
        INSERT INTO document_chunks (workspace_id, document_id, knowledge_source_id, chunk_index, content)
        VALUES (${ws}, ${owner.documentId ?? null}, ${owner.sourceId ?? null}, ${i}, ${`${key} passage ${i}`})
        RETURNING id`;
      (chunks[key] ??= []).push(String(row!.id));
    }
  };

  // D1: uploaded with P1 (KS1 + its chunks), then "Index now" on the
  //     document page wrote a second, NULL-source copy (I039) -> shadowed.
  await doc('D1', a);
  await source('KS1', a, 'document', [p1], docs.D1!);
  await chunk('KS1', a, { sourceId: sources.KS1 }, 2);
  await chunk('D1-level', a, { documentId: docs.D1 }, 2);
  // D2: uploaded with no product -> document-level only -> workspace source.
  await doc('D2', a);
  await chunk('D2-level', a, { documentId: docs.D2 }, 3);
  // D3: unscoped upload later attached to P2 via /knowledge/new -> shadowed.
  await doc('D3', a);
  await chunk('D3-level', a, { documentId: docs.D3 }, 2);
  await source('KS3', a, 'document', [p2], docs.D3!);
  await chunk('KS3', a, { sourceId: sources.KS3 }, 1);
  // D4: archived, document-level -> workspace source, still archived.
  await doc('D4', a, 'archived');
  await chunk('D4-level', a, { documentId: docs.D4 }, 1);
  // D5: a source ticked with another tenant's and a deleted product ->
  //     still "products ticked": shadowed, and the source needs a scope.
  await doc('D5', a);
  await source('KS5', a, 'document', [pB, MISSING_PRODUCT], docs.D5!);
  await chunk('D5-level', a, { documentId: docs.D5 }, 1);
  // D6: two sources with NO product (never reached product drafts) plus
  //     document-level chunks -> not shadowed: the OLDEST source (KS6)
  //     becomes the document's one workspace source, its own duplicate
  //     chunk goes and it takes over the document-level chunk; KS6b keeps
  //     "Needs a scope". No second source is created for D6.
  await doc('D6', a);
  await source('KS6', a, 'document', [], docs.D6!);
  await chunk('KS6', a, { sourceId: sources.KS6 }, 1);
  await chunk('D6-level', a, { documentId: docs.D6 }, 1);
  await source('KS6b', a, 'document', [], docs.D6!);
  // Text / url sources (document_id NULL).
  await source('KS7', a, 'text', [p1, p2]);
  await chunk('KS7', a, { sourceId: sources.KS7 }, 1);
  await source('KS8', a, 'text', []);
  await source('KS9', a, 'url', [p1, MISSING_PRODUCT]);
  // Workspace B.
  await doc('D7', b);
  await chunk('D7-level', b, { documentId: docs.D7 }, 1);
  await source('KS10', b, 'text', [pB]);
  await chunk('KS10', b, { sourceId: sources.KS10 }, 1);
  // D8: attached to P1 (KS11) but KS11 was never indexed; only "Index
  //     now" wrote document-level chunks -> shadowed, and KS11 ADOPTS a
  //     copy so P1 keeps the document.
  await doc('D8', a);
  await source('KS11', a, 'document', [p1], docs.D8!);
  await chunk('D8-level', a, { documentId: docs.D8 }, 2);
  // An orphan chunk: no source, no document.
  await chunk('orphan', a, {}, 1);
  // The dead array.
  await client`UPDATE product_profiles SET document_source_ids = ${[docs.D1!]}::bigint[] WHERE id = ${p1}`;

  return { wsA: a, wsB: b, p1, p2, pB, docs, sources, chunks };
}

// The scratch database is created once and then reused: each run empties
// it by dropping its schemas (see learning-scope-migration.test.ts).
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

describe('KL-05 knowledge-scope migration on a seeded database', () => {
  it('report → guard → migration → report → rollback', async () => {
    expect(migrationIdx).toBeGreaterThan(0);

    await migrateTo(migrationIdx);
    const before = await shape();
    expect(before.columns).toContain(
      "knowledge_sources.product_profile_ids ARRAY null=NO default='{}'::bigint[]",
    );
    const seeded = await seedOldShape();
    const { docs, sources: S, chunks: C } = seeded;

    // ---- the read-only owner report, BEFORE the migration ----
    const pre = await buildKnowledgeScopeReport(client);
    expect(pre.shape).toBe('pre_kl05');
    expect(pre.counts).toMatchObject({
      documents: 8,
      documentsArchived: 1,
      sources: 10,
      documentLevelChunks: 13,
      sourceChunks: 6,
      documentsWithBoth: 3, // D1, D3, D6
      orphanChunks: 1,
      shadowedDocuments: 4,
      shadowedChunks: 7,
      adoptingSources: 2, // KS5 (needs a scope anyway) and KS11
      adoptedChunks: 3,
      becomesWorkspaceWideDocuments: 4,
      becomesWorkspaceWideChunks: 6,
      reusedSources: 1, // KS6
      duplicateChunksDeleted: 1,
      sourcesNeedingScope: 3,
      droppedProductIds: 3,
      guardBlockingChunks: 0,
    });
    expect(pre.becomesWorkspaceWide.map((d) => d.documentId)).toEqual([
      docs.D2,
      docs.D4,
      docs.D6,
      docs.D7,
    ]);
    expect(pre.becomesWorkspaceWide.find((d) => d.documentId === docs.D6)).toMatchObject({
      unscopedSourceIds: [S.KS6, S.KS6b],
      reusedSourceId: S.KS6,
      duplicateChunks: 1,
    });
    expect(pre.becomesWorkspaceWide.find((d) => d.documentId === docs.D2)).toMatchObject({
      unscopedSourceIds: [],
      reusedSourceId: null,
      duplicateChunks: 0,
    });
    expect(pre.shadowed.map((d) => [d.documentId, d.chunks])).toEqual([
      [docs.D1, 2],
      [docs.D3, 2],
      [docs.D5, 1],
      [docs.D8, 2],
    ]);
    // Each product source's own chunk count: the owner sees which source
    // would have lost the document, and that it adopts a copy instead.
    expect(pre.shadowed.find((d) => d.documentId === docs.D1)?.productSources).toEqual([
      { sourceId: S.KS1, chunks: 2, adoptsChunks: false },
    ]);
    expect(pre.shadowed.find((d) => d.documentId === docs.D8)?.productSources).toEqual([
      { sourceId: S.KS11, chunks: 0, adoptsChunks: true },
    ]);
    expect(pre.needsScope.map((s) => [s.sourceId, s.reason])).toEqual([
      [S.KS5, 'only_foreign_or_deleted_products'],
      [S.KS6b, 'no_products'],
      [S.KS8, 'no_products'],
    ]);
    expect(pre.partiallyDropped).toEqual([
      expect.objectContaining({
        sourceId: S.KS9,
        keptProductIds: [seeded.p1],
        droppedProductIds: [MISSING_PRODUCT],
      }),
    ]);
    const md = renderKnowledgeScopeReport(pre);
    expect(md).toContain('Owner review: documents that become available to every product');
    expect(md).toContain('Doc D2');
    expect(md).toContain(`${S.KS11} (0, adopts a copy)`);
    expect(md).toContain(`source ${S.KS6}`);
    // Filtered to workspace B, only B's document is listed.
    const preB = await buildKnowledgeScopeReport(client, { workspaceIds: [seeded.wsB] });
    expect(preB.becomesWorkspaceWide.map((d) => d.documentId)).toEqual([docs.D7]);
    expect(preB.counts.documents).toBe(1);

    // ---- the guard: a chunk the migration cannot give an owner aborts it ----
    const [bad] = await client`
      INSERT INTO document_chunks (workspace_id, document_id, chunk_index, content)
      VALUES (${seeded.wsB}, ${docs.D2!}, 0, 'filed under the wrong workspace') RETURNING id`;
    expect((await buildKnowledgeScopeReport(client)).counts.guardBlockingChunks).toBe(1);
    await expect(migrateTo(migrationIdx + 1)).rejects.toThrow(/KL-05: 1 document_chunks row/);
    expect(await shape()).toEqual(before); // the whole migrator transaction rolled back
    await client`DELETE FROM document_chunks WHERE id = ${bad!.id}`;

    await migrateTo(migrationIdx + 1);

    // ---- shape after KL-05 ----
    const after = await shape();
    expect(after.columns).toContain('document_chunks.knowledge_source_id bigint null=NO default=-');
    expect(after.columns).toContain(
      "knowledge_sources.scope_kind USER-DEFINED null=NO default='products'::knowledge_scope_kind",
    );
    // The legacy arrays stay (deprecated, frozen) until the contract PR.
    expect(after.columns.some((c) => c.startsWith('knowledge_sources.product_profile_ids '))).toBe(true);
    expect(after.columns.some((c) => c.startsWith('product_profiles.document_source_ids '))).toBe(true);
    expect(after.types).toEqual(['knowledge_scope_kind', 'table knowledge_source_products']);
    const fk = after.constraints.find((c) => c.includes('document_chunks_knowledge_source_fk'));
    expect(fk).toContain(
      'FOREIGN KEY (workspace_id, knowledge_source_id) REFERENCES knowledge_sources(workspace_id, id) ON DELETE CASCADE',
    );
    expect(
      after.constraints.some((c) => c.includes('document_chunks_knowledge_source_id_knowledge_sources_id_fk')),
    ).toBe(false);

    // ---- chunks ----
    const chunkRows = await client`
      SELECT id::text, document_id::text AS d, knowledge_source_id::text AS ks FROM document_chunks`;
    const byId = new Map(chunkRows.map((r) => [r.id as string, r]));
    const gone = [
      ...C['D1-level']!,
      ...C['D3-level']!,
      ...C['D5-level']!,
      ...C['D8-level']!,
      ...C.orphan!,
      ...C.KS6!, // KS6's own copy duplicated the D6 passages it took over
    ];
    for (const id of gone) expect(byId.has(id), `chunk ${id} deleted`).toBe(false);
    expect(chunkRows).toHaveLength(14);
    expect(chunkRows.every((r) => r.ks !== null && r.d === null)).toBe(true);
    // Source chunks keep their owner.
    for (const key of ['KS1', 'KS3', 'KS7', 'KS10']) {
      for (const id of C[key]!) expect(byId.get(id)?.ks, key).toBe(S[key]);
    }
    // KS11 (P1, never indexed) adopted the D8 passages; KS5 adopted D5's.
    const adopted = await client`
      SELECT knowledge_source_id::text AS ks, content FROM document_chunks
      WHERE knowledge_source_id IN (${S.KS11!}, ${S.KS5!}) ORDER BY knowledge_source_id, chunk_index`;
    expect(adopted.map((r) => [r.ks, r.content])).toEqual([
      [S.KS5, 'D5-level passage 0'],
      [S.KS11, 'D8-level passage 0'],
      [S.KS11, 'D8-level passage 1'],
    ]);

    // ---- converted documents: ONE workspace source each, chunks moved ----
    const wsSources = await client`
      SELECT id::text, workspace_id::text AS w, document_id::text AS d, title, tags,
             external_status, external_provider_id
      FROM knowledge_sources WHERE scope_kind = 'workspace' ORDER BY document_id`;
    expect(wsSources.map((r) => r.d)).toEqual([docs.D2, docs.D4, docs.D6, docs.D7]);
    for (const key of ['D2', 'D4', 'D7']) {
      const src = wsSources.find((r) => r.d === docs[key])!;
      expect(src.title).toBe(`Doc ${key}`);
      expect(src.tags).toEqual([`t-${key}`]);
      expect([src.external_status, src.external_provider_id]).toEqual(['indexed', 'pgvector']);
      expect(src.w).toBe(key === 'D7' ? seeded.wsB : seeded.wsA);
      for (const id of C[`${key}-level`]!) expect(byId.get(id)?.ks, key).toBe(src.id);
    }
    // D6 reused its existing source instead of getting a second one.
    const d6 = wsSources.find((r) => r.d === docs.D6)!;
    expect([d6.id, d6.title]).toEqual([S.KS6, 'Source KS6']);
    for (const id of C['D6-level']!) expect(byId.get(id)?.ks).toBe(S.KS6);
    const d6Sources = await client`
      SELECT id::text FROM knowledge_sources WHERE document_id = ${docs.D6!} ORDER BY id`;
    expect(d6Sources.map((r) => r.id)).toEqual([S.KS6, S.KS6b]);
    const [d4] = await client`SELECT status FROM documents WHERE id = ${docs.D4!}`;
    expect(d4!.status).toBe('archived');

    // ---- scope rows: own-workspace products only; old sources stay 'products' ----
    const scopeRows = await client`
      SELECT source_id::text AS s, workspace_id::text AS w, product_profile_id::text AS p
      FROM knowledge_source_products ORDER BY source_id, product_profile_id`;
    expect(scopeRows.map((r) => [r.s, r.p])).toEqual([
      [S.KS1, seeded.p1],
      [S.KS3, seeded.p2],
      [S.KS7, seeded.p1],
      [S.KS7, seeded.p2],
      [S.KS9, seeded.p1],
      [S.KS10, seeded.pB],
      [S.KS11, seeded.p1],
    ]);
    const kinds = await client`
      SELECT id::text, scope_kind::text AS k FROM knowledge_sources
      WHERE id IN ${client(Object.values(S).filter((id) => id !== S.KS6))} ORDER BY id`;
    expect(new Set(kinds.map((r) => r.k))).toEqual(new Set(['products']));

    // ---- audit trail ----
    const audit = await client`
      SELECT kind, entity_id, payload FROM audit_log
      WHERE payload->>'migration' = ${MIGRATION} ORDER BY id`;
    const counted = (kind: string) =>
      audit
        .filter((r) => r.kind === kind)
        .map((r) => [r.entity_id, Number((r.payload as { chunks: number }).chunks)])
        .sort();
    expect(counted('document.shadow_chunks_deleted')).toEqual(
      [
        [docs.D1, 2],
        [docs.D3, 2],
        [docs.D5, 1],
        [docs.D8, 2],
      ].sort(),
    );
    expect(counted('knowledge_source.shadow_chunks_adopted')).toEqual(
      [
        [S.KS5, 1],
        [S.KS11, 2],
      ].sort(),
    );
    expect(counted('knowledge_source.duplicate_chunks_deleted')).toEqual([[S.KS6, 1]]);
    const backfill = audit.filter((r) => r.kind === 'knowledge_source.scope_backfill');
    expect(backfill).toHaveLength(4);
    expect(
      backfill.filter((r) => (r.payload as { reused: boolean }).reused).map((r) => r.entity_id),
    ).toEqual([S.KS6]);

    // ---- the same report, AFTER the migration ----
    const post = await buildKnowledgeScopeReport(client);
    expect(post.shape).toBe('post_kl05');
    expect(post.counts).toMatchObject({
      sources: 13,
      workspaceSources: 4,
      productSources: 9,
      sourcesNeedingScope: 3,
      chunks: 14,
      chunksWithoutSource: 0,
      chunksWithLegacyDocumentId: 0,
      documentsWithSeveralSources: 1, // D6: KS6 (now workspace) + KS6b (legacy, needs a scope)
    });
    expect(
      post.migratedSources.map((s) => [s.documentId, s.scope, s.reused]).sort(),
    ).toEqual(
      [
        [docs.D2, 'workspace', false],
        [docs.D4, 'workspace', false],
        [docs.D6, 'workspace', true],
        [docs.D7, 'workspace', false],
      ].sort(),
    );
    expect(post.needsScope.map((s) => s.sourceId)).toEqual([S.KS5, S.KS6b, S.KS8]);
    expect(renderKnowledgeScopeReport(post)).toContain('Sources the migration made workspace-wide');

    // ---- rollback ----
    await client.unsafe(readFileSync(ROLLBACK_FILE, 'utf8'));
    expect(await shape()).toEqual(before);

    const arrays = await client`
      SELECT id::text, product_profile_ids::text[] AS ids FROM knowledge_sources ORDER BY id`;
    const arr = new Map(arrays.map((r) => [r.id as string, r.ids as string[]]));
    expect(arr.get(S.KS1!)).toEqual([seeded.p1]);
    expect(arr.get(S.KS7!)).toEqual([seeded.p1, seeded.p2]);
    expect(arr.get(S.KS9!)).toEqual([seeded.p1]); // the missing id stays dropped
    expect(arr.get(S.KS5!)).toEqual([]);
    expect(arr.get(S.KS8!)).toEqual([]);
    expect(arr.get(S.KS11!)).toEqual([seeded.p1]);
    // Workspace document sources went back to document-level chunks; the
    // ones the migration created are deleted, the reused KS6 stays.
    expect(arrays).toHaveLength(10);
    expect(arr.get(S.KS6!)).toEqual([]);
    const back = await client`
      SELECT id::text, document_id::text AS d, knowledge_source_id::text AS ks FROM document_chunks`;
    const backById = new Map(back.map((r) => [r.id as string, r]));
    for (const key of ['D2', 'D4', 'D6', 'D7']) {
      for (const id of C[`${key}-level`]!) {
        expect([backById.get(id)?.d, backById.get(id)?.ks ?? null], key).toEqual([docs[key], null]);
      }
    }
    for (const id of C.KS1!) expect(backById.get(id)?.ks).toBe(S.KS1);
  }, 180_000);
});
