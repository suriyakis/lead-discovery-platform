-- KL-05 CONTRACT step. p1_knowledge_foundation_knowledge_scope gave every
-- chunk an owning knowledge source and copied the product arrays into
-- knowledge_source_products; now:
--   * document_chunks.knowledge_source_id is NOT NULL, and its FK becomes
--     composite on workspace_id (a chunk can only belong to a source of its
--     own workspace), still ON DELETE CASCADE;
--   * knowledge_sources.scope_kind loses its backfill default, so every
--     writer states the scope explicitly;
--   * knowledge_sources.product_profile_ids (no FK, the I109 orphan ids)
--     and the never-read product_profiles.document_source_ids are dropped.
-- Nothing in src/ reads them any more (src/tests/knowledge-scope.test.ts
-- fails the build on a reference).
ALTER TABLE "document_chunks" DROP CONSTRAINT "document_chunks_knowledge_source_id_knowledge_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ALTER COLUMN "scope_kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "document_chunks" ALTER COLUMN "knowledge_source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_knowledge_source_fk" FOREIGN KEY ("workspace_id","knowledge_source_id") REFERENCES "public"."knowledge_sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_profiles" DROP COLUMN "document_source_ids";--> statement-breakpoint
ALTER TABLE "knowledge_sources" DROP COLUMN "product_profile_ids";