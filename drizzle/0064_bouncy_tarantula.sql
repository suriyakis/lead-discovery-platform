-- flow:F-04 (X7, I095, I021): failing-mailbox visibility and backoff.
-- last_error_at dates last_error (updated_at moves on any edit, so the
-- mailbox page could not say WHEN the error happened). failing_since marks
-- the start of the current 'failing' episode: the re-check backoff grows
-- with it (1 h, or 6 h after a refused login, doubling to a 24 h cap) and
-- the page / health check say "failing since …".
--
-- Backfill: rows that already carry an error get updated_at as their best
-- known error time, and rows already 'failing' start their episode there
-- (prod: workspace 1's mailbox has been failing since 2026-05-08).
-- imap_next_sync_after is deliberately left NULL on failing rows: the first
-- IMAP tick after deploy "adopts" every failing mailbox with a NULL gate -
-- it raises the deduped mailbox.failing notification and writes the
-- backoff, with no connection attempt. Re-running is a no-op: each UPDATE
-- only touches rows whose new column is still NULL.
ALTER TABLE "mailboxes" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "failing_since" timestamp with time zone;--> statement-breakpoint
UPDATE "mailboxes" SET "last_error_at" = "updated_at" WHERE "last_error" IS NOT NULL AND "last_error_at" IS NULL;--> statement-breakpoint
UPDATE "mailboxes" SET "failing_since" = "updated_at" WHERE "status" = 'failing' AND "failing_since" IS NULL;
