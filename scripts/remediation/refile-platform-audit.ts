/* eslint-disable no-console */
/**
 * scripts/remediation/refile-platform-audit.ts — PC-03 / I051.
 *
 * Moves audit_log rows that the old /admin console filed into whatever
 * workspace the super-admin's switcher pointed at, to where the fixed code
 * files them today (platform scope, the billing target, or the support
 * thread's workspace). Logic + tests: src/lib/remediation/refile-platform-audit.ts.
 *
 * DRY RUN IS THE DEFAULT and runs in a READ ONLY transaction. Output has
 * workspace ids, audit row ids, kinds and counts — no emails, names or
 * payload contents — so it can be pasted into a ticket for sign-off.
 *
 *   # 1. dry run (read-only); optionally keep the JSON report
 *   DATABASE_URL=... pnpm exec tsx scripts/remediation/refile-platform-audit.ts \
 *       [--scope all|cross-tenant] [--out refile-report.json]
 *
 *   # 2. ONLY after the owner signed off that exact report:
 *   DATABASE_URL=... pnpm exec tsx scripts/remediation/refile-platform-audit.ts \
 *       --apply --expect <fingerprint from the dry run> [--scope ...]
 *
 *   # undo one apply run (rows go back to payload.refiledFrom.workspaceId)
 *   DATABASE_URL=... pnpm exec tsx scripts/remediation/refile-platform-audit.ts \
 *       --revert <runId printed by --apply>
 *
 * --apply refuses unless the candidate set is byte-for-byte the one that
 * produced the fingerprint, and runs in one transaction.
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/lib/db/schema';
import {
  applyRefile,
  planRefile,
  renderRefileReport,
  revertRefile,
  type RefileScope,
} from '../../src/lib/remediation/refile-platform-audit';

interface Args {
  mode: 'dry-run' | 'apply' | 'revert';
  scope: RefileScope;
  expect?: string;
  runId?: string;
  out?: string;
}

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      'usage:',
      '  refile-platform-audit.ts [--dry-run] [--scope all|cross-tenant] [--out report.json]',
      '  refile-platform-audit.ts --apply --expect <fingerprint> [--scope all|cross-tenant]',
      '  refile-platform-audit.ts --revert <runId>',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', scope: 'all' };
  const modes = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) usage(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--dry-run':
        modes.add('dry-run');
        break;
      case '--apply':
        modes.add('apply');
        args.mode = 'apply';
        break;
      case '--revert':
        modes.add('revert');
        args.mode = 'revert';
        args.runId = next();
        break;
      case '--expect':
        args.expect = next();
        break;
      case '--scope': {
        const v = next();
        if (v !== 'all' && v !== 'cross-tenant') usage(`--scope must be all or cross-tenant`);
        args.scope = v;
        break;
      }
      case '--out':
        args.out = next();
        break;
      case '-h':
      case '--help':
        usage();
        break;
      default:
        usage(`unknown argument ${a}`);
    }
  }
  if (modes.size > 1) usage('choose one of --dry-run, --apply, --revert');
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
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });
  try {
    console.log(`database: ${dbName} · mode: ${args.mode} · scope: ${args.scope}\n`);
    if (args.mode === 'dry-run') {
      const plan = await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        return planRefile(tx, { scope: args.scope });
      });
      console.log(renderRefileReport(plan));
      if (args.out) {
        writeFileSync(args.out, `${JSON.stringify(plan, null, 2)}\n`);
        console.log(`\nJSON report written to ${args.out}`);
      }
      if (plan.totals.rows > 0) {
        console.log(
          `\nAfter sign-off, apply exactly this plan with:\n  --apply --expect ${plan.fingerprint}${args.scope === 'all' ? '' : ` --scope ${args.scope}`}`,
        );
      }
      return;
    }
    if (args.mode === 'apply') {
      const res = await applyRefile(db, { expectFingerprint: args.expect!, scope: args.scope });
      console.log(renderRefileReport(res.plan));
      console.log(`\nApplied run ${res.runId}: moved ${res.moved} row(s).`);
      if (res.moved > 0) console.log(`Undo with: --revert ${res.runId}`);
      return;
    }
    const res = await revertRefile(db, { runId: args.runId! });
    console.log(
      `Reverted run ${res.runId}: restored ${res.restored} row(s); ${res.skippedMissingWorkspace} left in place (original workspace no longer exists).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('refile-platform-audit failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
