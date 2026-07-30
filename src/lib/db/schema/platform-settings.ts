import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Platform-wide NON-SECRET configuration, managed by super-admins from
 * /admin/providers — which provider + model each capability runs on by
 * default. Sits between a workspace's own selection and the env vars:
 *   workspace setting → platform setting (this table) → env → auto-detect.
 *
 * Keys are dot-separated `<capability>.<field>`, e.g. 'ai.provider',
 * 'ai.model', 'research.model'. Values are plain text; validation lives
 * in the platform-settings service.
 */
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedByUserId: text('updated_by_user_id'),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PlatformSetting = typeof platformSettings.$inferSelect;
export type NewPlatformSetting = typeof platformSettings.$inferInsert;
