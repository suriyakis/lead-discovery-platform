-- flow:F-01 (X1, I161, I165): inbound relevance gate.
-- outreach_relevance says whether an inbound message is about our outreach
-- (prospect_reply / auto_reply / bounce) or not (bulk / unrelated); only the
-- first three may trigger reply side effects. relevance_signals keeps the
-- header signals (List-*, Precedence, Auto-Submitted, ESP markers, parsed
-- DSN) and the evidence behind the verdict. Both stay NULL on outbound and
-- on inbound synced before F-01: labelling those is
-- backfillInboundRelevance(), run with the owner-approved remediation
-- (flow:F-06), not here. The partial lower(message_id) index serves the
-- case-insensitive "is this one of OUR Message-IDs?" lookup (I008 b).
CREATE TYPE "public"."outreach_relevance" AS ENUM('prospect_reply', 'auto_reply', 'bounce', 'bulk', 'unrelated');--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "outreach_relevance" "outreach_relevance";--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "relevance_signals" jsonb;--> statement-breakpoint
CREATE INDEX "mail_messages_ws_outbound_lower_message_id_idx" ON "mail_messages" USING btree ("workspace_id",lower("message_id")) WHERE "mail_messages"."direction" = 'outbound';--> statement-breakpoint
CREATE INDEX "mail_messages_ws_relevance_idx" ON "mail_messages" USING btree ("workspace_id","outreach_relevance");