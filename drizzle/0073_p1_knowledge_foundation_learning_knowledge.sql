CREATE TYPE "public"."lesson_lifecycle" AS ENUM('active', 'proposed', 'disabled', 'retired');--> statement-breakpoint
CREATE TYPE "public"."lesson_retired_reason" AS ENUM('stale', 'merged', 'superseded', 'contradicted', 'operator_rejected', 'source_decision_voided', 'absorbed_into_profile', 'product_deleted', 'category_removed');--> statement-breakpoint
CREATE TYPE "public"."lesson_scope_kind" AS ENUM('workspace', 'products');--> statement-breakpoint
CREATE TYPE "public"."knowledge_index_status" AS ENUM('queued', 'indexing', 'indexed', 'stale', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_scope_kind" AS ENUM('workspace', 'products');--> statement-breakpoint
CREATE TABLE "learning_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" bigint NOT NULL,
	"decision_key" text NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_decisions_ws_key_unique" UNIQUE("workspace_id","decision_key"),
	CONSTRAINT "learning_decisions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "learning_decisions_origin_check" CHECK ("learning_decisions"."origin" IN ('operator', 'autopilot', 'system'))
);
--> statement-breakpoint
CREATE TABLE "lesson_reinforcements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"lesson_id" bigint NOT NULL,
	"event_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"delta_requested" smallint NOT NULL,
	"delta_applied" smallint NOT NULL,
	"confidence_before" smallint NOT NULL,
	"confidence_after" smallint NOT NULL,
	"compensates_id" bigint,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_reinforcements_compensates_unique" UNIQUE("compensates_id"),
	CONSTRAINT "lesson_reinforcements_kind_check" CHECK ("lesson_reinforcements"."kind" IN ('cited', 'dedup_match', 'compensation')),
	CONSTRAINT "lesson_reinforcements_compensation_check" CHECK (("lesson_reinforcements"."kind" = 'compensation') = ("lesson_reinforcements"."compensates_id" IS NOT NULL)),
	CONSTRAINT "lesson_reinforcements_confidence_check" CHECK ("lesson_reinforcements"."confidence_before" BETWEEN 0 AND 100 AND "lesson_reinforcements"."confidence_after" BETWEEN 0 AND 100 AND "lesson_reinforcements"."confidence_after" - "lesson_reinforcements"."confidence_before" = "lesson_reinforcements"."delta_applied")
);
--> statement-breakpoint
CREATE TABLE "lesson_scopes" (
	"lesson_id" bigint NOT NULL,
	"workspace_id" bigint NOT NULL,
	"product_profile_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_scopes_pk" PRIMARY KEY("lesson_id","product_profile_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_source_products" (
	"source_id" bigint NOT NULL,
	"workspace_id" bigint NOT NULL,
	"product_profile_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_source_products_pk" PRIMARY KEY("source_id","product_profile_id")
);
--> statement-breakpoint
ALTER TABLE "learning_lessons" DROP CONSTRAINT "learning_lessons_product_profile_id_product_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "document_chunks" DROP CONSTRAINT "document_chunks_knowledge_source_id_knowledge_sources_id_fk";
--> statement-breakpoint
DROP INDEX "learning_lessons_ws_enabled_idx";--> statement-breakpoint
DROP INDEX "learning_lessons_product_category_idx";--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "decision_id" uuid;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "origin" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "polarity" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "weight" numeric(3, 2) DEFAULT '1.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "explicit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "reason_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "context" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "processing_status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "processing_note" text;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "voided_by_event_id" bigint;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "overrides_autopilot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "scope_kind" "lesson_scope_kind" DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "polarity" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "lifecycle" "lesson_lifecycle" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "retired_reason" "lesson_retired_reason";--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "retired_note" text;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "merged_into_id" bigint;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "cited_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "last_cited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "reinforced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "operator_verdict" text;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "operator_decided_by" text;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "operator_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "operator_event_id" bigint;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "geo_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "geo_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_text" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extractor" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_sha256" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "detected_language" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "scope_kind" "knowledge_scope_kind" DEFAULT 'products' NOT NULL;--> statement-breakpoint
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
ALTER TABLE "learning_decisions" ADD CONSTRAINT "learning_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_decisions" ADD CONSTRAINT "learning_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_reinforcements" ADD CONSTRAINT "lesson_reinforcements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_reinforcements" ADD CONSTRAINT "lesson_reinforcements_event_id_learning_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."learning_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_reinforcements" ADD CONSTRAINT "lesson_reinforcements_compensates_fk" FOREIGN KEY ("compensates_id") REFERENCES "public"."lesson_reinforcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_decisions_ws_subject_idx" ON "learning_decisions" USING btree ("workspace_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_reinforcements_event_lesson_unique" ON "lesson_reinforcements" USING btree ("event_id","lesson_id") WHERE "lesson_reinforcements"."compensates_id" IS NULL;--> statement-breakpoint
CREATE INDEX "lesson_reinforcements_event_idx" ON "lesson_reinforcements" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "lesson_reinforcements_ws_lesson_idx" ON "lesson_reinforcements" USING btree ("workspace_id","lesson_id","created_at");--> statement-breakpoint
CREATE INDEX "lesson_scopes_ws_product_idx" ON "lesson_scopes" USING btree ("workspace_id","product_profile_id");--> statement-breakpoint
CREATE INDEX "knowledge_source_products_ws_product_idx" ON "knowledge_source_products" USING btree ("workspace_id","product_profile_id");--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_decision_fk" FOREIGN KEY ("workspace_id","decision_id") REFERENCES "public"."learning_decisions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_voided_by_fk" FOREIGN KEY ("voided_by_event_id") REFERENCES "public"."learning_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_merged_into_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."learning_lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_product_profile_id_product_profiles_id_fk" FOREIGN KEY ("product_profile_id") REFERENCES "public"."product_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_operator_decided_by_users_id_fk" FOREIGN KEY ("operator_decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_operator_event_id_learning_events_id_fk" FOREIGN KEY ("operator_event_id") REFERENCES "public"."learning_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_geo_confirmed_by_users_id_fk" FOREIGN KEY ("geo_confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_events_ws_decision_idx" ON "learning_events" USING btree ("workspace_id","decision_id");--> statement-breakpoint
CREATE INDEX "learning_events_ws_subject_idx" ON "learning_events" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "learning_events_outbox_idx" ON "learning_events" USING btree ("processing_status","next_attempt_at") WHERE "learning_events"."processing_status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "learning_events_waiting_tokens_idx" ON "learning_events" USING btree ("workspace_id") WHERE "learning_events"."processing_status" = 'skipped_no_tokens';--> statement-breakpoint
CREATE INDEX "learning_events_voided_by_idx" ON "learning_events" USING btree ("voided_by_event_id") WHERE "learning_events"."voided_by_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "learning_lessons_ws_lifecycle_category_idx" ON "learning_lessons" USING btree ("workspace_id","lifecycle","category");--> statement-breakpoint
CREATE INDEX "knowledge_sources_document_idx" ON "knowledge_sources" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_ws_index_status_idx" ON "knowledge_sources" USING btree ("workspace_id","index_status");--> statement-breakpoint
CREATE INDEX "indexing_jobs_source_status_idx" ON "indexing_jobs" USING btree ("knowledge_source_id","status");--> statement-breakpoint
ALTER TABLE "product_profiles" ADD CONSTRAINT "product_profiles_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_origin_check" CHECK ("learning_events"."origin" IN ('operator', 'autopilot', 'system'));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_verdict_check" CHECK ("learning_events"."verdict" IS NULL OR "learning_events"."verdict" IN ('fit', 'not_fit'));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_polarity_check" CHECK ("learning_events"."polarity" IN (-1, 0, 1));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_weight_check" CHECK ("learning_events"."weight" > 0 AND "learning_events"."weight" <= 1);--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_processing_status_check" CHECK ("learning_events"."processing_status" IN ('pending', 'processing', 'done', 'no_rule', 'below_floor', 'skipped_no_tokens', 'skipped', 'failed'));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_void_reason_check" CHECK ("learning_events"."void_reason" IS NULL OR "learning_events"."void_reason" IN ('changed_mind', 'undo', 'autopilot_override'));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_voided_check" CHECK (("learning_events"."voided_at" IS NULL) = ("learning_events"."void_reason" IS NULL) AND ("learning_events"."voided_by_event_id" IS NULL OR "learning_events"."voided_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_polarity_check" CHECK ("learning_lessons"."polarity" IN (-1, 0, 1));--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_retired_reason_check" CHECK (("learning_lessons"."lifecycle" = 'retired') = ("learning_lessons"."retired_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_merged_into_check" CHECK ("learning_lessons"."merged_into_id" IS NULL OR ("learning_lessons"."lifecycle" = 'retired' AND "learning_lessons"."merged_into_id" <> "learning_lessons"."id"));--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_operator_verdict_check" CHECK ("qualifications"."operator_verdict" IS NULL OR "qualifications"."operator_verdict" IN ('fit', 'not_fit'));--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_operator_decided_check" CHECK (("qualifications"."operator_verdict" IS NULL) = ("qualifications"."operator_decided_at" IS NULL));--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_status_check" CHECK ("indexing_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed'));--> statement-breakpoint
-- custom:begin
-- Phase 1 lane knowledge-foundation (KL-01, KL-02, KL-03, KL-05, KL-06):
-- the hand-written part of p1_knowledge_foundation_learning_knowledge.
--
-- REGENERATING THIS MIGRATION: everything above this block is the verbatim
-- output of `pnpm db:generate --name p1_knowledge_foundation_learning_knowledge`
-- against the lane's final schema (no hand edits, no intermediate schema,
-- no interactive prompt: the lane only ADDS — the legacy columns
-- learning_lessons.product_profile_id / enabled,
-- knowledge_sources.product_profile_ids and
-- product_profiles.document_source_ids stay declared as deprecated
-- `legacy*` properties, so nothing is dropped or renamed). Regenerate,
-- then append this block unchanged. The knowledge-foundation CONTRACT PR
-- (later) drops the legacy columns, declares
-- document_chunks.knowledge_source_id notNull() and drops
-- knowledge_sources.scope_kind's default.
--
-- What only this block creates (deliberately not declared in the TS
-- schema): the six composite (workspace_id, …) foreign keys below, which
-- reference UNIQUE(workspace_id, id) constraints added above to EXISTING
-- tables — drizzle-kit emits every FK before every added UNIQUE, so a
-- declared FK would be created first and Postgres would refuse it —
-- document_chunks.knowledge_source_id NOT NULL (only true after the KL-05
-- backfill) and the two partial unique indexes on indexing_jobs (only
-- creatable after the KL-06 cleanup). src/tests/db-only-constraints.test.ts
-- fails if a regeneration loses any of them; the migration tests
-- (src/tests/*-migration.test.ts) run this file on seeded old-shape data
-- and check drizzle/rollback/p1_knowledge_foundation_learning_knowledge.down.sql.
--
-- Before deploying: run scripts/remediation/knowledge-scope-report.ts
-- (read-only) against production; it prints the counts the KL-05 part acts
-- on and the owner-review list of documents that become workspace-wide.
--
-- ===== A. Composite tenant FKs (the UNIQUEs they need exist now) =========
ALTER TABLE "lesson_scopes" ADD CONSTRAINT "lesson_scopes_lesson_fk" FOREIGN KEY ("workspace_id","lesson_id") REFERENCES "public"."learning_lessons"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_scopes" ADD CONSTRAINT "lesson_scopes_product_fk" FOREIGN KEY ("workspace_id","product_profile_id") REFERENCES "public"."product_profiles"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_reinforcements" ADD CONSTRAINT "lesson_reinforcements_lesson_fk" FOREIGN KEY ("workspace_id","lesson_id") REFERENCES "public"."learning_lessons"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_source_products" ADD CONSTRAINT "knowledge_source_products_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."knowledge_sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_source_products" ADD CONSTRAINT "knowledge_source_products_product_fk" FOREIGN KEY ("workspace_id","product_profile_id") REFERENCES "public"."product_profiles"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ===== B. KL-01 backfill (rule scope, lifecycle, polarity) ===============
-- Every statement only touches rows still on the column defaults.
--
-- B1. Scope. A rule that named a product becomes scope_kind 'products'
--     with one lesson_scopes row. The join keeps only products of the
--     rule's own workspace: a rule pointing at another tenant's product
--     (I167) gets no row, so it applies nowhere and shows as "Needs a
--     scope". The legacy column keeps its value (frozen, never read; its FK
--     is now ON DELETE SET NULL so a product delete cannot hard-delete the
--     rule, I109).
UPDATE "learning_lessons"
SET "scope_kind" = 'products'
WHERE "product_profile_id" IS NOT NULL AND "scope_kind" = 'workspace';--> statement-breakpoint
INSERT INTO "lesson_scopes" ("lesson_id", "workspace_id", "product_profile_id")
SELECT l."id", l."workspace_id", l."product_profile_id"
FROM "learning_lessons" l
JOIN "product_profiles" p
  ON p."id" = l."product_profile_id" AND p."workspace_id" = l."workspace_id"
WHERE l."product_profile_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- B2. Lifecycle: enabled -> active, disabled -> disabled.
UPDATE "learning_lessons"
SET "lifecycle" = 'disabled'
WHERE "enabled" = false AND "lifecycle" = 'active';--> statement-breakpoint
-- B3. Polarity from the category registry (src/lib/services/learning-categories.ts).
--     sector_preference / contact_role let the rule choose: an avoid-verb in
--     the text makes it AVOID (the old prompt rendered every one of them as
--     PREFER, the I098 drift), anything else PREFER. Neutral categories and
--     general_instruction stay 0.
UPDATE "learning_lessons"
SET "polarity" = CASE
  WHEN "category" IN ('qualification_positive', 'false_negative') THEN 1
  WHEN "category" IN ('qualification_negative', 'false_positive') THEN -1
  WHEN "category" IN ('sector_preference', 'contact_role') THEN
    CASE WHEN "rule" ~* '\y(avoid|skip|exclude|never|don''t|do not|not relevant|not interested|reject|ignore|steer clear)\y'
      THEN -1 ELSE 1 END
  ELSE 0
END
WHERE "polarity" = 0;--> statement-breakpoint
-- B4. dedupe_hint and connector_quality left the registry: nothing ever
--     read them (I038). Their rows retire with the reason on record.
UPDATE "learning_lessons"
SET "lifecycle" = 'retired',
    "retired_reason" = 'category_removed',
    "retired_note" = 'Category ' || "category" || ' was removed (KL-01): no qualification, outreach or reply step ever read it.'
WHERE "category" IN ('dedupe_hint', 'connector_quality') AND "lifecycle" <> 'retired';--> statement-breakpoint
-- KL-02 / KL-03 need no backfill: existing learning_events keep
-- decision_id NULL and take processing_status 'done' / origin 'operator'
-- from the column defaults (they were processed inline before KL-02; prod
-- has 0 events and 0 lessons, prod_report Q9).
--
-- ===== C. KL-05 backfill (knowledge scope and chunk ownership) ===========
-- In the order of the design (section 7). The guard at the end aborts the
-- whole deploy rather than leave a chunk without an owner.
--
-- C1. Orphan chunks (no source and no document): no provenance and nothing
--     could ever re-index them. Expected 0; the report counts them.
DELETE FROM "document_chunks"
WHERE "knowledge_source_id" IS NULL AND "document_id" IS NULL;--> statement-breakpoint
-- C2. The I039 shadow set: the document-level chunks (knowledge_source_id
--     NULL) of every document that has a source with products ticked. The
--     operator scoped that document; its second, workspace-wide copy is
--     what leaked into every other product. "Products ticked" means a
--     non-empty array, even when those products were deleted since: the
--     intent was product-scoped, so the document must not turn
--     workspace-wide.
--     C2a. A product source with NO chunks of its own (indexing never ran
--     for it, or its attach failed) was getting this document only through
--     the shadow copy: it ADOPTS a copy of those chunks (same text and
--     embeddings, nothing re-embedded) so its products keep the passages.
--     One audit row per adopting source with the count.
WITH "adopted" AS (
  INSERT INTO "document_chunks" (
    "workspace_id", "document_id", "knowledge_source_id", "chunk_index", "start_char",
    "end_char", "content", "token_count", "embedding", "embedding_model", "embedding_dim",
    "embedded_at", "metadata", "created_at"
  )
  SELECT c."workspace_id", NULL, ks."id", c."chunk_index", c."start_char",
         c."end_char", c."content", c."token_count", c."embedding", c."embedding_model", c."embedding_dim",
         c."embedded_at", c."metadata", c."created_at"
  FROM "document_chunks" c
  JOIN "knowledge_sources" ks
    ON ks."document_id" = c."document_id" AND ks."workspace_id" = c."workspace_id"
  WHERE c."knowledge_source_id" IS NULL
    AND cardinality(ks."product_profile_ids") > 0
    AND NOT EXISTS (SELECT 1 FROM "document_chunks" o WHERE o."knowledge_source_id" = ks."id")
  ORDER BY ks."id", c."chunk_index", c."id"
  RETURNING "workspace_id", "knowledge_source_id"
)
INSERT INTO "audit_log" ("workspace_id", "kind", "entity_type", "entity_id", "payload")
SELECT a."workspace_id", 'knowledge_source.shadow_chunks_adopted', 'knowledge_source',
       a."knowledge_source_id"::text,
       jsonb_build_object(
         'migration', 'p1_knowledge_foundation_learning_knowledge',
         'documentId', ks."document_id"::text,
         'chunks', count(*)
       )
FROM "adopted" a
JOIN "knowledge_sources" ks ON ks."id" = a."knowledge_source_id"
GROUP BY a."workspace_id", a."knowledge_source_id", ks."document_id";--> statement-breakpoint
--     C2b. Then the shadow copies themselves go, one audit row per
--     document with the count.
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
         'migration', 'p1_knowledge_foundation_learning_knowledge',
         'chunks', count(*)
       )
FROM "shadowed"
GROUP BY "workspace_id", "document_id";--> statement-breakpoint
-- C3. Scope rows from the array. Only products of the source's own
--     workspace that still exist get a row (foreign and deleted ids are
--     dropped; the FK would refuse them anyway). Every existing source
--     keeps scope_kind 'products' (the column default): one with no row
--     left (empty array, or only foreign / deleted ids) "Needs a scope".
--     Empty-array sources never reached a product's drafts before, so they
--     are not widened to every product without the owner deciding — except
--     in C4, where the document was ALREADY read by every product.
INSERT INTO "knowledge_source_products" ("source_id", "workspace_id", "product_profile_id")
SELECT DISTINCT ks."id", ks."workspace_id", p."id"
FROM "knowledge_sources" ks
CROSS JOIN LATERAL unnest(ks."product_profile_ids") AS u("pid")
JOIN "product_profiles" p ON p."id" = u."pid" AND p."workspace_id" = ks."workspace_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- C4. Documents still holding document-level chunks were uploaded (or
--     indexed) with no product, which the upload form promised is
--     workspace-wide, and every product's drafts already read them. Each
--     ends up with exactly ONE scope_kind 'workspace' document source
--     owning those chunks, unchanged (nothing re-embedded; an archived
--     document stays excluded until restored):
--     C4a. the document's existing source (all its sources have an empty
--          array here, or C2 would have removed the chunks), the oldest one
--          when there are several, is converted to 'workspace' — no second
--          source next to it (one source per document, KL-06);
--     C4b. that source's own chunks duplicated the document-level ones:
--          they go, so no product gets the passages twice;
--     C4c. a document with no source at all gets a new one (title =
--          document name, tags = document tags).
--     The report run before the deploy lists exactly these documents for
--     the owner: archive the ones that should not be used, or tick
--     products on their source (no re-index needed either way).
UPDATE "knowledge_sources" ks
SET "scope_kind" = 'workspace'
FROM (
  SELECT DISTINCT ON (s."workspace_id", s."document_id") s."id"
  FROM "knowledge_sources" s
  WHERE cardinality(s."product_profile_ids") = 0
    AND EXISTS (
      SELECT 1 FROM "document_chunks" c
      WHERE c."knowledge_source_id" IS NULL
        AND c."document_id" = s."document_id"
        AND c."workspace_id" = s."workspace_id"
    )
  ORDER BY s."workspace_id", s."document_id", s."id"
) chosen
WHERE ks."id" = chosen."id";--> statement-breakpoint
WITH "duplicates" AS (
  DELETE FROM "document_chunks" c
  USING "knowledge_sources" ks
  WHERE c."knowledge_source_id" = ks."id"
    AND ks."scope_kind" = 'workspace'
  RETURNING ks."workspace_id", ks."id"
)
INSERT INTO "audit_log" ("workspace_id", "kind", "entity_type", "entity_id", "payload")
SELECT "workspace_id", 'knowledge_source.duplicate_chunks_deleted', 'knowledge_source', "id"::text,
       jsonb_build_object(
         'migration', 'p1_knowledge_foundation_learning_knowledge',
         'chunks', count(*)
       )
FROM "duplicates"
GROUP BY "workspace_id", "id";--> statement-breakpoint
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
WHERE NOT EXISTS (
  SELECT 1 FROM "knowledge_sources" ks
  WHERE ks."document_id" = d."id" AND ks."workspace_id" = d."workspace_id"
)
ORDER BY d."workspace_id", d."id";--> statement-breakpoint
-- Until C4 no source had scope_kind 'workspace' (the column default is
-- 'products'), so these are exactly the C4a / C4c sources, one per
-- document. document_id is no longer written on chunks: the source owns
-- the chunk, the source wraps the document.
UPDATE "document_chunks" c
SET "knowledge_source_id" = ks."id", "document_id" = NULL
FROM "knowledge_sources" ks
WHERE c."knowledge_source_id" IS NULL
  AND ks."scope_kind" = 'workspace'
  AND ks."document_id" = c."document_id"
  AND ks."workspace_id" = c."workspace_id";--> statement-breakpoint
-- `reused` marks a C4a source: it existed before this migration (created
-- before the migration's transaction began, whose now() stamped every C4c
-- row). The rollback keeps such a source instead of deleting it.
INSERT INTO "audit_log" ("workspace_id", "kind", "entity_type", "entity_id", "payload")
SELECT ks."workspace_id", 'knowledge_source.scope_backfill', 'knowledge_source', ks."id"::text,
       jsonb_build_object(
         'migration', 'p1_knowledge_foundation_learning_knowledge',
         'documentId', ks."document_id"::text,
         'scopeKind', 'workspace',
         'reused', ks."created_at" < now(),
         'chunks', (SELECT count(*) FROM "document_chunks" c WHERE c."knowledge_source_id" = ks."id")
       )
FROM "knowledge_sources" ks
WHERE ks."scope_kind" = 'workspace'
ORDER BY ks."id";--> statement-breakpoint
-- C5. Guard, then the constraints only true from here on. A leftover can
--     only be a chunk filed under another workspace than its document;
--     fail with a readable message instead of a bare NOT NULL violation
--     (the migrator's transaction rolls everything back).
DO $$
DECLARE
  leftover bigint;
BEGIN
  SELECT count(*) INTO leftover FROM "document_chunks" WHERE "knowledge_source_id" IS NULL;
  IF leftover > 0 THEN
    RAISE EXCEPTION 'KL-05: % document_chunks row(s) still have no knowledge source; see scripts/remediation/knowledge-scope-report.ts', leftover;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "document_chunks" ALTER COLUMN "knowledge_source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_knowledge_source_fk" FOREIGN KEY ("workspace_id","knowledge_source_id") REFERENCES "public"."knowledge_sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ===== D. KL-06 (indexing as a job) =======================================
-- D1. Runs nobody will finish. A legacy 'running' row is a crashed request
--     (I108); a queued document-level row (no source, before KL-05) can no
--     longer run; of several queued rows for one source only the newest
--     stays. Closed with a message and no notification.
UPDATE "indexing_jobs"
SET "status" = 'failed',
    "error" = COALESCE("error" || ' | ', '') || 'Interrupted before KL-06: no worker finished this run.',
    "note" = 'timed_out',
    "finished_at" = COALESCE("finished_at", now())
WHERE "status" = 'running';--> statement-breakpoint
UPDATE "indexing_jobs"
SET "status" = 'failed',
    "error" = 'Document-level run from before KL-05; documents are indexed through their knowledge source.',
    "finished_at" = COALESCE("finished_at", now())
WHERE "status" = 'queued' AND "knowledge_source_id" IS NULL;--> statement-breakpoint
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
  );--> statement-breakpoint
-- D2. One queued and one running run per source from now on: requests
--     coalesce, and two workers never index the same source at once.
CREATE UNIQUE INDEX "indexing_jobs_one_queued_per_source"
  ON "indexing_jobs" ("knowledge_source_id")
  WHERE "status" = 'queued' AND "knowledge_source_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "indexing_jobs_one_running_per_source"
  ON "indexing_jobs" ("knowledge_source_id")
  WHERE "status" = 'running' AND "knowledge_source_id" IS NOT NULL;--> statement-breakpoint
-- D3. The honest status of every source (I104, I103), after C gave every
--     chunk its owner:
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
