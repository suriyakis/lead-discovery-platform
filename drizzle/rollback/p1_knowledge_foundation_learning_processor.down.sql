-- KL-03 rollback: restores learning_events to its shape before
-- p1_knowledge_foundation_learning_processor and drops the reinforcement
-- ledger. Drizzle migrations are forward-only, so this is the documented way
-- back; take a pg_dump of learning_events, learning_lessons and
-- lesson_reinforcements first. src/tests/learning-processor-migration.test.ts
-- applies the migration to a seeded scratch database, runs this file and
-- compares the result with the pre-migration shape.
--
-- Lossy by necessity: the ledger (which rules a decision moved, and the
-- compensations that undid them) is dropped, so confidences stay where they
-- are but can no longer be explained or compensated; claim tokens and
-- processing notes are dropped. Events claimed at rollback time stay
-- 'processing' — set them back to 'pending' if the previous release's
-- processor should pick them up.
--
-- Afterwards, delete the KL-03 row from drizzle.__drizzle_migrations
-- (created_at = the `when` of the p1_knowledge_foundation_learning_processor
-- entry in drizzle/meta/_journal.json) and redeploy the previous release.
BEGIN;

DROP INDEX IF EXISTS "learning_events_voided_by_idx";
DROP INDEX IF EXISTS "learning_events_waiting_tokens_idx";
DROP TABLE IF EXISTS "lesson_reinforcements";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "processing_note";
ALTER TABLE "learning_events" DROP COLUMN IF EXISTS "claimed_at";

COMMIT;
