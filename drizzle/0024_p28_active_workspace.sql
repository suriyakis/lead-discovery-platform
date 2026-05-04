ALTER TABLE "users" ADD COLUMN "activeWorkspaceId" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_activeWorkspaceId_workspaces_id_fk" FOREIGN KEY ("activeWorkspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;