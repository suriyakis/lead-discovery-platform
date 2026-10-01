// DS-04 confirmations: one-click high-impact actions ask first.
//
// Three layers:
//  1. the mechanics (src/lib/confirm.ts) and the copy (confirm-copy.ts),
//  2. the client buttons themselves — clicking with the dialog dismissed
//     must preventDefault (no submit, so no server-action request), and
//     accepting must let the submit through,
//  3. a static check that every listed action's form submits through one
//     of those buttons, so a later edit cannot quietly drop the dialog.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmAction,
  pickMessageForValue,
  readFieldValue,
  type ConfirmUi,
  type FormLike,
} from '@/lib/confirm';
import {
  accountStatusConfirms,
  archiveCrmConnectionConfirm,
  archiveWorkspaceConfirm,
  billingExemptOffConfirm,
  billingExemptOnConfirm,
  clearAutopilotOverridesConfirm,
  clearWorkspaceKeyConfirm,
  closeSupportThreadConfirm,
  demoteSuperAdminConfirm,
  parseTokenDelta,
  promoteSuperAdminConfirm,
  removeConsoleKeyConfirm,
  removeMemberConfirm,
  restoreWorkspaceConfirm,
  revokePreauthConfirm,
  switchToSimpleSetupConfirm,
  tokenAdjustmentConfirm,
  workspaceLabel,
  type AutopilotBaseLike,
  type AutopilotOverlayLike,
} from '@/lib/confirm-copy';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { ConfirmTokenAdjustButton } from '@/components/ConfirmTokenAdjustButton';

const ROOT = path.resolve(__dirname, '..', '..');

function fakeUi(answers: { confirm?: boolean; prompt?: string | null } = {}) {
  const ui = {
    confirm: vi.fn((_m: string) => answers.confirm ?? false),
    prompt: vi.fn((_m: string) => (answers.prompt === undefined ? null : answers.prompt)),
    alert: vi.fn((_m: string) => undefined),
  };
  return ui satisfies ConfirmUi;
}

function fakeForm(values: Record<string, string>): FormLike {
  return {
    elements: {
      namedItem: (name: string) => (name in values ? { value: values[name] } : null),
    },
  };
}

describe('confirmAction', () => {
  it('plain confirm: OK lets it through, Cancel stops it', () => {
    const yes = fakeUi({ confirm: true });
    expect(confirmAction({ message: 'Archive?' }, yes)).toBe(true);
    expect(yes.confirm).toHaveBeenCalledWith('Archive?');
    expect(confirmAction({ message: 'Archive?' }, fakeUi({ confirm: false }))).toBe(false);
  });

  it('type-to-confirm: cancel and a wrong phrase stop it, the exact phrase lets it through', () => {
    const cancelled = fakeUi({ prompt: null });
    expect(confirmAction({ message: 'Promote?', confirmPhrase: 'a@b.co' }, cancelled)).toBe(false);
    expect(cancelled.confirm).not.toHaveBeenCalled();
    expect(cancelled.prompt.mock.calls[0]?.[0]).toBe('Promote?\n\nType a@b.co to confirm.');
    expect(cancelled.alert).not.toHaveBeenCalled();

    const wrong = fakeUi({ prompt: 'a@b.com' });
    expect(confirmAction({ message: 'Promote?', confirmPhrase: 'a@b.co' }, wrong)).toBe(false);
    expect(wrong.alert).toHaveBeenCalledWith('That did not match "a@b.co". Nothing was changed.');

    const right = fakeUi({ prompt: '  a@b.co ' });
    expect(confirmAction({ message: 'Promote?', confirmPhrase: 'a@b.co' }, right)).toBe(true);
    expect(right.alert).not.toHaveBeenCalled();
  });

  it('a blank phrase falls back to a plain confirm', () => {
    const ui = fakeUi({ confirm: true });
    expect(confirmAction({ message: 'x', confirmPhrase: '  ' }, ui)).toBe(true);
    expect(ui.prompt).not.toHaveBeenCalled();
  });
});

describe('form field helpers', () => {
  it('readFieldValue reads a control and tolerates a missing form or field', () => {
    expect(readFieldValue(fakeForm({ tokens: '1000' }), 'tokens')).toBe('1000');
    expect(readFieldValue(fakeForm({}), 'tokens')).toBe('');
    expect(readFieldValue(null, 'tokens')).toBe('');
    expect(readFieldValue({ elements: { namedItem: () => ({ value: 5 }) } }, 'x')).toBe('');
  });

  it('pickMessageForValue picks by value and ignores values without a message', () => {
    const spec = { field: 'status', messages: { suspended: 'Suspend?' } };
    expect(pickMessageForValue(spec, fakeForm({ status: 'suspended' }))).toBe('Suspend?');
    expect(pickMessageForValue(spec, fakeForm({ status: 'active' }))).toBeUndefined();
    // Inherited keys are not messages.
    expect(pickMessageForValue(spec, fakeForm({ status: 'constructor' }))).toBeUndefined();
  });
});

describe('token adjustment confirm', () => {
  it('shows the signed delta and names the workspace', () => {
    const plus = tokenAdjustmentConfirm({ raw: '1000', workspaceName: 'Acme Ltd' });
    expect(plus?.split('\n')[0]).toBe('+1,000 tokens to Acme Ltd');
    const minus = tokenAdjustmentConfirm({ raw: '-1000', workspaceName: 'Acme Ltd' });
    expect(minus?.split('\n')[0]).toBe('-1,000 tokens from Acme Ltd');
    expect(tokenAdjustmentConfirm({ raw: ' 1e3 ', workspaceName: 'A' })?.split('\n')[0]).toBe(
      '+1,000 tokens to A',
    );
  });

  it('shows balance before → after, warns when it reaches zero, and echoes the reason', () => {
    const msg = tokenAdjustmentConfirm({
      raw: '-1500',
      workspaceName: 'Acme',
      balance: '1000',
      reason: ' correction ',
    })!;
    expect(msg).toContain('Balance: 1,000 → -500 tokens.');
    expect(msg).toContain('pauses until tokens are added');
    expect(msg).toContain('Reason: correction');
    expect(msg.endsWith('Apply this adjustment?')).toBe(true);

    const exempt = tokenAdjustmentConfirm({
      raw: '-1500',
      workspaceName: 'Acme',
      balance: '1000',
      billingExempt: true,
    })!;
    expect(exempt).not.toContain('pauses');

    const big = tokenAdjustmentConfirm({ raw: '10000', workspaceName: 'Acme', balance: '250' })!;
    expect(big).toContain('Balance: 250 → 10,250 tokens.');
    expect(big).not.toContain('pauses');
  });

  it('returns null for amounts the server rejects anyway (no dialog)', () => {
    for (const raw of ['', '  ', '0', '1.5', 'abc', 'Infinity']) {
      expect(parseTokenDelta(raw)).toBeNull();
      expect(tokenAdjustmentConfirm({ raw, workspaceName: 'A' })).toBeNull();
    }
    expect(parseTokenDelta('+25')).toBe(25n);
  });

  it('ignores an unparseable balance instead of printing nonsense', () => {
    const msg = tokenAdjustmentConfirm({ raw: '5', workspaceName: 'A', balance: 'n/a' })!;
    expect(msg).not.toContain('Balance');
  });
});

describe('workspaces are named by name and slug', () => {
  // Every self-signup workspace is called "Personal", so the name alone
  // cannot tell one tenant's row from the next one's.
  const mine = { name: 'Personal', slug: 'personal-1a2b3c4d' };
  const theirs = { name: 'Personal', slug: 'personal-9f8e7d6c' };

  it('workspaceLabel: name + slug, quoted on request, slug left out when missing or redundant', () => {
    expect(workspaceLabel(mine)).toBe('Personal (personal-1a2b3c4d)');
    expect(workspaceLabel(mine, { quoted: true })).toBe('"Personal" (personal-1a2b3c4d)');
    expect(workspaceLabel({ name: 'Acme' })).toBe('Acme');
    expect(workspaceLabel({ name: 'Acme', slug: null }, { quoted: true })).toBe('"Acme"');
    expect(workspaceLabel({ name: 'acme', slug: 'acme' })).toBe('acme');
  });

  it('two workspaces with the same name get different confirms', () => {
    const grant = (ws: typeof mine) =>
      tokenAdjustmentConfirm({ raw: '1000', workspaceName: ws.name, workspaceSlug: ws.slug })!;
    expect(grant(mine).split('\n')[0]).toBe('+1,000 tokens to Personal (personal-1a2b3c4d)');
    expect(grant(mine)).not.toBe(grant(theirs));

    for (const build of [
      (ws: typeof mine) => archiveWorkspaceConfirm({ ...ws, memberCount: 1 }),
      (ws: typeof mine) => restoreWorkspaceConfirm({ ...ws, memberCount: 1 }),
      (ws: typeof mine) => billingExemptOnConfirm(ws),
      (ws: typeof mine) =>
        billingExemptOffConfirm({
          ...ws,
          balance: '10',
          plan: 'pro',
          subscriptionStatus: 'active',
        }),
      (ws: typeof mine) => removeMemberConfirm({ name: null, email: 'bo@example.com' }, ws),
      (ws: typeof mine) => switchToSimpleSetupConfirm(ws),
      (ws: typeof mine) =>
        clearWorkspaceKeyConfirm({
          vendorName: 'Gemini',
          workspaceName: ws.name,
          workspaceSlug: ws.slug,
        }),
      (ws: typeof mine) =>
        closeSupportThreadConfirm({
          subject: 'Help',
          workspaceName: ws.name,
          workspaceSlug: ws.slug,
        }),
      (ws: typeof mine) =>
        revokePreauthConfirm({
          email: 'new@example.com',
          role: 'member',
          workspaceName: ws.name,
          workspaceSlug: ws.slug,
        }),
    ]) {
      expect(build(mine)).toContain('personal-1a2b3c4d');
      expect(build(mine)).not.toBe(build(theirs));
    }
  });

  it('the copy reads naturally with the slug in it', () => {
    expect(archiveWorkspaceConfirm({ ...mine, memberCount: 2 })).toContain(
      'Archive the workspace "Personal" (personal-1a2b3c4d)?',
    );
    expect(billingExemptOnConfirm(mine)).toContain(
      'Make "Personal" (personal-1a2b3c4d) billing exempt?',
    );
    expect(removeMemberConfirm({ name: null, email: 'bo@example.com' }, mine)).toContain(
      'Remove bo@example.com from "Personal" (personal-1a2b3c4d)?',
    );
    expect(
      closeSupportThreadConfirm({
        subject: 'Help',
        workspaceName: mine.name,
        workspaceSlug: mine.slug,
      }),
    ).toContain('Close the support thread "Help" from Personal (personal-1a2b3c4d)?');
  });
});

describe('confirm copy names what it acts on', () => {
  const ada = { name: 'Ada Lovelace', email: 'ada@example.com' };

  it('workspace lifecycle', () => {
    const archive = archiveWorkspaceConfirm({ name: 'Acme', memberCount: 3 });
    expect(archive).toContain('Archive the workspace "Acme"?');
    expect(archive).toContain('Its 3 members lose access');
    expect(archiveWorkspaceConfirm({ name: 'Acme', memberCount: 1 })).toContain(
      'Its 1 member loses access',
    );
    expect(archiveWorkspaceConfirm({ name: 'Acme', memberCount: 0 })).toContain(
      'It has no members yet.',
    );
    const restore = restoreWorkspaceConfirm({ name: 'Acme', memberCount: 2 });
    expect(restore).toContain('Restore the workspace "Acme"?');
    expect(restore).toContain('Its 2 members get access back');
  });

  it('billing exemption on and off', () => {
    expect(billingExemptOnConfirm({ name: 'Acme' })).toContain('Make "Acme" billing exempt?');
    const off = billingExemptOffConfirm({
      name: 'Acme',
      balance: '0',
      plan: 'pro',
      subscriptionStatus: 'trial',
    });
    expect(off).toContain('End the billing exemption for "Acme"?');
    expect(off).toContain('(0 tokens now)');
    expect(off).toContain('(pro, trial)');
    expect(off).toContain('pauses until tokens are added');
    expect(
      billingExemptOffConfirm({
        name: 'A',
        balance: '12000',
        plan: 'pro',
        subscriptionStatus: 'active',
      }),
    ).not.toContain('pauses');
  });

  it('members, roles and account status', () => {
    expect(removeMemberConfirm(ada, 'Acme')).toContain(
      'Remove Ada Lovelace <ada@example.com> from "Acme"?',
    );
    expect(removeMemberConfirm({ name: null, email: 'bo@example.com' })).toContain(
      'Remove bo@example.com from this workspace?',
    );
    expect(promoteSuperAdminConfirm(ada)).toContain(
      'Promote Ada Lovelace <ada@example.com> to super-admin?',
    );
    expect(demoteSuperAdminConfirm(ada)).toContain('Demote Ada Lovelace <ada@example.com>');

    const fromActive = accountStatusConfirms({ ...ada, role: 'member', accountStatus: 'active' });
    expect(Object.keys(fromActive).sort()).toEqual(['pending', 'rejected', 'suspended']);
    expect(fromActive.suspended).toContain('Suspend Ada Lovelace <ada@example.com>?');
    expect(fromActive.suspended).not.toContain('does not lock super-admins out');

    const fromPending = accountStatusConfirms({ ...ada, role: 'member', accountStatus: 'pending' });
    expect(fromPending.pending).toBeUndefined();
    expect(fromPending.active).toContain('Set Ada Lovelace <ada@example.com> to active?');

    const superAdmin = accountStatusConfirms({
      ...ada,
      role: 'super_admin',
      accountStatus: 'active',
    });
    expect(superAdmin.suspended).toContain('does not lock super-admins out');
  });

  it('pre-authorisation revoke and support close', () => {
    expect(
      revokePreauthConfirm({ email: 'new@example.com', role: 'admin', workspaceName: 'Acme' }),
    ).toMatch(/new@example\.com[\s\S]*"Acme" as admin/);
    expect(
      revokePreauthConfirm({ email: 'new@example.com', role: 'member', workspaceName: null }),
    ).toContain('pending review');
    expect(
      closeSupportThreadConfirm({ subject: 'Billing question', workspaceName: 'Acme' }),
    ).toContain('Close the support thread "Billing question" from Acme?');
  });

  it('provider keys and defaults', () => {
    const withEnv = removeConsoleKeyConfirm({
      vendorName: 'OpenAI',
      envVar: 'OPENAI_API_KEY',
      envSet: true,
    });
    expect(withEnv).toContain('Remove the platform OpenAI key?');
    expect(withEnv).toContain('fall back to the OPENAI_API_KEY server env var');
    const noEnv = removeConsoleKeyConfirm({
      vendorName: 'OpenAI',
      envVar: 'OPENAI_API_KEY',
      envSet: false,
    });
    expect(noEnv).toContain('OPENAI_API_KEY is not set');
    expect(clearWorkspaceKeyConfirm({ vendorName: 'Gemini', workspaceName: 'Acme' })).toContain(
      'Delete the Gemini key stored for "Acme"?',
    );
    expect(switchToSimpleSetupConfirm('Acme')).toContain('Switch "Acme" to Simple setup?');
    expect(archiveCrmConnectionConfirm({ name: 'Main HubSpot', system: 'hubspot' })).toContain(
      'Archive the CRM connection "Main HubSpot" (hubspot)?',
    );
  });

  describe('autopilot overrides', () => {
    const base: AutopilotBaseLike = {
      autopilotEnabled: true,
      emergencyPause: false,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 60,
      enableAutoEnqueueOutreach: true,
      enableAutoCrmContactSync: false,
      enableAutoCrmDealOnQualified: false,
    };
    const inherit: AutopilotOverlayLike = {
      autopilotEnabled: null,
      emergencyPause: null,
      enableAutoApproveProjects: null,
      autoApproveThreshold: null,
      enableAutoEnqueueOutreach: null,
      enableAutoCrmContactSync: null,
      enableAutoCrmDealOnQualified: null,
      defaultMailboxId: null,
    };

    it('spells out automation that turns ON and a pause that is lifted', () => {
      const msg = clearAutopilotOverridesConfirm(
        'Widget',
        {
          ...inherit,
          emergencyPause: true,
          enableAutoEnqueueOutreach: false,
          enableAutoCrmContactSync: true,
          autoApproveThreshold: 90,
          defaultMailboxId: 7n,
        },
        base,
      );
      expect(msg).toContain('Clear all autopilot overrides for "Widget"?');
      expect(msg).toContain('- Lifts the emergency pause on Widget.');
      expect(msg).toContain('- Turns ON: Auto-generate + enqueue outreach drafts.');
      expect(msg).toContain("- Turns off: Auto-sync qualified leads' contacts to CRM.");
      expect(msg).toContain('- Approval threshold: 90 → 60.');
      expect(msg).toContain('- Sends from the workspace default mailbox again.');
    });

    it('says when nothing changes in practice', () => {
      const msg = clearAutopilotOverridesConfirm(
        'Widget',
        { ...inherit, enableAutoApproveProjects: true, autoApproveThreshold: 60 },
        base,
      );
      expect(msg).toContain('Nothing changes in practice');
    });

    it('warns when clearing puts the product under the workspace emergency pause', () => {
      const msg = clearAutopilotOverridesConfirm(
        'Widget',
        { ...inherit, emergencyPause: false },
        { ...base, emergencyPause: true },
      );
      expect(msg).toContain('- Pauses Widget');
    });
  });
});

// ---- the client buttons ---------------------------------------------------

interface ButtonElement {
  type: string;
  props: { type?: string; className?: string; onClick: (e: unknown) => void };
}

function click(el: ReactElement, form: FormLike | null = null) {
  const event = { preventDefault: vi.fn(), currentTarget: { form } };
  (el as unknown as ButtonElement).props.onClick(event);
  return event;
}

describe('ConfirmFormButton', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a submit button and passes other props through', () => {
    const el = ConfirmFormButton({
      message: 'Archive?',
      className: 'ghost-btn',
      children: 'Archive',
    }) as unknown as ButtonElement;
    expect(el.type).toBe('button');
    expect(el.props.type).toBe('submit');
    expect(el.props.className).toBe('ghost-btn');
  });

  it('dismissing sends nothing; accepting submits and runs the caller onClick', () => {
    const onClick = vi.fn();
    const confirm = vi.fn((_m: string) => false);
    vi.stubGlobal('confirm', confirm);
    const el = ConfirmFormButton({ message: 'Archive "Acme"?', onClick, children: 'Archive' });

    const dismissed = click(el);
    expect(confirm).toHaveBeenCalledWith('Archive "Acme"?');
    expect(dismissed.preventDefault).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    const accepted = click(el);
    expect(accepted.preventDefault).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('type-to-confirm: a wrong phrase sends nothing, the right one submits', () => {
    const prompt = vi.fn((_m: string): string | null => 'acme');
    const alert = vi.fn((_m: string) => undefined);
    const confirm = vi.fn((_m: string) => true);
    vi.stubGlobal('prompt', prompt);
    vi.stubGlobal('alert', alert);
    vi.stubGlobal('confirm', confirm);
    const el = ConfirmFormButton({
      message: 'Make "Acme" billing exempt?',
      confirmPhrase: 'acme-ltd',
      children: 'Make billing exempt',
    });

    expect(click(el).preventDefault).toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled(); // a phrase replaces the OK button

    prompt.mockReturnValue('acme-ltd');
    expect(click(el).preventDefault).not.toHaveBeenCalled();
  });

  it('messageByValue: asks only for values that have a message', () => {
    const confirm = vi.fn((_m: string) => false);
    vi.stubGlobal('confirm', confirm);
    const el = ConfirmFormButton({
      messageByValue: { field: 'status', messages: { suspended: 'Suspend Ada?' } },
      children: 'Apply',
    });

    // Re-applying the current status (no message) submits without a dialog.
    expect(click(el, fakeForm({ status: 'active' })).preventDefault).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    const e = click(el, fakeForm({ status: 'suspended' }));
    expect(confirm).toHaveBeenCalledWith('Suspend Ada?');
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe('ConfirmTokenAdjustButton', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const button = () =>
    ConfirmTokenAdjustButton({
      workspaceName: 'Acme Ltd',
      balance: '5000',
      children: 'Apply',
    });

  it('confirms the signed delta read from the form', () => {
    const confirm = vi.fn((_m: string) => true);
    vi.stubGlobal('confirm', confirm);

    expect(
      click(button(), fakeForm({ tokens: '1000', reason: 'promo' })).preventDefault,
    ).not.toHaveBeenCalled();
    const grant = String(confirm.mock.calls[0]?.[0]);
    expect(grant.startsWith('+1,000 tokens to Acme Ltd\n')).toBe(true);
    expect(grant).toContain('Balance: 5,000 → 6,000 tokens.');
    expect(grant).toContain('Reason: promo');

    click(button(), fakeForm({ tokens: '-1000', reason: '' }));
    const deduct = String(confirm.mock.calls[1]?.[0]);
    expect(deduct.startsWith('-1,000 tokens from Acme Ltd\n')).toBe(true);
    expect(deduct).toContain('Balance: 5,000 → 4,000 tokens.');
  });

  it('names the workspace by name and slug', () => {
    const confirm = vi.fn((_m: string) => true);
    vi.stubGlobal('confirm', confirm);
    const el = ConfirmTokenAdjustButton({
      workspaceName: 'Personal',
      workspaceSlug: 'personal-1a2b3c4d',
      children: 'Apply',
    });
    click(el, fakeForm({ tokens: '1000' }));
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(
      /^\+1,000 tokens to Personal \(personal-1a2b3c4d\)\n/,
    );
  });

  it('dismissing sends nothing', () => {
    vi.stubGlobal(
      'confirm',
      vi.fn((_m: string) => false),
    );
    const onClick = vi.fn();
    const el = ConfirmTokenAdjustButton({ workspaceName: 'Acme', onClick, children: 'Apply' });
    expect(click(el, fakeForm({ tokens: '-100000' })).preventDefault).toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('an invalid amount skips the dialog and lets the server flash the error', () => {
    const confirm = vi.fn((_m: string) => false);
    vi.stubGlobal('confirm', confirm);
    expect(click(button(), fakeForm({ tokens: '0' })).preventDefault).not.toHaveBeenCalled();
    expect(click(button(), fakeForm({ tokens: '' })).preventDefault).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});

// ---- static wiring --------------------------------------------------------

/** Every one-click high-impact action that must ask first (DS-04 / I079). */
const CONFIRMED_ACTIONS: ReadonlyArray<{ file: string; actions: readonly string[] }> = [
  { file: 'src/app/admin/page.tsx', actions: ['quickGrantTokens'] },
  { file: 'src/app/admin/workspaces/page.tsx', actions: ['archive', 'restore'] },
  {
    file: 'src/app/admin/workspaces/[id]/page.tsx',
    actions: ['grantTokens', 'setExemptState', 'archive', 'restore', 'removeUser'],
  },
  { file: 'src/app/admin/users/page.tsx', actions: ['setStatus', 'revoke'] },
  {
    file: 'src/app/admin/users/[id]/page.tsx',
    actions: ['changeStatus', 'changePlatformRole', 'removeFromWorkspace'],
  },
  { file: 'src/app/admin/support/[id]/page.tsx', actions: ['setStatus'] },
  { file: 'src/app/admin/providers/page.tsx', actions: ['removeKey', 'saveDefaults'] },
  // The action moved to ./actions.ts (ia:F-04); the form still confirms.
  { file: 'src/app/settings/members/page.tsx', actions: ['removeMemberAction'] },
  {
    file: 'src/app/settings/integrations/page.tsx',
    actions: [
      'switchSetupMode',
      'clearKey',
      'clearOpenai',
      'clearAnthropic',
      'clearGemini',
      'clearPerplexity',
    ],
  },
  { file: 'src/app/autopilot/page.tsx', actions: ['clearOverlay'] },
  { file: 'src/app/settings/crm/[id]/page.tsx', actions: ['archive'] },
];

interface FormBlock {
  action: string | null;
  body: string;
}

/** Each <form …>…</form> in a TSX source: its action={name} and body. */
function formsIn(src: string): FormBlock[] {
  const out: FormBlock[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf('<form', from);
    if (start < 0) break;
    // End of the opening tag: the first '>' outside {…} expressions.
    let depth = 0;
    let i = start;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    const tag = src.slice(start, i);
    const close = src.indexOf('</form>', i);
    out.push({
      action: /\baction=\{(\w+)\}/.exec(tag)?.[1] ?? null,
      body: src.slice(i + 1, close < 0 ? undefined : close),
    });
    from = i + 1;
  }
  return out;
}

describe('high-impact forms submit through a confirm button', () => {
  for (const { file, actions } of CONFIRMED_ACTIONS) {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    const forms = formsIn(src);
    for (const action of actions) {
      it(`${file} → ${action}`, () => {
        const mine = forms.filter((f) => f.action === action);
        expect(mine.length, `no <form action={${action}}> in ${file}`).toBeGreaterThan(0);
        for (const f of mine) {
          expect(f.body).toMatch(/<Confirm(Form|TokenAdjust)Button\b/);
          expect(f.body, 'a plain <button> would submit without asking').not.toMatch(/<button\b/);
        }
      });
    }
  }

  it('the billing-exemption form sends the confirmed state, not a blind toggle', () => {
    const src = readFileSync(path.join(ROOT, 'src/app/admin/workspaces/[id]/page.tsx'), 'utf8');
    const form = formsIn(src).find((f) => f.action === 'setExemptState');
    expect(form?.body).toMatch(/name="exempt"/);
    expect(src).not.toMatch(/!\(rows\[0\]\?\.exempt/);
  });

  it('console confirms that name a workspace pass its slug too', () => {
    const CONSOLE_FILES = [
      'src/app/admin/page.tsx',
      'src/app/admin/workspaces/page.tsx',
      'src/app/admin/workspaces/[id]/page.tsx',
      'src/app/admin/users/page.tsx',
      'src/app/admin/users/[id]/page.tsx',
      'src/app/admin/support/[id]/page.tsx',
    ];
    const missing: string[] = [];
    for (const file of CONSOLE_FILES) {
      const src = readFileSync(path.join(ROOT, file), 'utf8');
      // <ConfirmTokenAdjustButton …> opening tags
      for (const m of src.matchAll(/<ConfirmTokenAdjustButton\b[^>]*>/g)) {
        if (!/\bworkspaceSlug=/.test(m[0])) missing.push(`${file}: ConfirmTokenAdjustButton`);
      }
      // xxxConfirm({ … }) calls that take a workspace object
      for (const m of src.matchAll(
        /\b(archiveWorkspaceConfirm|restoreWorkspaceConfirm|billingExemptOnConfirm|billingExemptOffConfirm)\(\{[^}]*\}/g,
      )) {
        if (!/\bslug:/.test(m[0])) missing.push(`${file}: ${m[1]}`);
      }
      for (const m of src.matchAll(
        /\b(closeSupportThreadConfirm|revokePreauthConfirm)\(\{[\s\S]*?\}\)/g,
      )) {
        if (!/\bworkspaceSlug\b/.test(m[0])) missing.push(`${file}: ${m[1]}`);
      }
      // removeMemberConfirm(user, <workspace>): an object with a slug, not a bare name
      for (const m of src.matchAll(/\bremoveMemberConfirm\(\s*\w+\s*,([\s\S]*?)\)\}/g)) {
        if (!/\bslug:/.test(m[1]!)) missing.push(`${file}: removeMemberConfirm`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('super-admin promotion and billing exemption are type-to-confirm', () => {
    const user = readFileSync(path.join(ROOT, 'src/app/admin/users/[id]/page.tsx'), 'utf8');
    expect(user).toMatch(
      /message=\{promoteSuperAdminConfirm\(user\)\}\s*confirmPhrase=\{user\.email\}/,
    );
    const ws = readFileSync(path.join(ROOT, 'src/app/admin/workspaces/[id]/page.tsx'), 'utf8');
    expect(ws).toMatch(/message=\{billingExemptOnConfirm\([^)]*\)\}\s*confirmPhrase=\{ws\.slug\}/);
  });
});
