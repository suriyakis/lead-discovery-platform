CREATE TABLE "product_vector_stores" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"product_profile_id" bigint NOT NULL,
	"provider_id" text NOT NULL,
	"external_store_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_error" text,
	"usage_bytes" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_provider_settings" ADD COLUMN "vector_storage_provider" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "vector_storage_quota_mb_per_product" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "external_provider_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "external_file_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "external_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "external_error" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "external_indexed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_vector_stores" ADD CONSTRAINT "product_vector_stores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_vector_stores" ADD CONSTRAINT "product_vector_stores_product_profile_id_product_profiles_id_fk" FOREIGN KEY ("product_profile_id") REFERENCES "public"."product_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_vector_stores" ADD CONSTRAINT "product_vector_stores_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_vector_stores_ws_idx" ON "product_vector_stores" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_vector_stores_ws_product_provider_idx" ON "product_vector_stores" USING btree ("workspace_id","product_profile_id","provider_id");