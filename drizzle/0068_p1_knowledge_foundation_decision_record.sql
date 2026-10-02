-- KL-02 (I032, I034, I018, I036, I030): the decision record.
--
-- * learning_decisions: one row per decision; UNIQUE(workspace_id,
--   decision_key) makes a repeated form submit (or autopilot run) a no-op.
--   Generic subject_type / subject_id so the Lead (flow:F-17) plugs in.
-- * learning_events becomes the decision log AND the learning outbox:
--   decision_id (composite FK on workspace_id), origin, verdict, polarity,
--   weight, explicit, reason_codes, context (record snapshot, I036),
--   processing_status / attempts / next_attempt_at / last_error /
--   processed_at, and supersession (voided_at, voided_by_event_id,
--   void_reason, overrides_autopilot). Existing rows keep decision_id NULL
--   and take processing_status 'done' / origin 'operator' from the column
--   defaults: they were processed inline before KL-02. Prod has 0 events.
-- * qualifications.operator_verdict / operator_decided_by / _at /
--   operator_event_id and geo_confirmed_by / _at: the operator verdict is
--   domain state; re-classification never writes these columns.
--
-- Small value sets are text + CHECK (not enums) so adding a value later is
-- a constraint swap inside the single migration transaction. No data
-- backfill is needed, so there is no custom block.
--
-- Rollback: drizzle/rollback/p1_knowledge_foundation_decision_record.down.sql
CREATE TABLE "learning_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" bigint NOT NULL,
	"decision_key" text NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_decisions_ws_key_unique" UNIQUE("workspace_id","decision_key"),
	CONSTRAINT "learning_decisions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "learning_decisions_origin_check" CHECK ("learning_decisions"."origin" IN ('operator', 'autopilot', 'system'))
);
--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "decision_id" uuid;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "origin" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "polarity" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "weight" numeric(3, 2) DEFAULT '1.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "explicit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "reason_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "context" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "processing_status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "voided_by_event_id" bigint;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "overrides_autopilot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "operator_verdict" text;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "operator_decided_by" text;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "operator_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "operator_event_id" bigint;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "geo_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "geo_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_decisions" ADD CONSTRAINT "learning_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_decisions" ADD CONSTRAINT "learning_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_decisions_ws_subject_idx" ON "learning_decisions" USING btree ("workspace_id","subject_type","subject_id");--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_decision_fk" FOREIGN KEY ("workspace_id","decision_id") REFERENCES "public"."learning_decisions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_voided_by_fk" FOREIGN KEY ("voided_by_event_id") REFERENCES "public"."learning_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_operator_decided_by_users_id_fk" FOREIGN KEY ("operator_decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_operator_event_id_learning_events_id_fk" FOREIGN KEY ("operator_event_id") REFERENCES "public"."learning_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_geo_confirmed_by_users_id_fk" FOREIGN KEY ("geo_confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_events_ws_decision_idx" ON "learning_events" USING btree ("workspace_id","decision_id");--> statement-breakpoint
CREATE INDEX "learning_events_ws_subject_idx" ON "learning_events" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "learning_events_outbox_idx" ON "learning_events" USING btree ("processing_status","next_attempt_at") WHERE "learning_events"."processing_status" IN ('pending', 'processing');--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_origin_check" CHECK ("learning_events"."origin" IN ('operator', 'autopilot', 'system'));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_verdict_check" CHECK ("learning_events"."verdict" IS NULL OR "learning_events"."verdict" IN ('fit', 'not_fit'));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_polarity_check" CHECK ("learning_events"."polarity" IN (-1, 0, 1));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_weight_check" CHECK ("learning_events"."weight" > 0 AND "learning_events"."weight" <= 1);--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_processing_status_check" CHECK ("learning_events"."processing_status" IN ('pending', 'processing', 'done', 'no_rule', 'below_floor', 'skipped_no_tokens', 'skipped', 'failed'));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_void_reason_check" CHECK ("learning_events"."void_reason" IS NULL OR "learning_events"."void_reason" IN ('changed_mind', 'undo', 'autopilot_override'));--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_voided_check" CHECK (("learning_events"."voided_at" IS NULL) = ("learning_events"."void_reason" IS NULL) AND ("learning_events"."voided_by_event_id" IS NULL OR "learning_events"."voided_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_operator_verdict_check" CHECK ("qualifications"."operator_verdict" IS NULL OR "qualifications"."operator_verdict" IN ('fit', 'not_fit'));--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_operator_decided_check" CHECK (("qualifications"."operator_verdict" IS NULL) = ("qualifications"."operator_decided_at" IS NULL));