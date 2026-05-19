ALTER TABLE "learning_lessons" ADD COLUMN "application_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "last_applied_at" timestamp with time zone;