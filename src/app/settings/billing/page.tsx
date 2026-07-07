import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Coins, CreditCard } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { BuyTokensButtons } from '@/components/BuyTokensButtons';
import { SettingsNav } from '@/components/SettingsNav';
import { auth } from '@/lib/auth';
import { getAvailablePlans, getPlanById } from '@/lib/billing/plans';
import { tokenPacks } from '@/lib/billing/tokens';
import { listTokenTransactions } from '@/lib/services/token-ledger';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  BillingError,
  createPortalSession,
} from '@/lib/services/billing';
import { canAdminWorkspace } from '@/lib/services/context';

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!ws) redirect('/');

  const isAdmin = canAdminWorkspace(ctx);
  const plan = getPlanById(ws.plan);
  const allPlans = getAvailablePlans();
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY?.trim());
  const packs = tokenPacks().map((p) => ({
    id: p.id,
    name: p.name,
    tokens: p.tokens,
    display: p.display,
    purchasable: Boolean(p.priceId) && stripeConfigured && isAdmin,
  }));
  const recentTokenTx = await listTokenTransactions(ctx, { limit: 15 });

  async function openPortal() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await createPortalSession(
        c,
        'https://discover.nulife.pl/settings/billing',
      );
      redirect(result.url);
    } catch (err) {
      const m =
        err instanceof BillingError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'portal failed';
      redirect(`/settings/billing?err=${encodeURIComponent(m)}`);
    }
  }

  const statusBadgeClass =
    ws.subscriptionStatus === 'active'
      ? 'badge badge-good'
      : ws.subscriptionStatus === 'trial'
        ? 'badge'
        : 'badge badge-bad';

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Billing</p>
          <h1 className="page-title">Subscription</h1>
          <p className="page-lede">
            Manage your plan, payment method, and invoices through Stripe&apos;s
            hosted billing portal.
          </p>
        </header>
        <SettingsNav />

        {sp.msg ? <p className="form-info">{sp.msg}</p> : null}
        {sp.err ? <p className="form-error">{sp.err}</p> : null}

        <section>
          <h2>
            <Coins className="lucide" aria-hidden="true" /> Tokens
          </h2>
          <div className="billing-summary">
            <dl>
              <dt>Balance</dt>
              <dd>
                <strong style={{ fontSize: '1.4rem' }}>
                  {ws.tokenBalance.toLocaleString()}
                </strong>{' '}
                <span className="muted">tokens</span>
                {ws.billingExempt ? (
                  <span className="badge" style={{ marginLeft: '0.5rem' }}>
                    billing exempt
                  </span>
                ) : null}
                {!ws.billingExempt && ws.tokenBalance <= 0n ? (
                  <span className="badge badge-bad" style={{ marginLeft: '0.5rem' }}>
                    empty — discovery, drafting and translation are paused
                  </span>
                ) : null}
              </dd>
            </dl>
          </div>
          <p className="muted small">
            Tokens are the prepaid currency for metered work: discovery search,
            AI qualification, outreach drafting, reply suggestions and
            translation. 1 token ≈ €0.01 of usage; every debit is itemised
            below. Actions running on your own API keys (BYOK) are free.
          </p>

          <BuyTokensButtons packs={packs} />

          {recentTokenTx.length > 0 ? (
            <details style={{ marginTop: '1rem' }}>
              <summary>Recent token activity ({recentTokenTx.length})</summary>
              <table className="data-table" style={{ marginTop: '0.5rem' }}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Change</th>
                    <th>Balance after</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTokenTx.map((t) => (
                    <tr key={t.id.toString()}>
                      <td>{t.createdAt.toLocaleString()}</td>
                      <td className={t.delta > 0n ? 'delta-good' : 'delta-bad'}>
                        {t.delta > 0n ? '+' : ''}
                        {t.delta.toLocaleString()}
                      </td>
                      <td>{t.balanceAfter.toLocaleString()}</td>
                      <td>
                        <code>{t.kind}</code> · {t.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
        </section>

        <section>
          <h2>Current plan</h2>
          <div className="billing-summary">
            <div className="billing-summary-icon" aria-hidden="true">
              <CreditCard />
            </div>
            <dl>
              <dt>Plan</dt>
              <dd>
                <strong>{plan?.name ?? ws.plan}</strong>
                {plan ? (
                  <span className="muted"> · {plan.displayPrice}</span>
                ) : null}
              </dd>
              <dt>Status</dt>
              <dd>
                <span className={statusBadgeClass}>{ws.subscriptionStatus}</span>
                {ws.trialEndsAt ? (
                  <span className="muted">
                    {' '}
                    trial ends {ws.trialEndsAt.toLocaleDateString()}
                  </span>
                ) : null}
              </dd>
              <dt>Stripe customer</dt>
              <dd>
                {ws.stripeCustomerId ? (
                  <code>{ws.stripeCustomerId}</code>
                ) : (
                  <span className="muted">not provisioned yet</span>
                )}
              </dd>
              <dt>Stripe subscription</dt>
              <dd>
                {ws.stripeSubscriptionId ? (
                  <code>{ws.stripeSubscriptionId}</code>
                ) : (
                  <span className="muted">no active subscription</span>
                )}
              </dd>
            </dl>
          </div>

          {isAdmin && stripeConfigured && ws.stripeCustomerId ? (
            <form action={openPortal} className="action-row" style={{ marginTop: '1rem' }}>
              <button type="submit" className="primary-btn">
                Manage subscription
              </button>
              <span className="muted small" style={{ alignSelf: 'center' }}>
                Opens Stripe&apos;s hosted billing portal — change plan, update card,
                cancel, view invoices.
              </span>
            </form>
          ) : !stripeConfigured ? (
            <p className="muted small">
              Stripe is not configured on the server (STRIPE_SECRET_KEY missing) —
              the platform owner needs to set it before billing can be managed in-app.
            </p>
          ) : !ws.stripeCustomerId ? (
            <p className="muted small">
              No Stripe customer yet. <Link href="/onboarding">Pick a plan</Link> to
              start a subscription.
            </p>
          ) : !isAdmin ? (
            <p className="muted small">Only admins can open the billing portal.</p>
          ) : null}
        </section>

        {allPlans.length > 0 ? (
          <section>
            <h2>Available plans</h2>
            <p className="muted small">
              To switch plan, open the billing portal above.
            </p>
            <div className="plan-picker">
              {allPlans.map((p) => {
                const isCurrent =
                  Boolean(ws.stripeSubscriptionId) && ws.plan === p.id;
                return (
                  <article
                    key={p.id}
                    className={isCurrent ? 'plan-card plan-card-current' : 'plan-card'}
                  >
                    <header className="plan-card-head">
                      <h3>{p.name}</h3>
                      <span className="plan-price">{p.displayPrice}</span>
                    </header>
                    {p.trialDays > 0 ? (
                      <p className="plan-trial-banner">
                        {p.trialDays}-day free trial · card required
                      </p>
                    ) : null}
                    <p className="plan-pitch">{p.pitch}</p>
                    <ul className="plan-features">
                      {p.features.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                    {isCurrent ? (
                      <p className="muted small">Your current plan.</p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
