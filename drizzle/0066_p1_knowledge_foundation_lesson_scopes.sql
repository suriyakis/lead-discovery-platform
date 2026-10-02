-- KL-01 (I167, I038, I098, I109) — EXPAND step: rule scope model, single
-- lifecycle, polarity.
--
-- * lesson_scopes(lesson_id, workspace_id, product_profile_id) replaces
--   learning_lessons.product_profile_id. Both FKs are composite on
--   workspace_id, so the database refuses a scope row that joins a rule to
--   another tenant's product (I167); deleting a product cascades its scope
--   rows instead of hard-deleting the rule (I109). learning_lessons.scope_kind
--   says 'workspace' (everywhere) or 'products' (exactly the scope rows).
-- * lifecycle (active | proposed | disabled | retired) + retired_reason /
--   retired_note / merged_into_id replace `enabled`.
-- * polarity (+1 PREFER, -1 AVOID, 0 neutral), cited_count, last_cited_at,
--   reinforced_at.
--
-- Two migrations by design (expand -> backfill -> contract): this one was
-- generated while src/lib/db/schema/learning.ts still declared the legacy
-- product_profile_id and enabled columns, and backfills from them below;
-- p1_knowledge_foundation_lesson_scopes_contract drops them afterwards. One
-- combined migration cannot work: drizzle-kit would drop the columns before
-- the custom backfill reads them (and asks interactive rename questions).
-- Regenerating: restore the two deprecated column declarations and their two
-- indexes in learning.ts, generate this file, re-append the custom block,
-- then remove them again and generate the contract migration.
--
-- Hand edit inside the generated part: drizzle-kit emits the composite FKs
-- of lesson_scopes BEFORE the two UNIQUE(workspace_id, id) constraints they
-- reference, which Postgres rejects; those two UNIQUE statements were moved
-- up to sit right after the new columns. Keep that order when regenerating.
--
-- Rollback: drizzle/rollback/p1_knowledge_foundation_lesson_scopes.down.sql
-- (run after the contract migration's rollback position, i.e. on the final
-- shape). Prod has 0 lessons (prod_report Q9); dev and test rows migrate.
CREATE TYPE "public"."lesson_lifecycle" AS ENUM('active', 'proposed', 'disabled', 'retired');--> statement-breakpoint
CREATE TYPE "public"."lesson_retired_reason" AS ENUM('stale', 'merged', 'superseded', 'contradicted', 'operator_rejected', 'source_decision_voided', 'absorbed_into_profile', 'product_deleted', 'category_removed');--> statement-breakpoint
CREATE TYPE "public"."lesson_scope_kind" AS ENUM('workspace', 'products');--> statement-breakpoint
CREATE TABLE "lesson_scopes" (
	"lesson_id" bigint NOT NULL,
	"workspace_id" bigint NOT NULL,
	"product_profile_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_scopes_pk" PRIMARY KEY("lesson_id","product_profile_id")
);
--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "scope_kind" "lesson_scope_kind" DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "polarity" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "lifecycle" "lesson_lifecycle" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "retired_reason" "lesson_retired_reason";--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "retired_note" text;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "merged_into_id" bigint;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "cited_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "last_cited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "reinforced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_profiles" ADD CONSTRAINT "product_profiles_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "lesson_scopes" ADD CONSTRAINT "lesson_scopes_lesson_fk" FOREIGN KEY ("workspace_id","lesson_id") REFERENCES "public"."learning_lessons"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_scopes" ADD CONSTRAINT "lesson_scopes_product_fk" FOREIGN KEY ("workspace_id","product_profile_id") REFERENCES "public"."product_profiles"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_scopes_ws_product_idx" ON "lesson_scopes" USING btree ("workspace_id","product_profile_id");--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_merged_into_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."learning_lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_lessons_ws_lifecycle_category_idx" ON "learning_lessons" USING btree ("workspace_id","lifecycle","category");--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_polarity_check" CHECK ("learning_lessons"."polarity" IN (-1, 0, 1));--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_retired_reason_check" CHECK (("learning_lessons"."lifecycle" = 'retired') = ("learning_lessons"."retired_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_merged_into_check" CHECK ("learning_lessons"."merged_into_id" IS NULL OR ("learning_lessons"."lifecycle" = 'retired' AND "learning_lessons"."merged_into_id" <> "learning_lessons"."id"));--> statement-breakpoint
-- custom:begin
-- KL-01 backfill. Every statement only touches rows still on the column
-- defaults, so a re-run changes nothing.
--
-- 1. Scope. A rule that named a product becomes scope_kind 'products' with
--    one lesson_scopes row. The join keeps only products of the rule's own
--    workspace: a rule pointing at another tenant's product (I167) gets no
--    row, so it applies nowhere and shows as "Needs a scope".
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
-- 2. Lifecycle: enabled -> active, disabled -> disabled.
UPDATE "learning_lessons"
SET "lifecycle" = 'disabled'
WHERE "enabled" = false AND "lifecycle" = 'active';--> statement-breakpoint
-- 3. Polarity from the category registry (src/lib/services/learning-categories.ts).
--    sector_preference / contact_role let the rule choose: an avoid-verb in
--    the text makes it AVOID (the old prompt rendered every one of them as
--    PREFER, the I098 drift), anything else PREFER. Neutral categories and
--    general_instruction stay 0.
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
-- 4. dedupe_hint and connector_quality left the registry: nothing ever read
--    them (I038). Their rows retire with the reason on record.
UPDATE "learning_lessons"
SET "lifecycle" = 'retired',
    "retired_reason" = 'category_removed',
    "retired_note" = 'Category ' || "category" || ' was removed (KL-01): no qualification, outreach or reply step ever read it.'
WHERE "category" IN ('dedupe_hint', 'connector_quality') AND "lifecycle" <> 'retired';
-- custom:end
