CREATE TYPE "public"."knowledge_purpose_category" AS ENUM('technical', 'marketing', 'case_study', 'internal_note', 'objection_handling', 'general');--> statement-breakpoint
CREATE TABLE "email_opens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"token" text NOT NULL,
	"user_agent" text,
	"ip_hash" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "purpose_category" "knowledge_purpose_category" DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "tracking_token" text;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "open_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "first_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_opens" ADD CONSTRAINT "email_opens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_opens_ws_message_idx" ON "email_opens" USING btree ("workspace_id","message_id");