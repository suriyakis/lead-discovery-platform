CREATE TYPE "public"."contact_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "contact_associations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"contact_id" bigint NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"relation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text,
	"phone" text,
	"company_name" text,
	"company_domain" text,
	"status" "contact_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "contact_id" bigint;--> statement-breakpoint
ALTER TABLE "contact_associations" ADD CONSTRAINT "contact_associations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_associations" ADD CONSTRAINT "contact_associations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_assoc_contact_entity_idx" ON "contact_associations" USING btree ("contact_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "contact_assoc_ws_entity_idx" ON "contact_associations" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_ws_email_idx" ON "contacts" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "contacts_ws_company_idx" ON "contacts" USING btree ("workspace_id","company_name");--> statement-breakpoint
CREATE INDEX "contacts_ws_domain_idx" ON "contacts" USING btree ("workspace_id","company_domain");--> statement-breakpoint
-- P16 backfill: lift contact info embedded on qualified_leads into the
-- new contacts + associations tables. Idempotent — the (workspace, email)
-- and (contact, entity) UNIQUE indexes prevent duplicates on re-run.
INSERT INTO contacts (workspace_id, email, name, role, phone, status, created_at, updated_at)
SELECT
  workspace_id,
  LOWER(TRIM(contact_email)),
  MIN(contact_name),
  MIN(contact_role),
  MIN(contact_phone),
  'active',
  NOW(),
  NOW()
FROM qualified_leads
WHERE contact_email IS NOT NULL AND TRIM(contact_email) <> ''
GROUP BY workspace_id, LOWER(TRIM(contact_email))
ON CONFLICT (workspace_id, email) DO NOTHING;
--> statement-breakpoint
INSERT INTO contact_associations (workspace_id, contact_id, entity_type, entity_id, relation)
SELECT
  ql.workspace_id,
  c.id,
  'qualified_lead',
  ql.id::text,
  'primary'
FROM qualified_leads ql
JOIN contacts c
  ON c.workspace_id = ql.workspace_id
  AND c.email = LOWER(TRIM(ql.contact_email))
WHERE ql.contact_email IS NOT NULL AND TRIM(ql.contact_email) <> ''
ON CONFLICT (contact_id, entity_type, entity_id) DO NOTHING;