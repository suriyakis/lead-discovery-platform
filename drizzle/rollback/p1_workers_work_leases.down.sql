-- Rollback of p1_workers_work_leases (lane workers: PC-12). Restores the
-- shape from before the migration. Drizzle migrations are forward-only, so
-- this is the documented way back; take a pg_dump of outreach_follow_ups
-- first.
--
-- Afterwards, delete the migration's row from drizzle.__drizzle_migrations
-- (created_at = the `when` of the p1_workers_work_leases entry in
-- drizzle/meta/_journal.json) and redeploy the previous release.
--
-- Lossy by necessity: the previous release knows no 'processing' follow-up
-- and would leave such a step claimed for good. A step claimed but never
-- handed to the mail server goes back to 'pending' (nothing was sent); one
-- that was handed over and has no outcome is failed as interrupted, never
-- sent again. Leases are transient and simply dropped.

UPDATE "outreach_follow_ups"
SET "status" = 'pending', "updated_at" = now()
WHERE "status" = 'processing' AND "sending_at" IS NULL;

UPDATE "outreach_follow_ups"
SET "status" = 'failed',
    "last_error" = 'Interrupted: delivery unknown. Cut off during a rollback while it was being sent. Check the Sent folder before you send it again.',
    "processed_at" = now(),
    "updated_at" = now()
WHERE "status" = 'processing';

ALTER TABLE "outreach_follow_ups" DROP CONSTRAINT IF EXISTS "outreach_follow_ups_processing_claim_check";
ALTER TABLE "outreach_follow_ups" DROP COLUMN IF EXISTS "sending_at";
ALTER TABLE "outreach_follow_ups" DROP COLUMN IF EXISTS "claimed_at";
DROP TABLE IF EXISTS "work_leases";
