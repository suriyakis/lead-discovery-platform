// Regeneration guard for the knowledge-foundation lane migration
// (drizzle/*_p1_knowledge_foundation_learning_knowledge.sql).
//
// The integrator regenerates every lane's migration with `pnpm db:generate`
// and re-appends the lane's `-- custom:begin … -- custom:end` block. That
// only works if (a) nothing above the block was hand-edited, and (b) the
// objects the block creates stay OUT of the TypeScript schema — drizzle-kit
// emits every FK before every UNIQUE it adds to an existing table, so the
// six composite tenant FKs, and NOT NULL / partial unique indexes that are
// only true after the block's backfill, live in the block alone. This file
// fails when a regeneration drops the block (the objects are missing from
// the freshly migrated test database), when someone declares one of them
// in the schema again, or when the block creates an object this list does
// not know about.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { knowledgeSourceProducts } from '@/lib/db/schema/documents';
import { lessonReinforcements, lessonScopes } from '@/lib/db/schema/learning';
import { documentChunks } from '@/lib/db/schema/rag';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TAG = '_p1_knowledge_foundation_learning_knowledge';

const journal = JSON.parse(
  readFileSync(path.join(repoRoot, 'drizzle', 'meta', '_journal.json'), 'utf8'),
) as { entries: Array<{ tag: string }> };
const entry = journal.entries.find((e) => e.tag.endsWith(TAG));
const migrationSql = entry
  ? readFileSync(path.join(repoRoot, 'drizzle', `${entry.tag}.sql`), 'utf8')
  : '';

/** The DB-only composite FKs: name -> the definition Postgres reports. */
const DB_ONLY_FKS: Record<string, { table: string; def: string }> = {
  lesson_scopes_lesson_fk: {
    table: 'lesson_scopes',
    def: 'FOREIGN KEY (workspace_id, lesson_id) REFERENCES learning_lessons(workspace_id, id) ON DELETE CASCADE',
  },
  lesson_scopes_product_fk: {
    table: 'lesson_scopes',
    def: 'FOREIGN KEY (workspace_id, product_profile_id) REFERENCES product_profiles(workspace_id, id) ON DELETE CASCADE',
  },
  lesson_reinforcements_lesson_fk: {
    table: 'lesson_reinforcements',
    def: 'FOREIGN KEY (workspace_id, lesson_id) REFERENCES learning_lessons(workspace_id, id) ON DELETE CASCADE',
  },
  knowledge_source_products_source_fk: {
    table: 'knowledge_source_products',
    def: 'FOREIGN KEY (workspace_id, source_id) REFERENCES knowledge_sources(workspace_id, id) ON DELETE CASCADE',
  },
  knowledge_source_products_product_fk: {
    table: 'knowledge_source_products',
    def: 'FOREIGN KEY (workspace_id, product_profile_id) REFERENCES product_profiles(workspace_id, id) ON DELETE CASCADE',
  },
  document_chunks_knowledge_source_fk: {
    table: 'document_chunks',
    def: 'FOREIGN KEY (workspace_id, knowledge_source_id) REFERENCES knowledge_sources(workspace_id, id) ON DELETE CASCADE',
  },
};
const DB_ONLY_INDEXES = [
  'indexing_jobs_one_queued_per_source',
  'indexing_jobs_one_running_per_source',
];

function customBlock(text: string): { before: string; block: string; after: string } {
  const begin = text.indexOf('-- custom:begin');
  const end = text.indexOf('-- custom:end');
  return {
    before: begin >= 0 ? text.slice(0, begin) : text,
    block: begin >= 0 && end > begin ? text.slice(begin, end) : '',
    after: end >= 0 ? text.slice(end + '-- custom:end'.length) : '',
  };
}

describe('the lane migration is regeneration-safe', () => {
  it('is one generated migration followed by exactly one custom block at the end', () => {
    expect(entry, `a journal entry ending in ${TAG}`).toBeDefined();
    const { before, block, after } = customBlock(migrationSql);
    expect(block.length).toBeGreaterThan(0);
    expect(migrationSql.split('-- custom:begin')).toHaveLength(2);
    expect(after.trim()).toBe('');
    // Above the block: drizzle-kit output only (no hand-written comments,
    // no hand-moved statements a regeneration would undo).
    const handWritten = before
      .split('\n')
      .filter((l) => l.trim().startsWith('--') && l.trim() !== '--> statement-breakpoint');
    expect(handWritten).toEqual([]);
    // Nothing above the block drops a column or a table (purely additive:
    // no data loss before the backfill reads it, no rename prompt).
    expect(before).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME/);
  });

  it('every object the custom block creates is listed here', () => {
    const { block } = customBlock(migrationSql);
    const constraints = [...block.matchAll(/ADD CONSTRAINT "([a-z0-9_]+)"/g)].map((m) => m[1]);
    const indexes = [...block.matchAll(/CREATE UNIQUE INDEX "([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(constraints.sort()).toEqual(Object.keys(DB_ONLY_FKS).sort());
    expect(indexes.sort()).toEqual([...DB_ONLY_INDEXES].sort());
    expect(block).toMatch(
      /ALTER TABLE "document_chunks" ALTER COLUMN "knowledge_source_id" SET NOT NULL/,
    );
  });

  it('the TypeScript schema does not declare them (a regeneration would emit them too early)', () => {
    const declaredFks = (t: PgTable) => getTableConfig(t).foreignKeys.map((fk) => fk.getName());
    const all = [
      lessonScopes,
      lessonReinforcements,
      knowledgeSourceProducts,
      documentChunks,
    ].flatMap(declaredFks);
    for (const name of Object.keys(DB_ONLY_FKS)) expect(all).not.toContain(name);
    expect(documentChunks.knowledgeSourceId.notNull).toBe(false);
  });

  it('the migrated database has them all', async () => {
    const fks = (await db.execute(sql`
      SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE contype = 'f' AND conname IN ${sql.raw(
        `(${Object.keys(DB_ONLY_FKS)
          .map((n) => `'${n}'`)
          .join(', ')})`,
      )}`)) as unknown as Array<{ conname: string; tbl: string; def: string }>;
    const byName = Object.fromEntries(fks.map((r) => [r.conname, r]));
    for (const [name, want] of Object.entries(DB_ONLY_FKS)) {
      expect(byName[name], name).toBeDefined();
      expect(byName[name]!.tbl, name).toBe(want.table);
      expect(byName[name]!.def, name).toBe(want.def);
    }
    const [col] = (await db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'document_chunks'
        AND column_name = 'knowledge_source_id'`)) as unknown as Array<{ is_nullable: string }>;
    expect(col!.is_nullable).toBe('NO');
    const idx = (await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'indexing_jobs'`)) as unknown as Array<{
      indexname: string;
      indexdef: string;
    }>;
    for (const name of DB_ONLY_INDEXES) {
      const row = idx.find((r) => r.indexname === name);
      expect(row, name).toBeDefined();
      expect(row!.indexdef).toMatch(/^CREATE UNIQUE INDEX .* WHERE /);
    }
  });
});
