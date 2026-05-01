// Vitest globalSetup. Runs once before any test file.
// Applies the Drizzle migrations to the test database. The migration runner
// is idempotent — already-applied migrations are skipped via the
// __drizzle_migrations table.

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// The globalSetup runs in the vitest parent process. Vitest's `test.env`
// applies to test workers, not to this setup, so we resolve the URL with a
// fallback to the canonical test DB. Workers receive the URL via test.env.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://lead:lead@localhost:5432/lead_test';

export default async function globalSetup() {
  if (!TEST_DATABASE_URL.includes('lead_test')) {
    throw new Error(
      `Refusing to run migrations: DATABASE_URL does not look like a test DB ` +
        `(${TEST_DATABASE_URL}). Tests must run against lead_test, not the dev database.`,
    );
  }

  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: './drizzle' });
  await client.end();
}
