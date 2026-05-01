import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. The app cannot start without a database.');
}

// One shared connection pool per process. In dev with hot-reload, Next.js
// re-evaluates this module on every change — without the global cache we'd
// leak connections rapidly. In production this branch is skipped.
const globalForDb = globalThis as unknown as {
  __dbClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__dbClient ??
  postgres(connectionString, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__dbClient = client;
}

export const db = drizzle(client, { schema });
export type Database = typeof db;
export { schema };
