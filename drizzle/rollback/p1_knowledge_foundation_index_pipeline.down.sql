-- KL-06 rollback: restores documents, knowledge_sources and indexing_jobs to
-- their shape before p1_knowledge_foundation_index_pipeline. Drizzle
-- migrations are forward-only, so this is the documented way back; take a
-- pg_dump of documents, knowledge_sources and indexing_jobs first.
-- src/tests/knowledge-index-migration.test.ts applies the migration to a
-- seeded scratch database, runs this file and compares the result with the
-- pre-migration shape.
--
-- Lossy by necessity: the extraction cache is dropped (the previous release
-- re-extracts — and re-pays OCR for — scanned PDFs on every index run), and
-- so are index_status, the content-hash stamps, retry counters and OCR
-- requests. The previous release never runs queued rows, so queued and
-- running rows are closed as failed here; external_status (still written by
-- KL-06) is what its pages show.
--
-- Afterwards, delete the KL-06 row from drizzle.__drizzle_migrations
-- (created_at = the `when` of the p1_knowledge_foundation_index_pipeline
-- entry in drizzle/meta/_journal.json) and redeploy the previous release.
BEGIN;

UPDATE "indexing_jobs"
SET "status" = 'failed',
    "error" = COALESCE("error" || ' | ', '') || 'Closed by the KL-06 rollback.',
    "finished_at" = COALESCE("finished_at", now())
WHERE "status" IN ('queued', 'running');

DROP INDEX IF EXISTS "indexing_jobs_one_queued_per_source";
DROP INDEX IF EXISTS "indexing_jobs_one_running_per_source";
DROP INDEX IF EXISTS "indexing_jobs_source_status_idx";
DROP INDEX IF EXISTS "knowledge_sources_ws_index_status_idx";
ALTER TABLE "indexing_jobs" DROP CONSTRAINT IF EXISTS "indexing_jobs_status_check";

ALTER TABLE "indexing_jobs" DROP COLUMN IF EXISTS "note";
ALTER TABLE "indexing_jobs" DROP COLUMN IF EXISTS "reason";
ALTER TABLE "indexing_jobs" DROP COLUMN IF EXISTS "force_ocr";
ALTER TABLE "indexing_jobs" DROP COLUMN IF EXISTS "next_attempt_at";
ALTER TABLE "indexing_jobs" DROP COLUMN IF EXISTS "attempts";

ALTER TABLE "knowledge_sources" DROP COLUMN IF EXISTS "last_index_error";
ALTER TABLE "knowledge_sources" DROP COLUMN IF EXISTS "indexed_embedding_model";
ALTER TABLE "knowledge_sources" DROP COLUMN IF EXISTS "indexed_content_hash";
ALTER TABLE "knowledge_sources" DROP COLUMN IF EXISTS "indexed_at";
ALTER TABLE "knowledge_sources" DROP COLUMN IF EXISTS "index_status";
DROP TYPE IF EXISTS "public"."knowledge_index_status";

ALTER TABLE "documents" DROP COLUMN IF EXISTS "page_count";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "detected_language";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "extracted_sha256";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "extracted_at";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "extractor";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "extracted_text";

COMMIT;
