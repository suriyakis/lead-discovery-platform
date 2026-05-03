CREATE TYPE "public"."suppression_kind" AS ENUM('email', 'domain', 'company');--> statement-breakpoint
ALTER TABLE "suppression_list" ALTER COLUMN "address" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "signatures" ADD COLUMN "greeting" text;--> statement-breakpoint
ALTER TABLE "signatures" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "signatures" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "signatures" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "signatures" ADD COLUMN "tagline" text;--> statement-breakpoint
ALTER TABLE "signatures" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "signatures" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "signatures" ADD COLUMN "phones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "signatures" ADD COLUMN "logo_storage_key" text;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN "kind" "suppression_kind" DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN "value" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- P17 backfill: existing email-only entries already have `address`. Mirror
-- it into `value` and keep kind='email' so the new (kind, value) UNIQUE
-- index has populated rows. Safe to re-run.
UPDATE "suppression_list" SET "value" = "address" WHERE "value" = '' AND "address" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_ws_kind_value_idx" ON "suppression_list" USING btree ("workspace_id","kind","value");