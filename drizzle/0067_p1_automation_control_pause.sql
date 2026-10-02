ALTER TYPE "public"."automation_capability" ADD VALUE 'trash_purge';--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "automation_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "automation_paused_by_user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "automation_pause_reason" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "automation_pause_source" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "outreach_live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "outreach_live_by_user_id" text;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_automation_paused_by_user_id_users_id_fk" FOREIGN KEY ("automation_paused_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_outreach_live_by_user_id_users_id_fk" FOREIGN KEY ("outreach_live_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "public"."workspace_automation_state" AS (SELECT w.id AS workspace_id, w.status AS workspace_status, w.owner_user_id, u."accountStatus" AS owner_account_status, (m.id IS NOT NULL) AS owner_is_member, w.automation_owner_incident_at AS owner_incident_at, w.automation_paused_at AS paused_at, w.automation_paused_by_user_id AS paused_by_user_id, w.automation_pause_reason AS pause_reason, w.automation_pause_source AS pause_source, w.outreach_live_at, w.outreach_live_by_user_id, (w.billing_exempt OR w.token_balance > 0) AS wallet_has_tokens, w.billing_exempt, w.plan, w.subscription_status FROM workspaces w LEFT JOIN users u ON u.id = w.owner_user_id LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = w.owner_user_id);--> statement-breakpoint
-- custom:begin
-- PC-05: the two legacy Emergency pause switches become the single
-- workspace pause. A workspace starts paused when either was on (prod
-- 2026-10: every row false, so this changes nothing there). Each one gets
-- an automation.paused audit row explaining where its pause came from, and
-- both legacy columns are set as the pause's write-only mirror (read by
-- nothing from this release; dropped one release later).
INSERT INTO "audit_log" ("workspace_id", "user_id", "kind", "entity_type", "entity_id", "payload")
SELECT
  w."id",
  NULL,
  'automation.paused',
  'workspace',
  w."id"::text,
  jsonb_build_object(
    'source', 'legacy_flag_migration',
    'reason', 'Carried over from the old Emergency pause switch',
    'autopilotEmergencyPause', COALESCE(a."emergency_pause", false),
    'sendQueueEmergencyPause', COALESCE(s."emergency_pause", false)
  )
FROM "workspaces" w
LEFT JOIN "autopilot_settings" a ON a."workspace_id" = w."id"
LEFT JOIN "outreach_send_settings" s ON s."workspace_id" = w."id"
WHERE w."automation_paused_at" IS NULL
  AND (COALESCE(a."emergency_pause", false) OR COALESCE(s."emergency_pause", false));--> statement-breakpoint
UPDATE "workspaces" w
SET "automation_paused_at" = now(),
    "automation_paused_by_user_id" = NULL,
    "automation_pause_reason" = 'Carried over from the old Emergency pause switch',
    "automation_pause_source" = 'legacy_flag_migration',
    "updated_at" = now()
WHERE w."automation_paused_at" IS NULL
  AND (
    EXISTS (SELECT 1 FROM "autopilot_settings" a WHERE a."workspace_id" = w."id" AND a."emergency_pause")
    OR EXISTS (SELECT 1 FROM "outreach_send_settings" s WHERE s."workspace_id" = w."id" AND s."emergency_pause")
  );--> statement-breakpoint
UPDATE "autopilot_settings" a
SET "emergency_pause" = true
FROM "workspaces" w
WHERE w."id" = a."workspace_id" AND w."automation_paused_at" IS NOT NULL AND NOT a."emergency_pause";--> statement-breakpoint
UPDATE "outreach_send_settings" s
SET "emergency_pause" = true
FROM "workspaces" w
WHERE w."id" = s."workspace_id" AND w."automation_paused_at" IS NOT NULL AND NOT s."emergency_pause";
-- custom:end
