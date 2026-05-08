import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowRight,
  Check,
  CreditCard,
  Inbox,
  Network,
  ShoppingBag,
  Sparkles,
} from 'lucide-react';
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
  getOnboardingState,
  markOnboardingComplete,
  markOnboardingStarted,
  type OnboardingStepKey,
} from '@/lib/services/onboarding';

const STEP_ICONS: Record<OnboardingStepKey, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  plan: CreditCard,
  ai: Sparkles,
  mailbox: Inbox,
  product: ShoppingBag,
  connector: Network,
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
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

  // Bump 'pending' → 'in_progress' so the dashboard stops nagging once
  // the operator has at least seen the wizard.
  await markOnboardingStarted(ctx);

  const state = await getOnboardingState(ctx);
  const isAdmin = canAdminWorkspace(ctx);

  async function finish() {
    'use server';
    const c = await getWorkspaceContext();
    await markOnboardingComplete(c);
    redirect('/dashboard');
  }

  const completedSteps = state.steps.filter((s) => s.done).length;
  const totalSteps = state.steps.length;

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Setup</p>
          <h1 className="page-title">
            {state.effectivelyComplete
              ? 'Setup complete.'
              : `Let’s get you running.`}
          </h1>
          <p className="page-lede">
            {state.effectivelyComplete
              ? 'Every step is checked off. You can keep this page bookmarked or dismiss it for good — the dashboard will land you on the main view from now on.'
              : `${completedSteps} of ${totalSteps} steps done. Each step has a link to the page where it gets configured. The wizard auto-detects when you’ve finished a step on its own page — come back here to see the green checks.`}
          </p>
        </header>

        {sp.msg ? <p className="form-info">{sp.msg}</p> : null}

        <ol className="onboarding-list">
          {state.steps.map((step, i) => {
            const Icon = STEP_ICONS[step.key];
            const isNext = i === state.nextStepIdx;
            return (
              <li
                key={step.key}
                className={`onboarding-step ${step.done ? 'done' : ''} ${isNext ? 'next' : ''}`}
              >
                <div className="onboarding-step-icon" aria-hidden="true">
                  {step.done ? <Check /> : <Icon />}
                </div>
                <div className="onboarding-step-body">
                  <div className="onboarding-step-head">
                    <strong>{step.title}</strong>
                    {step.done ? (
                      <span className="badge badge-good">Done</span>
                    ) : isNext ? (
                      <span className="badge">Next</span>
                    ) : (
                      <span className="badge muted">Pending</span>
                    )}
                  </div>
                  <p className="onboarding-step-blurb">{step.blurb}</p>
                  {step.why && !step.done ? (
                    <p className="onboarding-step-why muted small">{step.why}</p>
                  ) : null}
                  <div className="action-row">
                    <Link
                      href={step.href}
                      className={step.done ? 'ghost-btn' : 'primary-btn'}
                    >
                      {step.done ? 'Review' : `Open ${step.title}`}{' '}
                      <ArrowRight className="primary-btn-icon" aria-hidden="true" />
                    </Link>
                    {step.key === 'plan' ? (
                      <span className="muted small" style={{ alignSelf: 'center' }}>
                        Trial: <code>{state.workspace.subscriptionStatus}</code>{' '}
                        on plan <code>{state.workspace.plan}</code>
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {isAdmin ? (
          <section style={{ marginTop: '2rem' }}>
            <form action={finish}>
              <button type="submit" className="primary-btn">
                {state.effectivelyComplete
                  ? 'Continue to dashboard'
                  : 'Skip for now — take me to the dashboard'}
              </button>
            </form>
            {!state.effectivelyComplete ? (
              <p className="muted small" style={{ marginTop: '0.5rem' }}>
                You can always come back to this wizard from <code>/onboarding</code>.
              </p>
            ) : null}
          </section>
        ) : (
          <section style={{ marginTop: '2rem' }}>
            <p className="muted small">
              Only workspace admins can finish the wizard.{' '}
              <Link href="/dashboard">Skip to dashboard.</Link>
            </p>
          </section>
        )}
      </div>
    </AppShell>
  );
}
