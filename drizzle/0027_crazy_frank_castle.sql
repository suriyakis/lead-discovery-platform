-- Phase 43: per-mailbox sending policy. Idempotent on the create + the
-- constraints + the default fix-up so a stale dev DB (where a prior
-- attempt landed with business_hours_only=true) re-converges to the
-- intended schema without manual intervention.

CREATE TABLE IF NOT EXISTS "mailbox_sending_limits" (
	"mailbox_id" bigint PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"max_per_day" integer DEFAULT 50 NOT NULL,
	"max_per_hour" integer DEFAULT 10 NOT NULL,
	"max_per_domain" integer DEFAULT 5 NOT NULL,
	"min_delay_seconds" integer DEFAULT 60 NOT NULL,
	"max_delay_seconds" integer DEFAULT 300 NOT NULL,
	"business_hours_only" boolean DEFAULT false NOT NULL,
	"business_start_hour" smallint DEFAULT 8 NOT NULL,
	"business_end_hour" smallint DEFAULT 17 NOT NULL,
	"business_days" integer[] DEFAULT ARRAY[1,2,3,4,5]::int[] NOT NULL,
	"timezone" text DEFAULT 'Europe/Warsaw' NOT NULL,
	"respect_weekends" boolean DEFAULT true NOT NULL,
	"respect_holidays" boolean DEFAULT true NOT NULL,
	"holiday_country" text DEFAULT 'PL' NOT NULL,
	"sent_today" integer DEFAULT 0 NOT NULL,
	"sent_this_hour" integer DEFAULT 0 NOT NULL,
	"last_reset_date" text,
	"last_reset_hour" smallint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mailbox_sending_limits" ADD CONSTRAINT "mailbox_sending_limits_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mailbox_sending_limits" ADD CONSTRAINT "mailbox_sending_limits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Convergence: ensure the `business_hours_only` default is `false` even
-- if a stale dev DB picked up an earlier attempt that defaulted to true.
ALTER TABLE "mailbox_sending_limits" ALTER COLUMN "business_hours_only" SET DEFAULT false;
