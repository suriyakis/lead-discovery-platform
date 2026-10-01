-- F-03 (X1, I088): suppression provenance + revoke instead of delete.
-- `source` defaults to legacy_unknown so the existing rows (and any writer
-- that forgets to declare provenance) are labelled honestly; the backfill
-- at the end re-labels the rows the reply-classifier auto path wrote.
CREATE TYPE "public"."suppression_source" AS ENUM('unsubscribe_link', 'reply', 'dsn', 'smtp', 'manual', 'import', 'legacy_auto', 'legacy_unknown');--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN "source" "suppression_source" DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN "revoked_by" text;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- F-03 backfill: rows whose note is exactly what the pre-F-03 auto paths
-- wrote ('auto-suppressed from message <id>' in reply-classifier.ts,
-- 'auto-suppressed by outreach handler from message <id>' in
-- outreach-reply-handler.ts) become legacy_auto, with source_ref pointing
-- at the triggering message. Every other row keeps legacy_unknown. Only
-- rows still on the default are touched, so a re-run changes nothing.
-- Nothing is revoked here: un-suppressing is the owner-approved F-06 job.
UPDATE "suppression_list"
SET "source" = 'legacy_auto',
    "source_ref" = 'mail_message:' || substring("note" from '^auto-suppressed (?:by outreach handler )?from message ([0-9]+)$')
WHERE "source" = 'legacy_unknown'
  AND "note" ~ '^auto-suppressed (by outreach handler )?from message [0-9]+$';
