/**
 * scripts/remediation/mailbox-health-backfill.ts — PC-09 / X7.
 *
 * Mailboxes that were already failing before mailbox health shipped
 * (failure_class NULL) are neither announced nor probed on their own. This
 * lists them, and — after the owner reviewed the list — gives each its
 * failure class, its incident (ops_event; the owner's ntfy alert follows)
 * and its owners' / admins' bell notification. A backfilled mailbox is
 * NOT probed automatically afterwards; it recovers when someone fixes its
 * settings (one scheduled check), clicks Test again or Reactivate.
 * Logic + tests: src/lib/remediation/mailbox-health-backfill.ts.
 *
 * DRY RUN IS THE DEFAULT and runs in a READ ONLY transaction. Output has
 * workspace / mailbox ids, dates, counts, the failing side, the class and
 * host:port — no addresses, names or error text.
 *
 *   # 1. dry run (read-only)
 *   DATABASE_URL=... pnpm exec tsx scripts/remediation/mailbox-health-backfill.ts
 *
 *   # 2. ONLY after the owner signed off that exact list:
 *   DATABASE_URL=... pnpm exec tsx scripts/remediation/mailbox-health-backfill.ts \
 *       --apply --expect <fingerprint from the dry run>
 *
 * --apply refuses unless the candidate set is exactly the reviewed one. It
 * is idempotent: a tracked mailbox has a class and drops out of the list.
 */

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/lib/db/schema';
import {
  applyMailboxHealthBackfill,
  planMailboxHealthBackfill,
  renderMailboxHealthBackfillReport,
} from '../../src/lib/remediation/mailbox-health-backfill';

interface Args {
  mode: 'dry-run' | 'apply';
  expect?: string;
}

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      'usage:',
      '  mailbox-health-backfill.ts [--dry-run]',
      '  mailbox-health-backfill.ts --apply --expect <fingerprint>',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run' };
  const modes = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run':
        modes.add('dry-run');
        break;
      case '--apply':
        modes.add('apply');
        args.mode = 'apply';
        break;
      case '--expect': {
        const v = argv[++i];
        if (!v || v.startsWith('--')) usage('--expect needs a value');
        args.expect = v;
        break;
      }
      case '-h':
      case '--help':
        usage();
        break;
      default:
        usage(`unknown argument ${a}`);
    }
  }
  if (modes.size > 1) usage('choose one of --dry-run, --apply');
  if (args.mode === 'apply' && !args.expect) {
    usage('--apply requires --expect <fingerprint> from a reviewed dry run');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) usage('DATABASE_URL is not set');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  console.log(`database: ${dbName} · mode: ${args.mode}\n`);
  if (args.mode === 'dry-run') {
    const client = postgres(url, { max: 1, onnotice: () => {} });
    const db = drizzle(client, { schema });
    try {
      const plan = await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        return planMailboxHealthBackfill(tx);
      });
      console.log(renderMailboxHealthBackfillReport(plan));
      if (plan.rows.length > 0) {
        console.log(`\nAfter sign-off, apply exactly this list with:\n  --apply --expect ${plan.fingerprint}`);
      }
    } finally {
      await client.end();
    }
    return;
  }
  // --apply writes through the app's own client (DATABASE_URL), like the
  // incident and notification writers it calls.
  const res = await applyMailboxHealthBackfill({ expectFingerprint: args.expect! });
  console.log(renderMailboxHealthBackfillReport(res.plan));
  console.log(
    `\nApplied: ${res.tracked} mailbox(es) tracked, ${res.notified} notified, ${res.skipped} changed meanwhile and left alone.`,
  );
  const { db } = await import('../../src/lib/db/client');
  await (db.$client as unknown as { end: () => Promise<void> }).end();
}

main().catch((err) => {
  console.error('mailbox-health-backfill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
