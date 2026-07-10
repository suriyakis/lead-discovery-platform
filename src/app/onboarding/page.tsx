import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  ArrowRight,
  Check,
  CreditCard,
  Globe2,
  Inbox,
  ListChecks,
  Network,
  Radar,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import { getAvailablePlans, type PlanId } from '@/lib/billing/plans';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  BillingError,
  createCheckoutSession,
} from '@/lib/services/billing';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  OnboardingError,
  getOnboardingState,
  markOnboardingComplete,
  markOnboardingStarted,
  setSetupMode,
  type OnboardingStepKey,
  type SetupMode,
} from '@/lib/services/onboarding';

const STEP_ICONS: Record<OnboardingStepKey, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  setup: SlidersHorizontal,
  plan: CreditCard,
  ai: Sparkles,
  search: Globe2,
  mailbox: Inbox,
  product: ShoppingBag,
  connector: Network,
  run: Radar,
  review: ListChecks,
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; stripe?: string }>;
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

  async function chooseSetupMode(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const mode = String(formData.get('mode') ?? '') as SetupMode;
    try {
      await setSetupMode(c, mode);
      redirect('/onboarding');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof OnboardingError ? err.message : 'could not save setup mode';
      redirect(`/onboarding?msg=${encodeURIComponent(m)}`);
    }
  }

  async function startCheckout(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const planId = String(formData.get('planId') ?? '') as PlanId;
    if (planId !== 'starter' && planId !== 'pro') {
      redirect(`/onboarding?msg=${encodeURIComponent('Unknown plan id.')}`);
    }
    try {
      const result = await createCheckoutSession(c, {
        planId,
        successUrl: 'https://discover.nulife.pl/onboarding?stripe=success',
        cancelUrl: 'https://discover.nulife.pl/onboarding?stripe=canceled',
      });
      redirect(result.url);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof BillingError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'checkout failed';
      redirect(`/onboarding?msg=${encodeURIComponent(m)}`);
    }
  }

  const availablePlans = getAvailablePlans();
  const stripeBanner =
    sp.stripe === 'success'
      ? 'Subscription started — your workspace is now on a paid plan.'
      : sp.stripe === 'canceled'
        ? 'Checkout canceled — you can pick a plan whenever you’re ready.'
        : null;

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
        {stripeBanner ? (
          <p className={sp.stripe === 'success' ? 'form-success' : 'form-info'}>
            {stripeBanner}
          </p>
        ) : null}

        <div
          className="onboarding-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={totalSteps}
          aria-valuenow={completedSteps}
          aria-label={`${completedSteps} of ${totalSteps} setup steps complete`}
        >
          <div
            className="onboarding-progress-fill"
            style={{ width: `${Math.round((completedSteps / totalSteps) * 100)}%` }}
          />
        </div>

        <ol className="onboarding-list">
          {state.steps.map((step, i) => {
            const Icon = STEP_ICONS[step.key];
            const isNext = i === state.nextStepIdx;
            return (
              <li
                key={step.key}
                id={step.key}
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
                  {step.key === 'setup' ? (
                    <SetupModePicker
                      current={(state.workspace.setupMode ?? null) as SetupMode | null}
                      isAdmin={isAdmin}
                      chooseAction={chooseSetupMode}
                    />
                  ) : step.key === 'plan' ? (
                    <PlanPicker
                      plans={availablePlans}
                      currentPlan={state.workspace.plan}
                      currentStatus={state.workspace.subscriptionStatus}
                      hasSubscription={Boolean(state.workspace.stripeSubscriptionId)}
                      checkoutAction={startCheckout}
                    />
                  ) : (
                    <div className="action-row">
                      <Link
                        href={step.href}
                        className={step.done ? 'ghost-btn' : 'primary-btn'}
                      >
                        {step.done ? 'Review' : `Open ${step.title}`}{' '}
                        <ArrowRight className="primary-btn-icon" aria-hidden="true" />
                      </Link>
                    </div>
                  )}
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

function SetupModePicker({
  current,
  isAdmin,
  chooseAction,
}: {
  current: SetupMode | null;
  isAdmin: boolean;
  chooseAction: (formData: FormData) => Promise<void>;
}) {
  if (!isAdmin) {
    return (
      <p className="muted small">
        {current
          ? `This workspace is on the ${current} setup. Only workspace admins can change it.`
          : 'A workspace admin needs to pick the setup mode.'}
      </p>
    );
  }
  const modes: Array<{
    id: SetupMode;
    name: string;
    pitch: string;
    points: string[];
  }> = [
    {
      id: 'simple',
      name: 'Simple',
      pitch: 'Zero configuration. Recommended for most teams.',
      points: [
        'Runs on the platform’s system API keys — AI, web search, and storage are preconfigured',
        'Ready to work as soon as you have tokens or a subscription',
        'Usage is billed from your token balance',
        'You can switch to Advanced later at any time',
      ],
    },
    {
      id: 'advanced',
      name: 'Advanced',
      pitch: 'Same system defaults, full control when you want it.',
      points: [
        'Starts on the exact same system API keys as Simple',
        'Change the AI, web-search, embedding, or storage provider per workspace',
        'Bring your own API keys — BYOK usage is token-free',
        'Provider settings live under Settings → Integrations',
      ],
    },
  ];
  return (
    <div className="plan-picker">
      {modes.map((m) => {
        const isCurrent = current === m.id;
        return (
          <article
            key={m.id}
            className={isCurrent ? 'plan-card plan-card-current' : 'plan-card'}
          >
            <header className="plan-card-head">
              <h3>{m.name}</h3>
              {isCurrent ? <span className="badge badge-good">Selected</span> : null}
            </header>
            <p className="plan-pitch">{m.pitch}</p>
            <ul className="plan-features">
              {m.points.map((p) => (
                <li key={p}>
                  <Check className="plan-feature-icon" aria-hidden="true" /> {p}
                </li>
              ))}
            </ul>
            {isCurrent ? (
              <p className="muted small">
                Current setup. You can change it here or from{' '}
                <Link href="/settings/integrations">Integrations settings</Link>.
              </p>
            ) : (
              <form action={chooseAction}>
                <input type="hidden" name="mode" value={m.id} />
                <button type="submit" className="primary-btn">
                  {`Use ${m.name} setup`}
                </button>
              </form>
            )}
          </article>
        );
      })}
    </div>
  );
}

function PlanPicker({
  plans,
  currentPlan,
  currentStatus,
  hasSubscription,
  checkoutAction,
}: {
  plans: ReturnType<typeof getAvailablePlans>;
  currentPlan: string;
  currentStatus: string;
  hasSubscription: boolean;
  checkoutAction: (formData: FormData) => Promise<void>;
}) {
  if (plans.length === 0) {
    return (
      <p className="muted small">
        Plans are not configured yet (Stripe price IDs missing on the
        server). Trial mode stays active until billing is wired up.
      </p>
    );
  }
  return (
    <div className="plan-picker">
      {plans.map((p) => {
        const isCurrent = hasSubscription && currentPlan === p.id;
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
                {p.trialDays}-day free trial · card required, charged on day {p.trialDays + 1}
              </p>
            ) : null}
            <p className="plan-pitch">{p.pitch}</p>
            <ul className="plan-features">
              {p.features.map((f) => (
                <li key={f}>
                  <Check className="plan-feature-icon" aria-hidden="true" /> {f}
                </li>
              ))}
            </ul>
            {isCurrent ? (
              <p className="muted small">
                Current plan · status <code>{currentStatus}</code>. Manage from{' '}
                <Link href="/settings/billing">Billing settings</Link>.
              </p>
            ) : (
              <form action={checkoutAction}>
                <input type="hidden" name="planId" value={p.id} />
                <button type="submit" className="primary-btn">
                  {hasSubscription ? `Switch to ${p.name}` : `Choose ${p.name}`}
                </button>
              </form>
            )}
          </article>
        );
      })}
    </div>
  );
}
