CREATE TYPE "public"."crm_sync_kind" AS ENUM('contact', 'note', 'deal');--> statement-breakpoint
ALTER TABLE "crm_sync_log" ADD COLUMN "kind" "crm_sync_kind" DEFAULT 'contact' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_sync_log" ADD COLUMN "related_message_id" bigint;