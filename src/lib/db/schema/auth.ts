import { integer, pgEnum, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Auth.js-compatible schema for the Drizzle adapter.
// We extend the canonical `users` table with a platform-wide `role` and a
// couple of audit timestamps. The Auth.js adapter ignores extra columns.
//
// CONVENTION EXCEPTION: the four auth tables below use camelCase column
// names because that's what the Auth.js Drizzle adapter writes to. All
// non-auth tables in this codebase use snake_case columns. Documented in
// docs/DATABASE_MODEL.md.

export const userRole = pgEnum('user_role', ['member', 'super_admin']);

/**
 * Account lifecycle. Phase 15:
 *   pending   — first sign-in (or admin pre-created via preauthorize but
 *               their first OAuth round-trip hasn't happened yet); user
 *               sees a /pending page until an admin activates them.
 *   active    — full access.
 *   suspended — temporarily blocked by an admin (reason on
 *               accountStatusReason).
 *   rejected  — admin rejected the user; future sign-ins land on the
 *               pending wall again.
 */
export const accountStatus = pgEnum('account_status', [
  'pending',
  'active',
  'suspended',
  'rejected',
]);

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  role: userRole('role').notNull().default('member'),
  accountStatus: accountStatus('accountStatus').notNull().default('pending'),
  accountStatusReason: text('accountStatusReason'),
  accountStatusUpdatedAt: timestamp('accountStatusUpdatedAt', {
    mode: 'date',
    withTimezone: true,
  }),
  accountStatusUpdatedBy: text('accountStatusUpdatedBy'),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSignedInAt: timestamp('lastSignedInAt', { mode: 'date', withTimezone: true }),
});

/**
 * Pre-authorized email allow-list. Admins can pre-list an email so the user
 * lands on `active` at first sign-in instead of `pending`. Workspace-scoped:
 * an entry pre-adds the user to the named workspace at the named role.
 */
export const preauthorizedEmails = pgTable('preauthorized_emails', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  /** Workspace-id (text-encoded bigint) the user should join on first signin. */
  workspaceId: text('workspaceId'),
  /** Role they should receive in that workspace. Defaults to 'member'. */
  role: text('role').notNull().default('member'),
  createdBy: text('createdBy'),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
  consumedAt: timestamp('consumedAt', { mode: 'date', withTimezone: true }),
});

export type AccountStatus = (typeof accountStatus.enumValues)[number];
export type PreauthorizedEmail = typeof preauthorizedEmails.$inferSelect;
export type NewPreauthorizedEmail = typeof preauthorizedEmails.$inferInsert;

export const accounts = pgTable(
  'accounts',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (account) => ({
    compoundKey: primaryKey({ columns: [account.provider, account.providerAccountId] }),
  }),
);

export const sessions = pgTable('sessions', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (vt) => ({
    compoundKey: primaryKey({ columns: [vt.identifier, vt.token] }),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
