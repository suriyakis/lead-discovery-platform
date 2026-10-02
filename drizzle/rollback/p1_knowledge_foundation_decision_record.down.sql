-- KL-02 rollback: restores learning_events and qualifications to their shape
-- before p1_knowledge_foundation_decision_record and drops learning_decisions.
-- Drizzle migrations are forward-only, so this is the documented way back;
-- take a pg_dump of learning_events, learning_decisions and qualifications
-- first. src/tests/learning-decision-migration.test.ts applies the migration
-- to a seeded scratch database, runs this file and compares the result with
-- the pre-migration shape.
--
-- Lossy by necessity (the old shape cannot express these): every learning
-- event row is kept, but its decision link, origin, verdict, weight,
-- context snapshot, outbox state and supersession (voided) marks are
-- dropped, so a voided event looks live again to the weekly synthesis;
-- operator verdicts and geo confirmations on qualifications are dropped,
-- which lifts the not_fit block on Promote / drafting / auto-enqueue.
--
-- Afterwards, delete the KL-02 row from drizzle.__drizzle_migrations
-- (created_at = the `when` of the p1_knowledge_foundation_decision_record
-- entry in drizzle/meta/_journal.json) and redeploy the previous release.
BEGIN;

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

COMMIT;
