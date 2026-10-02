-- ia:F-03 (X1, I088): reply auto-actions default to OFF and are switched off
-- on every workspace; autopilot auto-approve is switched off everywhere.
--
-- Why (X1): the reply classifier runs over EVERY IMAP-synced message, not
-- only replies to our outreach, and its heuristics read newsletter footers
-- ("unsubscribe") and ordinary replies ("got your mail but I'm not the
-- right person") as opt-outs and bounces. With auto_suppress_unsubscribe /
-- auto_suppress_bounce on - their old default, with no UI to see or change
-- them - each such message hard-suppressed its sender and closed the
-- linked lead: ~141 innocent addresses in prod in 60 days, the owner's own
-- colleagues among them. Until the inbound relevance gate (flow:F-01)
-- ships and a workspace admin deliberately turns them back on under
-- /settings/outreach -> Reply auto-actions, no workspace suppresses or
-- closes a lead because of how a reply was classified. Explicit opt-outs
-- (the unsubscribe link) and SMTP send rejections never read these
-- switches and keep working. auto_extract_redirects is left as it is: it
-- neither suppresses nor closes.
--
-- Owner instruction (Phase 0): autopilot auto-approve off on every
-- workspace too (autopilot is off everywhere anyway). The workspace-level
-- flag gates the step, so per-product overrides cannot re-enable it.
--
-- Every row that changes gets an audit_log event first (actor NULL, payload
-- source 'migration:0062' with the before/after), so /settings/audit shows
-- why the switches moved. Existing suppressions are NOT touched: lifting
-- them is the owner-approved remediation (flow:F-06). Re-running is a no-op:
-- each statement only touches rows that are still on.
ALTER TABLE "reply_auto_actions" ALTER COLUMN "auto_suppress_bounce" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "reply_auto_actions" ALTER COLUMN "auto_suppress_unsubscribe" SET DEFAULT false;--> statement-breakpoint
INSERT INTO "audit_log" ("workspace_id", "user_id", "kind", "entity_type", "entity_id", "payload")
SELECT
  "workspace_id",
  NULL,
  'reply_auto_actions.changed',
  'workspace',
  "workspace_id"::text,
  jsonb_build_object(
    'source', 'migration:0062',
    'reason', 'X1: the reply classifier acts on every synced email, not only replies to outreach; automatic suppression and lead closing are off until a workspace admin turns them back on.',
    'changes', jsonb_strip_nulls(jsonb_build_object(
      'autoSuppressUnsubscribe', CASE WHEN "auto_suppress_unsubscribe" THEN '{"from": true, "to": false}'::jsonb END,
      'autoSuppressBounce', CASE WHEN "auto_suppress_bounce" THEN '{"from": true, "to": false}'::jsonb END,
      'autoCloseNegative', CASE WHEN "auto_close_negative" THEN '{"from": true, "to": false}'::jsonb END
    )),
    'after', jsonb_build_object(
      'autoSuppressUnsubscribe', false,
      'autoSuppressBounce', false,
      'autoCloseNegative', false,
      'autoExtractRedirects', "auto_extract_redirects"
    )
  )
FROM "reply_auto_actions"
WHERE "auto_suppress_unsubscribe" OR "auto_suppress_bounce" OR "auto_close_negative";--> statement-breakpoint
UPDATE "reply_auto_actions"
SET "auto_suppress_unsubscribe" = false,
    "auto_suppress_bounce" = false,
    "auto_close_negative" = false,
    "updated_by" = NULL,
    "updated_at" = now()
WHERE "auto_suppress_unsubscribe" OR "auto_suppress_bounce" OR "auto_close_negative";--> statement-breakpoint
INSERT INTO "audit_log" ("workspace_id", "user_id", "kind", "entity_type", "entity_id", "payload")
SELECT
  "workspace_id",
  NULL,
  'autopilot.settings.update',
  'workspace',
  "workspace_id"::text,
  jsonb_build_object(
    'source', 'migration:0062',
    'reason', 'Owner instruction (Phase 0): autopilot auto-approve off on every workspace.',
    'enableAutoApproveProjects', false
  )
FROM "autopilot_settings"
WHERE "enable_auto_approve_projects";--> statement-breakpoint
UPDATE "autopilot_settings"
SET "enable_auto_approve_projects" = false,
    "updated_by" = NULL,
    "updated_at" = now()
WHERE "enable_auto_approve_projects";
