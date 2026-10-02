ALTER TABLE "autopilot_settings" ADD COLUMN "guard_state" text;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD COLUMN "guard_state_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "autopilot_log_created_idx" ON "autopilot_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_read_created_idx" ON "notifications" USING btree ("created_at") WHERE read_at IS NOT NULL;--> statement-breakpoint
-- custom:begin
-- PC-35: seed the guard state the pre-PC-35 code logged on every run
-- (autopilot off or paused), so the first run after the deploy does not
-- log, as a change, the state the workspace has been in all along.
UPDATE "autopilot_settings" SET "guard_state" = CASE WHEN "emergency_pause" THEN 'emergency_pause' ELSE 'autopilot_disabled' END, "guard_state_at" = now() WHERE "guard_state" IS NULL AND ("emergency_pause" OR NOT "autopilot_enabled");
-- custom:end
