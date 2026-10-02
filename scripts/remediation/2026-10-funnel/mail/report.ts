// Remediation 2026-10-funnel, mail module (flow:F-06) — owner-facing
// markdown. Never prints message subjects or bodies; addresses appear only
// in the R1 and R3 tables, where a person has to judge the row.

import type { RevertResult } from '../../lib/engine';
import { mdCell } from '../../lib/report-io';
import type { ApplyResult } from './apply';
import type { MailChecks, MailPlan, WorkspaceMailPlan } from './types';

const CHECK_LABELS: Record<keyof MailChecks, string> = {
  inboundWithoutRelevance: 'Inbound messages without a relevance label',
  activeAutoSuppressionsFromNonProspectMail:
    'Active auto-suppressions from non-prospect mail (R1a)',
  labelledNonProspectInbound: 'Bulk/unrelated inbound carrying reply labels',
  inboundOnlyContacts: 'Active inbound-only contacts from bulk/unrelated mail',
  visibleInboundAutoContacts: 'Visible (active) contacts tagged inbound-auto',
  leadRepliedOnThreadsWithoutOutbound: 'lead.replied notifications on threads without outbound',
};

function table(header: string[], rows: Array<Array<string | number | null>>): string[] {
  if (rows.length === 0) return ['_None._', ''];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`),
    '',
  ];
}

function countLabels(w: WorkspaceMailPlan): string {
  const by = new Map<string, number>();
  for (const r of w.r2) {
    const key = `${r.label ?? '(confidence/date only)'} on ${r.relevance}`;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by.entries()].map(([k, n]) => `${n} × ${k}`).join(', ');
}

export function renderPlanMarkdown(
  plan: MailPlan,
  files: { decisions: string; report: string },
): string {
  const L: string[] = [];
  const db = `${plan.database.host}/${plan.database.name}`;
  L.push(`# Remediation ${plan.script} · ${plan.module}: dry run`, '');
  L.push(`- Batch: \`${plan.batchId}\``);
  L.push(`- Generated: ${plan.generatedAt}`);
  L.push(`- Database: \`${db}\``);
  L.push(`- Plan hash: \`${plan.planHash}\``);
  L.push(
    `- Options: workspaces ${plan.options.workspaceIds?.join(', ') ?? 'all'}; extra own domains ${
      plan.options.ownDomains.join(', ') || 'none'
    }`,
  );
  L.push('');
  L.push(
    '> Nothing has been changed. This report lists exactly what `--apply` would change.',
    '> It contains e-mail addresses (R1, R3): keep it private and never commit it.',
    '',
  );

  L.push('## How to approve', '');
  L.push(
    `1. Review this report. Bulk categories (R0, R2, R4, R8) are decided per workspace, rows that need judgement (R1a, R1b, R3, R7) one by one.`,
    `2. Edit the \`decision\` column of \`${files.decisions}\` where you disagree with the default. A row you delete is left alone.`,
    `3. Take a pg_dump, then apply as a super admin:`,
    '',
    '```',
    `pnpm tsx scripts/remediation/2026-10-funnel/index.ts --apply \\`,
    `  --report ${files.report} --decisions ${files.decisions} \\`,
    `  --actor <your login e-mail> --confirm-db ${plan.database.name}`,
    '```',
    '',
    `   The apply recomputes the plan and refuses if anything changed since this report. Undo with \`--revert ${plan.batchId}\`.`,
    '',
  );

  L.push('## Preconditions', '');
  const pc = plan.preconditions;
  L.push(
    ...table(
      ['Check', 'Value', 'OK'],
      [
        [
          'F-01 labelling inbound mail since',
          pc.f01LiveSince ?? 'never',
          pc.f01LiveSince ? 'yes' : 'NO',
        ],
        [
          'Hours live (needs 48)',
          pc.hoursLive ?? '–',
          pc.hoursLive !== null && pc.hoursLive >= 48 ? 'yes' : 'NO',
        ],
        [
          'Reply-classifier suppressions since F-01 not from a prospect reply',
          pc.nonProspectReplySuppressionsSinceF01,
          pc.nonProspectReplySuppressionsSinceF01 === 0 ? 'yes' : 'NO',
        ],
      ],
    ),
  );
  for (const n of pc.notes) L.push(`- ${n}`);
  if (pc.notes.length > 0) L.push('');

  L.push('## Summary', '');
  L.push(
    ...table(
      [
        'Workspace',
        'R0 label',
        'R1a revoke',
        'R1b review',
        'R2 labels',
        'R3 archive / keep',
        'R4 delete',
        'R5 non-zero',
        'R6 flags',
        'R7 failing',
        'R8 tokens',
      ],
      plan.workspaces.map((w) => {
        const r1a = w.r1.filter((r) => r.class === 'R1a');
        const r3keep = w.r3.filter((r) => r.defaultDecision === 'keep').length;
        const r5 = Object.values(w.r5).filter((n) => n > 0).length;
        return [
          `${w.workspaceId} · ${w.name}`,
          w.r0.length,
          `${r1a.length} (${r1a.filter((r) => r.ownDomain).length} own)`,
          w.r1.length - r1a.length,
          w.r2.length,
          `${w.r3.length - r3keep} / ${r3keep}`,
          w.r4.length,
          r5,
          w.r6.length,
          w.r7.length,
          w.r8.tokens,
        ];
      }),
    ),
  );

  for (const w of plan.workspaces) {
    L.push(
      `## Workspace ${w.workspaceId} · ${w.name}${w.status !== 'active' ? ` (${w.status})` : ''}`,
      '',
    );
    L.push(
      `Own domains: ${w.ownDomains.map((d) => `${d.domain} (${d.why})`).join(', ') || 'none found'}` +
        ' — plus addresses of the same brand. Add more with `--own-domain`.',
      '',
    );

    L.push(`### R0 · Relevance labels for mail synced before F-01 (${w.r0.length})`, '');
    if (w.r0.length > 0) {
      const by = new Map<string, number>();
      for (const r of w.r0) by.set(r.relevance, (by.get(r.relevance) ?? 0) + 1);
      L.push(`Would label: ${[...by.entries()].map(([k, n]) => `${n} ${k}`).join(', ')}.`, '');
    } else {
      L.push('_None._', '');
    }

    L.push(`### R1 · Suppressions (${w.r1.length}; own domain first)`, '');
    L.push(
      'R1a: every add was the reply classifier acting on bulk/unrelated mail → **revoke** ' +
        '(reason "remediation 2026-10 X1"). R1b: any manual, link, import or send-time add, no audit trail, ' +
        'or a prospect message → **keep** unless you decide otherwise.',
      '',
    );
    L.push(
      ...table(
        [
          'Id',
          'Own domain',
          'Address / value',
          'Reason',
          'Source',
          'Class',
          'Default',
          'Why',
          'Trail',
          'Warnings',
        ],
        w.r1.map((r) => [
          r.suppressionId,
          r.ownDomain,
          r.value,
          r.reason,
          r.source,
          r.class,
          r.defaultDecision,
          r.why,
          r.trail.map((t) => `${t.at.slice(0, 16)} ${t.kind}`).join('; '),
          r.warnings.join('; '),
        ]),
      ),
    );

    L.push(`### R2 · Reply labels on bulk/unrelated mail (${w.r2.length})`, '');
    L.push(w.r2.length > 0 ? `Would clear: ${countLabels(w)}.` : '_None._', '');

    L.push(`### R3 · Inbound-only contacts (${w.r3.length}; own domain first)`, '');
    L.push(
      'Archive and tag `inbound-auto`. Own-domain colleagues default to **keep**. ' +
        'Origin `inbound_sender` = created for the sender of bulk/unrelated mail; ' +
        '`redirect_target` = extracted from the text of bulk/unrelated mail by the old ' +
        'auto-redirect. Contacts with notes, tags, a lead, outbound mail or any other link ' +
        'are never listed.',
      '',
    );
    L.push(
      ...table(
        ['Id', 'Own domain', 'Contact', 'Origin', 'Inbound msgs', 'Default', 'Why'],
        w.r3.map((r) => [
          r.contactId,
          r.ownDomain,
          r.email,
          r.origin,
          r.inboundMessages,
          r.defaultDecision,
          r.why,
        ]),
      ),
    );

    L.push(`### R4 · False lead.replied notifications (${w.r4.length})`, '');
    L.push(
      w.r4.length > 0
        ? `Would delete ${w.r4.length} (${w.r4.filter((r) => !r.read).length} unread) on ${
            new Set(w.r4.map((r) => r.threadId)).size
          } thread(s) without outbound mail.`
        : '_None._',
    );
    if (w.r4Unparsed > 0)
      L.push(`${w.r4Unparsed} lead.replied row(s) name no thread and are left alone.`);
    L.push('');

    L.push('### R5 · Zero-impact checks (expected 0)', '');
    L.push(
      ...table(
        ['Check', 'Count'],
        [
          ['Thread states on threads without outbound', w.r5.threadStatesWithoutOutbound],
          ['Pipeline auto-closes by the reply auto-actions', w.r5.pipelineAutoCloses],
          ['Learning events from non-prospect mail', w.r5.learningEventsFromNonProspectMail],
          ['Reply drafts triggered by non-prospect mail', w.r5.replyDraftsFromNonProspectMail],
          [
            'Queued sends / due follow-ups to addresses R1 would un-suppress (blocks R1)',
            w.r5.pendingSendsToRevokeTargets,
          ],
        ],
      ),
    );

    L.push('### R6 · Feature flags (decision only; confirm before F-07 deploys)', '');
    L.push(
      ...table(
        ['Flag', 'Enabled', 'Set at', 'What F-07 will do', 'Observed', 'Owner confirms'],
        w.r6.map((f) => [
          f.key,
          f.enabled ? 'on' : 'off',
          f.setAt.slice(0, 10),
          f.effect,
          f.observed,
          '[ ] keep  [ ] change',
        ]),
      ),
    );

    L.push('### R7 · Failing mailboxes (decision only)', '');
    L.push(
      'Choose per mailbox: fix the credentials and click Test again, archive it on the mailbox page, ' +
        'or `recheck_now` in the decisions file (the next IMAP tick re-checks it).',
      '',
    );
    L.push(
      ...table(
        ['Id', 'Mailbox', 'Failing since', 'Failures', 'Next check', 'Last error', 'Advice'],
        w.r7.map((m) => [
          m.mailboxId,
          m.name,
          m.failingSince,
          m.consecutiveFailures,
          m.nextCheckAt,
          m.error,
          m.advice,
        ]),
      ),
    );

    L.push('### R8 · Token credit (optional, default skip)', '');
    L.push(
      BigInt(w.r8.tokens) > 0n
        ? `${w.r8.translatedMessages} non-prospect message(s) were translated; ${w.r8.billedTranslations} of them were billed, ` +
            `${w.r8.tokens} token(s) in total (attributed by time: a translation debit within 2 minutes before the message was translated). ` +
            'Approving credits them back as a ledgered adjustment.'
        : `${w.r8.translatedMessages} non-prospect message(s) were translated; no billed token debit was found for them. Nothing to credit.`,
      '',
    );

    L.push('### Checks now (after an apply these read 0, except rows you keep)', '');
    L.push(
      ...table(
        ['Check', 'Now'],
        (Object.keys(CHECK_LABELS) as Array<keyof MailChecks>).map((k) => [
          CHECK_LABELS[k],
          w.checks[k],
        ]),
      ),
    );
  }
  return L.join('\n');
}

export function renderApplyMarkdown(result: ApplyResult, plan: MailPlan): string {
  const L: string[] = [];
  L.push(`# Remediation ${plan.script} · ${plan.module}: apply`, '');
  L.push(`- Batch: \`${result.runId}\``);
  L.push(`- Status: **${result.status}**${result.error ? ` (${result.error})` : ''}`);
  L.push(`- Rows changed: ${result.totalChanged}`, '');
  L.push(
    ...table(
      ['Category', 'Selected', 'Changed', 'Skipped (changed meanwhile)'],
      Object.entries(result.categories).map(([k, c]) => [k, c.selected, c.changed, c.skipped]),
    ),
  );
  if (result.post) {
    L.push('## Post-apply checks', '');
    L.push(
      ...table(
        ['Check', 'Count'],
        (Object.keys(CHECK_LABELS) as Array<keyof MailChecks>).map((k) => [
          CHECK_LABELS[k],
          result.post![k],
        ]),
      ),
    );
    L.push(
      `Kept by decision: ${result.keptByDecision.r1a} R1a suppression(s), ${result.keptByDecision.r3} R3 contact(s).`,
      '',
    );
  }
  if (result.decisions.overrides.length > 0) {
    L.push(
      '## Decisions that differ from the default',
      '',
      ...result.decisions.overrides.map((o) => `- ${o}`),
      '',
    );
  }
  if (result.decisions.missing.length > 0) {
    L.push(
      '## Rows without a decision (left alone)',
      '',
      ...result.decisions.missing.map((o) => `- ${o}`),
      '',
    );
  }
  return L.join('\n');
}

export function renderRevertMarkdown(result: RevertResult): string {
  const L: string[] = [];
  L.push(`# Remediation revert`, '');
  L.push(`- Batch: \`${result.runId}\``);
  L.push(`- Status: **${result.status}**`);
  L.push(`- Rows restored: ${result.reverted}`, '');
  L.push(
    ...table(
      ['Category', 'Restored'],
      Object.entries(result.byCategory).map(([k, n]) => [k, n]),
    ),
  );
  if (result.conflicts.length > 0) {
    L.push('## Left as they are (changed since the apply)', '');
    L.push(
      ...table(
        ['Log id', 'Category', 'Table', 'Row', 'Reason'],
        result.conflicts.map((c) => [c.logId, c.category, c.table, c.rowId, c.reason]),
      ),
    );
  }
  return L.join('\n');
}
