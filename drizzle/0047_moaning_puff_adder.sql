ALTER TABLE "mail_messages" ADD COLUMN "body_text_native" text;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "native_language" text;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "target_language" text;