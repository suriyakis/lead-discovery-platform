import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
} from '@/lib/services/suppression';
import type {
  SuppressionEntry,
  SuppressionKind,
  SuppressionReason,
} from '@/lib/db/schema/mailing';

const REASONS: ReadonlyArray<{ key: SuppressionReason; label: string }> = [
  { key: 'manual', label: 'Manual' },
  { key: 'unsubscribe', label: 'Unsubscribe' },
  { key: 'bounce_hard', label: 'Bounce (hard)' },
  { key: 'bounce_soft', label: 'Bounce (soft)' },
  { key: 'complaint', label: 'Complaint' },
];

export default async function SuppressionPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  let entries: SuppressionEntry[] = [];
  try {
    const ctx = await getWorkspaceContext();
    entries = await listSuppressions(ctx);
  } catch (err) {
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

  async function add(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const kindRaw = String(formData.get('kind') ?? 'email');
    const kind: SuppressionKind =
      kindRaw === 'domain' || kindRaw === 'company' ? kindRaw : 'email';
    const value = String(formData.get('value') ?? '');
    const reasonRaw = String(formData.get('reason') ?? 'manual');
    const reason: SuppressionReason = REASONS.some((r) => r.key === reasonRaw)
      ? (reasonRaw as SuppressionReason)
      : 'manual';
    const note = String(formData.get('note') ?? '').trim() || null;
    await addSuppression(c, { kind, value, reason, note });
    redirect('/mailbox/suppression');
  }

  async function remove(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const idRaw = String(formData.get('id') ?? '');
    if (/^\d+$/.test(idRaw)) {
      await removeSuppression(c, BigInt(idRaw));
    }
    redirect('/mailbox/suppression');
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/mailbox">Mailbox</Link> / Suppression
        </p>
        <h1>Suppression list</h1>
        <p className="muted">
          Addresses we will never email — checked before every outbound send.
          Hard bounces, unsubscribes, and complaints land here automatically
          (later phase); manual entries are also fine.
        </p>

        <section>
          <h2>Add</h2>
          <form action={add} className="inline-form">
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
              <select name="reason">
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

        <section>
          <h2>Entries ({entries.length})</h2>
          {entries.length === 0 ? (
            <p className="muted">No suppressions yet.</p>
          ) : (
            <ul className="profile-list">
              {entries.map((e) => (
                <li key={e.id.toString()}>
                  <div className="lead-row">
                    <span className="badge">{e.kind}</span>
                    <code>{e.value || e.address}</code>
                    <span className="muted">{e.reason}</span>
                    {e.expiresAt ? (
                      <span className="muted">
                        until {e.expiresAt.toLocaleString()}
                      </span>
                    ) : null}
                  </div>
                  {e.note ? <p className="muted">{e.note}</p> : null}
                  <div className="action-row" style={{ marginTop: '0.5rem' }}>
                    <form action={remove}>
                      <input type="hidden" name="id" value={e.id.toString()} />
                      <button type="submit" className="ghost-btn">
                        Remove
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </AppShell>
  );
}
