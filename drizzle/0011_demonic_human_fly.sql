-- Phase 12: enable pgvector. The base postgres image switched to
-- pgvector/pgvector:pg17 in this same change.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"document_id" bigint,
	"knowledge_source_id" bigint,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"start_char" integer DEFAULT 0 NOT NULL,
	"end_char" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"embedding_dim" integer DEFAULT 1536 NOT NULL,
	"embedded_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexing_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"document_id" bigint,
	"knowledge_source_id" bigint,
	"status" text DEFAULT 'queued' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"embedding_model" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"triggered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "embedding_dim" integer DEFAULT 1536 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_lessons" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_knowledge_source_id_knowledge_sources_id_fk" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_knowledge_source_id_knowledge_sources_id_fk" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_chunks_ws_doc_idx" ON "document_chunks" USING btree ("workspace_id","document_id");--> statement-breakpoint
CREATE INDEX "document_chunks_ws_ks_idx" ON "document_chunks" USING btree ("workspace_id","knowledge_source_id");--> statement-breakpoint
CREATE INDEX "indexing_jobs_ws_created_idx" ON "indexing_jobs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "indexing_jobs_ws_status_idx" ON "indexing_jobs" USING btree ("workspace_id","status");--> statement-breakpoint
-- Vector similarity indexes. HNSW with cosine distance — works well for
-- RAG sizes (millions of chunks) at minimal write cost. Per pgvector docs
-- this is preferred over IVFFlat at our scale.
CREATE INDEX "document_chunks_embedding_hnsw_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "learning_lessons_embedding_hnsw_idx" ON "learning_lessons" USING hnsw ("embedding" vector_cosine_ops);