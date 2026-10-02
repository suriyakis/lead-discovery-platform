/* eslint-disable no-console */
/**
 * scripts/remediation/import-legacy-feature-flags.ts — PC-06 / I048 / X6.
 *
 * Turns the legacy feature_flags rows (never enforced) into holds the
 * platform owner reviews on /admin/workspaces/[id] → "Legacy flags to
 * review": every disabled flag becomes a pending_review row (a hold, or a
 * note when no hold matches), which is NOT enforced until confirmed.
 * Mapping and tests: src/lib/remediation/legacy-feature-flags.ts.
 *
 * DRY RUN IS THE DEFAULT and runs in a READ ONLY transaction:
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/remediation/import-legacy-feature-flags.ts
 *
 * then, once the listed rows look right:
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/remediation/import-legacy-feature-flags.ts --apply
 *
 * --apply is idempotent (one imported row per workspace + flag key), runs
 * in one transaction and writes one audit row per imported row plus a
 * platform-scope summary (admin.legacy_flags.import). feature_flags itself
 * is left untouched; it is dropped one release later.
 */

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/lib/db/schema';
import {
  applyLegacyFlagImport,
  planLegacyFlagImport,
  renderLegacyFlagReport,
} from '../../src/lib/remediation/legacy-feature-flags';

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('usage: import-legacy-feature-flags.ts [--dry-run | --apply]');
  process.exit(2);
}

function parseMode(argv: string[]): 'dry-run' | 'apply' {
  let mode: 'dry-run' | 'apply' = 'dry-run';
  for (const a of argv) {
    if (a === '--dry-run') mode = 'dry-run';
    else if (a === '--apply') mode = 'apply';
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument ${a}`);
  }
  if (argv.includes('--dry-run') && argv.includes('--apply')) usage('choose --dry-run or --apply');
  return mode;
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) usage('DATABASE_URL is not set');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });
  try {
    console.log(`database: ${dbName} · mode: ${mode}\n`);
    if (mode === 'dry-run') {
      const plan = await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        return planLegacyFlagImport(tx);
      });
      console.log(renderLegacyFlagReport(plan));
      if (plan.totals.toInsert > 0) console.log('\nRun again with --apply to import these rows.');
      return;
    }
    const res = await applyLegacyFlagImport(db);
    console.log(renderLegacyFlagReport(res.plan));
    console.log(
      `\nImported ${res.inserted} row(s) as pending_review. Review them on /admin/workspaces/<id>.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('import-legacy-feature-flags failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
