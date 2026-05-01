CREATE TABLE "qualifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"source_record_id" bigint NOT NULL,
	"product_profile_id" bigint NOT NULL,
	"is_relevant" boolean NOT NULL,
	"relevance_score" smallint NOT NULL,
	"confidence" smallint NOT NULL,
	"qualification_reason" text,
	"rejection_reason" text,
	"matched_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"disqualifying_signals" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"method" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_product_profile_id_product_profiles_id_fk" FOREIGN KEY ("product_profile_id") REFERENCES "public"."product_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qualifications_pair_idx" ON "qualifications" USING btree ("workspace_id","source_record_id","product_profile_id");--> statement-breakpoint
CREATE INDEX "qualifications_ws_product_idx" ON "qualifications" USING btree ("workspace_id","product_profile_id");--> statement-breakpoint
CREATE INDEX "qualifications_ws_relevant_idx" ON "qualifications" USING btree ("workspace_id","is_relevant");