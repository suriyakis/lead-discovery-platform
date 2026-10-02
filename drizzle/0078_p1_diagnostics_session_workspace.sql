ALTER TABLE "sessions" ADD COLUMN "activeWorkspaceId" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "createdAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "lastSeenAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "userAgent" text;--> statement-breakpoint
-- custom:begin
-- MOB-06: the session's workspace pointer follows workspace deletion like
-- users.activeWorkspaceId does (0024): a deleted workspace clears it and the
-- resolver re-pins the session from the last-used workspace. Kept here, not in
-- the TS schema, because schema/auth.ts cannot import schema/workspaces.ts.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_activeWorkspaceId_workspaces_id_fk" FOREIGN KEY ("activeWorkspaceId") REFERENCES "public"."workspaces"("id") ON DELETE SET NULL;
-- custom:end
