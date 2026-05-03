CREATE TYPE "public"."account_status" AS ENUM('pending', 'active', 'suspended', 'rejected');--> statement-breakpoint
CREATE TABLE "preauthorized_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"workspaceId" text,
	"role" text DEFAULT 'member' NOT NULL,
	"createdBy" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"consumedAt" timestamp with time zone,
	CONSTRAINT "preauthorized_emails_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accountStatus" "account_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accountStatusReason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accountStatusUpdatedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accountStatusUpdatedBy" text;--> statement-breakpoint
-- Existing users were access-cleared before this migration ran. Lift them to
-- 'active' so we don't lock them out. New signups default to 'pending' and
-- need an admin to approve (or land on the preauthorize allow-list).
UPDATE "users" SET "accountStatus" = 'active' WHERE "accountStatus" = 'pending';