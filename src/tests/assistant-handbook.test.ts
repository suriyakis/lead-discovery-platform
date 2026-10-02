// The assistant handbook must describe the product as it is TODAY. These
// tests pin its shape: no retired false claims, every [/path] is a real
// page, every registered workspace page is in the generated screens
// index, the facts that the audit found wrong are stated correctly (and
// generated from the code that holds them), every "Known limitations"
// line names its issue, every behavioural claim tag {H-xx} is pinned by a
// passing "[handbook H-xx]" test (see handbook-claims.test.ts), and
// docs/USER_GUIDE.md is the export of exactly this text (AP-01, AP-03).
//
// Pure file/string checks — no database.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  HANDBOOK_SOURCE,
  HANDBOOK_VERSION,
  KNOWN_LIMITATIONS,
  KNOWN_LIMITATIONS_HEADING,
  PLATFORM_HANDBOOK,
  buildHandbookSource,
  handbookClaimTags,
  handbookVersion,
  stripClaimTags,
} from '@/lib/assistant/handbook';
import {
  billingBlock,
  billingFactsFromEnv,
  documentedBillingFacts,
  screensIndex,
} from '@/lib/assistant/handbook/generated';
import { renderUserGuide, USER_GUIDE_PATH } from '@/lib/assistant/handbook/user-guide';
import { AUTOPILOT_STEPS } from '@/lib/autopilot/steps';
import { BRAND_NAME } from '@/lib/brand';
import { closeReason, pipelineState } from '@/lib/db/schema/pipeline';
import { LANGUAGE_PRECEDENCE } from '@/lib/i18n/language-precedence';
import { REPLY_CLASSES } from '@/lib/mail/reply-classes';
import { routeTable } from '@/lib/nav/route-table';
import type { ReplyClass } from '@/lib/services/reply-classifier';
import { appRouteFiles } from '../../e2e/routes';

const SRC = path.resolve(__dirname, '..');
const APP = path.join(SRC, 'app');
const TESTS = path.join(SRC, 'tests');
const ROOT = path.resolve(SRC, '..');

// Compile-time exhaustive: the classifier's type and the handbook's list
// share REPLY_CLASSES, so adding a class breaks the typecheck here.
const EVERY_REPLY_CLASS: Record<ReplyClass, true> = {
  positive: true,
  redirect: true,
  question: true,
  interest: true,
  doc_request: true,
  negative: true,
  out_of_office: true,
  bounce: true,
  unsubscribe: true,
  irrelevant: true,
};

/** Body of a "## Heading…" section, up to the next "## " heading. */
function section(text: string, headingPrefix: string): string {
  const start = text.indexOf(`\n${headingPrefix}`);
  if (start === -1) return '';
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}

function window(text: string, at: number, radius: number): string {
  return text.slice(Math.max(0, at - radius), at + radius);
}

/** Collapse line wrapping so multi-line prose can be matched as one run. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function bracketPaths(text: string): string[] {
  return [...text.matchAll(/\[(\/[^\]\s]*)\]/g)].map((m) => m[1]!);
}

function listFiles(dir: string, pred: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, pred));
    else if (pred(full)) out.push(full);
  }
  return out;
}

// Route pattern → page file. The workspace pages sit in the (app) route
// group (DS-07), so a URL is not a file path.
const PAGE_FILES = appRouteFiles(APP);

/** The page file a static path or src/app pattern stands for. */
function pageFileFor(p: string): string {
  return PAGE_FILES.get(p) ?? path.join(APP, ...p.split('/').filter(Boolean), 'page.tsx');
}

describe('assistant handbook — content truth', () => {
  it('is titled with the brand name and never uses the old working title', () => {
    expect(HANDBOOK_SOURCE.startsWith(`# ${BRAND_NAME} — how it works`)).toBe(true);
    expect(BRAND_NAME).toBe('Leadsonar');
    expect(HANDBOOK_SOURCE).not.toMatch(/Lead\s+Discovery\s+Platform/i);
  });

  it('contains none of the retired false claims', () => {
    for (const phrase of [
      'EVERY draft needs human approval',
      'replacing a file',
      'holds them for manual review',
      'Approvals become contactable leads',
      'approved records become',
      'fire when a cold email gets no reply',
      'sidebar → Account',
    ]) {
      expect(flat(HANDBOOK_SOURCE).toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  it('has an Autopilot section that covers /autopilot and the read-only status on /connectors/engine', () => {
    const autopilot = section(HANDBOOK_SOURCE, '## Autopilot');
    expect(autopilot).not.toBe('');
    expect(autopilot).toContain('[/autopilot]');
    expect(autopilot).toContain('[/connectors/engine]');
    const f = flat(autopilot);
    // PC-13 (I019, I020, I062): no dead switches, narrow-only overrides,
    // the Crawl Engine panel is read-only.
    expect(f).toContain('shows the autopilot steps read-only');
    expect(f).toContain('only narrow what the workspace runs');
    expect(f).not.toMatch(/Auto-drain|Sync inbound mail|Auto-send replies/);
    // PC-05: one pause for the whole workspace replaced the two
    // Emergency pause switches; anyone who can edit pauses, owners and
    // admins resume.
    expect(f).toContain(
      '"Pause all automation" (on [/autopilot] and [/mailbox/queue]; anyone who can edit, never blocked by the plan or an empty wallet)',
    );
    expect(f).toContain('Only owners and admins resume');
    expect(f).not.toContain('Emergency pause');
    // …and the sidebar's interim Emergency stop (DS-05, ia:F-10) leads to it.
    expect(f).toContain('"Emergency stop" at the foot of the sidebar');
    expect(f).toContain('every 5 minutes');
    expect(f).toContain('Starter and Pro');
  });

  it('names every reply class, generated from REPLY_CLASSES (I133)', () => {
    expect(Object.keys(EVERY_REPLY_CLASS).sort()).toEqual([...REPLY_CLASSES].sort());
    const replies = flat(section(HANDBOOK_SOURCE, '## Replies'));
    expect(replies).toContain(
      `gets a class: ${REPLY_CLASSES.slice(0, -1).join(', ')} or ${REPLY_CLASSES.at(-1)}.`,
    );
  });

  it('lists the full pipeline stage list in order, generated from the enum', () => {
    const m = /Stages, in order: ([^;]+);/.exec(flat(HANDBOOK_SOURCE));
    expect(m).not.toBeNull();
    const listed = m![1]!.split('→').map((s) => s.trim());
    expect(listed).toEqual(pipelineState.enumValues.filter((s) => s !== 'closed'));
    expect(listed).toContain('contact_identified');
    expect(flat(HANDBOOK_SOURCE)).toContain('any stage can move to closed');
    for (const reason of closeReason.enumValues) {
      expect(flat(HANDBOOK_SOURCE)).toContain(reason);
    }
  });

  it('gives the language order the resolver walks: lead, recipe, workspace default, product, workspace native (I132)', () => {
    expect(LANGUAGE_PRECEDENCE.map((t) => t.source)).toEqual([
      'lead',
      'recipe',
      'workspace_default',
      'product',
      'workspace',
      'default',
    ]);
    const f = flat(HANDBOOK_SOURCE);
    const start = f.indexOf('"Emails in the wrong language"');
    expect(start).toBeGreaterThan(-1);
    const bullet = f.slice(start, f.indexOf('"Everything is paused"', start));
    const order = LANGUAGE_PRECEDENCE.filter((t) => t.source !== 'default').map((t) =>
      bullet.indexOf(t.label),
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(bullet).toContain('otherwise English.');
  });

  it('lists the autopilot steps in run order, from AUTOPILOT_STEPS', () => {
    const autopilot = section(HANDBOOK_SOURCE, '## Autopilot');
    const at = AUTOPILOT_STEPS.map((s) => autopilot.indexOf(`- ${s.label}`));
    expect(at.every((i) => i > -1), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("puts 'send caps' next to /mailbox/queue, never next to /settings/outreach", () => {
    const at = occurrences(HANDBOOK_SOURCE, 'send caps');
    expect(at.length).toBeGreaterThan(0);
    for (const i of at) {
      expect(window(HANDBOOK_SOURCE, i, 120)).toContain('[/mailbox/queue]');
      expect(flat(window(HANDBOOK_SOURCE, i, 200))).toContain('owners and admins change them');
      expect(window(HANDBOOK_SOURCE, i, 400)).not.toContain('/settings/outreach');
    }
  });

  it('describes /settings/usage the way the page shows it, not as a cost breakdown', () => {
    const f = flat(HANDBOOK_SOURCE);
    expect(f).not.toContain('cost breakdown');
    expect(f).toContain('owners and admins also see the tokens charged');
  });

  // ia:F-03 (mail-safety, migration 0062) made the reply auto-actions
  // admin-only switches on /settings/outreach, off by default. This test
  // used to require the opposite; it flipped with that change.
  it("points every reply 'auto-action' at its switch on /settings/outreach", () => {
    const at = occurrences(HANDBOOK_SOURCE, 'auto-action');
    expect(at.length).toBeGreaterThan(0);
    for (const i of at) {
      expect(window(HANDBOOK_SOURCE, i, 400)).toContain('[/settings/outreach]');
    }
    const replies = flat(section(HANDBOOK_SOURCE, '## Replies'));
    expect(replies).toContain('Reply auto-actions are four switches on [/settings/outreach]');
    expect(replies).toContain('off unless an admin turns them on');
    // …and the retired "always on, no setting" claim is gone everywhere.
    const f = flat(HANDBOOK_SOURCE).toLowerCase();
    expect(f).not.toContain('always on and there is no setting');
    expect(f).not.toContain('auto-actions cannot be configured');
  });

  it('carries an issue id on every Known-limitations line, incl. the Phase 0 blockers', () => {
    const idx = HANDBOOK_SOURCE.indexOf(KNOWN_LIMITATIONS_HEADING);
    expect(idx).toBeGreaterThan(-1);
    const body = section(HANDBOOK_SOURCE, KNOWN_LIMITATIONS_HEADING)
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '');
    expect(body.length).toBe(KNOWN_LIMITATIONS.length);
    for (const line of body) {
      expect(line).toMatch(/^- (I\d{3}|X\d+): /);
    }
    const ids = KNOWN_LIMITATIONS.map((k) => k.id);
    for (const id of ids) expect(id).toMatch(/^(I\d{3}|X\d+)$/);
    for (const required of ['I001', 'I002', 'I005', 'X1', 'I073']) {
      expect(ids).toContain(required);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('assistant handbook — billing is the catalogue on sale (I181, AP-03 e)', () => {
  it("with STRIPE_PRICE_STARTER_DISPLAY='€35' and the Pro price id unset, shows €35, omits Pro and states the trial days", () => {
    const env = {
      STRIPE_PRICE_STARTER: 'price_starter_test',
      STRIPE_PRICE_STARTER_DISPLAY: '€35',
      STRIPE_TRIAL_DAYS: '7',
    };
    const billing = section(
      buildHandbookSource({ billing: billingFactsFromEnv(env) }),
      '## Tokens & billing',
    );
    const f = flat(billing);
    expect(f).toContain('Starter (€35)');
    expect(f).not.toContain('€29');
    expect(f).not.toContain('Pro (');
    expect(f).toContain('7-day free trial');
    // Packs whose price id is unset are not offered either.
    expect(f).toContain('No one-time token packs are on sale right now.');
  });

  it('uses the default trial length and lists only the packs on sale', () => {
    const f = flat(
      billingBlock(
        billingFactsFromEnv({
          STRIPE_PRICE_PRO: 'price_pro',
          STRIPE_PRICE_TOKENS_M: 'price_m',
        }),
      ),
    );
    expect(f).toContain('Pro (€99 / month) includes 13,000 tokens a month + unlimited products');
    expect(f).toContain('5-day free trial');
    expect(f).toContain('Pulse €49 → 5,500 tokens');
    expect(f).not.toContain('Ping');
    expect(f).not.toContain('Starter (');
  });

  it('says so when nothing is on sale, and a trial of 0 means no trial', () => {
    expect(flat(billingBlock(billingFactsFromEnv({})))).toContain(
      'No subscription plan is on sale right now',
    );
    expect(
      flat(billingBlock(billingFactsFromEnv({ STRIPE_PRICE_STARTER: 'p', STRIPE_TRIAL_DAYS: '0' }))),
    ).toContain('without a free trial');
  });

  it('the docs describe the default catalogue, whatever the machine env', () => {
    const f = flat(billingBlock(documentedBillingFacts()));
    expect(f).toContain('Starter (€29 / month)');
    expect(f).toContain('Pro (€99 / month)');
    expect(f).toContain('Ping €10 → 1,000, Pulse €49 → 5,500, Deep Dive €199 → 24,000 tokens');
    expect(f).toContain('These are the default prices');
  });
});

describe('assistant handbook — links', () => {
  it('every [/path] is a static page under src/app that the assistant panel can link (AP-03 a)', () => {
    const paths = bracketPaths(HANDBOOK_SOURCE);
    expect(paths.length).toBeGreaterThan(30);
    for (const p of new Set(paths)) {
      // AssistantPanel only links /[a-z0-9/-]; a dynamic segment such as
      // /pipeline/[id] would render as a broken link.
      expect(p, `${p} is not a plain static path`).toMatch(/^\/[a-z0-9/-]*$/);
      expect(p.startsWith('/api'), `${p} is an API route`).toBe(false);
      expect(p.startsWith('/admin'), `${p} is super-admin only`).toBe(false);
      expect(fs.existsSync(pageFileFor(p)), `${p} → ${pageFileFor(p)} does not exist`).toBe(true);
    }
  });

  it('writes every in-app path as a [/path] link (headings excepted)', () => {
    const bare: string[] = [];
    for (const line of HANDBOOK_SOURCE.split('\n')) {
      if (line.startsWith('#')) continue;
      for (const m of line.matchAll(/(?<![[\w\]])\/[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*/g)) {
        bare.push(`${m[0]}  (in: ${line.trim()})`);
      }
    }
    expect(bare).toEqual([]);
  });

  it('the screens index covers every workspace page the registry knows (AP-03 d)', () => {
    const screens = section(HANDBOOK_SOURCE, '## Where things are');
    expect(screens.trimEnd()).toBe(screensIndex());
    const linked = new Set(bracketPaths(screens));
    const missing: string[] = [];
    for (const r of routeTable().filter((x) => x.scope === 'tenant')) {
      if (r.href && !r.view) {
        if (!linked.has(r.href)) missing.push(r.href);
      } else if (r.view) {
        if (!screens.includes(`${r.label}, a view of [${r.pattern}]`)) missing.push(r.href!);
      } else if (!screens.includes(`${r.label} (from [${r.openedFrom}])`)) {
        missing.push(r.pattern);
      }
    }
    expect(missing).toEqual([]);
    // The console is for super-admins; the workspace guide leaves it out.
    expect(screens).not.toContain('/admin');
  });

  it('covers the routes the audit found missing (I134), at their current homes', () => {
    const paths = new Set(bracketPaths(HANDBOOK_SOURCE));
    for (const href of [
      '/today',
      '/autopilot',
      '/contacts',
      '/health',
      '/onboarding',
      '/notifications',
      '/products/autofill',
      '/products/new',
      '/mailbox/queue',
      '/mailbox/signatures',
      '/mailbox/suppression',
      '/mailbox/deliverability',
      '/settings/members',
      '/settings/crm',
      '/settings/audit',
      '/settings/account',
      '/support',
    ]) {
      expect(paths.has(href), href).toBe(true);
    }
    // The retired URLs only redirect now; the guide sends people to Today.
    expect(paths.has('/inbox')).toBe(false);
    expect(paths.has('/dashboard')).toBe(false);
    // The run log page is dynamic, so it is described, not linked.
    expect(flat(HANDBOOK_SOURCE)).toContain("one of its runs to see that run's log");
  });
});

/**
 * Claim tags in `tags` with no active "[handbook H-xx]" test among
 * `testSources`, and pins whose claim is gone.
 */
function claimCoverage(tags: ReadonlyArray<string>, testSources: ReadonlyArray<string>) {
  const pinned = new Set<string>();
  const nameRe = /\b(?:it|test)(\.(?:only|skip|todo|concurrent))?\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const src of testSources) {
    for (const m of src.matchAll(nameRe)) {
      if (m[1] === '.skip' || m[1] === '.todo') continue;
      for (const t of m[3]!.matchAll(/\[handbook (H-\d{2})\]/g)) pinned.add(t[1]!);
    }
  }
  return {
    unpinned: tags.filter((t) => !pinned.has(t)),
    stale: [...pinned].filter((t) => !tags.includes(t)),
  };
}

describe('assistant handbook — claim tags', () => {
  const testSources = listFiles(TESTS, (f) => f.endsWith('.test.ts')).map((f) =>
    fs.readFileSync(f, 'utf8'),
  );

  it('the model never sees claim tags', () => {
    expect(PLATFORM_HANDBOOK).toBe(stripClaimTags(HANDBOOK_SOURCE));
    expect(PLATFORM_HANDBOOK).not.toMatch(/\{H-\d{2}\}/);
    expect(PLATFORM_HANDBOOK).toContain(KNOWN_LIMITATIONS_HEADING);
  });

  it('every claim tag in the narrative is pinned by a [handbook H-xx] test, and no pin is stale', () => {
    const tags = handbookClaimTags();
    expect(tags.length).toBeGreaterThanOrEqual(20);
    const { unpinned, stale } = claimCoverage(tags, testSources);
    expect(unpinned, 'claims without a [handbook H-xx] test').toEqual([]);
    expect(stale, 'tests pinning a claim the handbook no longer makes').toEqual([]);
  });

  it("removing a claim's test fails the claims check (AP-03 h)", () => {
    const tags = handbookClaimTags();
    const victim = tags[0]!;
    const without = testSources.map((src) =>
      src.replaceAll(`[handbook ${victim}]`, '[handbook removed]'),
    );
    expect(claimCoverage(tags, without).unpinned).toEqual([victim]);
    // A pin whose claim was dropped from the handbook is reported too.
    expect(claimCoverage(tags.slice(1), testSources).stale).toEqual([victim]);
  });
});

describe('handbook version and the docs export (AP-03 f, g)', () => {
  it('HANDBOOK_VERSION is stable for identical inputs and changes with the text', () => {
    expect(HANDBOOK_VERSION).toMatch(/^hb-[0-9a-f]{12}$/);
    expect(HANDBOOK_VERSION).toBe(handbookVersion(stripClaimTags(buildHandbookSource())));
    const a = buildHandbookSource({ billing: documentedBillingFacts() });
    const b = buildHandbookSource({ billing: documentedBillingFacts() });
    expect(handbookVersion(a)).toBe(handbookVersion(b));
    const priced = buildHandbookSource({
      billing: billingFactsFromEnv({ STRIPE_PRICE_STARTER: 'p', STRIPE_PRICE_STARTER_DISPLAY: '€35' }),
    });
    expect(handbookVersion(priced)).not.toBe(handbookVersion(a));
  });

  it('docs/USER_GUIDE.md equals the export output — run `pnpm handbook:export` after a change', () => {
    const committed = fs.readFileSync(path.join(ROOT, USER_GUIDE_PATH), 'utf8');
    expect(committed).toBe(renderUserGuide());
  });

  it('the guide is the handbook for people: no claim tags, no stale working title, every page in its route table', () => {
    const guide = renderUserGuide();
    expect(guide).not.toMatch(/\{H-\d{2}\}/);
    expect(guide).not.toContain('signal/works');
    expect(guide).toContain(`# ${BRAND_NAME} — how it works`);
    expect(guide).toContain('## Route table');
    for (const r of routeTable()) expect(guide).toContain(`\`${r.href ?? r.pattern}\``);
  });
});
