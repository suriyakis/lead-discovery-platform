// Vitest globalSetup. Runs once before any test file.
// Creates the test database if it doesn't exist yet, then applies the
// Drizzle migrations. The migration runner is idempotent — already-applied
// migrations are skipped via the __drizzle_migrations table.

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// The globalSetup runs in the vitest parent process. Vitest's `test.env`
// applies to test workers, not to this setup, so resolve the URL the same
// way vitest.config.ts does. DATABASE_URL is deliberately NOT consulted:
// a dev shell usually exports the dev database there.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://lead:lead@localhost:5432/lead_test';

export default async function globalSetup() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
  if (!dbName.includes('lead_test')) {
    throw new Error(
      `Refusing to run migrations: TEST_DATABASE_URL does not look like a test DB ` +
        `("${dbName}"). Test database names must contain "lead_test".`,
    );
  }

  await ensureDatabase(dbName);

  const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: './drizzle' });
  await client.end();
}

// Parallel checkouts (git worktrees, CI shards) each point TEST_DATABASE_URL
// at their own lead_test_* database; create it on first use so nobody has to
// remember a manual createdb.
async function ensureDatabase(dbName: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Refusing to create test database with unexpected name "${dbName}"`);
  }
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (rows.length === 0) {
      // Identifier validated above; CREATE DATABASE can't take a bind param.
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
}
