// DS-09 (absorbs ia:F-11): the signal meaning map and the label maps.
//
// Every value an operator sees has exactly one label and one tone:
//   - every pgEnum's enumValues, REPLY_CLASSES, followUpStatus, the
//     notification-kind registry, knowledge_sources.external_status and the
//     other text-column registries match TONE_MAPS (tone.ts) and LABEL_MAPS
//     (labels.ts) key for key: an unlabelled value fails here as well as
//     in typecheck;
//   - every audit and usage kind has a label, and the kinds written
//     straight into audit_log / the demo seed are registered;
//   - the semantics the design proposal fixes (§6.2) hold;
//   - nothing renders a raw code: labels and the fallback carry no
//     underscores or dots.
// The type-level half (an unregistered notify() kind or a map missing a
// value fails typecheck) is src/tests/signals.types.test.ts; the
// components are signals-components.test.ts; the pages are
// e2e/signals.spec.ts.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as schema from '@/lib/db/schema';
import { followUpSkipReason, followUpStatus } from '@/lib/db/schema/follow-ups';
import { knowledgeSourceExternalStatus } from '@/lib/db/schema/documents';
import { outreachDraftMethods } from '@/lib/db/schema/outreach';
import { qualificationMethods } from '@/lib/db/schema/qualifications';
import { PLATFORM_AUDIT_KINDS } from '@/lib/audit-scope';
import { WORKSPACE_PLANS } from '@/lib/billing/plans';
import { AUDIT_KINDS, LEGACY_AUDIT_KINDS, isLabelledAuditKind } from '@/lib/kinds/audit';
import { NOTIFICATION_KINDS, isNotificationKind } from '@/lib/kinds/notification';
import {
  AI_USAGE_KINDS,
  LEGACY_USAGE_KINDS,
  USAGE_KEY_SOURCES,
  USAGE_KINDS,
  isLabelledUsageKind,
} from '@/lib/kinds/usage';
import { REPLY_CLASSES } from '@/lib/mail/reply-classes';
import { GEO_STATUSES } from '@/lib/services/geo';
import { HEALTH_FINDING_SEVERITIES } from '@/lib/services/health-check';
import { HINT_SEVERITIES } from '@/lib/services/hints';
import {
  AUDIT_KIND_LABEL,
  LABEL_MAPS,
  USAGE_KIND_LABEL,
  auditKindLabel,
  auditKindOptions,
  humanizeCode,
  labelFor,
  signalFor,
  usageKindLabel,
} from '@/lib/ui/labels';
import {
  PIPELINE_PROGRESS,
  PULSE_VALUES,
  REPLY_TRIAGE_TRUSTED,
  SEQUENCE_STEPS,
  TONES,
  TONE_MAPS,
  healthScoreTone,
  sequenceStep,
  type SignalSet,
} from '@/lib/ui/tone';
import { loadCssFile, rootTokens } from './helpers/css-cascade';

const ROOT = path.resolve(__dirname, '..', '..');

/** Every pgEnum the schema exports, by SQL name. */
function schemaEnums(): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const value of Object.values(schema)) {
    const e = value as unknown as { enumName?: unknown; enumValues?: unknown };
    if (
      typeof value === 'function' &&
      typeof e.enumName === 'string' &&
      Array.isArray(e.enumValues)
    ) {
      out.set(e.enumName, e.enumValues as string[]);
    }
  }
  return out;
}

/** The text-column registries, by the set name they have in TONE_MAPS. */
const REGISTRIES: Readonly<Record<string, readonly string[]>> = {
  reply_class: REPLY_CLASSES,
  follow_up_status: followUpStatus,
  follow_up_skip_reason: followUpSkipReason,
  notification_kind: NOTIFICATION_KINDS,
  knowledge_external_status: knowledgeSourceExternalStatus,
  qualification_method: qualificationMethods,
  outreach_draft_method: outreachDraftMethods,
  geo_status: GEO_STATUSES,
  health_finding_severity: HEALTH_FINDING_SEVERITIES,
  hint_severity: HINT_SEVERITIES,
  workspace_plan: WORKSPACE_PLANS,
  usage_key_source: USAGE_KEY_SOURCES,
};

const sorted = (xs: Iterable<string>) => [...xs].sort();

/** A label that is still a code: snake_case, dotted, or a shouted word
 *  (APPROVED); short acronyms such as AI are words. */
const RAW_CODE = /[_.]|^[A-Z]{4,}$/;

describe('every value set is mapped exactly (tone.ts, labels.ts)', () => {
  const enums = schemaEnums();

  it('finds the schema enums', () => {
    // 29 today; the check below covers however many there are.
    expect(enums.size).toBeGreaterThanOrEqual(29);
  });

  it.each([...schemaEnums().keys()].sort())('pgEnum %s', (name) => {
    const values = enums.get(name)!;
    expect(Object.keys(TONE_MAPS), `TONE_MAPS lacks the ${name} set`).toContain(name);
    expect(Object.keys(LABEL_MAPS), `LABEL_MAPS lacks the ${name} set`).toContain(name);
    expect(sorted(Object.keys(TONE_MAPS[name as SignalSet]))).toEqual(sorted(values));
    expect(sorted(Object.keys(LABEL_MAPS[name as SignalSet]))).toEqual(sorted(values));
  });

  it.each(Object.keys(REGISTRIES).sort())('registry %s', (name) => {
    const values = REGISTRIES[name]!;
    expect(sorted(Object.keys(TONE_MAPS[name as SignalSet]))).toEqual(sorted(values));
    expect(sorted(Object.keys(LABEL_MAPS[name as SignalSet]))).toEqual(sorted(values));
  });

  it('maps no set that is neither a pgEnum nor a registry', () => {
    const known = sorted([...enums.keys(), ...Object.keys(REGISTRIES)]);
    expect(sorted(Object.keys(TONE_MAPS))).toEqual(known);
    expect(sorted(Object.keys(LABEL_MAPS))).toEqual(known);
  });

  it('uses only the eight tones', () => {
    for (const [set, map] of Object.entries(TONE_MAPS)) {
      for (const [value, tone] of Object.entries(map)) {
        expect(TONES, `${set}.${value}`).toContain(tone);
      }
    }
  });

  it('gives every value a readable label, unique within its set', () => {
    for (const [set, map] of Object.entries(LABEL_MAPS)) {
      const labels = Object.values(map) as string[];
      for (const label of labels) {
        expect(label.trim(), `${set}: empty label`).not.toBe('');
        expect(label, `${set}: "${label}" reads like a code`).not.toMatch(RAW_CODE);
        expect(label[0], `${set}: "${label}" is not sentence case`).toBe(label[0]!.toUpperCase());
      }
      expect(new Set(labels).size, `${set} has two values with one label`).toBe(labels.length);
    }
  });

  it('pulses only values of their own set', () => {
    for (const [set, values] of Object.entries(PULSE_VALUES)) {
      for (const v of values ?? []) {
        expect(Object.keys(TONE_MAPS[set as SignalSet])).toContain(v);
      }
    }
  });
});

describe('the meaning map (design proposal §6.2)', () => {
  it('a stage is never coloured, and closing reads neutral', () => {
    for (const tone of Object.values(TONE_MAPS.outreach_stage)) expect(tone).toBe('neutral');
    expect(signalFor('outreach_stage', 'closing').tone).toBe('neutral');
    expect(labelFor('outreach_stage', 'discovery')).toBe('First contact');
  });

  it('only a win is coloured among close reasons, and never red', () => {
    for (const [reason, tone] of Object.entries(TONE_MAPS.close_reason)) {
      expect(tone, reason).toBe(reason === 'won' ? 'success' : 'neutral');
    }
  });

  it('a health score of 78 and a warning finding read amber', () => {
    expect(healthScoreTone(78)).toBe('attention');
    expect(healthScoreTone(80)).toBe('success');
    expect(healthScoreTone(50)).toBe('attention');
    expect(healthScoreTone(49)).toBe('danger');
    expect(signalFor('health_finding_severity', 'warning').tone).toBe('attention');
    expect(signalFor('health_finding_severity', 'info').tone).toBe('neutral');
  });

  it('review states: amber only where a decision waits', () => {
    expect(TONE_MAPS.review_item_state).toMatchObject({
      new: 'neutral',
      needs_review: 'attention',
      approved: 'success',
      rejected: 'danger',
      ignored: 'muted',
      archived: 'muted',
    });
    expect(labelFor('review_item_state', 'needs_review')).toBe('Needs review');
  });

  it('pipeline progress is info (shown by position), closed and raw are neutral', () => {
    for (const state of PIPELINE_PROGRESS) expect(TONE_MAPS.pipeline_state[state]).toBe('info');
    expect(TONE_MAPS.pipeline_state.closed).toBe('neutral');
    expect(TONE_MAPS.pipeline_state.raw_discovered).toBe('neutral');
    // The funnel's rows are exactly the progress states, in order.
    expect([...PIPELINE_PROGRESS]).toEqual(
      schema.pipelineState.enumValues.filter((s) => s !== 'raw_discovered' && s !== 'closed'),
    );
  });

  it('roles, plans and kinds are neutral', () => {
    for (const set of ['workspace_member_role', 'user_role', 'workspace_plan'] as const) {
      for (const tone of Object.values(TONE_MAPS[set])) expect(tone).toBe('neutral');
    }
  });

  it('notification kinds follow the map: decisions amber, failures red, AI violet', () => {
    expect(TONE_MAPS.notification_kind).toMatchObject({
      'review.needs_review': 'attention',
      'follow_up.awaiting_approval': 'attention',
      'health.warning': 'attention',
      'run.failed': 'danger',
      'tokens.auto_topup_failed': 'danger',
      'lead.replied': 'info',
      'learning.synthesis': 'ai',
      'tokens.auto_topup': 'success',
    });
  });
});

describe('signalFor, labelFor and the fallback', () => {
  it('resolves a known value', () => {
    expect(signalFor('review_item_state', 'needs_review')).toEqual({
      label: 'Needs review',
      tone: 'attention',
      pulse: false,
    });
  });

  it('pulses running processes only', () => {
    expect(signalFor('connector_run_status', 'running')).toMatchObject({
      tone: 'live',
      pulse: true,
    });
    expect(signalFor('connector_run_status', 'succeeded').pulse).toBe(false);
  });

  it('carries descriptions where the set has them', () => {
    expect(signalFor('workspace_member_role', 'viewer').description).toMatch(/changes nothing/);
    expect(signalFor('review_item_state', 'new').description).toBeUndefined();
  });

  it('reads an unknown value (an older row) as neutral words, never the code', () => {
    const s = signalFor('notification_kind', 'tokens.renewal_due');
    expect(s).toEqual({ label: 'Tokens renewal due', tone: 'neutral', pulse: false });
    expect(labelFor('follow_up_status', 'on_hold')).toBe('On hold');
  });

  it('keeps reply classes neutral and marked auto until triage is trusted', () => {
    expect(REPLY_TRIAGE_TRUSTED).toBe(false);
    const s = signalFor('reply_class', 'positive');
    expect(s.tone).toBe('neutral');
    expect(s.label).toBe('Positive · auto');
    expect(s.description).toMatch(/not verified/);
  });

  it('humanizeCode never returns underscores, dots or an empty string', () => {
    for (const code of ['needs_review', 'follow_up.awaiting_approval', 'a-b:c/d', '___', '']) {
      const out = humanizeCode(code);
      expect(out).not.toMatch(/[_.]/);
      expect(out.length).toBeGreaterThan(0);
    }
    expect(humanizeCode('mail.bounce_loop')).toBe('Mail bounce loop');
  });
});

describe('audit and usage kinds (src/lib/kinds)', () => {
  it('every audit kind, current or legacy, has a label and nothing else does', () => {
    expect(sorted(Object.keys(AUDIT_KIND_LABEL))).toEqual(
      sorted([...AUDIT_KINDS, ...LEGACY_AUDIT_KINDS]),
    );
    expect(new Set(AUDIT_KINDS).size).toBe(AUDIT_KINDS.length);
    expect(
      AUDIT_KINDS.filter((k) => (LEGACY_AUDIT_KINDS as readonly string[]).includes(k)),
    ).toEqual([]);
  });

  it('every usage kind, current or legacy, has a label and nothing else does', () => {
    expect(sorted(Object.keys(USAGE_KIND_LABEL))).toEqual(
      sorted([...USAGE_KINDS, ...LEGACY_USAGE_KINDS]),
    );
    for (const k of AI_USAGE_KINDS) expect(USAGE_KINDS).toContain(k);
    expect(new Set(USAGE_KINDS).size).toBe(USAGE_KINDS.length);
  });

  it('labels kinds in words, one label per kind', () => {
    for (const map of [AUDIT_KIND_LABEL, USAGE_KIND_LABEL]) {
      const labels = Object.values(map) as string[];
      for (const label of labels) expect(label).not.toMatch(RAW_CODE);
      expect(new Set(labels).size).toBe(labels.length);
    }
    expect(usageKindLabel('ai.assistant')).toBe('Assistant questions');
    expect(auditKindLabel('review.approved')).toBe('Record approved');
    expect(auditKindLabel('legacy.thing_done')).toBe('Legacy thing done');
  });

  it('platform audit kinds are registered audit kinds', () => {
    for (const k of PLATFORM_AUDIT_KINDS) expect(isLabelledAuditKind(k), k).toBe(true);
  });

  it('the kind filter lists each kind once, by label', () => {
    expect(auditKindOptions(['review.approved', 'contact.create', 'review.approved'])).toEqual([
      { kind: 'contact.create', label: 'Contact added' },
      { kind: 'review.approved', label: 'Record approved' },
    ]);
  });
});

// ---- Kinds written outside the typed producers ----------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'tests') continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** The text from an opening ( or [ at `open` to its matching closer. */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** Literal `kind:` values of the objects at the top level of `region` (not payloads). */
function topLevelKinds(region: string): string[] {
  const kinds: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < region.length; i++) {
    const ch = region[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (depth === 1 && region.startsWith('kind:', i) && !/[\w.$]/.test(region[i - 1] ?? '')) {
      const m = /^kind:\s*'([^']+)'/.exec(region.slice(i));
      if (m) kinds.push(m[1]!);
    }
  }
  return kinds;
}

/** Literal top-level kinds in every region that starts at a match of `opener` (ending in ( or [). */
function kindsAt(src: string, opener: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(opener)) {
    const open = m.index! + m[0].length - 1;
    out.push(...topLevelKinds(balanced(src, open)));
  }
  return out;
}

const SOURCES = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))].map(
  (full) => ({
    rel: path.relative(ROOT, full).split(path.sep).join('/'),
    src: readFileSync(full, 'utf8'),
  }),
);
const SEED = readFileSync(path.join(ROOT, 'scripts', 'seed-demo.ts'), 'utf8');

describe('kinds written straight into the tables are registered', () => {
  it('every literal kind inserted into audit_log (in-transaction writes, remediation, seed)', () => {
    const written: Array<{ rel: string; kind: string }> = [];
    for (const f of SOURCES) {
      const kinds = [
        ...kindsAt(f.src, /\.insert\((?:s\.)?auditLog\)\s*\.values\(/g),
        ...kindsAt(f.src, /(?<!function )\bauditInTx\(/g),
        ...kindsAt(f.src, /\bconst audit: s\.NewAuditLogEntry\[\] = \[/g),
        ...kindsAt(f.src, /\baudit\.push\(/g),
      ];
      written.push(...kinds.map((kind) => ({ rel: f.rel, kind })));
    }
    // The scan must see the known direct writers, or it proves nothing.
    expect(written.map((w) => w.kind)).toEqual(
      expect.arrayContaining(['pipeline.transition', 'workspace.bootstrap', 'remediation.revert']),
    );
    expect(written.filter((w) => w.rel === 'scripts/seed-demo.ts').length).toBeGreaterThan(20);
    const unknown = written.filter((w) => !isLabelledAuditKind(w.kind));
    expect(unknown).toEqual([]);
  });

  it('every notification kind the demo seed writes', () => {
    const kinds = kindsAt(SEED, /\.insert\(s\.notifications\)\s*\.values\(/g);
    expect(kinds.length).toBeGreaterThan(10);
    expect(kinds.filter((k) => !isNotificationKind(k))).toEqual([]);
  });

  it('every usage kind the demo seed writes', () => {
    const kinds = [
      ...kindsAt(SEED, /\bconst USAGE_KINDS: [^=]+= \[/g),
      ...kindsAt(SEED, /\busageRows\.push\(/g),
    ];
    expect(kinds.length).toBeGreaterThan(10);
    expect(kinds.filter((k) => !isLabelledUsageKind(k))).toEqual([]);
  });
});

describe('the one-hue sequence ramp', () => {
  it('steps evenly from the first to the last row', () => {
    expect(PIPELINE_PROGRESS.map((_, i) => sequenceStep(i, PIPELINE_PROGRESS.length))).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(sequenceStep(0, 1)).toBe(1);
    expect(sequenceStep(0, 3)).toBe(1);
    expect(sequenceStep(2, 3)).toBe(SEQUENCE_STEPS);
    expect(sequenceStep(99, 3)).toBe(SEQUENCE_STEPS);
  });

  it('every step is the primary hue at a falling opacity (tokens.css)', () => {
    const tokens = rootTokens(loadCssFile('src/styles/tokens.css'));
    expect(tokens.get('--seq-1')).toBe('var(--primary)');
    let last = 100;
    for (let n = 2; n <= SEQUENCE_STEPS; n++) {
      const m = /^color-mix\(in oklab, var\(--primary\) (\d+)%, transparent\)$/.exec(
        tokens.get(`--seq-${n}`) ?? '',
      );
      expect(m, `--seq-${n}`).not.toBeNull();
      const pct = Number(m![1]);
      expect(pct).toBeLessThan(last);
      last = pct;
    }
    expect(last).toBe(40);
    expect(tokens.has(`--seq-${SEQUENCE_STEPS + 1}`)).toBe(false);
  });
});
