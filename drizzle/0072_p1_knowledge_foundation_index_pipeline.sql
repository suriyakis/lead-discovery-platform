-- KL-06 (I040, I103, I104, I108, I021): indexing as a job.
--
-- * documents: the extraction cache — extracted_text, extractor,
--   extracted_at, extracted_sha256 (the bytes it came from), detected_language
--   and page_count. OCR runs once per document SHA.
-- * knowledge_sources: index_status (queued | indexing | indexed | stale |
--   failed, enum knowledge_index_status), indexed_at, indexed_content_hash and
--   indexed_embedding_model (same hash + model = no re-embed) and
--   last_index_error.
-- * indexing_jobs becomes the knowledge.index outbox: attempts,
--   next_attempt_at (retry backoff), force_ocr (admin "Re-extract with
--   OCR"), reason, note, a CHECK on status, and an index for the per-source
--   lookups.
--
-- The custom block (end of file) closes the runs nobody will finish (before
-- KL-06 a run was inserted 'running' and a crash left it so forever), then
-- creates the two partial unique indexes that need that cleanup first — at
-- most one 'queued' and one 'running' run per source — and backfills the
-- honest status of every existing source from its chunks and
-- external_status. Nothing is re-indexed or re-embedded by the migration:
-- sources it marks 'stale' (never indexed, or a text / URL source edited
-- after its chunks were written, I103) wait for Re-index.
--
-- Rollback: drizzle/rollback/p1_knowledge_foundation_index_pipeline.down.sql
CREATE TYPE "public"."knowledge_index_status" AS ENUM('queued', 'indexing', 'indexed', 'stale', 'failed');--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_text" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extractor" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_sha256" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "detected_language" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "index_status" "knowledge_index_status" DEFAULT 'stale' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "indexed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "indexed_content_hash" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "indexed_embedding_model" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "last_index_error" text;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "force_ocr" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD COLUMN "note" text;--> statement-breakpoint
CREATE INDEX "knowledge_sources_ws_index_status_idx" ON "knowledge_sources" USING btree ("workspace_id","index_status");--> statement-breakpoint
CREATE INDEX "indexing_jobs_source_status_idx" ON "indexing_jobs" USING btree ("knowledge_source_id","status");--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_status_check" CHECK ("indexing_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed'));

--> statement-breakpoint
-- custom:begin
-- 1. Runs nobody will finish. A legacy 'running' row is a crashed request
--    (I108); a queued document-level row (no source, before KL-05) can no
--    longer run; of several queued rows for one source only the newest
--    stays. Closed with a message and no notification.
UPDATE "indexing_jobs"
SET "status" = 'failed',
    "error" = COALESCE("error" || ' | ', '') || 'Interrupted before KL-06: no worker finished this run.',
    "note" = 'timed_out',
    "finished_at" = COALESCE("finished_at", now())
WHERE "status" = 'running';
--> statement-breakpoint
UPDATE "indexing_jobs"
SET "status" = 'failed',
    "error" = 'Document-level run from before KL-05; documents are indexed through their knowledge source.',
    "finished_at" = COALESCE("finished_at", now())
WHERE "status" = 'queued' AND "knowledge_source_id" IS NULL;
--> statement-breakpoint
UPDATE "indexing_jobs" j
SET "status" = 'failed',
    "note" = 'superseded',
    "error" = 'Superseded by a newer request.',
    "finished_at" = now()
WHERE j."status" = 'queued'
  AND j."knowledge_source_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "indexing_jobs" n
    WHERE n."knowledge_source_id" = j."knowledge_source_id"
      AND n."status" = 'queued'
      AND n."id" > j."id"
  );
--> statement-breakpoint
-- 2. One queued and one running run per source from now on: requests
--    coalesce, and two workers never index the same source at once.
CREATE UNIQUE INDEX "indexing_jobs_one_queued_per_source"
  ON "indexing_jobs" ("knowledge_source_id")
  WHERE "status" = 'queued' AND "knowledge_source_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "indexing_jobs_one_running_per_source"
  ON "indexing_jobs" ("knowledge_source_id")
  WHERE "status" = 'running' AND "knowledge_source_id" IS NOT NULL;
--> statement-breakpoint
-- 3. The honest status of every existing source (I104, I103):
--    queued   a queued run is waiting for it;
--    failed   its last attach failed (external_status), message kept;
--    stale    no chunks (never indexed), or a text / URL source changed
--             more than a minute after its chunks were written (edits never
--             re-indexed before KL-06);
--    indexed  otherwise, stamped with its chunks' time and model. The
--             content hash stays NULL, so the first re-index re-embeds once.
UPDATE "knowledge_sources" ks
SET "index_status" = (CASE
      WHEN EXISTS (
        SELECT 1 FROM "indexing_jobs" j
        WHERE j."knowledge_source_id" = ks."id" AND j."status" = 'queued'
      ) THEN 'queued'
      WHEN ks."external_status" = 'failed' THEN 'failed'
      WHEN NOT EXISTS (
        SELECT 1 FROM "document_chunks" c WHERE c."knowledge_source_id" = ks."id"
      ) THEN 'stale'
      WHEN ks."kind" IN ('text', 'url')
        AND ks."updated_at" > (
          SELECT max(c."created_at") FROM "document_chunks" c
          WHERE c."knowledge_source_id" = ks."id"
        ) + interval '1 minute'
        THEN 'stale'
      ELSE 'indexed'
    END)::"knowledge_index_status",
    "indexed_at" = (
      SELECT COALESCE(ks."external_indexed_at", max(c."created_at"))
      FROM "document_chunks" c
      WHERE c."knowledge_source_id" = ks."id"
      HAVING count(*) > 0
    ),
    "indexed_embedding_model" = (
      SELECT max(c."embedding_model") FROM "document_chunks" c
      WHERE c."knowledge_source_id" = ks."id"
    ),
    "last_index_error" = CASE WHEN ks."external_status" = 'failed' THEN ks."external_error" END;
-- custom:end
