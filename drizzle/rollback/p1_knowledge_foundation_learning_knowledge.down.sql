-- Rollback of p1_knowledge_foundation_learning_knowledge (lane
-- knowledge-foundation: KL-01, KL-02, KL-03, KL-05, KL-06). Restores the
-- shape from before the migration, keeping the data that shape can hold.
-- Drizzle migrations are forward-only, so this is the documented way back:
-- take a pg_dump of learning_lessons, lesson_scopes, learning_events,
-- learning_decisions, lesson_reinforcements, qualifications,
-- knowledge_sources, knowledge_source_products, document_chunks,
-- indexing_jobs, documents and product_profiles first. The migration tests
-- (src/tests/learning-scope-migration.test.ts, learning-decision-,
-- learning-processor-, knowledge-scope-, knowledge-index-migration) apply
-- the migration to a seeded scratch database, run this file and compare
-- the result with the shape captured before.
--
-- Afterwards, delete the migration's row from drizzle.__drizzle_migrations
-- (created_at = the `when` of the p1_knowledge_foundation_learning_knowledge
-- entry in drizzle/meta/_journal.json) and redeploy the previous release.
--
-- Lossy by necessity (the old shape cannot express these):
--   KL-06  the extraction cache is dropped (the previous release
--          re-extracts — and re-pays OCR for — scanned PDFs on every index
--          run), and so are index_status, the content-hash stamps, retry
--          counters and OCR requests. The previous release never runs
--          queued rows, so queued and running rows are closed as failed;
--          external_status (still written) is what its pages show.
--   KL-05  scope rows map back to knowledge_sources.product_profile_ids
--          (ordered ids; empty for workspace-wide and "Needs a scope"
--          sources). A workspace-scoped DOCUMENT source becomes its
--          document's document-level chunks (document_id set,
--          knowledge_source_id NULL) — how the old code made a document
--          workspace-wide; the source row is deleted unless the migration
--          reused a source that existed before it (audit_log
--          knowledge_source.scope_backfill with reused = true), which is
--          kept with an empty array. A deleted one loses its title,
--          summary, purpose, tags and indexing_jobs rows. A workspace-
--          scoped url / text source comes back with an empty array, which
--          the old code read as "not attached" (the reply assistant still
--          used it, product drafts did not). Shadow copies the migration
--          deleted stay deleted (a product source adopted a copy where it
--          had none); duplicate chunks of a reused source stay deleted.
--          The audit_log rows the migration wrote are history and stay.
--   KL-03  the reinforcement ledger is dropped: confidences stay where
--          they are but can no longer be explained or compensated; claim
--          tokens and processing notes are dropped. Events claimed at
--          rollback time stay 'processing' — set them to 'pending' if the
--          previous release's processor should pick them up.
--   KL-02  every learning event row is kept, but its decision link,
--          origin, verdict, weight, context snapshot, outbox state and
--          supersession (voided) marks are dropped, so a voided event looks
--          live again to the weekly synthesis; operator verdicts and geo
--          confirmations on qualifications are dropped, which lifts the
--          not_fit block on Promote / drafting / auto-enqueue.
--   KL-01  a rule scoped to several products keeps only its lowest
--          product id; a 'products' rule with no scope rows ("Needs a
--          scope") comes back DISABLED with product_profile_id NULL (NULL
--          meant workspace-wide, so enabling it would silently widen it);
--          proposed / retired rules come back disabled; retired_reason,
--          retired_note, merged_into_id, polarity and the citation counters
--          are dropped.
BEGIN;

-- ===== KL-06 ================================================================
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

-- ===== KL-05 ================================================================
UPDATE "knowledge_sources" ks
SET "product_profile_ids" = COALESCE(
  (SELECT array_agg(p."product_profile_id" ORDER BY p."product_profile_id")
   FROM "knowledge_source_products" p
   WHERE p."source_id" = ks."id"),
  '{}'::bigint[]
);

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

DELETE FROM "knowledge_sources" ks
WHERE ks."scope_kind" = 'workspace' AND ks."kind" = 'document' AND ks."document_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "audit_log" a
    WHERE a."kind" = 'knowledge_source.scope_backfill'
      AND a."entity_type" = 'knowledge_source'
      AND a."entity_id" = ks."id"::text
      AND a."workspace_id" = ks."workspace_id"
      AND a."payload"->>'reused' = 'true'
  );

ALTER TABLE "knowledge_source_products" DROP CONSTRAINT IF EXISTS "knowledge_source_products_source_fk";
ALTER TABLE "knowledge_source_products" DROP CONSTRAINT IF EXISTS "knowledge_source_products_product_fk";
DROP TABLE "knowledge_source_products";
DROP INDEX "knowledge_sources_document_idx";
ALTER TABLE "knowledge_sources" DROP CONSTRAINT "knowledge_sources_workspace_id_id_unique";
ALTER TABLE "knowledge_sources" DROP COLUMN "scope_kind";
DROP TYPE "public"."knowledge_scope_kind";

-- ===== KL-03 ================================================================
DROP INDEX IF EXISTS "learning_events_voided_by_idx";
DROP INDEX IF EXISTS "learning_events_waiting_tokens_idx";
DROP TABLE IF EXISTS "lesson_reinforcements";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "processing_note";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "claimed_at";

-- ===== KL-02 ================================================================
ALTER TABLE "qualifications" DROP CONSTRAINT IF EXISTS "qualifications_operator_decided_check";
ALTER TABLE "qualifications" DROP CONSTRAINT IF EXISTS "qualifications_operator_verdict_check";
ALTER TABLE "qualifications" DROP CONSTRAINT IF EXISTS "qualifications_geo_confirmed_by_users_id_fk";
ALTER TABLE "qualifications" DROP CONSTRAINT IF EXISTS "qualifications_operator_event_id_learning_events_id_fk";
ALTER TABLE "qualifications" DROP CONSTRAINT IF EXISTS "qualifications_operator_decided_by_users_id_fk";
ALTER TABLE "qualifications" DROP COLUMN IF EXISTS "geo_confirmed_at";
ALTER TABLE "qualifications" DROP COLUMN IF EXISTS "geo_confirmed_by";
ALTER TABLE "qualifications" DROP COLUMN IF EXISTS "operator_event_id";
ALTER TABLE "qualifications" DROP COLUMN IF EXISTS "operator_decided_at";
ALTER TABLE "qualifications" DROP COLUMN IF EXISTS "operator_decided_by";
ALTER TABLE "qualifications" DROP COLUMN IF EXISTS "operator_verdict";

ALTER TABLE "learning_events" DROP CONSTRAINT IF EXISTS "learning_events_voided_check";
ALTER TABLE "learning_events" DROP CONSTRAINT IF EXISTS "learning_events_void_reason_check";
ALTER TABLE "learning_events" DROP CONSTRAINT IF EXISTS "learning_events_processing_status_check";
ALTER TABLE "learning_events" DROP CONSTRAINT IF EXISTS "learning_events_weight_check";
ALTER TABLE "learning_events" DROP CONSTRAINT IF EXISTS "learning_events_polarity_check";
ALTER TABLE "learning_events" DROP CONSTRAINT IF EXISTS "learning_events_verdict_check";
ALTER TABLE "learning_events" DROP CONSTRAINT IF EXISTS "learning_events_origin_check";
ALTER TABLE "learning_events" DROP CONSTRAINT IF EXISTS "learning_events_voided_by_fk";
ALTER TABLE "learning_events" DROP CONSTRAINT IF EXISTS "learning_events_decision_fk";
DROP INDEX IF EXISTS "learning_events_outbox_idx";
DROP INDEX IF EXISTS "learning_events_ws_subject_idx";
DROP INDEX IF EXISTS "learning_events_ws_decision_idx";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "overrides_autopilot";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "void_reason";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "voided_by_event_id";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "voided_at";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "processed_at";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "last_error";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "next_attempt_at";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "attempts";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "processing_status";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "context";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "reason_codes";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "explicit";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "weight";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "polarity";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "verdict";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "origin";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "decision_id";

DROP TABLE IF EXISTS "learning_decisions";

-- ===== KL-01 ================================================================
-- The legacy columns stayed in place (frozen at the backfill); bring them
-- back in line with what the rules became.
UPDATE "learning_lessons" l
SET "product_profile_id" = (
      SELECT min(s."product_profile_id") FROM "lesson_scopes" s WHERE s."lesson_id" = l."id"
    ),
    "enabled" = (l."lifecycle" = 'active');

UPDATE "learning_lessons"
SET "enabled" = false
WHERE "scope_kind" = 'products' AND "product_profile_id" IS NULL;

DO $$
DECLARE
  multi integer;
  unscoped integer;
BEGIN
  SELECT count(*) INTO multi FROM (
    SELECT "lesson_id" FROM "lesson_scopes" GROUP BY "lesson_id" HAVING count(*) > 1
  ) m;
  SELECT count(*) INTO unscoped FROM "learning_lessons"
  WHERE "scope_kind" = 'products' AND "product_profile_id" IS NULL;
  RAISE NOTICE 'KL-01 rollback: % multi-product rule(s) kept only their lowest product id; % rule(s) with no product came back disabled.', multi, unscoped;
END $$;

ALTER TABLE "learning_lessons" DROP CONSTRAINT "learning_lessons_product_profile_id_product_profiles_id_fk";
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_product_profile_id_product_profiles_id_fk" FOREIGN KEY ("product_profile_id") REFERENCES "public"."product_profiles"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "learning_lessons_ws_enabled_idx" ON "learning_lessons" USING btree ("workspace_id","enabled");
CREATE INDEX "learning_lessons_product_category_idx" ON "learning_lessons" USING btree ("product_profile_id","category","enabled");

DROP TABLE "lesson_scopes";

ALTER TABLE "learning_lessons" DROP CONSTRAINT "learning_lessons_merged_into_check";
ALTER TABLE "learning_lessons" DROP CONSTRAINT "learning_lessons_retired_reason_check";
ALTER TABLE "learning_lessons" DROP CONSTRAINT "learning_lessons_polarity_check";
ALTER TABLE "learning_lessons" DROP CONSTRAINT "learning_lessons_merged_into_id_fk";
ALTER TABLE "learning_lessons" DROP CONSTRAINT "learning_lessons_workspace_id_id_unique";
DROP INDEX "learning_lessons_ws_lifecycle_category_idx";

ALTER TABLE "learning_lessons" DROP COLUMN "scope_kind";
ALTER TABLE "learning_lessons" DROP COLUMN "polarity";
ALTER TABLE "learning_lessons" DROP COLUMN "lifecycle";
ALTER TABLE "learning_lessons" DROP COLUMN "retired_reason";
ALTER TABLE "learning_lessons" DROP COLUMN "retired_note";
ALTER TABLE "learning_lessons" DROP COLUMN "merged_into_id";
ALTER TABLE "learning_lessons" DROP COLUMN "cited_count";
ALTER TABLE "learning_lessons" DROP COLUMN "last_cited_at";
ALTER TABLE "learning_lessons" DROP COLUMN "reinforced_at";

ALTER TABLE "product_profiles" DROP CONSTRAINT "product_profiles_workspace_id_id_unique";

DROP TYPE "public"."lesson_lifecycle";
DROP TYPE "public"."lesson_retired_reason";
DROP TYPE "public"."lesson_scope_kind";

COMMIT;
