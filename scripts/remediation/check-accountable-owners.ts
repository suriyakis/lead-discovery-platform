/**
 * scripts/remediation/check-accountable-owners.ts — PC-06 pre-deploy check.
 *
 * From the Phase 1 automation-control release on, an active workspace
 * whose owner account is not active, or whose owner is not a member, runs
 * NO automatic work (inbox sync included) from the first tick after the
 * deploy. Run this against prod BEFORE that deploy (it reads the base
 * tables, so it works before and after the migration):
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/remediation/check-accountable-owners.ts
 *
 * READ ONLY (one read-only transaction). Exit 0 = every active workspace
 * passes; exit 1 = the listed workspaces would stop (reactivate the owner
 * or transfer ownership first, or accept it); exit 2 = usage error.
 * Logic and tests: src/lib/remediation/accountable-owners.ts.
 */

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/lib/db/schema';
import {
  findWorkspacesWithoutAccountableOwner,
  renderAccountableOwnersReport,
} from '../../src/lib/remediation/accountable-owners';

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('usage: check-accountable-owners.ts');
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) usage();
  if (args.length > 0) usage(`unknown argument ${args[0]}`);
  const url = process.env.DATABASE_URL;
  if (!url) usage('DATABASE_URL is not set');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });
  try {
    console.log(`database: ${dbName} · read only\n`);
    const found = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return findWorkspacesWithoutAccountableOwner(tx);
    });
    console.log(renderAccountableOwnersReport(found));
    if (found.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('check-accountable-owners failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
