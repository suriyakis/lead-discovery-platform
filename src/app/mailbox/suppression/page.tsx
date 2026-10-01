import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from '@/lib/services/context';
import {
  SUPPRESSION_SOURCE_LABELS,
  SuppressionServiceError,
  addSuppression,
  listSuppressions,
  revokeSuppression,
} from '@/lib/services/suppression';
import { listMembers } from '@/lib/services/workspace';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  suppressionKind,
  suppressionReason,
  type SuppressionEntry,
  type SuppressionReason,
} from '@/lib/db/schema/mailing';

// F-03 interim UI: Source column + admin Revoke on the existing markup.
// The DS Settings pass restyles this page later.

const PAGE = '/mailbox/suppression';

const REASONS: ReadonlyArray<{ key: SuppressionReason; label: string }> = [
  { key: 'manual', label: 'Manual' },
  { key: 'unsubscribe', label: 'Unsubscribe' },
  { key: 'bounce_hard', label: 'Bounce (hard)' },
  { key: 'bounce_soft', label: 'Bounce (soft)' },
  { key: 'complaint', label: 'Complaint' },
];

const REASON_LABELS = Object.fromEntries(
  REASONS.map((r) => [r.key, r.label]),
) as Record<SuppressionReason, string>;

const addForm = z.object({
  kind: z.enum(suppressionKind.enumValues).catch('email'),
  value: z.string().trim().min(1, 'Enter an email, domain or company.').max(320),
  reason: z.enum(suppressionReason.enumValues).catch('manual'),
  note: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => v || null),
});

const revokeForm = z.object({
  id: z.string().regex(/^\d+$/, 'Unknown entry.'),
  reason: z
    .string()
    .trim()
    .min(1, 'Say why this address may be emailed again.')
    .max(500, 'Keep the reason under 500 characters.'),
});

// Server actions live at module scope so they never close over
// component-local helpers.

async function addAction(formData: FormData): Promise<void> {
  'use server';
  const parsed = addForm.safeParse({
    kind: formData.get('kind') ?? undefined,
    value: formData.get('value') ?? '',
    reason: formData.get('reason') ?? undefined,
    note: formData.get('note') ?? undefined,
  });
  if (!parsed.success) {
    redirectWith({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' });
  }
  const { kind, value, reason, note } = parsed.data;
  try {
    const c = await getWorkspaceContext();
    const entry = await addSuppression(c, { kind, value, reason, note, source: 'manual' });
    // The upsert never weakens an existing entry; say so when it kept one.
    // (Messages travel in the query string, so they never echo the value.)
    const kept = entry.reason !== reason || entry.source !== 'manual';
    redirectWith({
      message: kept
        ? `Already suppressed as ${REASON_LABELS[entry.reason]} (${SUPPRESSION_SOURCE_LABELS[entry.source]}). That entry is kept; your add is recorded in the audit log.`
        : 'Suppression saved.',
    });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof SuppressionServiceError) {
      redirectWith({
        error:
          err.code === 'invalid_input'
            ? `That is not a valid ${kind}.`
            : err.code === 'permission_denied'
              ? 'Your role cannot add suppressions.'
              : 'Could not save the suppression.',
      });
    }
    throw err;
  }
}

async function revokeAction(formData: FormData): Promise<void> {
  'use server';
  const parsed = revokeForm.safeParse({
    id: formData.get('id') ?? '',
    reason: formData.get('reason') ?? '',
  });
  if (!parsed.success) {
    redirectWith({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' });
  }
  try {
    const c = await getWorkspaceContext();
    const revoked = await revokeSuppression(c, BigInt(parsed.data.id), parsed.data.reason);
    redirectWith({ message: `Revoked. That ${revoked.kind} can be emailed again.` });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof SuppressionServiceError) {
      redirectWith({
        error:
          err.code === 'permission_denied'
            ? 'Only workspace admins can revoke a suppression.'
            : err.code === 'already_revoked'
              ? 'That entry was already revoked.'
              : err.code === 'not_found'
                ? 'That entry no longer exists.'
                : err.message,
      });
    }
    throw err;
  }
}

function redirectWith(params: { message?: string; error?: string }): never {
  const q = new URLSearchParams();
  if (params.message) q.set('message', params.message);
  if (params.error) q.set('error', params.error);
  const qs = q.toString();
  redirect(qs ? `${PAGE}?${qs}` : PAGE);
}

function formatWhen(d: Date): string {
  return d.toLocaleString();
}

function formatSourceRef(ref: string): string {
  const m = /^mail_message:(\d+)$/.exec(ref);
  return m ? `message #${m[1]}` : ref;
}

export default async function SuppressionPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx: WorkspaceContext;
  let entries: SuppressionEntry[] = [];
  const names = new Map<string, string>();
  try {
    ctx = await getWorkspaceContext();
    entries = await listSuppressions(ctx, { includeRevoked: true });
    for (const m of await listMembers(ctx)) {
      names.set(m.user.id, m.user.name || m.user.email);
    }
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Suppression list</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </AppShell>
      );
    }
    throw err;
  }

  const isAdmin = canAdminWorkspace(ctx);
  const mayAdd = canWrite(ctx);
  const active = entries.filter((e) => !e.revokedAt);
  const revoked = entries.filter((e) => e.revokedAt);
  const who = (id: string | null) => (id ? names.get(id) ?? 'a former member' : null);

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/mailbox">Mailbox</Link> / Suppression
        </p>
        <h1>Suppression list</h1>
        <p className="muted">
          Addresses, domains and companies we will never email — checked
          before every outbound send. Entries come from unsubscribe links,
          bounces, reply classification, imports or manual adds; Source shows
          which. A weaker entry never replaces a stronger one. Revoking keeps
          the entry and its history; adding it again re-activates it.
        </p>
        {sp.message ? <p className="form-success">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        {mayAdd ? (
          <section>
            <h2>Add</h2>
            <form action={addAction} className="inline-form">
              <label>
                <span>Kind</span>
                <select name="kind" defaultValue="email">
                  <option value="email">Email</option>
                  <option value="domain">Domain (e.g. blocked.com)</option>
                  <option value="company">Company (matches contacts at)</option>
                </select>
              </label>
              <label>
                <span>Value</span>
                <input
                  type="text"
                  name="value"
                  required
                  placeholder="anna@example.com / example.com / Acme Inc"
                />
              </label>
              <label>
                <span>Reason</span>
                <select name="reason" defaultValue="manual">
                  {REASONS.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Note (optional)</span>
                <input type="text" name="note" maxLength={200} />
              </label>
              <button type="submit" className="primary-btn">
                Add
              </button>
            </form>
          </section>
        ) : null}

        <section>
          <h2>Active ({active.length})</h2>
          {!isAdmin && active.length > 0 ? (
            <p className="muted">Only workspace admins can revoke entries.</p>
          ) : null}
          {active.length === 0 ? (
            <p className="muted">No active suppressions.</p>
          ) : (
            <ul className="profile-list">
              {active.map((e) => (
                <li key={e.id.toString()}>
                  <div className="lead-row">
                    <span className="badge">{e.kind}</span>
                    <code>{e.value || e.address}</code>
                    <span className="muted">{REASON_LABELS[e.reason]}</span>
                    <span className="muted">
                      Source: {SUPPRESSION_SOURCE_LABELS[e.source]}
                      {e.sourceRef ? ` · ${formatSourceRef(e.sourceRef)}` : ''}
                    </span>
                    {e.expiresAt ? (
                      <span className="muted">until {formatWhen(e.expiresAt)}</span>
                    ) : null}
                  </div>
                  {e.note ? <p className="muted">{e.note}</p> : null}
                  <p className="muted">
                    Added {formatWhen(e.createdAt)}
                    {who(e.createdBy) ? ` by ${who(e.createdBy)}` : ''}
                  </p>
                  {isAdmin ? (
                    <form action={revokeAction} className="inline-form">
                      <input type="hidden" name="id" value={e.id.toString()} />
                      <label>
                        <span>Reason for revoking</span>
                        <input
                          type="text"
                          name="reason"
                          required
                          maxLength={500}
                          placeholder="Why may this be emailed again?"
                        />
                      </label>
                      <button type="submit" className="ghost-btn">
                        Revoke
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {revoked.length > 0 ? (
          <section>
            <h2>Revoked ({revoked.length})</h2>
            <p className="muted">
              No longer suppressed. Kept for the record; adding the same entry
              again re-activates it.
            </p>
            <ul className="profile-list">
              {revoked.map((e) => (
                <li key={e.id.toString()}>
                  <div className="lead-row">
                    <span className="badge">{e.kind}</span>
                    <code>{e.value || e.address}</code>
                    <span className="muted">{REASON_LABELS[e.reason]}</span>
                    <span className="muted">
                      Source: {SUPPRESSION_SOURCE_LABELS[e.source]}
                      {e.sourceRef ? ` · ${formatSourceRef(e.sourceRef)}` : ''}
                    </span>
                  </div>
                  <p className="muted">
                    Revoked {e.revokedAt ? formatWhen(e.revokedAt) : ''}
                    {who(e.revokedBy) ? ` by ${who(e.revokedBy)}` : ''}
                    {e.revokeReason ? `: ${e.revokeReason}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </AppShell>
  );
}
