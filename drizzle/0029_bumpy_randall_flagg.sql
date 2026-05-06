CREATE TABLE "workspace_provider_settings" (
	"workspace_id" bigint PRIMARY KEY NOT NULL,
	"ai_provider" text,
	"embedding_provider" text,
	"research_provider" text,
	"search_provider" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_provider_settings" ADD CONSTRAINT "workspace_provider_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;