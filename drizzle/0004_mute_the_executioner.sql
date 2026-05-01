CREATE TABLE "learning_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"user_id" text,
	"entity_type" text,
	"entity_id" text,
	"product_profile_id" bigint,
	"action_type" text NOT NULL,
	"original_comment" text,
	"extracted_lesson_id" bigint,
	"confidence" smallint DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_lessons" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"product_profile_id" bigint,
	"category" text NOT NULL,
	"rule" text NOT NULL,
	"evidence_event_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"confidence" smallint DEFAULT 60 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_product_profile_id_product_profiles_id_fk" FOREIGN KEY ("product_profile_id") REFERENCES "public"."product_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_product_profile_id_product_profiles_id_fk" FOREIGN KEY ("product_profile_id") REFERENCES "public"."product_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD CONSTRAINT "learning_lessons_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_events_ws_created_idx" ON "learning_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "learning_events_product_action_idx" ON "learning_events" USING btree ("product_profile_id","action_type");--> statement-breakpoint
CREATE INDEX "learning_lessons_ws_enabled_idx" ON "learning_lessons" USING btree ("workspace_id","enabled");--> statement-breakpoint
CREATE INDEX "learning_lessons_product_category_idx" ON "learning_lessons" USING btree ("product_profile_id","category","enabled");