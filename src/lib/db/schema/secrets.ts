import { bigint, customType, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

/** Drizzle 0.38 lacks a built-in bytea type — define it via customType. */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => 'bytea',
  fromDriver: (value) => (value instanceof Buffer ? value : Buffer.from(value as never)),
  toDriver: (value) => value,
});

/**
 * Encrypted per-workspace secrets. The cleartext value is encrypted with
 * AES-256-GCM using a key derived from server-wide `MASTER_KEY`. The
 * encrypted blob layout is `nonce(12) || ciphertext || authTag(16)`.
 *
 * Examples of secrets stored here in Phase 6+:
 *   - serpapi.apiKey
 *   - imap.password
 *   - hubspot.accessToken
 *
 * Naming convention for `key`: dot-separated `<provider>.<field>`.
 * Operators can list and rotate via the workspace settings UI; values are
 * never returned to the client and never logged.
 */
export const workspaceSecrets = pgTable(
  'workspace_secrets',
  {
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    encryptedValue: bytea('encrypted_value').notNull(),
    /** Dot-prefix that helps the UI group settings by integration. */
    scope: text('scope').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.key] }),
  }),
);

export type WorkspaceSecret = typeof workspaceSecrets.$inferSelect;
export type NewWorkspaceSecret = typeof workspaceSecrets.$inferInsert;

/**
 * Platform-wide provider secrets — the keys the PLATFORM runs on when a
 * workspace hasn't brought its own. Managed by super-admins from the
 * /admin/providers console page. Same encryption scheme as workspace
 * secrets (AES-256-GCM under MASTER_KEY). Resolution order everywhere:
 * workspace secret → platform secret (this table) → env var.
 */
export const platformSecrets = pgTable('platform_secrets', {
  key: text('key').primaryKey(),
  encryptedValue: bytea('encrypted_value').notNull(),
  scope: text('scope').notNull(),
  updatedByUserId: text('updated_by_user_id'),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PlatformSecret = typeof platformSecrets.$inferSelect;
export type NewPlatformSecret = typeof platformSecrets.$inferInsert;
