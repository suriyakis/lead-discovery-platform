-- KL-01 rollback: restores learning_lessons / product_profiles to their shape
-- before p1_knowledge_foundation_lesson_scopes (+ _contract), keeping the
-- data that shape can hold. Drizzle migrations are forward-only, so this is
-- the documented way back; take a pg_dump of learning_lessons, lesson_scopes
-- and product_profiles first. src/tests/learning-scope-migration.test.ts
-- applies both migrations to a seeded scratch database, runs this file and
-- compares the result with the pre-migration shape.
--
-- Lossy by necessity (the old shape cannot express these):
--   * a rule scoped to several products keeps only its lowest product id;
--   * a 'products' rule with no scope rows ("Needs a scope") comes back
--     DISABLED with product_profile_id NULL — NULL meant workspace-wide, so
--     enabling it would silently widen it;
--   * proposed / retired rules come back disabled; retired_reason,
--     retired_note, merged_into_id, polarity and the citation counters are
--     dropped.
--
-- Afterwards, delete the two KL-01 rows from drizzle.__drizzle_migrations
-- (created_at = the two `when` values of the p1_knowledge_foundation_lesson_scopes*
-- entries in drizzle/meta/_journal.json) and redeploy the previous release.
--
-- product_profiles_workspace_id_id_unique is dropped last; if a later
-- migration's composite FK (e.g. a knowledge-source scope table) depends on
-- it, that DROP fails and the whole script rolls back — roll that one back
-- first.
BEGIN;

ALTER TABLE "learning_lessons" ADD COLUMN "product_profile_id" bigint;
ALTER TABLE "learning_lessons" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;

UPDATE "learning_lessons" SET "enabled" = ("lifecycle" = 'active');

UPDATE "learning_lessons" l
SET "product_profile_id" = s."product_profile_id"
FROM (
  SELECT "lesson_id", min("product_profile_id") AS "product_profile_id"
  FROM "lesson_scopes"
  GROUP BY "lesson_id"
) s
WHERE s."lesson_id" = l."id";

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
