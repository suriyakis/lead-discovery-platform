CREATE TYPE "public"."onboarding_status" AS ENUM('pending', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trial', 'active', 'past_due', 'canceled');--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "onboarding_status" "onboarding_status" DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan" text DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "subscription_status" "subscription_status" DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "stripe_subscription_id" text;