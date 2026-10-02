// Phase 27: Autopilot console. Reorganized around an "Autonomous Flow"
// visualization at the top + a scope picker that lets the operator
// switch between Workspace-default settings and per-product overrides.
//
// PC-05: the "Emergency pause (kill switch)" checkbox (which wrote
// autopilot_settings.emergency_pause and stopped autopilot runs only) is
// replaced by the workspace pause control (#pause): one standalone action
// that stops every kind of automatic work, never plan-gated.
//
// PC-13: the page says what really runs. The flow view is rendered from
// resolveAutomationPolicy (autopilotFlow) — the send queue is shown as
// always on in the background, and a paused product holds its mail. The
// dead "Sync inbound mail" and "Auto-drain the send queue" switches are
// gone (I019). Per-product overrides are narrow-only — inherit or off, a
// higher threshold — and enforced (I020); a product is paused with its own
// Pause / Resume. The full consolidation into /automation is PC-34.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { cx } from '@/lib/ui/cx';
import styles from './autopilot.module.css';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace, canWrite } from '@/lib/services/context';
import {
  AutopilotError,
  clearProductAutopilotSettings,
  getAutopilotSettings,
  getProductAutopilotSettings,
  listAutopilotLog,
  listProductAutopilotSettings,
  pauseProductAutomation,
  resumeProductAutomation,
  runOnce,
  updateAutopilotSettings,
  upsertProductAutopilotSettings,
} from '@/lib/services/autopilot';
import {
  autopilotFlow,
  productPolicy,
  resolveAutomationPolicy,
  type FlowStep,
  type ProductPolicy,
} from '@/lib/services/automation-policy';
import { listMailboxes } from '@/lib/services/mailbox';
import { listCrmConnections } from '@/lib/services/crm';
import { listProductProfiles } from '@/lib/services/product-profile';
import type { AutopilotSettings, AutopilotProductSettings } from '@/lib/db/schema/autopilot';
import type { ProductProfile } from '@/lib/db/schema/products';
import { isNextRedirectError } from '@/lib/server-redirect';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { AutomationPauseControl } from '@/components/AutomationPauseControl';
import { clearAutopilotOverridesConfirm, resumeProductConfirm } from '@/lib/confirm-copy';
import { getAutomationPauseOverview } from '@/lib/services/automation-pause';
import { PlanLimitError } from '@/lib/services/plan-limits';

export default async function AutopilotPage({
  searchParams,
}: {
  searchParams: Promise<{
    message?: string;
    error?: string;
    /** "default" or a productProfileId. */
    scope?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  const [base, log, mailboxes, crmConns, products, productOverlays, pauseOverview] =
    await Promise.all([
      getAutopilotSettings(ctx),
      listAutopilotLog(ctx, 100),
      listMailboxes(ctx),
      listCrmConnections(ctx),
      listProductProfiles(ctx, { includeArchived: false }),
      listProductAutopilotSettings(ctx),
      getAutomationPauseOverview(ctx),
    ]);
  // After getAutopilotSettings, so the policy sees the settings row.
  const policy = await resolveAutomationPolicy(ctx);
  const overlayByProduct = new Map(
    productOverlays.map((o) => [o.productProfileId.toString(), o]),
  );

  const canEdit = canAdminWorkspace(ctx);

  // Resolve current scope from searchParams.
  const productId =
    sp.scope && /^\d+$/.test(sp.scope) ? BigInt(sp.scope) : null;
  const product = productId
    ? products.find((p) => p.id === productId) ?? null
    : null;

  const flow = autopilotFlow(policy, product ? product.id : null);
  const resolved = product ? productPolicy(policy, product.id) : null;
  const overlay = product
    ? await getProductAutopilotSettings(ctx, product.id)
    : null;

  async function saveDefault(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const num = (k: string) => {
      const v = String(formData.get(k) ?? '');
      return /^\d+$/.test(v) ? Number(v) : undefined;
    };
    const big = (k: string) => {
      const v = String(formData.get(k) ?? '');
      return /^\d+$/.test(v) ? BigInt(v) : null;
    };
    try {
      await updateAutopilotSettings(c, {
        autopilotEnabled: formData.get('autopilotEnabled') === 'on',
        enableAutoApproveProjects: formData.get('enableAutoApproveProjects') === 'on',
        autoApproveThreshold: num('autoApproveThreshold'),
        enableAutoEnqueueOutreach: formData.get('enableAutoEnqueueOutreach') === 'on',
        enableAutoCrmContactSync: formData.get('enableAutoCrmContactSync') === 'on',
        enableAutoCrmDealOnQualified: formData.get('enableAutoCrmDealOnQualified') === 'on',
        maxApprovalsPerRun: num('maxApprovalsPerRun'),
        maxEnqueuesPerRun: num('maxEnqueuesPerRun'),
        defaultMailboxId: big('defaultMailboxId'),
        defaultCrmConnectionId: big('defaultCrmConnectionId'),
      });
      redirect('/autopilot?message=Workspace+defaults+saved');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      // I063: a lapsed plan's refusal says why instead of "failed"; only
      // switching something ON is refused (PC-13).
      const m =
        err instanceof AutopilotError || err instanceof PlanLimitError ? err.message : 'failed';
      redirect(`/autopilot?error=${encodeURIComponent(m)}`);
    }
  }

  async function saveProductOverlay(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const pid = BigInt(String(formData.get('productProfileId')));
    // PC-13: two states per switch — "inherit" or "off" (narrow-only).
    const narrow = (k: string): false | null | undefined => {
      const v = String(formData.get(k) ?? '');
      if (v === 'inherit') return null;
      if (v === 'off') return false;
      return undefined;
    };
    const num = (k: string): number | null | undefined => {
      const v = String(formData.get(k) ?? '');
      if (v === '' || v === 'inherit') return null;
      return /^\d+$/.test(v) ? Number(v) : undefined;
    };
    const big = (k: string): bigint | null | undefined => {
      const v = String(formData.get(k) ?? '');
      if (v === '' || v === 'inherit') return null;
      return /^\d+$/.test(v) ? BigInt(v) : undefined;
    };
    try {
      await upsertProductAutopilotSettings(c, {
        productProfileId: pid,
        autopilotEnabled: narrow('autopilotEnabled'),
        enableAutoApproveProjects: narrow('enableAutoApproveProjects'),
        autoApproveThreshold: num('autoApproveThreshold'),
        enableAutoEnqueueOutreach: narrow('enableAutoEnqueueOutreach'),
        enableAutoCrmContactSync: narrow('enableAutoCrmContactSync'),
        enableAutoCrmDealOnQualified: narrow('enableAutoCrmDealOnQualified'),
        defaultMailboxId: big('defaultMailboxId'),
      });
      redirect(`/autopilot?scope=${pid}&message=Product+overrides+saved`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AutopilotError ? err.message : 'failed';
      redirect(`/autopilot?scope=${pid}&error=${encodeURIComponent(m)}`);
    }
  }

  async function clearOverlay(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const pid = BigInt(String(formData.get('productProfileId')));
    await clearProductAutopilotSettings(c, pid);
    redirect(`/autopilot?scope=${pid}&message=Overrides+cleared`);
  }

  async function pauseProduct(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const pid = BigInt(String(formData.get('productProfileId')));
    try {
      const r = await pauseProductAutomation(c, pid);
      redirect(
        `/autopilot?scope=${pid}&message=${encodeURIComponent(
          r.alreadyPaused ? 'This product was already paused.' : 'Product paused: its automation and outbound mail wait.',
        )}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AutopilotError ? err.message : 'failed';
      redirect(`/autopilot?scope=${pid}&error=${encodeURIComponent(m)}`);
    }
  }

  async function resumeProduct(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const pid = BigInt(String(formData.get('productProfileId')));
    try {
      await resumeProductAutomation(c, pid);
      redirect(`/autopilot?scope=${pid}&message=Product+resumed`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AutopilotError ? err.message : 'failed';
      redirect(`/autopilot?scope=${pid}&error=${encodeURIComponent(m)}`);
    }
  }

  async function runNow() {
    'use server';
    const c = await getWorkspaceContext();
    const r = await runOnce(c);
    // PC-06: a held run stops at the guard step — say why. PC-35: the guard
    // is logged only when its state changes, so a run it stopped may add
    // no activity row; the message says why instead.
    const first = r.steps[0];
    const guard = first?.step === 'guard' && first.outcome === 'skipped' ? first : null;
    const message = guard?.detail?.startsWith('held: ')
      ? `Nothing ran. ${guard.detail.slice('held: '.length)}`
      : guard
        ? `Autopilot did not run: ${guard.detail ?? 'guard'}`
        : `runOnce — ${r.steps.length} steps`;
    redirect(`/autopilot?message=${encodeURIComponent(message)}`);
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/today">Today</Link> / Autopilot
      </p>
      <h1>Autopilot</h1>
      <p className="muted">
        Autopilot approves, drafts, queues and hands over to the CRM on its
        own, every 5 minutes and after each crawl that found records. Pick a
        product to narrow what it does for that product, or to pause it.
      </p>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <MasterStrip settings={base} paused={pauseOverview.pause !== null} runNow={runNow} />

      <AutomationPauseControl overview={pauseOverview} returnTo="/autopilot" />

      <AutonomousFlow
        steps={flow}
        scopeLabel={product ? product.name : 'Workspace defaults'}
      />

      <ScopePicker
        products={products}
        overlayByProduct={overlayByProduct}
        currentScope={productId !== null ? productId.toString() : 'default'}
      />

      {product && resolved ? (
        <ProductPauseControl
          product={product}
          resolved={resolved}
          canPause={canWrite(ctx)}
          canResume={canEdit}
          pauseProduct={pauseProduct}
          resumeProduct={resumeProduct}
        />
      ) : null}

      {canEdit ? (
        product ? (
          <ProductOverlayForm
            product={product}
            overlay={overlay}
            base={base}
            mailboxes={mailboxes}
            saveProductOverlay={saveProductOverlay}
            clearOverlay={clearOverlay}
          />
        ) : (
          <WorkspaceDefaultsForm
            settings={base}
            mailboxes={mailboxes}
            crmConns={crmConns}
            saveDefault={saveDefault}
          />
        )
      ) : (
        <p className="muted">Workspace admins can edit autopilot settings.</p>
      )}

      <section>
        <h2>Recent activity ({log.length})</h2>
        {log.length === 0 ? (
          <p className="muted">No autopilot runs yet.</p>
        ) : (
          <ul className="timeline">
            {log.map((l) => (
              <li key={l.id.toString()}>
                <span className="muted">{l.createdAt.toLocaleString()}</span>{' '}
                <strong>{l.step}</strong>
                {' · '}
                <span className={outcomeClass(l.outcome)}>{l.outcome}</span>
                {l.detail ? ` — ${l.detail.slice(0, 200)}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}

// ---- Components -----------------------------------------------------

function MasterStrip({
  settings,
  paused,
  runNow,
}: Readonly<{
  settings: AutopilotSettings;
  /** PC-05: the workspace pause (it stops autopilot with everything else). */
  paused: boolean;
  runNow: () => Promise<void>;
}>) {
  return (
    <section>
      <div className={cx('autopilot-master-strip', styles.masterStrip)}>
        <strong>Master state:</strong>
        <span
          className={
            settings.autopilotEnabled && !paused ? 'badge badge-good' : 'badge badge-bad'
          }
        >
          {paused
            ? '🛑 paused (all automation)'
            : settings.autopilotEnabled
              ? '🟢 enabled'
              : '⚫ disabled'}
        </span>
        <form action={runNow}>
          <button type="submit">Run now</button>
        </form>
      </div>
    </section>
  );
}

/** PC-13: the flow as resolveAutomationPolicy sees it (autopilotFlow). */
function AutonomousFlow({
  steps,
  scopeLabel,
}: Readonly<{ steps: readonly FlowStep[]; scopeLabel: string }>) {
  return (
    <section>
      <h2>Autonomous flow — {scopeLabel}</h2>
      <p className="muted">
        What runs right now for the scope above, and why a step waits.
      </p>
      <ol className="autopilot-flow">
        {steps.map((s, idx) => (
          <li key={s.key} data-flow-step={s.key} data-flow-status={s.status}>
            <div className={cx('flow-step', `flow-step-${s.status}`, FLOW_STEP_CLASS[s.status])}>
              <span className="flow-step-icon">{FLOW_ICONS[s.status]}</span>
              <div>
                <strong>{s.label}</strong>{' '}
                <span className="muted small">{FLOW_STATUS_LABELS[s.status]}</span>
                <p className={cx('muted small flow-step-blurb', styles.blurb)}>{s.blurb}</p>
              </div>
            </div>
            {idx < steps.length - 1 ? (
              <span className="flow-arrow" aria-hidden>
                ↓
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The states the legacy flow-step classes do not style (autopilot.module.css). */
const FLOW_STEP_CLASS: Readonly<Partial<Record<FlowStep['status'], string>>> = {
  always: styles.stepAlways,
  held: styles.stepHeld,
  partial: styles.stepPartial,
};

const FLOW_ICONS: Readonly<Record<FlowStep['status'], string>> = {
  on: '✓',
  off: '–',
  always: '⟳',
  inline: '⚡',
  held: '⏸',
  partial: '◐',
};

const FLOW_STATUS_LABELS: Readonly<Record<FlowStep['status'], string>> = {
  on: 'on',
  off: 'off',
  always: 'always on',
  inline: 'as work arrives',
  held: 'waiting',
  partial: 'partly waiting',
};

function ScopePicker({
  products,
  overlayByProduct,
  currentScope,
}: Readonly<{
  products: ReadonlyArray<ProductProfile>;
  overlayByProduct: Map<string, AutopilotProductSettings>;
  currentScope: string;
}>) {
  return (
    <section>
      <h2>Edit scope</h2>
      <p className="muted">
        Pick what to edit: the workspace-wide defaults, or one product, which
        can switch steps off, require a higher threshold, or be paused.
      </p>
      <nav className="scope-tabs">
        <Link
          href="/autopilot"
          className={currentScope === 'default' ? 'active' : ''}
        >
          Workspace defaults
        </Link>
        {products.map((p) => {
          const o = overlayByProduct.get(p.id.toString());
          return (
            <Link
              key={p.id.toString()}
              href={`/autopilot?scope=${p.id}`}
              className={currentScope === p.id.toString() ? 'active' : ''}
            >
              {p.name}
              {o?.pausedAt ? (
                <span className="badge badge-warn"> paused</span>
              ) : o ? (
                <span className="badge"> override</span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </section>
  );
}

function WorkspaceDefaultsForm({
  settings,
  mailboxes,
  crmConns,
  saveDefault,
}: Readonly<{
  settings: AutopilotSettings;
  mailboxes: Awaited<ReturnType<typeof listMailboxes>>;
  crmConns: Awaited<ReturnType<typeof listCrmConnections>>;
  saveDefault: (formData: FormData) => Promise<void>;
}>) {
  return (
    <section>
      <h2>Workspace defaults</h2>
      <form action={saveDefault} className="edit-draft-form">
        <fieldset className="ks-kind-fields">
          <legend className="muted">Master switch</legend>
          <label className="checkbox-row">
            <input
              type="checkbox"
              name="autopilotEnabled"
              defaultChecked={settings.autopilotEnabled}
            />
            <span>Autopilot enabled (master)</span>
          </label>
          <p className="muted small">
            To stop everything at once, use <a href="#pause">Pause all automation</a> above.
          </p>
        </fieldset>

        <fieldset className="ks-kind-fields">
          <legend className="muted">Steps</legend>
          <Step
            name="enableAutoApproveProjects"
            label="Auto-approve relevant review items"
            checked={settings.enableAutoApproveProjects}
          />
          <label>
            <span>Approval threshold (0..100)</span>
            <input
              type="number"
              name="autoApproveThreshold"
              defaultValue={settings.autoApproveThreshold}
              min={0}
              max={100}
            />
          </label>
          <Step
            name="enableAutoEnqueueOutreach"
            label="Generate + queue outreach drafts (approved in the owner's name, nobody reviews them)"
            checked={settings.enableAutoEnqueueOutreach}
          />
          <Step
            name="enableAutoCrmContactSync"
            label="Sync new and changed qualified leads' contacts to the CRM"
            checked={settings.enableAutoCrmContactSync}
          />
          <Step
            name="enableAutoCrmDealOnQualified"
            label="Create CRM deals for qualified leads whose contact is synced"
            checked={settings.enableAutoCrmDealOnQualified}
          />
          <p className="muted small">
            Not autopilot steps, always on in the background: approved emails
            send from the <Link href="/mailbox/queue">send queue</Link> every
            30 seconds within each mailbox&apos;s window, unless automation is
            paused or the workspace is not live yet; mailboxes are read every
            2 minutes while Mailbox auto-sync is on in{' '}
            <Link href="/settings/outreach">Outreach config</Link>.
          </p>
        </fieldset>

        <fieldset className="ks-kind-fields">
          <legend className="muted">Per-run caps</legend>
          <label>
            <span>Max approvals per run</span>
            <input
              type="number"
              name="maxApprovalsPerRun"
              defaultValue={settings.maxApprovalsPerRun}
              min={0}
            />
          </label>
          <label>
            <span>Max enqueues per run</span>
            <input
              type="number"
              name="maxEnqueuesPerRun"
              defaultValue={settings.maxEnqueuesPerRun}
              min={0}
            />
          </label>
        </fieldset>

        <fieldset className="ks-kind-fields">
          <legend className="muted">Defaults</legend>
          <label>
            <span>Default mailbox for outreach</span>
            <select
              name="defaultMailboxId"
              defaultValue={settings.defaultMailboxId?.toString() ?? ''}
            >
              <option value="">workspace default</option>
              {mailboxes
                .filter((m) => m.status === 'active')
                .map((m) => (
                  <option key={m.id.toString()} value={m.id.toString()}>
                    {m.name} ({m.fromAddress})
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>Default CRM connection</span>
            <select
              name="defaultCrmConnectionId"
              defaultValue={settings.defaultCrmConnectionId?.toString() ?? ''}
            >
              <option value="">first active</option>
              {crmConns
                .filter((c) => c.status === 'active')
                .map((c) => (
                  <option key={c.id.toString()} value={c.id.toString()}>
                    {c.name} ({c.system})
                  </option>
                ))}
            </select>
          </label>
        </fieldset>

        <div className="action-row">
          <button type="submit" className="primary-btn">
            Save defaults
          </button>
        </div>
      </form>
    </section>
  );
}

/** PC-13: pause / resume one product (any editor pauses; owners and
 *  admins resume). */
function ProductPauseControl({
  product,
  resolved,
  canPause,
  canResume,
  pauseProduct,
  resumeProduct,
}: Readonly<{
  product: ProductProfile;
  resolved: ProductPolicy;
  canPause: boolean;
  canResume: boolean;
  pauseProduct: (formData: FormData) => Promise<void>;
  resumeProduct: (formData: FormData) => Promise<void>;
}>) {
  return (
    <section id="product-pause">
      <h2>Pause {product.name}</h2>
      {resolved.pause ? (
        <>
          <p>
            <span className="badge badge-warn">Paused</span> since{' '}
            {resolved.pause.since.toLocaleString()}. Autopilot does nothing for
            this product, its queued emails and follow-ups wait (nothing fails
            or is lost), and no AI reply drafts are written for its leads.
            Email you write yourself still sends.
          </p>
          {canResume ? (
            <form action={resumeProduct}>
              <input type="hidden" name="productProfileId" value={product.id.toString()} />
              <ConfirmFormButton
                className="primary-btn"
                message={resumeProductConfirm(product.name)}
              >
                Resume {product.name}
              </ConfirmFormButton>
            </form>
          ) : (
            <p className="muted small">Owners and admins can resume it.</p>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            Pausing stops autopilot for this product and holds its queued
            emails and follow-ups until an owner or admin resumes it.
          </p>
          {canPause ? (
            <form action={pauseProduct}>
              <input type="hidden" name="productProfileId" value={product.id.toString()} />
              <button type="submit" className="ghost-btn">
                Pause {product.name}
              </button>
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}

function ProductOverlayForm({
  product,
  overlay,
  base,
  mailboxes,
  saveProductOverlay,
  clearOverlay,
}: Readonly<{
  product: ProductProfile;
  overlay: AutopilotProductSettings | null;
  base: AutopilotSettings;
  mailboxes: Awaited<ReturnType<typeof listMailboxes>>;
  saveProductOverlay: (formData: FormData) => Promise<void>;
  clearOverlay: (formData: FormData) => Promise<void>;
}>) {
  const hasOverrides =
    overlay !== null &&
    (overlay.autopilotEnabled === false ||
      overlay.enableAutoApproveProjects === false ||
      overlay.enableAutoEnqueueOutreach === false ||
      overlay.enableAutoCrmContactSync === false ||
      overlay.enableAutoCrmDealOnQualified === false ||
      overlay.autoApproveThreshold !== null ||
      overlay.defaultMailboxId !== null);
  return (
    <section>
      <h2>Overrides for {product.name}</h2>
      <p className="muted">
        A product can only narrow what the workspace runs: each step either
        inherits the workspace setting or is off for this product, and the
        approval threshold can only be higher. To run a step for some
        products only, switch it on for the workspace and off for the others.
      </p>
      <form action={saveProductOverlay} className="edit-draft-form">
        <input
          type="hidden"
          name="productProfileId"
          value={product.id.toString()}
        />

        <fieldset className="ks-kind-fields">
          <legend className="muted">Master switch</legend>
          <NarrowToggle
            name="autopilotEnabled"
            label="Autopilot for this product"
            base={base.autopilotEnabled}
            override={overlay?.autopilotEnabled ?? null}
          />
        </fieldset>

        <fieldset className="ks-kind-fields">
          <legend className="muted">Steps</legend>
          <NarrowToggle
            name="enableAutoApproveProjects"
            label="Auto-approve relevant review items"
            base={base.enableAutoApproveProjects}
            override={overlay?.enableAutoApproveProjects ?? null}
          />
          <label>
            <span>
              Approval threshold (workspace {base.autoApproveThreshold}; only a
              higher one applies)
            </span>
            <input
              type="number"
              name="autoApproveThreshold"
              defaultValue={overlay?.autoApproveThreshold ?? ''}
              placeholder={`inherit (${base.autoApproveThreshold})`}
              min={base.autoApproveThreshold}
              max={100}
            />
          </label>
          <NarrowToggle
            name="enableAutoEnqueueOutreach"
            label="Generate + queue outreach drafts"
            base={base.enableAutoEnqueueOutreach}
            override={overlay?.enableAutoEnqueueOutreach ?? null}
          />
          <NarrowToggle
            name="enableAutoCrmContactSync"
            label="Sync qualified leads' contacts to the CRM"
            base={base.enableAutoCrmContactSync}
            override={overlay?.enableAutoCrmContactSync ?? null}
          />
          <NarrowToggle
            name="enableAutoCrmDealOnQualified"
            label="Create CRM deals for qualified leads"
            base={base.enableAutoCrmDealOnQualified}
            override={overlay?.enableAutoCrmDealOnQualified ?? null}
          />
          <label>
            <span>Default mailbox</span>
            <select
              name="defaultMailboxId"
              defaultValue={overlay?.defaultMailboxId?.toString() ?? ''}
            >
              <option value="">
                inherit (
                {base.defaultMailboxId
                  ? mailboxes.find((m) => m.id === base.defaultMailboxId)?.name ?? '—'
                  : 'workspace default'}
                )
              </option>
              {mailboxes
                .filter((m) => m.status === 'active')
                .map((m) => (
                  <option key={m.id.toString()} value={m.id.toString()}>
                    {m.name} ({m.fromAddress})
                  </option>
                ))}
            </select>
          </label>
        </fieldset>

        <div className="action-row">
          <button type="submit" className="primary-btn">
            Save overrides
          </button>
        </div>
      </form>

      {overlay && hasOverrides ? (
        <form action={clearOverlay} className="action-row">
          <input
            type="hidden"
            name="productProfileId"
            value={product.id.toString()}
          />
          <ConfirmFormButton
            className="ghost-btn"
            message={clearAutopilotOverridesConfirm(product.name, overlay, base)}
          >
            Clear all overrides for {product.name}
          </ConfirmFormButton>
        </form>
      ) : null}
    </section>
  );
}

function Step({
  name,
  label,
  checked,
}: Readonly<{ name: string; label: string; checked: boolean }>) {
  return (
    <label className="checkbox-row">
      <input type="checkbox" name={name} defaultChecked={checked} />
      <span>{label}</span>
    </label>
  );
}

/** PC-13: Inherit | Off radio group — a product override can only narrow. */
function NarrowToggle({
  name,
  label,
  base,
  override,
}: Readonly<{
  name: string;
  label: string;
  base: boolean;
  override: boolean | null;
}>) {
  const value = override === false ? 'off' : 'inherit';
  return (
    <div className="tri-toggle">
      <span className="tri-toggle-label">{label}</span>
      <span className="tri-toggle-options">
        <label>
          <input
            type="radio"
            name={name}
            value="inherit"
            defaultChecked={value === 'inherit'}
          />{' '}
          inherit ({base ? 'on' : 'off'})
        </label>
        <label>
          <input
            type="radio"
            name={name}
            value="off"
            defaultChecked={value === 'off'}
          />{' '}
          off for this product
        </label>
      </span>
    </div>
  );
}

function outcomeClass(o: string): string {
  if (o === 'success') return 'badge badge-good';
  if (o === 'error') return 'badge badge-bad';
  return 'badge';
}
