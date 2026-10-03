ALTER TABLE "autopilot_product_settings" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "autopilot_product_settings" ADD COLUMN "paused_by_user_id" text;--> statement-breakpoint
ALTER TABLE "autopilot_product_settings" ADD CONSTRAINT "autopilot_product_settings_paused_by_user_id_users_id_fk" FOREIGN KEY ("paused_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- custom:begin
-- PC-13 (I019): the dead toggles. Autopilot's "Auto-drain the send queue"
-- and "Sync inbound mail" only added an extra pass inside a run (the drain
-- and IMAP ticks run whatever they said), and "Auto-send replies" was never
-- implemented. Code and UI no longer read or write them. The columns stay
-- one release, so a rollback's select() still finds them, set to false so
-- old code cannot act on them either (prod 2026-10: every row is false
-- already), then they are dropped.
UPDATE "autopilot_settings"
SET "enable_auto_drain_queue" = false,
    "enable_auto_sync_inbound" = false,
    "updated_at" = now()
WHERE "enable_auto_drain_queue" OR "enable_auto_sync_inbound";--> statement-breakpoint
UPDATE "workspaces"
SET "auto_send_replies" = false,
    "updated_at" = now()
WHERE "auto_send_replies";--> statement-breakpoint
COMMENT ON COLUMN "autopilot_settings"."enable_auto_drain_queue" IS 'Deprecated (PC-13, I019): read by nothing; the 30 s drain tick sends approved mail whatever it says. Dropped one release later.';--> statement-breakpoint
COMMENT ON COLUMN "autopilot_settings"."enable_auto_sync_inbound" IS 'Deprecated (PC-13, I019, I067): read by nothing; the IMAP tick is the only automatic inbound path. Dropped one release later.';--> statement-breakpoint
COMMENT ON COLUMN "workspaces"."auto_send_replies" IS 'Deprecated (PC-13, I019): read by nothing; it was never implemented. Dropped one release later.';--> statement-breakpoint
-- PC-13 (I020): per-product overrides become narrow-only and enforced.
-- A per-product "Emergency pause" override (saved, never applied) becomes
-- the real product pause, since that is what its author asked for; each
-- one gets an audit row saying where it came from (prod 2026-10: no
-- overlay rows, so this changes nothing there). The old column is cleared
-- and kept one release, read by nothing.
INSERT INTO "audit_log" ("workspace_id", "user_id", "kind", "entity_type", "entity_id", "payload")
SELECT
  o."workspace_id",
  NULL,
  'automation.product_paused',
  'product_profile',
  o."product_profile_id"::text,
  jsonb_build_object(
    'source', 'legacy_overlay_migration',
    'reason', 'Carried over from the per-product Emergency pause override'
  )
FROM "autopilot_product_settings" o
WHERE o."emergency_pause" AND o."paused_at" IS NULL;--> statement-breakpoint
UPDATE "autopilot_product_settings"
SET "paused_at" = "updated_at",
    "paused_by_user_id" = "updated_by"
WHERE "emergency_pause" AND "paused_at" IS NULL;--> statement-breakpoint
UPDATE "autopilot_product_settings"
SET "emergency_pause" = NULL
WHERE "emergency_pause" IS NOT NULL;--> statement-breakpoint
COMMENT ON COLUMN "autopilot_product_settings"."emergency_pause" IS 'Deprecated (PC-13): carried into paused_at; read by nothing. Dropped one release later.';--> statement-breakpoint
-- An "on" override never widened anything (runOnce returned early or
-- skipped the step on the workspace flags), so clearing it to inherit
-- changes nothing that runs. Then the narrow-only rule holds in the
-- database too: an override is NULL (inherit) or false (off).
UPDATE "autopilot_product_settings"
SET "autopilot_enabled" = CASE WHEN "autopilot_enabled" THEN NULL ELSE "autopilot_enabled" END,
    "enable_auto_approve_projects" = CASE WHEN "enable_auto_approve_projects" THEN NULL ELSE "enable_auto_approve_projects" END,
    "enable_auto_enqueue_outreach" = CASE WHEN "enable_auto_enqueue_outreach" THEN NULL ELSE "enable_auto_enqueue_outreach" END,
    "enable_auto_crm_contact_sync" = CASE WHEN "enable_auto_crm_contact_sync" THEN NULL ELSE "enable_auto_crm_contact_sync" END,
    "enable_auto_crm_deal_on_qualified" = CASE WHEN "enable_auto_crm_deal_on_qualified" THEN NULL ELSE "enable_auto_crm_deal_on_qualified" END
WHERE "autopilot_enabled"
   OR "enable_auto_approve_projects"
   OR "enable_auto_enqueue_outreach"
   OR "enable_auto_crm_contact_sync"
   OR "enable_auto_crm_deal_on_qualified";--> statement-breakpoint
ALTER TABLE "autopilot_product_settings" ADD CONSTRAINT "autopilot_product_settings_narrow_only_check" CHECK (
  "autopilot_enabled" IS NOT TRUE
  AND "enable_auto_approve_projects" IS NOT TRUE
  AND "enable_auto_enqueue_outreach" IS NOT TRUE
  AND "enable_auto_crm_contact_sync" IS NOT TRUE
  AND "enable_auto_crm_deal_on_qualified" IS NOT TRUE
);
-- custom:end
