CREATE TYPE "public"."automation_capability" AS ENUM('sending', 'inbox_sync', 'inbound_actions', 'discovery', 'autopilot', 'crm_sync', 'background_ai', 'auto_topup');--> statement-breakpoint
CREATE TYPE "public"."workspace_hold_kind" AS ENUM('hold', 'note');--> statement-breakpoint
CREATE TYPE "public"."workspace_hold_scope" AS ENUM('all', 'capabilities');--> statement-breakpoint
CREATE TYPE "public"."workspace_hold_source" AS ENUM('tenant', 'platform');--> statement-breakpoint
CREATE TYPE "public"."workspace_hold_state" AS ENUM('active', 'pending_review', 'released', 'discarded');--> statement-breakpoint
CREATE TABLE "workspace_holds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"kind" "workspace_hold_kind" DEFAULT 'hold' NOT NULL,
	"scope" "workspace_hold_scope" NOT NULL,
	"capabilities" "automation_capability"[] DEFAULT '{}' NOT NULL,
	"state" "workspace_hold_state" DEFAULT 'active' NOT NULL,
	"source" "workspace_hold_source" NOT NULL,
	"reason" text NOT NULL,
	"blocks_access" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"placed_by_user_id" text,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by_user_id" text,
	"confirmed_at" timestamp with time zone,
	"ended_by_user_id" text,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"legacy_flag_key" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_holds_shape_check" CHECK ((kind = 'hold' AND ((scope = 'all' AND cardinality(capabilities) = 0) OR (scope = 'capabilities' AND cardinality(capabilities) > 0))) OR (kind = 'note' AND scope = 'capabilities' AND cardinality(capabilities) = 0 AND state IN ('pending_review', 'discarded'))),
	CONSTRAINT "workspace_holds_reason_check" CHECK (length(btrim(reason)) > 0)
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "automation_owner_incident_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_holds" ADD CONSTRAINT "workspace_holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_holds" ADD CONSTRAINT "workspace_holds_placed_by_user_id_users_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_holds" ADD CONSTRAINT "workspace_holds_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_holds" ADD CONSTRAINT "workspace_holds_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_holds_workspace_state_idx" ON "workspace_holds" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_holds_legacy_flag_idx" ON "workspace_holds" USING btree ("workspace_id","legacy_flag_key") WHERE legacy_flag_key IS NOT NULL;