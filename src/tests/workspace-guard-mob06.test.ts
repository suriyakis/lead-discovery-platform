// MOB-06 — the expected-workspace guard on every action that sends, spends
// or decides.
//
//   - Registry: every listed action is wrapped (withWorkspaceGuard /
//     withWorkspaceGuardRoute) under its id, and the list covers what the
//     deliverable names.
//   - Wiring: every form that posts to a guarded server action carries
//     <ExpectedWorkspaceField/>, every client caller of a guarded action
//     passes the page's workspace, and every fetch of a guarded route sends
//     the x-expected-workspace header.
//   - Stale tabs: after the session switched workspace in another tab, a
//     form or fetch from a page of the old workspace that posts Approve,
//     Pause, Send (and the other guarded actions) answers workspace_changed,
//     and no review, queue, audit or mail row changes. A matching claim
//     still works, a missing one fails closed, and the checked workspace is
//     pinned for the whole action.
//
// The session cookie and next-auth's lookup are stubbed; the actions, the
// routes, the resolver and the database are real.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog, usageLog } from '@/lib/db/schema/audit';
import { mailMessages } from '@/lib/db/schema/mailing';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { reviewItems } from '@/lib/db/schema/review';
import { workspaces } from '@/lib/db/schema/workspaces';
import { createSessionForUser } from '@/lib/session-helpers';
import { historyToSend, settleAsk } from '@/lib/assistant/panel-state';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { makeWorkspaceContext } from '@/lib/services/context';
import { setActiveWorkspaceAction } from '@/lib/workspace-actions';
import { GUARDED_ACTION_IDS, type GuardedActionId } from '@/lib/workspace-guard/registry';
import {
  describeWorkspaceMismatch,
  expectedWorkspaceFromArgs,
  guardedActionId,
  withWorkspaceGuard,
} from '@/lib/workspace-guard/server';
import * as reviewItemActions from '@/app/(app)/review/[id]/actions';
import * as reviewBulkActions from '@/app/(app)/review/actions';
import * as queueActions from '@/app/(app)/mailbox/queue/actions';
import * as composeActions from '@/app/(app)/mailbox/[id]/compose/actions';
import * as pauseActions from '@/lib/automation-pause-actions';
import * as autopilotActions from '@/app/(app)/autopilot/actions';
import * as engineActions from '@/app/(app)/connectors/engine/actions';
import * as healthActions from '@/app/(app)/health/actions';
import * as replyAutoActions from '@/app/(app)/settings/outreach/actions';
import { POST as replyPOST } from '@/app/api/communication/reply/route';
import { POST as assistantPOST } from '@/app/api/assistant/route';
import { POST as buyTokensPOST } from '@/app/api/stripe/buy-tokens/route';
import WorkspaceChangedPage from '@/app/(app)/workspace-changed/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';
import { queuedDraft, setupQueueWorkspace, type QueueSetup } from './helpers/outreach-fixtures';
import { claimHeaders, claimedForm } from './helpers/workspace-guard';

// ---- the request ------------------------------------------------------------

const req = vi.hoisted(() => ({
  user: null as null | { id: string },
  token: null as string | null,
  referer: null as string | null,
}));

vi.mock('@/lib/auth', () => ({
  auth: async () =>
    req.user
      ? {
          user: {
            id: req.user.id,
            email: `${req.user.id}@test.local`,
            name: null,
            role: 'member',
            accountStatus: 'active',
          },
        }
      : null,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'authjs.session-token' && req.token ? { name, value: req.token } : undefined,
  }),
  headers: async () =>
    new Headers({
      'user-agent': 'Vitest browser',
      ...(req.referer ? { referer: req.referer } : {}),
    }),
}));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidatePath: () => undefined,
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children?: unknown }) => children,
}));

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

// ---- registry ---------------------------------------------------------------

/** Each registered id → the module (repo path, no extension) and the export it must wrap. */
const WRAPPED: ReadonlyArray<readonly [GuardedActionId, string, string]> = [
  ['review.approve', 'src/app/(app)/review/[id]/actions', 'approveReviewItemAction'],
  ['review.reject', 'src/app/(app)/review/[id]/actions', 'rejectReviewItemAction'],
  ['review.ignore', 'src/app/(app)/review/[id]/actions', 'ignoreReviewItemAction'],
  ['review.flag', 'src/app/(app)/review/[id]/actions', 'flagReviewItemAction'],
  ['review.archive', 'src/app/(app)/review/[id]/actions', 'archiveReviewItemAction'],
  ['review.generate_draft', 'src/app/(app)/review/[id]/actions', 'generateDraftAction'],
  ['review.bulk_archive', 'src/app/(app)/review/actions', 'bulkArchiveAction'],
  ['review.bulk_delete', 'src/app/(app)/review/actions', 'bulkDeleteAction'],
  ['draft.approve', 'src/app/(app)/drafts/[id]/actions', 'approveDraftAction'],
  ['draft.enqueue', 'src/app/(app)/drafts/[id]/actions', 'enqueueDraftAction'],
  ['draft.reject', 'src/app/(app)/drafts/[id]/actions', 'rejectDraftAction'],
  ['draft.regenerate', 'src/app/(app)/drafts/[id]/actions', 'regenerateDraftAction'],
  ['draft.archive', 'src/app/(app)/drafts/[id]/actions', 'archiveDraftAction'],
  ['draft.translate', 'src/app/(app)/drafts/[id]/actions', 'translateDraftAction'],
  ['follow_up.approve', 'src/app/(app)/communication/follow-ups/actions', 'approveFollowUpAction'],
  [
    'follow_up.skip',
    'src/app/(app)/communication/follow-ups/actions',
    'cancelThreadFollowUpsAction',
  ],
  ['follow_up.reject', 'src/app/(app)/communication/follow-ups/actions', 'rejectFollowUpAction'],
  ['communication.reply', 'src/app/api/communication/reply/route', 'POST'],
  ['communication.compose', 'src/app/(app)/mailbox/[id]/compose/actions', 'sendComposeAction'],
  [
    'communication.compose_translate',
    'src/app/(app)/mailbox/[id]/compose/actions',
    'translateComposeAction',
  ],
  ['communication.suggest_reply', 'src/app/api/communication/suggest-reply/route', 'POST'],
  ['communication.translate', 'src/app/api/translate/route', 'POST'],
  ['queue.save_settings', 'src/app/(app)/mailbox/queue/actions', 'saveSendSettingsAction'],
  ['queue.cancel', 'src/app/(app)/mailbox/queue/actions', 'cancelQueuedEmailAction'],
  ['queue.reschedule', 'src/app/(app)/mailbox/queue/actions', 'rescheduleQueuedEmailAction'],
  ['queue.retry', 'src/app/(app)/mailbox/queue/actions', 'retryQueuedEmailAction'],
  ['queue.requeue', 'src/app/(app)/mailbox/queue/actions', 'requeueQueuedEmailAction'],
  ['queue.mark_delivered', 'src/app/(app)/mailbox/queue/actions', 'markQueuedEmailDeliveredAction'],
  ['queue.drain', 'src/app/(app)/mailbox/queue/actions', 'drainSendQueueAction'],
  ['autopilot.save_defaults', 'src/app/(app)/autopilot/actions', 'saveAutopilotDefaultsAction'],
  ['autopilot.save_product', 'src/app/(app)/autopilot/actions', 'saveProductAutopilotAction'],
  ['autopilot.clear_product', 'src/app/(app)/autopilot/actions', 'clearProductAutopilotAction'],
  ['autopilot.pause_product', 'src/app/(app)/autopilot/actions', 'pauseProductAction'],
  ['autopilot.resume_product', 'src/app/(app)/autopilot/actions', 'resumeProductAction'],
  ['autopilot.run_now', 'src/app/(app)/autopilot/actions', 'runAutopilotNowAction'],
  ['automation.pause', 'src/lib/automation-pause-actions', 'pauseAutomationAction'],
  ['automation.undo_pause', 'src/lib/automation-pause-actions', 'undoPauseAction'],
  ['automation.resume', 'src/lib/automation-pause-actions', 'resumeAutomationAction'],
  [
    'settings.reply_auto_actions',
    'src/app/(app)/settings/outreach/actions',
    'saveReplyAutoActions',
  ],
  ['discovery.reclassify_all', 'src/app/(app)/connectors/engine/actions', 'reclassifyAll'],
  ['health.run_check', 'src/app/(app)/health/actions', 'runHealthCheckNowAction'],
  ['health.save_settings', 'src/app/(app)/health/actions', 'saveHealthCheckSettingsAction'],
  ['billing.buy_tokens', 'src/app/api/stripe/buy-tokens/route', 'POST'],
  ['billing.subscribe', 'src/app/(app)/settings/billing/actions', 'subscribeToPlanAction'],
  ['billing.auto_topup', 'src/app/(app)/settings/billing/actions', 'saveAutoTopupAction'],
  ['assistant.ask', 'src/app/api/assistant/route', 'POST'],
];

describe('guarded action registry (MOB-06)', () => {
  it('every registered id is wrapped on its export, and every wrapped export is registered', async () => {
    for (const [id, file, name] of WRAPPED) {
      const mod = (await import(/* @vite-ignore */ path.join(ROOT, `${file}.ts`))) as Record<
        string,
        unknown
      >;
      expect(guardedActionId(mod[name]), `${name} should be wrapped as ${id}`).toBe(id);
    }
    expect(WRAPPED.map(([id]) => id).sort()).toEqual([...GUARDED_ACTION_IDS].sort());
  });

  it('covers every action MOB-06 names', () => {
    const named: GuardedActionId[] = [
      // review decide and bulk
      'review.approve',
      'review.reject',
      'review.ignore',
      'review.bulk_archive',
      'review.bulk_delete',
      // draft approve, enqueue, reject and regenerate
      'draft.approve',
      'draft.enqueue',
      'draft.reject',
      'draft.regenerate',
      // follow-up approve, skip and reject
      'follow_up.approve',
      'follow_up.skip',
      'follow_up.reject',
      // /api/communication/reply and compose
      'communication.reply',
      'communication.compose',
      // autopilot settings, pause and resume
      'autopilot.save_defaults',
      'autopilot.save_product',
      'autopilot.pause_product',
      'autopilot.resume_product',
      'automation.pause',
      'automation.resume',
      // buy-tokens, assistant ask
      'billing.buy_tokens',
      'assistant.ask',
    ];
    for (const id of named) expect(GUARDED_ACTION_IDS).toContain(id);
  });

  it('every action of the mailbox queue module is guarded', () => {
    const exported = Object.entries(queueActions).filter(([, v]) => typeof v === 'function');
    expect(exported.length).toBeGreaterThanOrEqual(7);
    for (const [name, fn] of exported) expect(guardedActionId(fn), name).not.toBeNull();
  });

  it('an unwrapped function is not reported as guarded', () => {
    expect(guardedActionId(async () => undefined)).toBeNull();
    expect(guardedActionId(reviewItemActions.commentOnReviewItemAction)).toBeNull();
  });
});

// ---- wiring: forms, client callers, fetches ---------------------------------

/** Each <form …>…</form> in a TSX source: the opening tag and the body. */
function formsIn(src: string): Array<{ tag: string; body: string }> {
  const out: Array<{ tag: string; body: string }> = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf('<form', from);
    if (start < 0) break;
    let depth = 0;
    let i = start;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    const close = src.indexOf('</form>', i);
    out.push({ tag: src.slice(start, i), body: src.slice(i + 1, close < 0 ? undefined : close) });
    from = i + 1;
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => path.join(dir, f).split(path.sep).join('/'));
}

const UI_FILES = [...sourceFiles('src/app'), ...sourceFiles('src/components')].filter(
  (f) => !f.startsWith('src/app/api/'),
);

describe('every guarded action is reached with the page’s workspace (MOB-06)', () => {
  /** Guarded server-action exports by module (repo path, no extension). */
  const guardedByModule = new Map<string, Set<string>>();
  for (const [, file, name] of WRAPPED) {
    if (name === 'POST') continue;
    guardedByModule.set(file, (guardedByModule.get(file) ?? new Set()).add(name));
  }

  /** The repo path an import specifier of `file` points at (no extension). */
  function resolveSpecifier(file: string, spec: string): string | null {
    if (spec.startsWith('@/')) return `src/${spec.slice(2)}`;
    if (spec.startsWith('.')) return path.posix.join(path.posix.dirname(file), spec);
    return null;
  }

  /** Local names in `src` bound to a guarded action (imports and their aliases). */
  function guardedNamesIn(file: string, src: string): Set<string> {
    const names = new Set<string>();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
      const target = resolveSpecifier(file, m[2]!);
      const guarded = target ? guardedByModule.get(target) : undefined;
      if (!guarded) continue;
      for (const part of m[1]!.split(',')) {
        const [imported, local] = part.trim().split(/\s+as\s+/);
        if (imported && guarded.has(imported)) names.add(local ?? imported);
      }
    }
    return names;
  }

  it('every form posting to a guarded action carries <ExpectedWorkspaceField/>', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of UI_FILES.filter((f) => f.endsWith('.tsx'))) {
      const src = read(file);
      // Local names that stand for a guarded action: the import itself, or
      // `const x = action` / `const x = action.bind(…)`.
      const names = guardedNamesIn(file, src);
      for (const n of [...names]) {
        for (const m of src.matchAll(new RegExp(`const (\\w+) = ${n}\\b`, 'g'))) names.add(m[1]!);
      }
      if (names.size === 0) continue;
      for (const form of formsIn(src)) {
        const action = /\baction=\{(\w+)\}/.exec(form.tag)?.[1];
        const buttonActions = [...form.body.matchAll(/formAction=\{(\w+)\}/g)].map((m) => m[1]!);
        const guarded = [action, ...buttonActions].filter((a) => a && names.has(a));
        if (guarded.length === 0) continue;
        checked += 1;
        if (!form.body.includes('<ExpectedWorkspaceField')) {
          problems.push(`${file}: <form action={${action}}> (${guarded.join(', ')})`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it('components that post a guarded action they were handed carry the field too', () => {
    for (const file of [
      'src/components/FollowUpApprovalRow.tsx',
      'src/components/AutomationPauseControl.tsx',
      'src/app/(app)/settings/outreach/ReplyAutoActionsCard.tsx',
    ]) {
      const forms = formsIn(read(file));
      expect(forms.length, file).toBeGreaterThan(0);
      for (const f of forms) expect(f.body, file).toContain('<ExpectedWorkspaceField');
    }
  });

  it('client components that call a guarded action directly pass expectedWorkspaceId', () => {
    const composeForm = read('src/app/(app)/mailbox/[id]/compose/ComposeForm.tsx');
    expect(composeForm).toContain('useExpectedWorkspace()');
    expect(composeForm.match(/expectedWorkspaceId,?\n/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('every fetch of a guarded route sends the x-expected-workspace header', () => {
    const ROUTES = [
      '/api/communication/reply',
      '/api/communication/suggest-reply',
      '/api/translate',
      '/api/stripe/buy-tokens',
      '/api/assistant',
    ];
    const callers = [...UI_FILES, ...sourceFiles('src/lib')].filter((f) => {
      const src = read(f);
      return ROUTES.some((r) => src.includes(`'${r}'`));
    });
    expect(callers.sort()).toEqual([
      'src/components/BuyTokensButtons.tsx',
      'src/components/CommunicationReply.tsx',
      'src/components/FollowUpApprovalRow.tsx',
      'src/lib/assistant/panel-state.ts',
    ]);
    for (const f of callers) {
      const src = read(f);
      const fetches = src.match(/fetch(Impl)?\(\s*'\/api\/[^']+'/g) ?? [];
      const guardedSpreads = src.match(/\.\.\.(guardHeaders|headers) \}/g) ?? [];
      expect(guardedSpreads.length, f).toBeGreaterThanOrEqual(fetches.length);
    }
    expect(read('src/components/AssistantPanel.tsx')).toContain('useExpectedWorkspaceHeaders()');
  });

  it('the app shell provides the page’s workspace and the switch notice', () => {
    // DS-07: the (app) layout renders the shell once for every page; the
    // shell's state (this session's workspace) is resolved in one place.
    expect(read('src/app/(app)/layout.tsx')).toContain('<AppShell>{children}</AppShell>');
    const shell = read('src/components/AppShell.tsx');
    expect(shell).toContain('<WorkspaceGuardProvider workspace={pageWorkspace}>');
    expect(shell).toContain('<WorkspaceSwitchNotice />');
    expect(shell).toContain('<WorkspaceDriftNotice />');
    expect(read('src/lib/shell/state.ts')).toContain('resolveSessionWorkspaceContext({');
  });

  it('links to /go are plain <a> (never prefetched by next/link)', () => {
    const offenders = UI_FILES.filter((f) => /<Link[^>]*href=\{?[^>]*\/go\?/.test(read(f)));
    expect(offenders).toEqual([]);
    expect(read('src/app/(app)/notifications/page.tsx')).toContain('notificationHref(n)');
  });
});

// ---- the claim ----------------------------------------------------------------

describe('expectedWorkspaceFromArgs', () => {
  it('reads the form field, an object argument, or nothing', () => {
    expect(expectedWorkspaceFromArgs(['7', claimedForm(12n)])).toBe(12n);
    expect(expectedWorkspaceFromArgs([{ expectedWorkspaceId: '9', to: 'x' }])).toBe(9n);
    expect(expectedWorkspaceFromArgs(['7', new FormData()])).toBeNull();
    expect(expectedWorkspaceFromArgs([claimedForm('nope')])).toBeNull();
    expect(expectedWorkspaceFromArgs([])).toBeNull();
  });
});

// ---- stale tabs against the database ------------------------------------------

interface World {
  s: QueueSetup;
  /** The workspace the stale page was rendered for (holds the mail, queue, items). */
  one: bigint;
  /** The workspace another tab switched this browser to. */
  two: bigint;
  token: string;
  itemId: bigint;
}

async function world(): Promise<World> {
  const s = await setupQueueWorkspace();
  await db.update(workspaces).set({ name: 'One' }).where(eq(workspaces.id, s.workspaceId));
  const two = await seedWorkspace({ name: 'Two', ownerUserId: s.ownerId });
  const { draft } = await queuedDraft(s, 'anna@target.test');
  await db.update(reviewItems).set({ state: 'new' }).where(eq(reviewItems.id, draft.reviewItemId));
  const minted = await createSessionForUser(s.ownerId);
  req.user = { id: s.ownerId };
  req.token = minted.sessionToken;
  req.referer = `http://app.test/review/${draft.reviewItemId}`;
  // The stale page renders: this browser works in One.
  expect((await getWorkspaceContext()).workspaceId).toBe(s.workspaceId);
  return { s, one: s.workspaceId, two, token: minted.sessionToken, itemId: draft.reviewItemId };
}

/** Another tab of the same browser switches to Two. */
async function switchInAnotherTab(w: World): Promise<void> {
  await setActiveWorkspaceAction(w.two.toString());
  expect((await getWorkspaceContext()).workspaceId).toBe(w.two);
}

async function snapshot(w: World) {
  const [audit] = await db.select({ n: count() }).from(auditLog);
  const [usage] = await db.select({ n: count() }).from(usageLog);
  const [mail] = await db.select({ n: count() }).from(mailMessages);
  const queue = await db
    .select({
      id: outreachQueue.id,
      status: outreachQueue.status,
      claimedAt: outreachQueue.claimedAt,
    })
    .from(outreachQueue)
    .orderBy(outreachQueue.id);
  const items = await db
    .select({ id: reviewItems.id, state: reviewItems.state })
    .from(reviewItems)
    .orderBy(reviewItems.id);
  const paused = await db
    .select({ id: workspaces.id, at: workspaces.automationPausedAt })
    .from(workspaces)
    .orderBy(workspaces.id);
  void w;
  return { audit: audit!.n, usage: usage!.n, mail: mail!.n, queue, items, paused };
}

beforeEach(async () => {
  await truncateAll();
  req.user = null;
  req.token = null;
  req.referer = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('a stale tab after a workspace switch (MOB-06)', () => {
  it('Approve gets workspace_changed and no review or audit row changes', async () => {
    const w = await world();
    await switchInAnotherTab(w);
    const before = await snapshot(w);
    const to = await expectRedirect(() =>
      reviewItemActions.approveReviewItemAction(
        w.itemId.toString(),
        claimedForm(w.one, { reason: 'fits' }),
      ),
    );
    expect(to).toBe(
      `/workspace-changed?ws=${w.one}&to=${encodeURIComponent(`/review/${w.itemId}`)}`,
    );
    expect(await snapshot(w)).toEqual(before);
  });

  it('Pause gets workspace_changed and neither workspace is paused', async () => {
    const w = await world();
    await switchInAnotherTab(w);
    const before = await snapshot(w);
    const to = await expectRedirect(() =>
      pauseActions.pauseAutomationAction(claimedForm(w.one, { returnTo: '/autopilot' })),
    );
    expect(to.startsWith(`/workspace-changed?ws=${w.one}`)).toBe(true);
    expect(await snapshot(w)).toEqual(before);
    expect(before.paused.every((p) => p.at === null)).toBe(true);
  });

  it('Send (the reply route) answers 409 workspace_changed and no mail row is written', async () => {
    const w = await world();
    await switchInAnotherTab(w);
    const before = await snapshot(w);
    const res = await replyPOST(
      new Request('http://app.test/api/communication/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...claimHeaders(w.one) },
        body: JSON.stringify({
          threadId: '1',
          mailboxId: w.s.mailboxId.toString(),
          to: 'anna@target.test',
          subject: 'Re: Quick question',
          body: 'Tuesday works.',
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'workspace_changed',
      expectedWorkspaceId: w.one.toString(),
      activeWorkspaceId: w.two.toString(),
    });
    expect(body.detail).toMatch(/Nothing was changed/);
    expect(body.detail).toContain('“One”');
    expect(body.detail).toContain('“Two”');
    expect(await snapshot(w)).toEqual(before);
  });

  it('Send from the compose page answers workspace_changed and sends nothing', async () => {
    const w = await world();
    await switchInAnotherTab(w);
    const before = await snapshot(w);
    const r = await composeActions.sendComposeAction({
      mailboxId: w.s.mailboxId.toString(),
      to: 'anna@target.test',
      cc: '',
      bcc: '',
      subject: 'Hello',
      body: 'Hi Anna',
      targetLanguage: '',
      translatedSubject: '',
      translatedBody: '',
      expectedWorkspaceId: w.one.toString(),
    });
    expect(r).toMatchObject({ ok: false, code: 'workspace_changed' });
    expect(await snapshot(w)).toEqual(before);
  });

  it('the send queue, bulk review, autopilot, buy-tokens and the assistant are refused the same way', async () => {
    const w = await world();
    await switchInAnotherTab(w);
    const before = await snapshot(w);
    const one = w.one.toString();
    for (const run of [
      () => queueActions.drainSendQueueAction(claimedForm(one)),
      () => queueActions.cancelQueuedEmailAction(claimedForm(one, { id: '1' })),
      () => reviewBulkActions.bulkArchiveAction(claimedForm(one, { ids: w.itemId.toString() })),
      () => autopilotActions.runAutopilotNowAction(claimedForm(one)),
      () =>
        autopilotActions.saveAutopilotDefaultsAction(claimedForm(one, { autopilotEnabled: 'on' })),
    ]) {
      expect((await expectRedirect(run)).startsWith(`/workspace-changed?ws=${one}`)).toBe(true);
    }
    for (const call of [
      () =>
        buyTokensPOST(
          new Request('http://app.test/api/stripe/buy-tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...claimHeaders(one) },
            body: JSON.stringify({ packId: 'pack_s' }),
          }),
        ),
      () =>
        assistantPOST(
          new Request('http://app.test/api/assistant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...claimHeaders(one) },
            body: JSON.stringify({ question: 'why no leads?' }),
          }),
        ),
    ]) {
      const res = await call();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('workspace_changed');
    }
    expect(await snapshot(w)).toEqual(before);
  });

  it('re-classify, the health check and the reply auto-actions are refused the same way', async () => {
    // Each spends AI tokens or decides what happens to inbound mail; a
    // stale tab must do neither in the workspace another tab switched to.
    const w = await world();
    await switchInAnotherTab(w);
    const before = await snapshot(w);
    const one = w.one.toString();
    for (const run of [
      () => engineActions.reclassifyAll(claimedForm(one)),
      () => healthActions.runHealthCheckNowAction(claimedForm(one)),
      () =>
        healthActions.saveHealthCheckSettingsAction(
          claimedForm(one, { enabled: 'on', intervalDays: '7' }),
        ),
      () =>
        replyAutoActions.saveReplyAutoActions(claimedForm(one, { autoSuppressUnsubscribe: 'on' })),
    ]) {
      expect((await expectRedirect(run)).startsWith(`/workspace-changed?ws=${one}`)).toBe(true);
    }
    expect(await snapshot(w)).toEqual(before);
  });

  it('a form without a claim fails closed', async () => {
    const w = await world();
    const before = await snapshot(w);
    const fd = new FormData();
    fd.set('reason', 'fits');
    const to = await expectRedirect(() =>
      reviewItemActions.approveReviewItemAction(w.itemId.toString(), fd),
    );
    expect(to.startsWith('/workspace-changed')).toBe(true);
    expect(to).not.toContain('ws=');
    expect(await snapshot(w)).toEqual(before);
  });

  it('the same form works once the browser is back in its workspace', async () => {
    const w = await world();
    await switchInAnotherTab(w);
    await setActiveWorkspaceAction(w.one.toString());
    const to = await expectRedirect(() =>
      reviewItemActions.approveReviewItemAction(
        w.itemId.toString(),
        claimedForm(w.one, { reason: 'fits' }),
      ),
    );
    expect(to).toBe(`/review/${w.itemId}`);
    const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, w.itemId));
    expect(row?.state).toBe('approved');
  });

  it('the checked workspace is pinned for the whole action, even if the session moves meanwhile', async () => {
    const w = await world();
    const probe = withWorkspaceGuard('review.approve', async (_fd: FormData) => {
      await setActiveWorkspaceAction(w.two.toString()); // another tab, mid-action
      return (await getWorkspaceContext()).workspaceId;
    });
    expect(await probe(claimedForm(w.one))).toBe(w.one);
    // Outside the action the session is in Two now.
    expect((await getWorkspaceContext()).workspaceId).toBe(w.two);
  });

  it('the refusal names only workspaces the user belongs to', async () => {
    const w = await world();
    const stranger = await seedUser({ email: 'stranger@mob06.test' });
    const foreign = await seedWorkspace({ name: 'Secret Corp', ownerUserId: stranger });
    const ctx = makeWorkspaceContext({ workspaceId: w.two, userId: w.s.ownerId, role: 'owner' });
    const named = await describeWorkspaceMismatch(ctx, w.one);
    expect(named.message).toContain('“One”');
    expect(named.message).toContain('“Two”');
    const hidden = await describeWorkspaceMismatch(ctx, foreign);
    expect(hidden.message).not.toContain('Secret Corp');
    const missing = await describeWorkspaceMismatch(ctx, null);
    expect(missing.message).toMatch(/did not say which workspace/);
  });

  it('/workspace-changed explains and offers to switch back through /go', async () => {
    const w = await world();
    await switchInAnotherTab(w);
    const html = await renderToHtml(
      await WorkspaceChangedPage({
        searchParams: Promise.resolve({ ws: w.one.toString(), to: `/review/${w.itemId}` }),
      }),
    );
    expect(html).toContain('This browser switched workspace');
    expect(html).toContain('opened in “One”');
    expect(html).toContain(
      `href="/go?ws=${w.one}&amp;to=${encodeURIComponent(`/review/${w.itemId}`)}"`,
    );
    expect(html).toContain('Continue in “Two”');
  });
});

// ---- the assistant remembers the workspace an answer belongs to ---------------

describe('assistant answers carry their workspace (MOB-06)', () => {
  it('settleAsk keeps workspaceId on the answer, and history never sends it back', () => {
    const outcome = settleAsk([], 'q', 200, {
      ok: true,
      answer: 'See [/drafts/12]',
      workspaceId: '4',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.turns[1]).toEqual({
      role: 'assistant',
      content: 'See [/drafts/12]',
      workspaceId: '4',
    });
    expect(historyToSend(outcome.turns)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'See [/drafts/12]' },
    ]);
  });

  it('a workspace_changed refusal shows the guard’s own sentence and is not retryable', () => {
    const outcome = settleAsk([], 'q', 409, {
      error: 'workspace_changed',
      detail: 'Nothing was changed: …',
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { message: 'Nothing was changed: …', retryable: false },
    });
  });
});
