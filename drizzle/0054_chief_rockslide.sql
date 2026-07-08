ALTER TABLE "workspaces" ADD COLUMN "auto_topup_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "auto_topup_pack_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "auto_topup_last_at" timestamp with time zone;