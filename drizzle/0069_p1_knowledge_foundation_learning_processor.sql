-- KL-03 (I099, I108, I032, I021, I154): the learning processor.
--
-- * lesson_reinforcements: the reinforcement ledger. One row per confidence
--   change a decision causes on a rule (cited / dedup_match), written in the
--   same transaction as the change; a partial UNIQUE(event_id, lesson_id)
--   makes re-runs idempotent, and a compensation row (compensates_id,
--   UNIQUE) reverses one forward row exactly by its delta_applied when the
--   decision event is voided. Composite FK (workspace_id, lesson_id) keeps a
--   row inside its tenant.
-- * learning_events.claimed_at (the processor's claim token; the sweeper
--   releases claims older than 10 minutes) and processing_note (why a row
--   was closed the way it was, read by the decision receipt).
-- * Partial indexes for the sweeper (events waiting for tokens) and for
--   supersession lookups (voided_by_event_id).
--
-- Additive only; no backfill (prod has 0 learning events and 0 lessons).
-- Rollback: drizzle/rollback/p1_knowledge_foundation_learning_processor.down.sql
CREATE TABLE "lesson_reinforcements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"lesson_id" bigint NOT NULL,
	"event_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"delta_requested" smallint NOT NULL,
	"delta_applied" smallint NOT NULL,
	"confidence_before" smallint NOT NULL,
	"confidence_after" smallint NOT NULL,
	"compensates_id" bigint,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_reinforcements_compensates_unique" UNIQUE("compensates_id"),
	CONSTRAINT "lesson_reinforcements_kind_check" CHECK ("lesson_reinforcements"."kind" IN ('cited', 'dedup_match', 'compensation')),
	CONSTRAINT "lesson_reinforcements_compensation_check" CHECK (("lesson_reinforcements"."kind" = 'compensation') = ("lesson_reinforcements"."compensates_id" IS NOT NULL)),
	CONSTRAINT "lesson_reinforcements_confidence_check" CHECK ("lesson_reinforcements"."confidence_before" BETWEEN 0 AND 100 AND "lesson_reinforcements"."confidence_after" BETWEEN 0 AND 100 AND "lesson_reinforcements"."confidence_after" - "lesson_reinforcements"."confidence_before" = "lesson_reinforcements"."delta_applied")
);
--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "processing_note" text;--> statement-breakpoint
ALTER TABLE "lesson_reinforcements" ADD CONSTRAINT "lesson_reinforcements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_reinforcements" ADD CONSTRAINT "lesson_reinforcements_event_id_learning_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."learning_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_reinforcements" ADD CONSTRAINT "lesson_reinforcements_lesson_fk" FOREIGN KEY ("workspace_id","lesson_id") REFERENCES "public"."learning_lessons"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_reinforcements" ADD CONSTRAINT "lesson_reinforcements_compensates_fk" FOREIGN KEY ("compensates_id") REFERENCES "public"."lesson_reinforcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_reinforcements_event_lesson_unique" ON "lesson_reinforcements" USING btree ("event_id","lesson_id") WHERE "lesson_reinforcements"."compensates_id" IS NULL;--> statement-breakpoint
CREATE INDEX "lesson_reinforcements_event_idx" ON "lesson_reinforcements" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "lesson_reinforcements_ws_lesson_idx" ON "lesson_reinforcements" USING btree ("workspace_id","lesson_id","created_at");--> statement-breakpoint
CREATE INDEX "learning_events_waiting_tokens_idx" ON "learning_events" USING btree ("workspace_id") WHERE "learning_events"."processing_status" = 'skipped_no_tokens';--> statement-breakpoint
CREATE INDEX "learning_events_voided_by_idx" ON "learning_events" USING btree ("voided_by_event_id") WHERE "learning_events"."voided_by_event_id" IS NOT NULL;