-- Rollback of p1_diagnostics_notify_ledger (lane diagnostics: AP-06).
-- Additive migration: one new table, the notify sweep's ledger. Dropping it
-- loses only which findings were already announced, so the first sweep
-- after a re-apply announces each standing problem once more.
--
-- Afterwards, delete the migration's row from drizzle.__drizzle_migrations
-- (created_at = the `when` of the p1_diagnostics_notify_ledger entry in
-- drizzle/meta/_journal.json) and redeploy the previous release.

DROP TABLE IF EXISTS "diagnostic_notices";
