// Apply pending Drizzle migrations.
//
// Run via: pnpm db:migrate
// Reads DATABASE_URL from .env. Idempotent — already-applied migrations
// are skipped via Drizzle's __drizzle_migrations table.

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  // Use a single short-lived connection for the migration run.
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  console.log('Running migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');

  await client.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
