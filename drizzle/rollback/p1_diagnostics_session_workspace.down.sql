-- Rollback of p1_diagnostics_session_workspace (lane diagnostics: MOB-06).
-- Additive migration: four nullable / defaulted columns on "sessions". Dropping
-- them loses only each session's own workspace pointer; every session then
-- follows users.activeWorkspaceId again (the pre-MOB-06 behaviour) and no one
-- is signed out.
--
-- Afterwards, delete the migration's row from drizzle.__drizzle_migrations
-- (created_at = the `when` of the p1_diagnostics_session_workspace entry in
-- drizzle/meta/_journal.json) and redeploy the previous release.

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_activeWorkspaceId_workspaces_id_fk";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "userAgent";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "lastSeenAt";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "createdAt";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "activeWorkspaceId";
