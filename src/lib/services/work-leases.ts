// PC-12 (I064, I067, I068): work leases — the one guard against two
// processes (or two overlapping triggers in one process) doing the same
// work in a workspace at the same time.
//
// Before this, runOnce was entered from the 5-minute tick, Run now and the
// fire-and-forget post-crawl hook with no lock anywhere; drains overlapped
// through the 30 s tick, the post-crawl hook and "Send due emails now",
// each computing the daily cap once for itself; two syncs of one mailbox
// raced on the (workspace, message_id) unique index and the loser counted
// a spurious IMAP failure. Now each of those runs under a lease row
// (schema/work-leases.ts):
//
//   acquire  INSERT … ON CONFLICT (workspace, kind, resource) DO UPDATE …
//            WHERE work_leases.expires_at < clock_timestamp() — wins when
//            there is no row or the row expired (its holder crashed); a
//            live row means another holder: the caller gets `lease_held`
//            with who and since when, and does nothing.
//   renew    while it works: on a timer (ttl/3) for the kinds that run in
//            one call, or at the work's own checkpoints for discovery runs
//            (so a hung run stops renewing, like its progress heartbeat).
//            A holder gives its lease up after maxHoldMs: checkpoint()
//            answers false from then on, so a stuck pass cannot keep the
//            work locked for good.
//   release  DELETE … WHERE holder = token, in a finally.
//
// Every renew and release matches the holder token, so a holder whose
// lease expired and was taken over can neither renew nor delete the new
// holder's row; it learns at its next checkpoint() that it lost the lease
// and stops. Times are the database's (clock_timestamp()), never this
// process's, so the web and the worker process agree on expiry.

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import {
  WORK_LEASE_KINDS,
  workLeases,
  type WorkLeaseKind,
} from '@/lib/db/schema/work-leases';
import { formatUtc } from '@/lib/format-utc';
import { getBootInfo } from '@/lib/jobs/boot';
import type { WorkspaceContext } from './context';
import { PlatformContextError, isPlatformContext, type PlatformContext } from './platform-context';

export { WORK_LEASE_KINDS, type WorkLeaseKind };

/** How long a lease lasts without renewal, how long one holder may keep
 *  it, and whether a timer renews it (else the work's checkpoints do). */
export interface WorkLeasePolicy {
  ttlMs: number;
  maxHoldMs: number;
  autoRenew: boolean;
}

const MINUTE = 60_000;

/**
 * Per kind. The TTL bounds how long a crashed holder blocks the work; the
 * maximum hold bounds a holder that hangs while its timer keeps renewing.
 * Discovery runs renew at their progress checkpoints instead, with the
 * stuck-work reaper's no-progress window (RUN_STUCK_AFTER_MS, 15 min) as
 * the TTL: a run that stops making progress stops renewing too.
 */
export const WORK_LEASE_POLICY: Readonly<Record<WorkLeaseKind, WorkLeasePolicy>> = {
  // A run is capped per step; drafting is the slow part (an AI call per lead).
  'autopilot.run': { ttlMs: 2 * MINUTE, maxHoldMs: 30 * MINUTE, autoRenew: true },
  // At most 50 rows a pass, one SMTP submission (about 2 min worst case) each.
  'outreach.drain': { ttlMs: 2 * MINUTE, maxHoldMs: 15 * MINUTE, autoRenew: true },
  // Up to 100 due steps an hour, an AI composition each.
  'outreach.follow_up': { ttlMs: 2 * MINUTE, maxHoldMs: 50 * MINUTE, autoRenew: true },
  // One IMAP fetch of up to 100 messages, or one SMTP + IMAP check.
  'mailbox.sync': { ttlMs: 2 * MINUTE, maxHoldMs: 10 * MINUTE, autoRenew: true },
  'connector.recipe': { ttlMs: 15 * MINUTE, maxHoldMs: Number.POSITIVE_INFINITY, autoRenew: false },
};

/** Per-resource kinds key the lease by a mailbox or recipe id. */
const PER_RESOURCE: ReadonlySet<WorkLeaseKind> = new Set(['mailbox.sync', 'connector.recipe']);

export interface WorkLeaseSpec {
  kind: WorkLeaseKind;
  /** The mailbox / recipe id (required for the per-resource kinds). */
  resource?: bigint | string;
  /** Shown in the ops console: 'tick', 'manual', 'post-crawl', … */
  purpose?: string;
  /** Overrides of WORK_LEASE_POLICY[kind] (tests). */
  ttlMs?: number;
  maxHoldMs?: number;
  autoRenew?: boolean;
}

const SpecSchema = z
  .object({
    kind: z.enum(WORK_LEASE_KINDS),
    resource: z
      .union([z.bigint().nonnegative(), z.string().regex(/^\d{1,19}$/)])
      .optional(),
    purpose: z.string().max(200).optional(),
    ttlMs: z.number().int().min(10).max(24 * 60 * MINUTE).optional(),
    maxHoldMs: z.number().positive().optional(),
    autoRenew: z.boolean().optional(),
  })
  .refine((s) => PER_RESOURCE.has(s.kind) === (s.resource !== undefined), {
    message: 'a mailbox.sync / connector.recipe lease names its resource; the other kinds do not',
  });

/** Who holds a lease the caller could not take. */
export interface LeaseHolder {
  kind: WorkLeaseKind;
  resourceKey: string;
  holderLabel: string;
  purpose: string;
  acquiredAt: Date;
  expiresAt: Date;
}

/** "since 2026-10-02 09:14 UTC (tick, worker pid 7 on app-1)". */
export function describeLeaseHolder(held: Pick<LeaseHolder, 'acquiredAt' | 'purpose' | 'holderLabel'>): string {
  const what = held.purpose ? `${held.purpose}, ` : '';
  return `since ${formatUtc(held.acquiredAt)} (${what}${held.holderLabel})`;
}

export type AcquireResult =
  | { acquired: true; lease: WorkLease }
  | { acquired: false; held: LeaseHolder };

export type LeasedResult<T> =
  | { status: 'ran'; value: T }
  | { status: 'lease_held'; held: LeaseHolder };

/** This process, for people: "worker pid 7 on app-1, boot 1a2b3c4d". */
export function processLabel(): string {
  const role = process.env.ROLE?.trim().toLowerCase() || 'all';
  return `${role} pid ${process.pid} on ${hostname()}, boot ${getBootInfo().id.slice(0, 8)}`;
}

function expiresIn(ttlMs: number): SQL {
  return sql`clock_timestamp() + (${ttlMs}::integer * interval '1 millisecond')`;
}

function keyOf(workspaceId: bigint, kind: WorkLeaseKind, resourceKey: string): SQL {
  return and(
    eq(workLeases.workspaceId, workspaceId),
    eq(workLeases.kind, kind),
    eq(workLeases.resourceKey, resourceKey),
  ) as SQL;
}

/**
 * A lease this process holds. Ask checkpoint() between items of work: it
 * renews when a renewal is due and answers whether the lease is still
 * this holder's (false once it was lost, released or held for maxHoldMs).
 */
export class WorkLease {
  readonly workspaceId: bigint;
  readonly kind: WorkLeaseKind;
  readonly resourceKey: string;
  /** This acquisition's token (work_leases.holder). */
  readonly token: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  private readonly policy: WorkLeasePolicy;
  private readonly startedMs = Date.now();
  private lastRenewMs = Date.now();
  private lostLease = false;
  private released = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(input: {
    workspaceId: bigint;
    kind: WorkLeaseKind;
    resourceKey: string;
    token: string;
    acquiredAt: Date;
    expiresAt: Date;
    policy: WorkLeasePolicy;
  }) {
    this.workspaceId = input.workspaceId;
    this.kind = input.kind;
    this.resourceKey = input.resourceKey;
    this.token = input.token;
    this.acquiredAt = input.acquiredAt;
    this.expiresAt = input.expiresAt;
    this.policy = input.policy;
    if (this.policy.autoRenew) {
      this.timer = setInterval(() => void this.tick(), this.renewEveryMs);
      // Never keeps a process (or a test run) alive on its own.
      this.timer.unref?.();
    }
  }

  private get renewEveryMs(): number {
    return Math.max(5, Math.floor(this.policy.ttlMs / 3));
  }

  private get overMaxHold(): boolean {
    return Date.now() - this.startedMs >= this.policy.maxHoldMs;
  }

  /** True once another holder took the lease over (it expired first). */
  get lost(): boolean {
    return this.lostLease;
  }

  private async tick(): Promise<void> {
    if (this.overMaxHold) {
      this.stopTimer();
      return;
    }
    try {
      await this.renew();
    } catch (err) {
      // A failed renewal (database unreachable) is retried on the next
      // tick; if the lease expires meanwhile, checkpoint() finds out.
      console.error(
        `[work-lease] ${this.kind} ws=${this.workspaceId} renewal failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Extend the lease by its TTL. False when it is no longer this
   *  holder's (taken over after it expired) or already released. */
  async renew(): Promise<boolean> {
    if (this.lostLease || this.released) return false;
    const rows = await db
      .update(workLeases)
      .set({ renewedAt: sql`clock_timestamp()`, expiresAt: expiresIn(this.policy.ttlMs) })
      .where(
        and(keyOf(this.workspaceId, this.kind, this.resourceKey), eq(workLeases.holder, this.token)),
      )
      .returning({ holder: workLeases.holder });
    if (rows.length === 0) {
      this.lostLease = true;
      this.stopTimer();
      return false;
    }
    this.lastRenewMs = Date.now();
    return true;
  }

  /**
   * May the holder go on with its next item? Renews when a renewal is due
   * (a third of the TTL since the last one). False once the lease was
   * lost, released, or held for maxHoldMs — the holder stops there and
   * leaves the rest for the next pass.
   */
  async checkpoint(): Promise<boolean> {
    if (this.lostLease || this.released) return false;
    if (this.overMaxHold) {
      this.stopTimer();
      return false;
    }
    if (Date.now() - this.lastRenewMs >= this.renewEveryMs) return this.renew();
    return true;
  }

  /** Delete the row (only while it is still this holder's). Idempotent. */
  async release(): Promise<void> {
    this.stopTimer();
    if (this.released) return;
    this.released = true;
    await db
      .delete(workLeases)
      .where(
        and(keyOf(this.workspaceId, this.kind, this.resourceKey), eq(workLeases.holder, this.token)),
      );
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Take the lease, or learn who holds it. A row that exists but has
 * expired (its holder crashed or hung past its TTL) is taken over.
 */
export async function acquireWorkLease(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  input: WorkLeaseSpec,
): Promise<AcquireResult> {
  const spec = SpecSchema.parse(input);
  const policy: WorkLeasePolicy = {
    ttlMs: spec.ttlMs ?? WORK_LEASE_POLICY[spec.kind].ttlMs,
    maxHoldMs: spec.maxHoldMs ?? WORK_LEASE_POLICY[spec.kind].maxHoldMs,
    autoRenew: spec.autoRenew ?? WORK_LEASE_POLICY[spec.kind].autoRenew,
  };
  const resourceKey = spec.resource === undefined ? '' : spec.resource.toString();
  const label = processLabel();

  // A release can land between our insert and the read of the holder;
  // then the key is free again and the next attempt takes it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomUUID();
    const [won] = await db
      .insert(workLeases)
      .values({
        workspaceId: ctx.workspaceId,
        kind: spec.kind,
        resourceKey,
        holder: token,
        holderLabel: label,
        purpose: spec.purpose ?? '',
        acquiredAt: sql`clock_timestamp()`,
        renewedAt: sql`clock_timestamp()`,
        expiresAt: expiresIn(policy.ttlMs),
      })
      .onConflictDoUpdate({
        target: [workLeases.workspaceId, workLeases.kind, workLeases.resourceKey],
        set: {
          holder: sql`excluded.holder`,
          holderLabel: sql`excluded.holder_label`,
          purpose: sql`excluded.purpose`,
          acquiredAt: sql`excluded.acquired_at`,
          renewedAt: sql`excluded.renewed_at`,
          expiresAt: sql`excluded.expires_at`,
        },
        setWhere: sql`${workLeases.expiresAt} < clock_timestamp()`,
      })
      .returning({
        holder: workLeases.holder,
        acquiredAt: workLeases.acquiredAt,
        expiresAt: workLeases.expiresAt,
      });
    if (won && won.holder === token) {
      return {
        acquired: true,
        lease: new WorkLease({
          workspaceId: ctx.workspaceId,
          kind: spec.kind,
          resourceKey,
          token,
          acquiredAt: won.acquiredAt,
          expiresAt: won.expiresAt,
          policy,
        }),
      };
    }
    const [current] = await db
      .select()
      .from(workLeases)
      .where(keyOf(ctx.workspaceId, spec.kind, resourceKey))
      .limit(1);
    if (current) {
      return {
        acquired: false,
        held: {
          kind: spec.kind,
          resourceKey,
          holderLabel: current.holderLabel,
          purpose: current.purpose,
          acquiredAt: current.acquiredAt,
          expiresAt: current.expiresAt,
        },
      };
    }
  }
  throw new Error(`work lease ${spec.kind} could not be acquired or read (released under us 3 times)`);
}

/**
 * Run `fn` under the lease, releasing it afterwards whatever happens; or,
 * when another holder has it, do nothing and say who.
 */
export async function withWorkLease<T>(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  spec: WorkLeaseSpec,
  fn: (lease: WorkLease) => Promise<T>,
): Promise<LeasedResult<T>> {
  const got = await acquireWorkLease(ctx, spec);
  if (!got.acquired) return { status: 'lease_held', held: got.held };
  try {
    return { status: 'ran', value: await fn(got.lease) };
  } finally {
    try {
      await got.lease.release();
    } catch (err) {
      // It expires on its own after its TTL.
      console.error(
        `[work-lease] ${spec.kind} ws=${ctx.workspaceId} release failed (it expires on its own):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** The live (unexpired) holder of this lease, or null when nobody holds
 *  it right now. */
export async function liveWorkLease(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  kind: WorkLeaseKind,
  resource?: bigint | string,
): Promise<LeaseHolder | null> {
  const resourceKey = resource === undefined ? '' : resource.toString();
  const [row] = await db
    .select({
      holderLabel: workLeases.holderLabel,
      purpose: workLeases.purpose,
      acquiredAt: workLeases.acquiredAt,
      expiresAt: workLeases.expiresAt,
    })
    .from(workLeases)
    .where(
      and(
        keyOf(ctx.workspaceId, kind, resourceKey),
        sql`${workLeases.expiresAt} > clock_timestamp()`,
      ),
    )
    .limit(1);
  return row ? { kind, resourceKey, ...row } : null;
}

/** Is someone holding this lease right now (not expired)? */
export async function isWorkLeaseLive(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  kind: WorkLeaseKind,
  resource?: bigint | string,
): Promise<boolean> {
  return (await liveWorkLease(ctx, kind, resource)) !== null;
}

/**
 * PC-12: could the pass holding this lease right now have made a claim at
 * `claimedAt`? Only when it took the lease at or before then; a claim
 * older than the live lease belongs to a pass that is gone. Used by the
 * stuck-work reaper so it never settles a slow pass's live claim.
 */
export function leaseCoversClaim(live: LeaseHolder | null, claimedAt: Date): boolean {
  return live !== null && live.acquiredAt.getTime() <= claimedAt.getTime();
}

export interface WorkLeaseView extends LeaseHolder {
  workspaceId: bigint;
  renewedAt: Date;
  /** False: the holder neither renewed nor released it (it died); the
   *  next acquire takes it over. */
  live: boolean;
}

/**
 * The ops console's read model: every lease row, live ones first, then
 * the expired ones a dead holder left behind. Platform scope only.
 */
export async function listWorkLeases(ctx: PlatformContext): Promise<WorkLeaseView[]> {
  if (!isPlatformContext(ctx)) {
    throw new PlatformContextError('listWorkLeases needs a PlatformContext');
  }
  const live = sql<boolean>`${workLeases.expiresAt} > clock_timestamp()`;
  const rows = await db
    .select({
      workspaceId: workLeases.workspaceId,
      kind: workLeases.kind,
      resourceKey: workLeases.resourceKey,
      holderLabel: workLeases.holderLabel,
      purpose: workLeases.purpose,
      acquiredAt: workLeases.acquiredAt,
      renewedAt: workLeases.renewedAt,
      expiresAt: workLeases.expiresAt,
      live,
    })
    .from(workLeases)
    .orderBy(sql`${live} DESC`, asc(workLeases.workspaceId), asc(workLeases.kind), asc(workLeases.resourceKey));
  return rows.map((r) => ({ ...r, kind: r.kind as WorkLeaseKind, live: r.live === true }));
}
