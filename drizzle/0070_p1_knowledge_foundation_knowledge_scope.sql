-- KL-05 (I039, I101, I104, I109) — EXPAND step: knowledge scope and chunk
-- ownership.
--
-- * knowledge_source_products(source_id, workspace_id, product_profile_id)
--   replaces the FK-less knowledge_sources.product_profile_ids array. Both
--   FKs are composite on workspace_id (the database refuses another tenant's
--   product) and cascade: deleting a product drops its scope rows, and a
--   'products' source left with none "Needs a scope" and is retrieved
--   nowhere. knowledge_sources.scope_kind says 'workspace' (every product)
--   or 'products' (exactly the scope rows); an empty list no longer means
--   anything.
-- * Every chunk gets an owner: the custom block below deletes the
--   document-level chunks (knowledge_source_id NULL) that the I039 "Index
--   now" path wrote next to a product-scoped source, then turns the
--   remaining document-level chunks into workspace-scoped document sources.
--   p1_knowledge_foundation_knowledge_scope_contract then sets
--   document_chunks.knowledge_source_id NOT NULL (composite FK on
--   workspace_id) and drops knowledge_sources.product_profile_ids and the
--   dead product_profiles.document_source_ids.
--
-- Two migrations by design (expand -> backfill -> contract), like KL-01:
-- this one was generated while src/lib/db/schema still declared
-- knowledge_sources.product_profile_ids, product_profiles.document_source_ids,
-- a nullable document_chunks.knowledge_source_id with its single-column FK,
-- and scope_kind DEFAULT 'products' (every existing source starts as
-- 'products'; the backfill below adds its rows). One combined migration
-- cannot work: drizzle-kit would drop the array before the backfill reads
-- it. Regenerating: restore those four declarations, generate this file,
-- re-append the custom block, then restore the final schema and generate
-- the contract migration.
--
-- Hand edit inside the generated part: drizzle-kit emits
-- knowledge_sources_workspace_id_id_unique AFTER the composite FK that
-- references it, which Postgres rejects; the UNIQUE statement was moved up
-- to sit right after the new column. Keep that order when regenerating.
--
-- Before deploying: run scripts/remediation/knowledge-scope-report.ts
-- (read-only) against production. It prints the counts this migration acts
-- on and the owner-review list of documents that become workspace-wide.
-- Rollback: drizzle/rollback/p1_knowledge_foundation_knowledge_scope.down.sql
-- (on the final shape, after both migrations).
CREATE TYPE "public"."knowledge_scope_kind" AS ENUM('workspace', 'products');--> statement-breakpoint
CREATE TABLE "knowledge_source_products" (
	"source_id" bigint NOT NULL,
	"workspace_id" bigint NOT NULL,
	"product_profile_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_source_products_pk" PRIMARY KEY("source_id","product_profile_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "scope_kind" "knowledge_scope_kind" DEFAULT 'products' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "knowledge_source_products" ADD CONSTRAINT "knowledge_source_products_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."knowledge_sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_source_products" ADD CONSTRAINT "knowledge_source_products_product_fk" FOREIGN KEY ("workspace_id","product_profile_id") REFERENCES "public"."product_profiles"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_source_products_ws_product_idx" ON "knowledge_source_products" USING btree ("workspace_id","product_profile_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_document_idx" ON "knowledge_sources" USING btree ("document_id");
--> statement-breakpoint
-- custom:begin
-- KL-05 backfill, in the order of the design (section 7). Runs once, in
-- the migrator's transaction; the guard at the end aborts the whole deploy
-- rather than leave a chunk without an owner.
--
-- 1. Orphan chunks (no source and no document): no provenance and nothing
--    could ever re-index them. Expected 0; the report counts them.
DELETE FROM "document_chunks"
WHERE "knowledge_source_id" IS NULL AND "document_id" IS NULL;--> statement-breakpoint
-- 2. The I039 shadow set, deleted BEFORE any conversion: the
--    document-level chunks of every document that has a source with
--    products ticked. The operator scoped that document; its second,
--    workspace-wide copy is what leaked into every other product (and gave
--    the scoped product duplicate passages). "Products ticked" means a
--    non-empty array, even when those products were deleted since: the
--    intent was product-scoped, so the document must not turn
--    workspace-wide. One audit row per document records the count.
WITH "shadowed" AS (
  DELETE FROM "document_chunks" c
  WHERE c."knowledge_source_id" IS NULL
    AND EXISTS (
      SELECT 1 FROM "knowledge_sources" ks
      WHERE ks."document_id" = c."document_id"
        AND ks."workspace_id" = c."workspace_id"
        AND cardinality(ks."product_profile_ids") > 0
    )
  RETURNING c."workspace_id", c."document_id"
)
INSERT INTO "audit_log" ("workspace_id", "kind", "entity_type", "entity_id", "payload")
SELECT "workspace_id", 'document.shadow_chunks_deleted', 'document', "document_id"::text,
       jsonb_build_object(
         'migration', 'p1_knowledge_foundation_knowledge_scope',
         'chunks', count(*)
       )
FROM "shadowed"
GROUP BY "workspace_id", "document_id";--> statement-breakpoint
-- 3. Scope rows from the array. Only products of the source's own
--    workspace that still exist get a row (foreign and deleted ids are
--    dropped; the FK would refuse them anyway). Every existing source
--    keeps scope_kind 'products' (the column default): one with no row
--    left (empty array, or only foreign / deleted ids) "Needs a scope".
--    Empty-array sources never reached a product's drafts before, so they
--    are not widened to every product without the owner deciding.
INSERT INTO "knowledge_source_products" ("source_id", "workspace_id", "product_profile_id")
SELECT DISTINCT ks."id", ks."workspace_id", p."id"
FROM "knowledge_sources" ks
CROSS JOIN LATERAL unnest(ks."product_profile_ids") AS u("pid")
JOIN "product_profiles" p ON p."id" = u."pid" AND p."workspace_id" = ks."workspace_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 4. Documents still holding document-level chunks were uploaded (or
--    indexed) with no product, which the upload form promised is
--    workspace-wide, and every product's drafts already read them. Each
--    becomes ONE scope_kind 'workspace' document source (title = document
--    name, tags = document tags) and its chunks move onto it unchanged, so
--    nothing is re-embedded and an archived document stays excluded until
--    restored. The report run before the deploy lists exactly these
--    documents for the owner: archive the ones that should not be used, or
--    tick products on their source (no re-index needed either way).
INSERT INTO "knowledge_sources" (
  "workspace_id", "kind", "document_id", "title", "tags", "scope_kind",
  "external_provider_id", "external_status", "external_indexed_at",
  "created_by", "created_at", "updated_at"
)
SELECT d."workspace_id", 'document', d."id", left(d."name", 240), d."tags", 'workspace',
       'pgvector', 'indexed', c."indexed_at",
       d."created_by", now(), now()
FROM "documents" d
JOIN (
  SELECT "document_id", "workspace_id", max("embedded_at") AS "indexed_at"
  FROM "document_chunks"
  WHERE "knowledge_source_id" IS NULL
  GROUP BY "document_id", "workspace_id"
) c ON c."document_id" = d."id" AND c."workspace_id" = d."workspace_id"
ORDER BY d."workspace_id", d."id";--> statement-breakpoint
-- Until step 4 no source had scope_kind 'workspace', so these are exactly
-- the sources it created (one per document). document_id is no longer
-- written on chunks: the source owns the chunk, the source wraps the
-- document.
UPDATE "document_chunks" c
SET "knowledge_source_id" = ks."id", "document_id" = NULL
FROM "knowledge_sources" ks
WHERE c."knowledge_source_id" IS NULL
  AND ks."scope_kind" = 'workspace'
  AND ks."kind" = 'document'
  AND ks."document_id" = c."document_id"
  AND ks."workspace_id" = c."workspace_id";--> statement-breakpoint
INSERT INTO "audit_log" ("workspace_id", "kind", "entity_type", "entity_id", "payload")
SELECT ks."workspace_id", 'knowledge_source.scope_backfill', 'knowledge_source', ks."id"::text,
       jsonb_build_object(
         'migration', 'p1_knowledge_foundation_knowledge_scope',
         'documentId', ks."document_id"::text,
         'scopeKind', 'workspace',
         'chunks', (SELECT count(*) FROM "document_chunks" c WHERE c."knowledge_source_id" = ks."id")
       )
FROM "knowledge_sources" ks
WHERE ks."scope_kind" = 'workspace'
ORDER BY ks."id";--> statement-breakpoint
-- 5. Guard: the contract migration sets knowledge_source_id NOT NULL. A
--    leftover can only be a chunk filed under another workspace than its
--    document; fail with a readable message instead of a bare NOT NULL
--    violation (the migrator's transaction rolls everything back).
DO $$
DECLARE
  leftover bigint;
BEGIN
  SELECT count(*) INTO leftover FROM "document_chunks" WHERE "knowledge_source_id" IS NULL;
  IF leftover > 0 THEN
    RAISE EXCEPTION 'KL-05: % document_chunks row(s) still have no knowledge source; see scripts/remediation/knowledge-scope-report.ts', leftover;
  END IF;
END $$;
-- custom:end
