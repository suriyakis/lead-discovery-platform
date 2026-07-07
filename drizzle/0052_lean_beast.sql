CREATE TABLE "token_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"delta" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"external_ref" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "token_balance" bigint DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "token_tx_ws_created_idx" ON "token_transactions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_tx_external_ref_idx" ON "token_transactions" USING btree ("external_ref") WHERE external_ref IS NOT NULL;