// Regression tests for the follow-up card on /settings/outreach
// (deliverable ia:F-08, audit I114).
//
// Steps could not be removed: the page said "clear its days field", but
// every existing step input was `required` (and min=1), so the browser
// blocked the submit. Steps now have an explicit Remove box, the inputs are
// no longer required, and each step is one card whose days, instructions
// and Remove box post indexed fields, so the remaining steps keep their
// own instructions.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { db } from '@/lib/db/client';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
import { makeWorkspaceContext } from '@/lib/services/context';
import {
  loadSettings,
  updateFollowUpConfig,
  type FollowUpStepConfig,
} from '@/lib/services/follow-up';
import {
  STEP_REMOVE_FIELD,
  parseFollowUpForm,
  stepDaysField,
  stepInstrField,
} from '@/app/(app)/settings/outreach/follow-up-form';
import { saveFollowUp } from '@/app/(app)/settings/outreach/follow-up-actions';
import OutreachSettingsPage from '@/app/(app)/settings/outreach/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

function signInAs(userId: string): void {
  session.current = { user: { id: userId, role: 'member', accountStatus: 'active' } };
}

const FOUR_STEPS: FollowUpStepConfig[] = [
  { daysAfterPrev: 3, customInstructions: 'Mention the case study.' },
  { daysAfterPrev: 5, customInstructions: 'Offer a call.' },
  { daysAfterPrev: 7, customInstructions: '' },
  { daysAfterPrev: 14, customInstructions: 'Say goodbye kindly.' },
];

/**
 * The FormData the card posts: one entry per step card in page order,
 * then the empty "add a step" card, plus the ticked Remove boxes.
 */
function cardForm(
  steps: ReadonlyArray<{ days: string; instr?: string }>,
  opts: { remove?: number[]; add?: { days: string; instr?: string }; enabled?: boolean } = {},
): FormData {
  const fd = new FormData();
  if (opts.enabled ?? true) fd.set('followUpEnabled', 'on');
  fd.set('followUpRequireApproval', 'on');
  const cards = [...steps, opts.add ?? { days: '', instr: '' }];
  cards.forEach((c, i) => {
    fd.set(stepDaysField(i), c.days);
    fd.set(stepInstrField(i), c.instr ?? '');
  });
  for (const i of opts.remove ?? []) fd.append(STEP_REMOVE_FIELD, String(i));
  return fd;
}

function asCards(steps: ReadonlyArray<FollowUpStepConfig>): Array<{ days: string; instr?: string }> {
  return steps.map((s) => ({ days: String(s.daysAfterPrev), instr: s.customInstructions }));
}

describe('parseFollowUpForm', () => {
  it('removing step 2 of 4 keeps the other three in order with their own instructions', () => {
    const r = parseFollowUpForm(cardForm(asCards(FOUR_STEPS), { remove: [1] }));

    expect(r).toEqual({
      ok: true,
      value: {
        enabled: true,
        requireApproval: true,
        steps: [FOUR_STEPS[0], FOUR_STEPS[2], FOUR_STEPS[3]],
      },
    });
  });

  it('ignores the empty add card, and appends it with its instructions when filled', () => {
    const untouched = parseFollowUpForm(cardForm(asCards(FOUR_STEPS)));
    expect(untouched.ok && untouched.value.steps).toEqual(FOUR_STEPS);

    const added = parseFollowUpForm(
      cardForm(asCards(FOUR_STEPS), { add: { days: ' 21 ', instr: '  Last nudge.  ' } }),
    );
    expect(added.ok && added.value.steps).toEqual([
      ...FOUR_STEPS,
      { daysAfterPrev: 21, customInstructions: 'Last nudge.' },
    ]);
  });

  it('drops a step whose days field was cleared, like Remove', () => {
    const cards = asCards(FOUR_STEPS);
    cards[2] = { days: '', instr: cards[2]!.instr };

    const r = parseFollowUpForm(cardForm(cards));

    expect(r.ok && r.value.steps).toEqual([FOUR_STEPS[0], FOUR_STEPS[1], FOUR_STEPS[3]]);
  });

  it('rejects days outside 1..365 and names the step instead of silently dropping it', () => {
    for (const bad of ['0', '-2', '1.5', '366', 'abc']) {
      const cards = asCards(FOUR_STEPS);
      cards[1] = { days: bad };
      expect(parseFollowUpForm(cardForm(cards))).toEqual({
        ok: false,
        error: 'Step 2: days must be a whole number from 1 to 365.',
      });
    }
  });

  it('a removed step is not validated', () => {
    const cards = asCards(FOUR_STEPS);
    cards[1] = { days: '0' };

    const r = parseFollowUpForm(cardForm(cards, { remove: [1] }));

    expect(r.ok && r.value.steps).toHaveLength(3);
  });

  it('refuses to remove every step and points at the on/off switch', () => {
    const r = parseFollowUpForm(cardForm(asCards(FOUR_STEPS), { remove: [0, 1, 2, 3] }));

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/at least one follow-up step.*Follow-ups enabled/);
  });

  it('refuses it with the switch already off too, without promising that switching off helps', () => {
    const r = parseFollowUpForm(
      cardForm(asCards(FOUR_STEPS), { remove: [0, 1, 2, 3], enabled: false }),
    );

    expect(r.ok).toBe(false);
    // The old text ended "switch ... off instead", which an operator who
    // had already switched it off could not act on.
    expect(!r.ok && r.error).not.toMatch(/instead/);
    expect(!r.ok && r.error).toMatch(/even while "Follow-ups enabled" is off.*keep a step/);
  });

  it('refuses more than ten steps', () => {
    const ten = Array.from({ length: 10 }, () => ({ days: '7' }));

    const r = parseFollowUpForm(cardForm(ten, { add: { days: '7' } }));

    expect(r).toEqual({ ok: false, error: 'At most 10 follow-up steps.' });
  });

  it('ignores malformed Remove values and unrelated fields', () => {
    const fd = cardForm(asCards(FOUR_STEPS), { enabled: false });
    fd.append(STEP_REMOVE_FIELD, '1; drop table');
    fd.append(STEP_REMOVE_FIELD, '-1');
    fd.set('stepDays.x', '9');
    fd.set('stepDays', '9');

    const r = parseFollowUpForm(fd);

    expect(r.ok && r.value).toEqual({
      enabled: false,
      requireApproval: true,
      steps: FOUR_STEPS,
    });
  });
});

describe('/settings/outreach follow-up card', () => {
  async function setup() {
    const owner = await seedUser({ email: 'owner@test.local' });
    const workspaceId = await seedWorkspace({ name: 'A', ownerUserId: owner });
    await updateFollowUpConfig(
      makeWorkspaceContext({ workspaceId, userId: owner, role: 'owner' }),
      { enabled: true, requireApproval: true, steps: FOUR_STEPS },
    );
    return { owner, workspaceId };
  }

  beforeEach(async () => {
    await truncateAll();
    session.current = null;
  });

  afterAll(async () => {
    await (db.$client as unknown as { end: () => Promise<void> }).end();
  });

  it('renders one card per step with a Remove box and no required days inputs', async () => {
    const f = await setup();
    signInAs(f.owner);

    const tree = await OutreachSettingsPage({ searchParams: Promise.resolve({}) });
    const html = (await renderToHtml(tree)).replaceAll('<!-- -->', '');

    for (let i = 0; i < FOUR_STEPS.length; i++) {
      const days = new RegExp(`<input[^>]*name="stepDays\\.${i}"[^>]*>`).exec(html)?.[0];
      expect(days, `step ${i + 1} days input`).toBeDefined();
      expect(days).toContain(`value="${FOUR_STEPS[i]!.daysAfterPrev}"`);
      expect(days).not.toMatch(/\brequired\b/);
      expect(html).toMatch(
        new RegExp(`<input[^>]*type="checkbox"[^>]*name="stepRemove"[^>]*value="${i}"`),
      );
      expect(html).toContain(`name="stepInstr.${i}"`);
    }
    // The add card takes the next index, with an empty days field.
    const addDays = /<input[^>]*name="stepDays\.4"[^>]*>/.exec(html)?.[0];
    expect(addDays).toContain('placeholder="7"');
    expect(addDays).not.toContain('value=');
    expect(html).not.toContain('clear its');
    expect(html).toContain('Mention the case study.');
    // Only the last step is labelled the final attempt.
    expect(html.match(/>Final attempt</g)).toHaveLength(1);
  });

  it('saving with step 2 removed stores 3 steps in order with their instructions', async () => {
    const f = await setup();
    signInAs(f.owner);

    const target = await expectRedirect(() =>
      saveFollowUp(cardForm(asCards(FOUR_STEPS), { remove: [1] })),
    );

    expect(new URL(target, 'http://app.test').searchParams.get('message')).toBe(
      'Follow-up settings saved: 3 steps.',
    );
    const saved = await loadSettings(f.workspaceId);
    expect(saved.steps).toEqual([FOUR_STEPS[0], FOUR_STEPS[2], FOUR_STEPS[3]]);
  });

  it('an invalid form saves nothing and explains why', async () => {
    const f = await setup();
    signInAs(f.owner);
    const cards = asCards(FOUR_STEPS);
    cards[3] = { days: '400' };

    const target = await expectRedirect(() => saveFollowUp(cardForm(cards, { remove: [0] })));

    expect(new URL(target, 'http://app.test').searchParams.get('error')).toBe(
      'Step 4: days must be a whole number from 1 to 365.',
    );
    expect((await loadSettings(f.workspaceId)).steps).toEqual(FOUR_STEPS);
  });

  it('a non-admin member gets an error flash and nothing changes', async () => {
    const f = await setup();
    const member = await seedUser({ email: 'member@test.local' });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: f.workspaceId, userId: member, role: 'member' });
    signInAs(member);

    const target = await expectRedirect(() =>
      saveFollowUp(cardForm(asCards(FOUR_STEPS), { remove: [1] })),
    );

    expect(new URL(target, 'http://app.test').searchParams.get('error')).toBe(
      'Only workspace admins can change follow-up settings.',
    );
    expect((await loadSettings(f.workspaceId)).steps).toEqual(FOUR_STEPS);
  });
});
