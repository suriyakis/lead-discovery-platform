-- Rollback of p1_workers_mailbox_health (lane workers: PC-09). Restores the
-- shape from before the migration. Drizzle migrations are forward-only, so
-- this is the documented way back.
--
-- Afterwards, delete the migration's row from drizzle.__drizzle_migrations
-- (created_at = the `when` of the p1_workers_mailbox_health entry in
-- drizzle/meta/_journal.json) and redeploy the previous release.
--
-- Lossy by necessity: the failure class, the probe schedule and the last
-- SMTP verify are dropped. The previous release (flow:F-04) re-checks a
-- failing mailbox on its imap_next_sync_after gate and adopts failing rows
-- whose gate is NULL, announcing them again; open mailbox.failing
-- ops_events stay open until resolved by hand in the console.

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_probe_attempts_check";
ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_failure_class_only_when_failing_check";
ALTER TABLE "mailboxes" DROP COLUMN IF EXISTS "smtp_verified_at";
ALTER TABLE "mailboxes" DROP COLUMN IF EXISTS "probe_attempts";
ALTER TABLE "mailboxes" DROP COLUMN IF EXISTS "next_probe_at";
ALTER TABLE "mailboxes" DROP COLUMN IF EXISTS "failure_class";
DROP TYPE IF EXISTS "public"."mailbox_failure_class";
