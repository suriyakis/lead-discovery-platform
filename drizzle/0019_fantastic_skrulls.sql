CREATE TABLE "reply_auto_actions" (
	"workspace_id" bigint PRIMARY KEY NOT NULL,
	"auto_suppress_bounce" boolean DEFAULT true NOT NULL,
	"auto_suppress_unsubscribe" boolean DEFAULT true NOT NULL,
	"auto_close_negative" boolean DEFAULT false NOT NULL,
	"auto_extract_redirects" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "reply_classification" text;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "reply_classification_confidence" smallint;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "reply_classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "extracted_emails" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_auto_actions" ADD CONSTRAINT "reply_auto_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_auto_actions" ADD CONSTRAINT "reply_auto_actions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;