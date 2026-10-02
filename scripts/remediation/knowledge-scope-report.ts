/* eslint-disable no-console */
/**
 * scripts/remediation/knowledge-scope-report.ts — KL-05 (I039, I101, I104,
 * I109). DRY RUN ONLY: there is no apply mode. It reads, in a READ ONLY
 * transaction, what the knowledge-scope migration will do (run it BEFORE
 * deploying) or what it did (run it after):
 *
 *   * the counts for the PR: documents, sources, document-level chunks,
 *     source chunks, documents having both;
 *   * the OWNER-REVIEW list of documents that become available to every
 *     product (workspace-wide knowledge sources);
 *   * the shadowed document-level chunks the migration deletes;
 *   * sources that will "Need a scope", and product ids that are dropped.
 *
 * Logic + tests: src/lib/remediation/knowledge-scope-report.ts and
 * src/tests/knowledge-scope-migration.test.ts.
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/remediation/knowledge-scope-report.ts \
 *       [--workspace <id>]... [--out <dir>] [--json]
 *
 * The report names documents and sources (titles, filenames): print it, or
 * write it with --out to remediation-reports/ (git-ignored, mode 0600) —
 * never commit it.
 */

import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import {
  buildKnowledgeScopeReport,
  renderKnowledgeScopeReport,
} from '../../src/lib/remediation/knowledge-scope-report';
import { RemediationError, databaseTarget, writePrivateFile } from './lib/report-io';

const DEFAULT_OUT = 'remediation-reports';

const USAGE = `KL-05 knowledge scope report (read-only; no apply mode)

  --workspace <id>   limit to a workspace (repeatable)
  --out <dir>        also write report.md + report.json there (default folder ${DEFAULT_OUT}/ is git-ignored)
  --json             print JSON instead of Markdown
`;

/** Reports may not land inside the repository except in the ignored folder. */
function assertPrivateOutDir(dir: string): string {
  const resolved = path.resolve(dir);
  const repo = process.cwd();
  const ignored = path.resolve(repo, DEFAULT_OUT);
  const inside = (parent: string) => resolved === parent || resolved.startsWith(parent + path.sep);
  if (inside(repo) && !inside(ignored)) {
    throw new RemediationError(
      `--out ${dir} is inside the repository; use ${DEFAULT_OUT}/ (git-ignored) or a folder outside it`,
      'unsafe_out_dir',
    );
  }
  return resolved;
}

async function main(): Promise<number> {
  let values: { workspace?: string[]; out?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        workspace: { type: 'string', multiple: true },
        out: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const workspaceIds = values.workspace ?? [];
  const bad = workspaceIds.filter((w) => !/^\d+$/.test(w));
  if (bad.length > 0) {
    console.error(`--workspace must be a numeric id (got ${bad.join(', ')})\n\n${USAGE}`);
    return 2;
  }
  const outDir = values.out ? assertPrivateOutDir(values.out) : null;

  const url = process.env.DATABASE_URL;
  const target = databaseTarget(url);
  const client = postgres(url!, { max: 1, onnotice: () => {} });
  try {
    const report = await client.begin('read only', (tx) =>
      buildKnowledgeScopeReport(tx, { workspaceIds }),
    );
    const markdown = renderKnowledgeScopeReport(report);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    console.error(`database: ${target.name} @ ${target.host} · shape: ${report.shape} · read-only`);
    console.log(values.json ? json : markdown);
    if (outDir) {
      const md = writePrivateFile(outDir, 'knowledge-scope-report.md', `${markdown}\n`);
      const js = writePrivateFile(outDir, 'knowledge-scope-report.json', json);
      console.error(`written: ${md}\n         ${js}`);
    }
    return 0;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('knowledge-scope-report failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
