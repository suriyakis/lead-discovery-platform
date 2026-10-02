-- KL-01 CONTRACT step: drop the legacy learning_lessons.product_profile_id
-- (replaced by scope_kind + lesson_scopes) and enabled (replaced by
-- lifecycle). p1_knowledge_foundation_lesson_scopes backfilled both before
-- this runs; nothing in src/ reads them any more (src/tests/
-- learning-legacy-columns.test.ts fails the build on a reference).
ALTER TABLE "learning_lessons" DROP CONSTRAINT "learning_lessons_product_profile_id_product_profiles_id_fk";
--> statement-breakpoint
DROP INDEX "learning_lessons_ws_enabled_idx";--> statement-breakpoint
DROP INDEX "learning_lessons_product_category_idx";--> statement-breakpoint
ALTER TABLE "learning_lessons" DROP COLUMN "product_profile_id";--> statement-breakpoint
ALTER TABLE "learning_lessons" DROP COLUMN "enabled";
