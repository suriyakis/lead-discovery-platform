// Phase A: workspace-default toggles for staged outreach automation.
// autoDraftReplies governs whether inbound replies trigger an AI draft
// for human review; autoSendReplies governs whether high-confidence
// drafts go out without manual approval. Workspace-admin only.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  WorkspaceServiceError,
  getWorkspace,
  updateOutreachDefaults,
} from '@/lib/services/workspace';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function OutreachSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  let ws;
  try {
    ctx = await getWorkspaceContext();
    ws = await getWorkspace(ctx);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }
  if (!canAdminWorkspace(ctx)) {
    return (
      <AppShell>
        <h1>Outreach defaults</h1>
        <p className="form-error">Workspace-admin only.</p>
      </AppShell>
    );
  }

  async function save(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const autoDraftReplies = formData.get('autoDraftReplies') === 'on';
    const autoSendReplies = formData.get('autoSendReplies') === 'on';
    try {
      await updateOutreachDefaults(c, { autoDraftReplies, autoSendReplies });
      redirect('/settings/outreach?message=Saved');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof WorkspaceServiceError ? err.message : 'failed';
      redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/settings/integrations">Settings</Link> / Outreach
      </p>
      <h1>Outreach defaults</h1>
      <p className="page-lede">
        How the staged outreach engine handles replies on this workspace&apos;s
        threads. Both flags can be flipped per workspace; super-admin can
        also override per lead.
      </p>

      {sp.message ? <p className="form-info">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <form action={save} className="edit-draft-form">
        <fieldset className="ks-kind-fields">
          <legend className="muted">Reply automation</legend>

          <label className="checkbox-row">
            <input
              type="checkbox"
              name="autoDraftReplies"
              defaultChecked={ws.autoDraftReplies}
            />
            <span>
              <strong>Auto-draft replies</strong> — when an inbound message
              lands on an outreach thread, generate the next draft via AI
              and queue it for your review. <em>Recommended: ON.</em>
            </span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              name="autoSendReplies"
              defaultChecked={ws.autoSendReplies}
            />
            <span>
              <strong>Auto-send replies</strong> — when an auto-drafted reply
              has high enough confidence, send it without manual approval.
              Implies auto-draft. <em>Recommended: OFF</em> until you have
              several weeks of supervised drafts you&apos;re happy with.
            </span>
          </label>
        </fieldset>

        <div className="action-row">
          <button type="submit" className="primary-btn">Save</button>
          <Link href="/settings/integrations" className="ghost-btn">Cancel</Link>
        </div>
      </form>
    </AppShell>
  );
}
