ALTER TABLE "autopilot_settings" ADD COLUMN "guard_state" text;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD COLUMN "guard_state_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "autopilot_log_created_idx" ON "autopilot_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_read_created_idx" ON "notifications" USING btree ("created_at") WHERE read_at IS NOT NULL;--> statement-breakpoint
-- custom:begin
-- PC-35: seed the guard state the pre-PC-35 code logged on every run
-- (autopilot off or paused), so the first run after the deploy does not
-- log, as a change, the state the workspace has been in all along.
-- Integration (phase1 × PC-05): the pause is the workspace pause
-- (workspaces.automation_paused_at, set from the legacy switches by
-- p1_automation_control_pause), never the legacy emergency_pause column,
-- and the states are the ones runOnce records now: 'autopilot_disabled'
-- (checked first) or the gate's 'paused'.
UPDATE "autopilot_settings" a SET "guard_state" = CASE WHEN NOT a."autopilot_enabled" THEN 'autopilot_disabled' ELSE 'paused' END, "guard_state_at" = now() FROM "workspaces" w WHERE w."id" = a."workspace_id" AND a."guard_state" IS NULL AND (NOT a."autopilot_enabled" OR w."automation_paused_at" IS NOT NULL);
-- custom:end
