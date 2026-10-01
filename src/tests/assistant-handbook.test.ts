// The assistant handbook must describe the product as it is TODAY. These
// tests pin its shape: no retired false claims, every [/path] is a real
// page, every sidebar route is covered, the facts that the audit found
// wrong are stated correctly, every "Known limitations" line names its
// issue, and every behavioural claim tag {H-xx} is pinned by a passing
// "[handbook H-xx]" test (see handbook-claims.test.ts).
//
// Pure file/string checks — no database.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  HANDBOOK_SOURCE,
  KNOWN_LIMITATIONS_HEADING,
  PLATFORM_HANDBOOK,
  handbookClaimTags,
  stripClaimTags,
} from '@/lib/assistant/handbook';
import { BRAND_NAME } from '@/lib/brand';
import { NAV_ROUTES } from '@/components/nav-routes';
import { closeReason, pipelineState } from '@/lib/db/schema/pipeline';
import type { ReplyClass } from '@/lib/services/reply-classifier';

const SRC = path.resolve(__dirname, '..');
const APP = path.join(SRC, 'app');
const TESTS = path.join(SRC, 'tests');

// Compile-time exhaustive: adding or removing a ReplyClass breaks the
// typecheck here, so the handbook list can't silently drift.
const REPLY_CLASSES: Record<ReplyClass, true> = {
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

describe('assistant handbook — content truth', () => {
  it('is titled with the brand name and never uses the old working title', () => {
    expect(HANDBOOK_SOURCE.startsWith(`# ${BRAND_NAME} — how it works`)).toBe(true);
    expect(BRAND_NAME).toBe('Leadsonar');
    expect(HANDBOOK_SOURCE).not.toContain('Lead Discovery Platform');
  });

  it('contains none of the retired false claims', () => {
    for (const phrase of [
      'EVERY draft needs human approval',
      'replacing a file',
      'holds them for manual review',
      'Approvals become contactable leads',
      'approved records become',
      'fire when a cold email gets no reply',
    ]) {
      expect(flat(HANDBOOK_SOURCE).toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  it('has an Autopilot section that covers /autopilot and the duplicate switches on /connectors/engine', () => {
    const autopilot = section(HANDBOOK_SOURCE, '## Autopilot');
    expect(autopilot).not.toBe('');
    expect(autopilot).toContain('[/autopilot]');
    expect(autopilot).toContain('[/connectors/engine]');
    const f = flat(autopilot);
    // Both pause switches, and what each one really stops.
    expect(f).toContain('stops autopilot runs only');
    expect(f).toContain('[/mailbox/queue]) stops the send queue only');
    expect(f).toContain('every 5 minutes');
    expect(f).toContain('Starter and Pro');
  });

  it('names every reply class', () => {
    for (const cls of Object.keys(REPLY_CLASSES)) {
      expect(HANDBOOK_SOURCE).toMatch(new RegExp(`(^|[^a-z_])${cls}([^a-z_]|$)`, 'm'));
    }
  });

  it('lists the full pipeline stage list in order, including contact_identified and closed', () => {
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

  it('gives the real language order: lead, recipe, workspace default, product, workspace native', () => {
    const f = flat(HANDBOOK_SOURCE);
    const start = f.indexOf('"Emails in the wrong language"');
    expect(start).toBeGreaterThan(-1);
    const bullet = f.slice(start, f.indexOf('"Everything is paused"', start));
    const order = [
      "the lead's own language",
      "the recipe's Language",
      'the workspace default outreach language',
      "the product's language",
      'the workspace native language',
    ].map((needle) => bullet.indexOf(needle));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("puts 'send caps' next to /mailbox/queue, never next to /settings/outreach", () => {
    const at = occurrences(HANDBOOK_SOURCE, 'send caps');
    expect(at.length).toBeGreaterThan(0);
    for (const i of at) {
      expect(window(HANDBOOK_SOURCE, i, 120)).toContain('[/mailbox/queue]');
      expect(window(HANDBOOK_SOURCE, i, 400)).not.toContain('/settings/outreach');
    }
  });

  it("never points reply 'auto-actions' at /settings/outreach (they cannot be configured there)", () => {
    const at = occurrences(HANDBOOK_SOURCE, 'auto-actions');
    expect(at.length).toBeGreaterThan(0);
    for (const i of at) {
      expect(window(HANDBOOK_SOURCE, i, 400)).not.toContain('/settings/outreach');
    }
  });

  it('carries an issue id on every Known-limitations line, incl. the Phase 0 blockers', () => {
    const idx = HANDBOOK_SOURCE.indexOf(KNOWN_LIMITATIONS_HEADING);
    expect(idx).toBeGreaterThan(-1);
    const body = section(HANDBOOK_SOURCE, KNOWN_LIMITATIONS_HEADING)
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '');
    expect(body.length).toBeGreaterThan(0);
    for (const line of body) {
      expect(line).toMatch(/(I|X)\d+/);
      expect(line).toMatch(/^- (I\d{3}|X\d+): /);
    }
    const ids = body.map((l) => /^- ((?:I|X)\d+):/.exec(l)![1]);
    for (const required of ['I001', 'I002', 'I005', 'X1', 'I073']) {
      expect(ids).toContain(required);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('assistant handbook — links', () => {
  it('every [/path] is a static page under src/app that the assistant panel can link', () => {
    const paths = bracketPaths(HANDBOOK_SOURCE);
    expect(paths.length).toBeGreaterThan(30);
    for (const p of new Set(paths)) {
      // AssistantPanel only links /[a-z0-9/-]; a dynamic segment such as
      // /pipeline/[id] would render as a broken link.
      expect(p, `${p} is not a plain static path`).toMatch(/^\/[a-z0-9/-]*$/);
      expect(p.startsWith('/api'), `${p} is an API route`).toBe(false);
      expect(p.startsWith('/admin'), `${p} is super-admin only`).toBe(false);
      const page = path.join(APP, ...p.split('/').filter(Boolean), 'page.tsx');
      expect(fs.existsSync(page), `${p} → ${page} does not exist`).toBe(true);
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

  it('mentions every tenant sidebar route, including the hidden follow-ups page', () => {
    const paths = new Set(bracketPaths(HANDBOOK_SOURCE));
    const tenantRoutes = NAV_ROUTES.filter((r) => !r.superAdminOnly).map((r) => r.href);
    expect(tenantRoutes).toContain('/communication/follow-ups');
    const missing = tenantRoutes.filter((href) => !paths.has(href));
    expect(missing).toEqual([]);
  });

  it('covers the routes the audit found missing (I134)', () => {
    const paths = new Set(bracketPaths(HANDBOOK_SOURCE));
    for (const href of [
      '/inbox',
      '/dashboard',
      '/autopilot',
      '/contacts',
      '/health',
      '/onboarding',
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
    ]) {
      expect(paths.has(href), href).toBe(true);
    }
    // The run log page is dynamic, so it is described, not linked.
    expect(flat(HANDBOOK_SOURCE)).toContain("one of its runs to see that run's log");
  });
});

describe('assistant handbook — claim tags', () => {
  it('the model never sees claim tags', () => {
    expect(PLATFORM_HANDBOOK).toBe(stripClaimTags(HANDBOOK_SOURCE));
    expect(PLATFORM_HANDBOOK).not.toMatch(/\{H-\d{2}\}/);
    expect(PLATFORM_HANDBOOK).toContain(KNOWN_LIMITATIONS_HEADING);
  });

  it('every claim tag in the narrative is pinned by a [handbook H-xx] test, and no pin is stale', () => {
    const tags = handbookClaimTags();
    expect(tags.length).toBeGreaterThanOrEqual(20);

    // Collect active test names (it/test, not .skip/.todo) across the suite.
    const pinned = new Set<string>();
    const nameRe = /\b(?:it|test)(\.(?:only|skip|todo|concurrent))?\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
    const files = listFiles(TESTS, (f) => f.endsWith('.test.ts'));
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(nameRe)) {
        if (m[1] === '.skip' || m[1] === '.todo') continue;
        for (const t of m[3]!.matchAll(/\[handbook (H-\d{2})\]/g)) pinned.add(t[1]!);
      }
    }
    const unpinned = tags.filter((t) => !pinned.has(t));
    expect(unpinned, 'claims without a [handbook H-xx] test').toEqual([]);
    const stale = [...pinned].filter((t) => !tags.includes(t));
    expect(stale, 'tests pinning a claim the handbook no longer makes').toEqual([]);
  });
});
