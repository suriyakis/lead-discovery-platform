-- Rollback of p1_workers_ai_action_guards (lane workers: PC-38). Restores
-- the shape from before the migration. Drizzle migrations are forward-only,
-- so this is the documented way back.
--
-- Afterwards, delete the migration's row from drizzle.__drizzle_migrations
-- (created_at = the `when` of the p1_workers_ai_action_guards entry in
-- drizzle/meta/_journal.json) and redeploy the previous release.
--
-- Lossy by design: the rate limiter's windows and the re-classification
-- history are dropped (the previous release keeps its windows in memory and
-- re-classifies inside the request). Action leases are transient and
-- dropped before the CHECK constraints go back to the PC-12 kinds.

DELETE FROM "work_leases" WHERE "kind" = 'action';

ALTER TABLE "work_leases" DROP CONSTRAINT IF EXISTS "work_leases_resource_key_check";
ALTER TABLE "work_leases" ADD CONSTRAINT "work_leases_resource_key_check" CHECK (CASE WHEN "kind" IN ('mailbox.sync', 'connector.recipe') THEN "resource_key" ~ '^[0-9]+$' ELSE "resource_key" = '' END);
ALTER TABLE "work_leases" DROP CONSTRAINT IF EXISTS "work_leases_kind_check";
ALTER TABLE "work_leases" ADD CONSTRAINT "work_leases_kind_check" CHECK ("kind" IN ('autopilot.run', 'outreach.drain', 'outreach.follow_up', 'mailbox.sync', 'connector.recipe'));

DROP TABLE IF EXISTS "qualification_runs";
DROP TABLE IF EXISTS "rate_limit_buckets";
