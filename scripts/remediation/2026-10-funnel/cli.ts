// Remediation 2026-10-funnel (flow:F-06) — command line. The entry point is
// ./index.ts; the runbook is ./README.md.
//
//   dry run (default; read-only; writes report.json, report.md, decisions.csv):
//     pnpm tsx scripts/remediation/2026-10-funnel/index.ts [--out remediation-reports]
//       [--own-domain example.com | --own-domain 4:example.com]... [--workspace 4]...
//   apply a reviewed dry run:
//     pnpm tsx scripts/remediation/2026-10-funnel/index.ts --apply
//       --report <dir>/report.json --decisions <dir>/decisions.csv
//       --actor <super-admin e-mail> --confirm-db <database name>
//   revert an applied batch:
//     pnpm tsx scripts/remediation/2026-10-funnel/index.ts --revert <batch id>
//       --actor <super-admin e-mail> --confirm-db <database name> [--skip-conflicts]
//   checks only (read-only; prints the post-apply counts for the current data):
//     pnpm tsx scripts/remediation/2026-10-funnel/index.ts --check
//
// Reports carry e-mail addresses: they go to remediation-reports/
// (git-ignored), never into the repository.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RemediationError, databaseTarget, isBatchId, writePrivateFile } from '../lib/report-io';

export const DEFAULT_OUT = 'remediation-reports';

const USAGE = `Remediation 2026-10-funnel (mail module)

  --dry-run                 (default) compute the plan; write report.json, report.md, decisions.csv
  --out <dir>               where reports go (default ${DEFAULT_OUT}/, git-ignored)
  --own-domain <d|ws:d>     extra own domain, repeatable (mailbox and member domains are found automatically)
  --workspace <id>          limit to a workspace, repeatable

  --apply                   apply a reviewed dry run
  --report <file>           the dry run's report.json
  --decisions <file>        the (edited) decisions.csv
  --skip-preconditions      rehearsal on a restored snapshot only (F-01 is not live there)

  --revert <batch id>       restore every change of an applied batch
  --skip-conflicts          revert everything except rows changed since the apply

  --check                   print the post-apply checks for the current data
  --actor <e-mail>          active super admin performing --apply / --revert
  --confirm-db <name>       must equal the database name in DATABASE_URL (--apply / --revert)
`;

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

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

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      revert: { type: 'string' },
      check: { type: 'boolean' },
      report: { type: 'string' },
      decisions: { type: 'string' },
      actor: { type: 'string' },
      'confirm-db': { type: 'string' },
      out: { type: 'string' },
      'own-domain': { type: 'string', multiple: true },
      workspace: { type: 'string', multiple: true },
      'skip-preconditions': { type: 'boolean' },
      'skip-conflicts': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const modes = [values.apply, values.revert !== undefined, values.check, values['dry-run']].filter(
    Boolean,
  );
  if (modes.length > 1)
    throw new RemediationError('choose one of --dry-run, --apply, --revert, --check', 'usage');
  // The batch id also names the report folder: never let it be a path.
  if (values.revert !== undefined && !isBatchId(values.revert)) {
    throw new RemediationError(`--revert takes a batch id, not "${values.revert}"`, 'usage');
  }

  const target = databaseTarget();
  console.log(`database: ${target.host}/${target.name}`);
  const writes = values.apply || values.revert !== undefined;
  if (writes && values['confirm-db'] !== target.name) {
    throw new RemediationError(
      `pass --confirm-db ${target.name} to write to this database`,
      'confirm_db',
    );
  }
  if (writes && !values.actor)
    throw new RemediationError('--actor <super-admin e-mail> is required', 'usage');

  // Imported here, after the target is known: the db client connects on import.
  const mail = await import('./mail/index');
  const engine = await import('../lib/engine');

  if (values.check) {
    const { plan } = await mail.buildMailPlan({
      ownDomains: values['own-domain'] ?? [],
      workspaceIds: values.workspace ?? null,
    });
    for (const w of plan.workspaces) {
      console.log(`workspace ${w.workspaceId}: ${JSON.stringify(w.checks)}`);
    }
    return 0;
  }

  if (values.revert !== undefined) {
    const actor = await engine.resolveActor(values.actor!);
    const result = await engine.revertRun(values.revert, {
      actor,
      skipConflicts: values['skip-conflicts'] ?? false,
    });
    const dir = assertPrivateOutDir(path.join(values.out ?? DEFAULT_OUT, values.revert));
    const name = `revert-${stamp()}`;
    writePrivateFile(dir, `${name}.json`, JSON.stringify(result, null, 2));
    const md = writePrivateFile(dir, `${name}.md`, mail.renderRevertMarkdown(result));
    console.log(
      `revert ${result.status}: ${result.reverted} row(s) restored, ${result.conflicts.length} conflict(s). ${md}`,
    );
    return 0;
  }

  if (values.apply) {
    if (!values.report || !values.decisions) {
      throw new RemediationError('--apply needs --report and --decisions', 'usage');
    }
    const report = mail.assertMailReport(JSON.parse(readFileSync(values.report, 'utf8')));
    const decisionsCsv = readFileSync(values.decisions, 'utf8');
    const actor = await engine.resolveActor(values.actor!);
    const result = await mail.applyMailPlan({
      report,
      decisionsCsv,
      actor,
      skipPreconditions: values['skip-preconditions'] ?? false,
    });
    const dir = assertPrivateOutDir(path.dirname(values.report));
    const name = `apply-${stamp()}`;
    writePrivateFile(dir, `${name}.json`, JSON.stringify(result, null, 2));
    const md = writePrivateFile(dir, `${name}.md`, mail.renderApplyMarkdown(result, report));
    console.log(`apply ${result.status}: ${result.totalChanged} row(s) changed. ${md}`);
    if (result.post) console.log(`post-apply checks: ${JSON.stringify(result.post)}`);
    return result.status === 'failed' ? 1 : 0;
  }

  // Dry run.
  const { plan } = await mail.buildMailPlan({
    ownDomains: values['own-domain'] ?? [],
    workspaceIds: values.workspace ?? null,
  });
  const dir = assertPrivateOutDir(path.join(values.out ?? DEFAULT_OUT, plan.batchId));
  const report = writePrivateFile(dir, 'report.json', JSON.stringify(plan, null, 2));
  const decisions = writePrivateFile(dir, 'decisions.csv', mail.renderDecisionsCsv(plan));
  const shown = (file: string) => {
    const rel = path.relative(process.cwd(), file);
    return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
  };
  const md = writePrivateFile(
    dir,
    'report.md',
    mail.renderPlanMarkdown(plan, { report: shown(report), decisions: shown(decisions) }),
  );
  for (const w of plan.workspaces) {
    const r1a = w.r1.filter((r) => r.class === 'R1a').length;
    console.log(
      `workspace ${w.workspaceId}: R0 ${w.r0.length}, R1a ${r1a}, R1b ${w.r1.length - r1a}, ` +
        `R2 ${w.r2.length}, R3 ${w.r3.length}, R4 ${w.r4.length}, R7 ${w.r7.length}, R8 ${w.r8.tokens} tokens`,
    );
  }
  console.log(
    `plan hash ${plan.planHash}; preconditions ${plan.preconditions.ok ? 'met' : 'NOT met'}`,
  );
  console.log(`report: ${md}`);
  return 0;
}
