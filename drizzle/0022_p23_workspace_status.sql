CREATE TYPE "public"."workspace_status" AS ENUM('active', 'archived');--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "status" "workspace_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "archived_reason" text;