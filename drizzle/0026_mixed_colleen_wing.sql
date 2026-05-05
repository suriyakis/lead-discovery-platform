ALTER TABLE "mail_messages" ADD COLUMN "body_text_en" text;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "translated_from_language" text;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "translated_at" timestamp with time zone;