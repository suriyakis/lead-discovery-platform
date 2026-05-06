CREATE TABLE "lead_research" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"qualified_lead_id" bigint NOT NULL,
	"question" text NOT NULL,
	"question_hash" text NOT NULL,
	"answer" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"queries_issued" text[] DEFAULT '{}'::text[] NOT NULL,
	"provider_id" text NOT NULL,
	"cost_estimate_cents" bigint DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_research" ADD CONSTRAINT "lead_research_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_research" ADD CONSTRAINT "lead_research_qualified_lead_id_qualified_leads_id_fk" FOREIGN KEY ("qualified_lead_id") REFERENCES "public"."qualified_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_research_lead_idx" ON "lead_research" USING btree ("workspace_id","qualified_lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_research_lead_question_idx" ON "lead_research" USING btree ("workspace_id","qualified_lead_id","question_hash");