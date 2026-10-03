/* eslint-disable no-console */
/**
 * scripts/drill/phase1-drill.ts — the Phase 1 drill ("safe and
 * controllable"). Re-run it before every go-live; docs/drills/phase1-drill.md
 * is the runbook and the record of the last run.
 *
 * It builds a throwaway world and checks, against the REAL production
 * build (next start, ROLE=web) and the REAL worker (dist/worker/worker.cjs,
 * ROLE=worker) on BullMQ + Redis, with background jobs ON:
 *
 *   1. drain     60 queued emails go out through a local SMTP sink
 *   2. pause     a pause half-way stops the drain: no queue row is claimed
 *                after the pause time; the rest stay queued
 *   3. resume    resuming drains the rest, each email exactly once
 *   4. hold      under a Sending hold a manual compose is refused, nothing sent
 *   5. failing   the sink refuses logins: the mailbox goes failing (class
 *                auth) within 5 minutes, an ntfy alert is attempted (a local
 *                stub records it) and the emails stay queued, not failed
 *   6. recover   the sink accepts logins again; Test again recovers the
 *                mailbox and closes its incident
 *   7. outbox    the learning outbox has no pending event older than 15 min
 *                (a decision event seeded 20 minutes in the past is drained)
 *   8. ready     a stopped tick turns /api/ready 503 (after the 10-minute
 *                boot grace)
 *   9. findings  /health, /today, /api/attention and the assistant name the
 *                same problems (the stale tick among them)
 *
 * Nothing here touches production: the database must be a local one whose
 * name contains "drill" (it is DROPPED and re-created), mail goes to the
 * sink on 127.0.0.1, alerts to the stub on 127.0.0.1, AI and search run on
 * the mock providers.
 *
 * Usage (inside WSL, from the repo root):
 *
 *   pnpm build && pnpm build:worker          # or pass --build
 *   pnpm exec tsx scripts/drill/phase1-drill.ts [--build] [--keep] [--report <file.md>]
 *
 * Environment (all optional):
 *   DRILL_DATABASE_URL   default postgres://lead:lead@localhost:5432/lead_drill
 *   DRILL_REDIS_URL      use this Redis instead of starting a throwaway
 *                        container (docker run redis:7-alpine on :6391)
 *   DRILL_APP_PORT       default 3310
 *   DRILL_SMTP_PORT      default 2525      DRILL_NTFY_PORT   default 2580
 *
 * Exit code 0 when every check passed, 1 otherwise. The report (markdown)
 * goes to --report, or to a file under the OS temp directory.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { startNtfyStub, type NtfyStub } from './ntfy-stub';
import { startSmtpSink, type SmtpSink } from './smtp-sink';

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

const DATABASE_URL =
  process.env.DRILL_DATABASE_URL ?? 'postgres://lead:lead@localhost:5432/lead_drill';
const DB_NAME = new URL(DATABASE_URL).pathname.replace(/^\//, '');
if (!/drill/.test(DB_NAME)) {
  console.error(
    `refusing: the drill database must be a throwaway one named *drill* (got "${DB_NAME}")`,
  );
  process.exit(2);
}
const APP_PORT = Number(process.env.DRILL_APP_PORT ?? 3310);
const SMTP_PORT = Number(process.env.DRILL_SMTP_PORT ?? 2525);
const NTFY_PORT = Number(process.env.DRILL_NTFY_PORT ?? 2580);
const REDIS_CONTAINER = 'ldp-drill-redis';
const REDIS_URL = process.env.DRILL_REDIS_URL ?? 'redis://127.0.0.1:6391';
const APP_URL = `http://localhost:${APP_PORT}`;
const QUEUED = 60;
const HELD = 5;
const SINK_DELAY_MS = 1500;
const BOOT_GRACE_MS = 10 * 60 * 1000;
/** The tick the drill stops (30 s: stale ~90 s after its last start). */
const STOPPED_TICK = 'outreach.drain.tick';
const TICKS_QUEUE = 'lead-platform-ticks';

// Per-run secrets: generated here, handed to the child processes, never
// printed or written to the report.
const SECRETS = {
  masterKey: randomBytes(32).toString('hex'),
  authSecret: randomBytes(32).toString('hex'),
  readyToken: randomBytes(24).toString('hex'),
  ownerPassword: randomBytes(18).toString('base64url'),
  mailboxPassword: randomBytes(12).toString('hex'),
};
const MAILBOX_USER = 'drill-sender';
const OWNER_EMAIL = 'drill-owner@drill.example.test';
const ADMIN_EMAIL = 'drill-admin@drill.example.test';

/** The environment both the drill (in-process services) and its children run with. */
function drillEnv(): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  delete base.SCHEDULE_BACKGROUND_JOBS; // background jobs ON
  delete base.ENABLE_TEST_ROUTES;
  return {
    ...base,
    NODE_ENV: 'production',
    DATABASE_URL,
    REDIS_URL,
    JOB_QUEUE_PROVIDER: 'bullmq',
    MASTER_KEY: SECRETS.masterKey,
    AUTH_SECRET: SECRETS.authSecret,
    AUTH_URL: APP_URL,
    AUTH_TRUST_HOST: 'true',
    APP_URL,
    OPS_READY_TOKEN: SECRETS.readyToken,
    AI_PROVIDER: 'mock',
    SEARCH_PROVIDER: 'mock',
    STORAGE_PROVIDER: 'local',
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    PERPLEXITY_API_KEY: '',
    SERPAPI_API_KEY: '',
    STRIPE_SECRET_KEY: '',
    NTFY_URL: `http://127.0.0.1:${NTFY_PORT}`,
    NTFY_TOPIC: 'leadsonar-drill',
    NTFY_TOKEN: '',
    OPS_ALERT_MIN_SEVERITY: 'error',
  };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

interface CheckResult {
  id: string;
  title: string;
  ok: boolean;
  evidence: string[];
  ms: number;
}

const results: CheckResult[] = [];
const started = new Date();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[drill ${stamp()}] ${msg}`);

async function check(
  id: string,
  title: string,
  body: (evidence: string[]) => Promise<boolean>,
): Promise<boolean> {
  const evidence: string[] = [];
  const t0 = Date.now();
  log(`▶ ${id}: ${title}`);
  let ok = false;
  try {
    ok = await body(evidence);
  } catch (err) {
    evidence.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
    ok = false;
  }
  results.push({ id, title, ok, evidence, ms: Date.now() - t0 });
  log(`${ok ? '✔' : '✘'} ${id} (${Math.round((Date.now() - t0) / 1000)} s)`);
  for (const e of evidence) log(`    ${e}`);
  return ok;
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  everyMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
// infrastructure: database, redis, processes
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];
let runDir = '';
let redisStarted = false;

function run(cmd: string, argv: string[], env: NodeJS.ProcessEnv): void {
  execFileSync(cmd, argv, { cwd: ROOT, env, stdio: 'inherit' });
}

async function recreateDatabase(): Promise<void> {
  const admin = new URL(DATABASE_URL);
  admin.pathname = '/postgres';
  const sqlAdmin = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    await sqlAdmin.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await sqlAdmin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await sqlAdmin.end();
  }
  run('pnpm', ['-s', 'db:migrate'], drillEnv());
}

function startRedis(): void {
  if (process.env.DRILL_REDIS_URL) return;
  try {
    execFileSync('docker', ['rm', '-f', REDIS_CONTAINER], { stdio: 'ignore' });
  } catch {
    // not there
  }
  const port = new URL(REDIS_URL).port || '6391';
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      REDIS_CONTAINER,
      '-p',
      `127.0.0.1:${port}:6379`,
      'redis:7-alpine',
    ],
    { stdio: 'ignore' },
  );
  redisStarted = true;
}

function stopRedis(): void {
  if (!redisStarted) return;
  try {
    execFileSync('docker', ['stop', REDIS_CONTAINER], { stdio: 'ignore' });
  } catch {
    // already gone
  }
}

function startChild(
  name: string,
  cmd: string,
  argv: string[],
  extraEnv: Record<string, string>,
): ChildProcess {
  const out = createWriteStream(path.join(runDir, `${name}.log`));
  const env: NodeJS.ProcessEnv = { ...drillEnv(), ...extraEnv };
  const child: ChildProcess = spawn(cmd, argv, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
    log(`${name} exited (${signal ?? code})`),
  );
  children.push(child);
  return child;
}

async function stopChildren(): Promise<void> {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await sleep(5000);
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
}

// ---------------------------------------------------------------------------
// HTTP as the signed-in owner
// ---------------------------------------------------------------------------

let cookie = '';

async function http(
  pathname: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; json: () => unknown }> {
  const res = await fetch(`${APP_URL}${pathname}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) as unknown };
}

async function signIn(): Promise<void> {
  const res = await fetch(`${APP_URL}/api/auth/team-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: SECRETS.ownerPassword }),
  });
  if (res.status !== 200) throw new Error(`team-login answered ${res.status}`);
  const set = res.headers.getSetCookie();
  cookie = set.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('team-login set no cookie');
}

/** data-code values of the FindingList labelled `label` in `html`. */
/** The title of an ntfy publish: the JSON body's, else the Title header. */
function ntfyTitle(r: { title: string | null; body: string }): string {
  try {
    const j = JSON.parse(r.body) as { title?: unknown };
    if (typeof j.title === 'string') return j.title;
  } catch {
    // not JSON: a header-style publish
  }
  return r.title ?? r.body.slice(0, 120);
}

function codesInList(html: string, label: string): string[] | null {
  const start = html.indexOf(`aria-label="${label}"`);
  if (start < 0) return null;
  const end = html.indexOf('</ul>', start);
  const block = html.slice(start, end < 0 ? undefined : end);
  return [...block.matchAll(/data-code="([^"]+)"/g)].map((m) => m[1]!);
}

// ---------------------------------------------------------------------------
// the drill
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  runDir = mkdtempSync(path.join(os.tmpdir(), 'leadsonar-drill-'));
  log(`run directory (process logs): ${runDir}`);

  if (flag('--build')) {
    run('pnpm', ['-s', 'build'], drillEnv());
    run('pnpm', ['-s', 'build:worker'], drillEnv());
  }
  for (const f of ['.next/BUILD_ID', 'dist/worker/worker.cjs']) {
    if (!existsSync(path.join(ROOT, f))) {
      throw new Error(
        `${f} is missing: run pnpm build && pnpm build:worker first (or pass --build)`,
      );
    }
  }

  log(`database ${DB_NAME}: drop, create, migrate`);
  await recreateDatabase();

  // In-process services read the environment at import time.
  Object.assign(process.env, drillEnv());
  const [
    { db },
    schema,
    { makeWorkspaceContext },
    { makePlatformContext },
    { createWorkspace },
    { createMailbox, testMailboxConnection },
    { releaseOutreachLive },
    { pauseAutomation, resumeAutomation },
    { placeTenantHold, releaseTenantHold },
    { sendMessage },
    { buildComposeSendInput },
    drizzle,
    bcrypt,
  ] = await Promise.all([
    import('../../src/lib/db/client'),
    import('../../src/lib/db/schema'),
    import('../../src/lib/services/context'),
    import('../../src/lib/services/platform-context'),
    import('../../src/lib/services/workspace'),
    import('../../src/lib/services/mailbox'),
    import('../../src/lib/services/go-live'),
    import('../../src/lib/services/automation-pause'),
    import('../../src/lib/services/holds'),
    import('../../src/lib/services/mail'),
    import('../../src/app/(app)/mailbox/[id]/compose/compose-input'),
    import('drizzle-orm'),
    import('bcryptjs'),
  ]);
  const { and, eq, sql, inArray } = drizzle;
  const s = schema;

  // ---- seed ---------------------------------------------------------------
  log('seed: owner, super-admin, workspace, mailbox on the sink, send settings');
  const hash = await bcrypt.hash(SECRETS.ownerPassword, 10);
  const [owner] = await db
    .insert(s.users)
    .values({
      email: OWNER_EMAIL,
      name: 'Drill Owner',
      accountStatus: 'active',
      passwordHash: hash,
    })
    .returning();
  const [admin] = await db
    .insert(s.users)
    .values({
      email: ADMIN_EMAIL,
      name: 'Drill Admin',
      role: 'super_admin',
      accountStatus: 'active',
    })
    .returning();
  if (!owner || !admin) throw new Error('user seed failed');
  const { workspace } = await createWorkspace({
    name: 'Drill workspace',
    slug: `drill-${Date.now()}`,
    ownerUserId: owner.id,
  });
  const wsId = workspace.id;
  await db
    .update(s.workspaces)
    .set({ plan: 'pro', subscriptionStatus: 'active', tokenBalance: 1_000_000n })
    .where(eq(s.workspaces.id, wsId));
  await db.update(s.users).set({ activeWorkspaceId: wsId }).where(eq(s.users.id, owner.id));
  const ctx = makeWorkspaceContext({ workspaceId: wsId, userId: owner.id, role: 'owner' });
  const pctx = makePlatformContext(admin.id);

  const mailbox = await createMailbox(ctx, {
    name: 'Drill sender',
    fromAddress: 'sender@drill.example.test',
    fromName: 'Drill',
    smtpHost: '127.0.0.1',
    smtpPort: SMTP_PORT,
    smtpSecure: false,
    smtpUser: MAILBOX_USER,
    smtpPassword: SECRETS.mailboxPassword,
    imap: null,
    isDefault: true,
  });
  await db
    .insert(s.outreachSendSettings)
    .values({ workspaceId: wsId, dailyEmailLimit: 500, domainCooldownHours: 0 })
    .onConflictDoUpdate({
      target: s.outreachSendSettings.workspaceId,
      set: { dailyEmailLimit: 500, domainCooldownHours: 0 },
    });
  await db
    .insert(s.mailboxSendingLimits)
    .values({
      mailboxId: mailbox.id,
      workspaceId: wsId,
      maxPerDay: 1000,
      maxPerHour: 1000,
      maxPerDomain: 1000,
      minDelaySeconds: 0,
      maxDelaySeconds: 0,
      businessHoursOnly: false,
    })
    .onConflictDoUpdate({
      target: s.mailboxSendingLimits.mailboxId,
      set: { maxPerDay: 1000, maxPerHour: 1000, maxPerDomain: 1000, businessHoursOnly: false },
    });

  // The go-live hold: a new workspace is not live; the drill releases it
  // the way a super-admin does (audited).
  await releaseOutreachLive(pctx, wsId, 'Phase 1 drill: release the drill workspace');

  // A comment decision 20 minutes old whose learning event is still
  // pending (KL-02's outbox row): the sweeper must drain it before the
  // outbox check.
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
  const [decision] = await db
    .insert(s.learningDecisions)
    .values({
      workspaceId: wsId,
      decisionKey: `drill:${randomUUID()}`,
      kind: 'review.comment',
      origin: 'operator',
      subjectType: 'review_item',
      subjectId: null,
      userId: owner.id,
      createdAt: twentyMinutesAgo,
    })
    .returning({ id: s.learningDecisions.id });
  if (!decision) throw new Error('decision seed failed');
  const [seededEvent] = await db
    .insert(s.learningEvents)
    .values({
      workspaceId: wsId,
      userId: owner.id,
      actionType: 'comment',
      originalComment: 'Drill: a comment-only decision for the outbox sweeper.',
      decisionId: decision.id,
      origin: 'operator',
      processingStatus: 'pending',
      createdAt: twentyMinutesAgo,
    })
    .returning({ id: s.learningEvents.id });

  // ---- infrastructure -----------------------------------------------------
  const sink: SmtpSink = await startSmtpSink({
    smtpPort: SMTP_PORT,
    controlPort: null,
    user: MAILBOX_USER,
    password: SECRETS.mailboxPassword,
    delayMs: SINK_DELAY_MS,
  });
  const ntfy: NtfyStub = await startNtfyStub(NTFY_PORT);
  log(`SMTP sink on 127.0.0.1:${SMTP_PORT}, ntfy stub on 127.0.0.1:${NTFY_PORT}`);
  startRedis();
  await waitFor(
    'redis',
    async () => {
      try {
        const { Queue } = await import('bullmq');
        const q = new Queue(TICKS_QUEUE, { connection: redisConnection() });
        await q.getRepeatableJobs();
        await q.close();
        return true;
      } catch {
        return false;
      }
    },
    30_000,
    1000,
  );

  const workerBootAt = Date.now();
  startChild('worker', 'node', ['dist/worker/worker.cjs'], { ROLE: 'worker' });
  const webBootAt = Date.now();
  startChild('web', path.join(ROOT, 'node_modules/.bin/next'), ['start', '-p', String(APP_PORT)], {
    ROLE: 'web',
  });
  await waitFor(
    'the web server',
    async () => {
      try {
        return (await fetch(`${APP_URL}/api/health`)).status === 200;
      } catch {
        return false;
      }
    },
    120_000,
    1000,
  );
  await signIn();
  log('web (ROLE=web) and worker (ROLE=worker) are up; signed in as the drill owner');

  try {
    // ---- 1–3: drain, pause half-way, resume ------------------------------
    const queueRows = Array.from({ length: QUEUED }, (_, i) => ({
      workspaceId: wsId,
      mailboxId: mailbox.id,
      toAddresses: [`lead${String(i + 1).padStart(2, '0')}@recipient${i % 7}.drill.example.test`],
      subject: `Drill message ${String(i + 1).padStart(2, '0')}`,
      bodyText: `Phase 1 drill message ${i + 1}. Nobody receives this: it ends in a local sink.`,
      status: 'queued' as const,
      delayMode: 'immediate' as const,
      scheduledSendAt: new Date(Date.now() - 60_000),
    }));
    await db.insert(s.outreachQueue).values(queueRows);
    const countBy = async (status: string) =>
      Number(
        (
          await db
            .select({ n: sql<number>`count(*)::int` })
            .from(s.outreachQueue)
            .where(
              and(
                eq(s.outreachQueue.workspaceId, wsId),
                sql`${s.outreachQueue.status} = ${status}`,
              ),
            )
        )[0]?.n ?? 0,
      );

    let pausedAt: Date | null = null;
    await check('pause', `pause half-way through a ${QUEUED}-email drain`, async (ev) => {
      await waitFor('10 emails at the sink', async () => sink.state().received >= 10, 180_000, 500);
      await pauseAutomation(ctx, { reason: 'Phase 1 drill: pause mid-drain', source: 'api' });
      const [ws] = await db
        .select({ at: s.workspaces.automationPausedAt })
        .from(s.workspaces)
        .where(eq(s.workspaces.id, wsId));
      pausedAt = ws?.at ?? null;
      if (!pausedAt) throw new Error('the workspace has no automation_paused_at');
      const atPause = sink.state().received;
      ev.push(`paused at ${pausedAt.toISOString()} with ${atPause} emails at the sink`);
      // Two drain slots (30 s each) and then some.
      await sleep(75_000);
      const pausedIso = pausedAt.toISOString();
      const [late] = await db
        .select({
          n: sql<number>`count(*)::int`,
          max: sql<string | null>`max(${s.outreachQueue.claimedAt})::text`,
        })
        .from(s.outreachQueue)
        .where(
          and(
            eq(s.outreachQueue.workspaceId, wsId),
            sql`${s.outreachQueue.claimedAt} > ${pausedIso}::timestamptz`,
          ),
        );
      const [maxClaim] = await db
        .select({ max: sql<string | null>`max(${s.outreachQueue.claimedAt})::text` })
        .from(s.outreachQueue)
        .where(eq(s.outreachQueue.workspaceId, wsId));
      const after = sink.state().received;
      const queued = await countBy('queued');
      const sent = await countBy('sent');
      ev.push(
        `75 s later: ${after} at the sink (${after - atPause} finished in flight), sent=${sent}, queued=${queued}`,
      );
      ev.push(
        `rows claimed after the pause: ${late?.n ?? '?'}; latest claim ${maxClaim?.max ?? 'none'}`,
      );
      return Number(late?.n ?? -1) === 0 && queued > 0 && after - atPause <= 1 && sent === after;
    });

    await check('resume', 'resume drains the rest, each email exactly once', async (ev) => {
      await resumeAutomation(ctx, { reason: 'Phase 1 drill: resume', source: 'api' });
      sink.setDelay(0);
      await waitFor(
        `${QUEUED} sent`,
        async () => (await countBy('sent')) === QUEUED,
        300_000,
        2000,
      );
      const subjects = sink.messages().map((m) => m.subject);
      const unique = new Set(subjects);
      ev.push(
        `sent=${await countBy('sent')}, failed=${await countBy('failed')}, sink received ${subjects.length}, distinct subjects ${unique.size}`,
      );
      return subjects.length === QUEUED && unique.size === QUEUED;
    });

    // ---- 4: a Sending hold refuses a manual compose ---------------------
    await check('hold', 'a Sending hold refuses a manual compose', async (ev) => {
      const hold = await placeTenantHold(ctx, {
        scope: 'capabilities',
        capabilities: ['sending'],
        reason: 'Phase 1 drill: sending hold',
      });
      const before = sink.state().received;
      const built = buildComposeSendInput(
        {
          mailboxId: mailbox.id.toString(),
          to: 'someone@recipient0.drill.example.test',
          cc: '',
          bcc: '',
          subject: 'Drill compose under a hold',
          body: 'This must not be sent.',
          targetLanguage: '',
          translatedSubject: '',
          translatedBody: '',
        },
        'en',
      );
      if (!built.ok) throw new Error(built.error);
      let refusal = '';
      try {
        await sendMessage(ctx, built.input);
      } catch (err) {
        refusal = `${err instanceof Error ? err.name : 'error'}: ${err instanceof Error ? err.message : String(err)}`;
      }
      await sleep(2000);
      const after = sink.state().received;
      ev.push(refusal ? `refused — ${refusal}` : 'NOT refused: the compose went through');
      ev.push(`sink: ${before} before, ${after} after`);
      await releaseTenantHold(ctx, hold.id, 'Phase 1 drill: hold released');
      return refusal !== '' && after === before;
    });

    // ---- 5: the sink refuses logins → failing within 5 min, alert, held --
    await check(
      'failing',
      'refused logins: failing within 5 min, an ntfy alert, emails held',
      async (ev) => {
        sink.setAuth('reject');
        const alertsBefore = ntfy.requests().length;
        const t0 = Date.now();
        await db.insert(s.outreachQueue).values(
          Array.from({ length: HELD }, (_, i) => ({
            workspaceId: wsId,
            mailboxId: mailbox.id,
            toAddresses: [`held${i + 1}@recipient${i}.drill.example.test`],
            subject: `Drill held ${i + 1}`,
            bodyText: 'Phase 1 drill: sent while the mailbox refuses logins.',
            status: 'queued' as const,
            delayMode: 'immediate' as const,
            scheduledSendAt: new Date(Date.now() - 1000),
          })),
        );
        const failing = await waitFor(
          'the mailbox to go failing',
          async () => {
            const [m] = await db.select().from(s.mailboxes).where(eq(s.mailboxes.id, mailbox.id));
            return m?.status === 'failing' ? m : null;
          },
          5 * 60_000,
          2000,
        );
        const secs = Math.round((Date.now() - t0) / 1000);
        ev.push(
          `failing after ${secs} s, class ${failing.failureClass}, next probe ${failing.nextProbeAt?.toISOString() ?? 'none (a person acts)'}`,
        );
        const alert = await waitFor(
          'an ntfy alert',
          async () =>
            ntfy
              .requests()
              .slice(alertsBefore)
              .find((r) => /mailbox/i.test(`${r.title ?? ''} ${r.body}`)) ?? null,
          Math.max(30_000, 5 * 60_000 - (Date.now() - t0)),
          2000,
        ).catch(() => null);
        ev.push(
          alert
            ? `ntfy alert after ${Math.round((Date.parse(alert.at) - t0) / 1000)} s: "${ntfyTitle(alert)}"`
            : 'no ntfy alert recorded',
        );
        const held = await db
          .select({ status: s.outreachQueue.status, lastError: s.outreachQueue.lastError })
          .from(s.outreachQueue)
          .where(
            and(
              eq(s.outreachQueue.workspaceId, wsId),
              sql`${s.outreachQueue.subject} like 'Drill held %'`,
            ),
          );
        const statuses = held.map((h) => h.status);
        ev.push(
          `held emails: ${statuses.join(', ')}; e.g. "${(held[0]?.lastError ?? '').slice(0, 120)}"`,
        );
        return (
          secs <= 300 &&
          failing.failureClass === 'auth' &&
          alert !== null &&
          held.length === HELD &&
          statuses.every((st) => st === 'queued')
        );
      },
    );

    // ---- 6: recover --------------------------------------------------------
    await check('recover', 'logins accepted again: Test again recovers the mailbox', async (ev) => {
      sink.setAuth('accept');
      // Test again takes the mailbox's lease; a probe holding it for a
      // moment answers "busy": try again shortly, as a person would.
      let result: unknown = null;
      for (let attempt = 1; attempt <= 5 && result === null; attempt++) {
        try {
          result = await testMailboxConnection(ctx, mailbox.id);
        } catch (err) {
          if (attempt === 5) throw err;
          ev.push(
            `Test again attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
          );
          await sleep(5000);
        }
      }
      const [m] = await db.select().from(s.mailboxes).where(eq(s.mailboxes.id, mailbox.id));
      const open = await db
        .select({ id: s.opsEvents.id })
        .from(s.opsEvents)
        .where(
          and(
            eq(s.opsEvents.workspaceId, wsId),
            eq(s.opsEvents.kind, 'mailbox.failing'),
            sql`${s.opsEvents.resolvedAt} is null`,
          ),
        );
      ev.push(
        `Test again: SMTP ${(result as { smtp?: { ok?: boolean } } | null)?.smtp?.ok ? 'ok' : 'not ok'}; mailbox ${m?.status}, class ${m?.failureClass ?? 'none'}; open mailbox incidents: ${open.length}`,
      );
      return m?.status === 'active' && m.failureClass === null && open.length === 0;
    });

    // ---- 7: the learning outbox -------------------------------------------
    await check(
      'outbox',
      'the learning outbox has no pending event older than 15 minutes',
      async (ev) => {
        const oldPending = async () =>
          Number(
            (
              await db
                .select({ n: sql<number>`count(*)::int` })
                .from(s.learningEvents)
                .where(
                  and(
                    eq(s.learningEvents.processingStatus, 'pending'),
                    sql`${s.learningEvents.createdAt} < now() - interval '15 minutes'`,
                  ),
                )
            )[0]?.n ?? 0,
          );
        await waitFor(
          'the outbox sweeper',
          async () => (await oldPending()) === 0,
          6 * 60_000,
          5000,
        ).catch(() => null);
        const [seeded] = seededEvent
          ? await db
              .select({
                status: s.learningEvents.processingStatus,
                note: s.learningEvents.processingNote,
              })
              .from(s.learningEvents)
              .where(inArray(s.learningEvents.id, [seededEvent.id]))
          : [];
        const n = await oldPending();
        ev.push(
          `pending events older than 15 min: ${n}; the seeded 20-minute-old event is now ${seeded?.status ?? '?'}${seeded?.note ? ` (${seeded.note})` : ''}`,
        );
        if (seeded?.status === 'skipped_no_tokens') {
          ev.push(
            'it is closed and waits for a real AI provider: learning never extracts with the mock one, and the sweeper resumes it once one is configured',
          );
        }
        return n === 0;
      },
    );

    // ---- 8: a stopped tick fails readiness ---------------------------------
    await check('ready', `a stopped tick (${STOPPED_TICK}) turns /api/ready 503`, async (ev) => {
      const graceEnds = Math.max(workerBootAt, webBootAt) + BOOT_GRACE_MS + 15_000;
      if (Date.now() < graceEnds) {
        log(
          `waiting ${Math.round((graceEnds - Date.now()) / 1000)} s for the 10-minute boot grace to end`,
        );
        await sleep(graceEnds - Date.now());
      }
      const baseline = await http('/api/ready');
      ev.push(`before: /api/ready ${baseline.status}`);
      const { Queue } = await import('bullmq');
      const q = new Queue(TICKS_QUEUE, { connection: redisConnection() });
      let removed = 0;
      for (const r of await q.getRepeatableJobs()) {
        if (r.name === STOPPED_TICK && (await q.removeRepeatableByKey(r.key))) removed += 1;
      }
      await q.close();
      ev.push(`removed ${removed} repeatable schedule(s) of ${STOPPED_TICK}`);
      const t0 = Date.now();
      const failed = await waitFor(
        '/api/ready to fail',
        async () => {
          const r = await http('/api/ready', {
            headers: { authorization: `Bearer ${SECRETS.readyToken}` },
          });
          return r.status === 503 ? r : null;
        },
        5 * 60_000,
        5000,
      );
      const detail = failed.json() as { checks?: { ticks?: { stale?: string[] } } };
      const staleTicks = detail.checks?.ticks?.stale ?? [];
      ev.push(
        `503 after ${Math.round((Date.now() - t0) / 1000)} s; failing ticks: ${staleTicks.join(', ') || '(see body)'}`,
      );
      return baseline.status === 200 && removed > 0 && staleTicks.includes(STOPPED_TICK);
    });

    // ---- 9: one list of findings everywhere --------------------------------
    await check(
      'findings',
      '/health, /today, /api/attention and the assistant show the same findings',
      async (ev) => {
        let last = '';
        for (let attempt = 1; attempt <= 4; attempt++) {
          const health = await http('/health');
          const today = await http('/today');
          const attention = await http('/api/attention');
          const assistant = await http('/api/assistant', {
            method: 'POST',
            body: { question: 'What needs fixing in this workspace right now?' },
            headers: { 'x-expected-workspace': wsId.toString() },
          });
          const healthProblems = codesInList(health.text, 'Problems') ?? [];
          const todayProblems = codesInList(today.text, 'Problems in this workspace') ?? [];
          const attentionCodes =
            attention.status === 200
              ? ((attention.json() as { findings?: Array<{ code: string }> }).findings ?? []).map(
                  (f) => f.code,
                )
              : [];
          const assistantCodes =
            assistant.status === 200
              ? ((assistant.json() as { findings?: string[] }).findings ?? [])
              : [];
          last =
            `health ${health.status} [${healthProblems.join(', ')}] · today ${today.status} [${todayProblems.join(', ')}] · ` +
            `attention ${attention.status} [${attentionCodes.join(', ')}] · assistant ${assistant.status} [${assistantCodes.join(', ')}]`;
          const same =
            healthProblems.includes('jobs.stale') &&
            JSON.stringify(todayProblems) === JSON.stringify(healthProblems.slice(0, 5)) &&
            // /api/attention carries at most 20 problems, in the same order.
            JSON.stringify(attentionCodes) === JSON.stringify(healthProblems.slice(0, 20)) &&
            healthProblems.every((c) => assistantCodes.includes(c));
          if (same) {
            ev.push(last);
            return true;
          }
          // The engine memoises each workspace for 30 s: read again.
          await sleep(35_000);
        }
        ev.push(last);
        return false;
      },
    );
  } finally {
    if (flag('--keep')) {
      log(
        `--keep: leaving web :${APP_PORT}, the worker, the sink and Redis running (Ctrl-C to stop)`,
      );
    } else {
      await stopChildren();
      await sink.close();
      await ntfy.close();
      stopRedis();
    }
  }

  // ---- report -------------------------------------------------------------
  const okAll = results.every((r) => r.ok);
  const lines = [
    `# Phase 1 drill — ${started.toISOString()}`,
    '',
    `Commit ${gitHead()} · database ${DB_NAME} · BullMQ on ${process.env.DRILL_REDIS_URL ? 'DRILL_REDIS_URL' : 'a throwaway redis:7-alpine'} · web ROLE=web (next start) + worker ROLE=worker · background jobs ON`,
    '',
    `**Result: ${okAll ? 'PASS' : 'FAIL'}** (${results.filter((r) => r.ok).length}/${results.length} checks, ${Math.round((Date.now() - started.getTime()) / 60000)} min)`,
    '',
    '| Check | Result | Time | Evidence |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.id}: ${r.title} | ${r.ok ? 'pass' : '**FAIL**'} | ${Math.round(r.ms / 1000)} s | ${r.evidence.join('<br>').replace(/\|/g, '\\|')} |`,
    ),
    '',
    `Process logs: ${runDir}`,
  ];
  const reportPath = option('--report') ?? path.join(runDir, 'phase1-drill-report.md');
  writeFileSync(reportPath, lines.join('\n') + '\n');
  log(`report written to ${reportPath}`);
  console.log('\n' + lines.join('\n'));
  return okAll ? 0 : 1;
}

function redisConnection(): { host: string; port: number; maxRetriesPerRequest: null } {
  const u = new URL(REDIS_URL);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
}

function gitHead(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
}

main()
  .then((code) => {
    if (!flag('--keep')) process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error('[drill] aborted:', err instanceof Error ? (err.stack ?? err.message) : err);
    await stopChildren();
    stopRedis();
    process.exit(1);
  });
