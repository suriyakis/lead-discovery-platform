ALTER TABLE "qualifications" ADD COLUMN "target_country" text;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "inferred_country" text;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "geo_status" text DEFAULT 'no_gate' NOT NULL;