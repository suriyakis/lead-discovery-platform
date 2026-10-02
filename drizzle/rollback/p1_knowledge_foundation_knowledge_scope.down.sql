-- KL-05 rollback: restores knowledge_sources / knowledge_source_products /
-- document_chunks / product_profiles to their shape before
-- p1_knowledge_foundation_knowledge_scope (+ _contract), keeping the data
-- that shape can hold. Drizzle migrations are forward-only, so this is the
-- documented way back; take a pg_dump of knowledge_sources,
-- knowledge_source_products, document_chunks, indexing_jobs and
-- product_profiles first. src/tests/knowledge-scope-migration.test.ts
-- applies both migrations to a seeded scratch database, runs this file and
-- compares the result with the pre-migration shape.
--
-- What maps back:
--   * scope rows -> knowledge_sources.product_profile_ids (ordered ids);
--   * a workspace-scoped DOCUMENT source -> its document's document-level
--     chunks (document_id set, knowledge_source_id NULL), which is how the
--     old code made a document workspace-wide; the source row is deleted.
-- Lossy by necessity (the old shape cannot express these):
--   * a workspace-scoped document source loses its title, summary, purpose
--     and tags, and its indexing_jobs rows (they cascade with it);
--   * a workspace-scoped url / text source comes back with an empty array,
--     which the old code read as "not attached": the reply assistant still
--     used it, product drafts did not;
--   * a 'products' source with no scope row ("Needs a scope") comes back
--     with an empty array (same old meaning);
--   * the shadowed document-level chunks the migration deleted stay
--     deleted (they duplicated a product-scoped source; re-index restores
--     them if ever needed), and the dead product_profiles.document_source_ids
--     comes back empty.
-- The audit_log rows the migration wrote (knowledge_source.scope_backfill,
-- document.shadow_chunks_deleted) are history and stay.
--
-- Afterwards, delete the two KL-05 rows from drizzle.__drizzle_migrations
-- (created_at = the two `when` values of the
-- p1_knowledge_foundation_knowledge_scope* entries in
-- drizzle/meta/_journal.json) and redeploy the previous release.
BEGIN;

ALTER TABLE "knowledge_sources" ADD COLUMN "product_profile_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL;
ALTER TABLE "product_profiles" ADD COLUMN "document_source_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL;

UPDATE "knowledge_sources" ks
SET "product_profile_ids" = s."ids"
FROM (
  SELECT "source_id", array_agg("product_profile_id" ORDER BY "product_profile_id") AS "ids"
  FROM "knowledge_source_products"
  GROUP BY "source_id"
) s
WHERE s."source_id" = ks."id";

ALTER TABLE "document_chunks" DROP CONSTRAINT "document_chunks_knowledge_source_fk";
ALTER TABLE "document_chunks" ALTER COLUMN "knowledge_source_id" DROP NOT NULL;
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_knowledge_source_id_knowledge_sources_id_fk" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;

DO $$
DECLARE
  doc_sources integer;
  other_ws integer;
  unscoped integer;
BEGIN
  SELECT count(*) INTO doc_sources FROM "knowledge_sources"
  WHERE "scope_kind" = 'workspace' AND "kind" = 'document' AND "document_id" IS NOT NULL;
  SELECT count(*) INTO other_ws FROM "knowledge_sources"
  WHERE "scope_kind" = 'workspace' AND NOT ("kind" = 'document' AND "document_id" IS NOT NULL);
  SELECT count(*) INTO unscoped FROM "knowledge_sources" ks
  WHERE ks."scope_kind" = 'products'
    AND NOT EXISTS (SELECT 1 FROM "knowledge_source_products" p WHERE p."source_id" = ks."id");
  RAISE NOTICE 'KL-05 rollback: % workspace-wide document source(s) became document-level chunks; % workspace-wide url/text source(s) and % source(s) needing a scope came back with no products.', doc_sources, other_ws, unscoped;
END $$;

UPDATE "document_chunks" c
SET "document_id" = ks."document_id", "knowledge_source_id" = NULL
FROM "knowledge_sources" ks
WHERE c."knowledge_source_id" = ks."id"
  AND ks."scope_kind" = 'workspace'
  AND ks."kind" = 'document'
  AND ks."document_id" IS NOT NULL;

DELETE FROM "knowledge_sources"
WHERE "scope_kind" = 'workspace' AND "kind" = 'document' AND "document_id" IS NOT NULL;

DROP TABLE "knowledge_source_products";
DROP INDEX "knowledge_sources_document_idx";
ALTER TABLE "knowledge_sources" DROP CONSTRAINT "knowledge_sources_workspace_id_id_unique";
ALTER TABLE "knowledge_sources" DROP COLUMN "scope_kind";
DROP TYPE "public"."knowledge_scope_kind";

COMMIT;
