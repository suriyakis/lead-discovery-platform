// Phase 27: Autopilot console. Reorganized around an "Autonomous Flow"
// visualization at the top + a scope picker that lets the operator
// switch between Workspace-default settings and per-product overrides.

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
  AutopilotError,
  clearProductAutopilotSettings,
  getAutopilotSettings,
  getEffectiveAutopilotSettings,
  getProductAutopilotSettings,
  listAutopilotLog,
  listProductAutopilotSettings,
  runOnce,
  updateAutopilotSettings,
  upsertProductAutopilotSettings,
} from '@/lib/services/autopilot';
import { listMailboxes } from '@/lib/services/mailbox';
import { listCrmConnections } from '@/lib/services/crm';
import { listProductProfiles } from '@/lib/services/product-profile';
import type { AutopilotSettings, AutopilotProductSettings } from '@/lib/db/schema/autopilot';
import type { ProductProfile } from '@/lib/db/schema/products';

type FlowStepKey =
  | 'discovery'
  | 'classify'
  | 'auto_approve'
  | 'auto_send'
  | 'auto_drain'
  | 'classify_reply'
  | 'auto_handover';

interface FlowStep {
  key: FlowStepKey;
  label: string;
  blurb: string;
  scope: 'manual' | 'inline' | 'workspace' | 'product';
  /** Read-only — derived from settings. */
  enabled?: boolean;
  /** Settings field this step toggles, when scope is 'workspace' or 'product'. */
  field?: keyof AutopilotSettings;
}

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
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  const [base, log, mailboxes, crmConns, products, productOverlays] =
    await Promise.all([
      getAutopilotSettings(ctx),
      listAutopilotLog(ctx, 100),
      listMailboxes(ctx),
      listCrmConnections(ctx),
      listProductProfiles(ctx, { includeArchived: false }),
      listProductAutopilotSettings(ctx),
    ]);
  const overlayByProduct = new Map(
    productOverlays.map((o) => [o.productProfileId.toString(), o]),
  );

  const canEdit = canAdminWorkspace(ctx);

  // Resolve current scope from searchParams.
  const productId =
    sp.scope && /^\d+$/.test(sp.scope) ? BigInt(sp.scope) : null;
  const isProductScope = productId !== null;
  const product = productId
    ? products.find((p) => p.id === productId) ?? null
    : null;

  // Effective settings for the visual flow + form defaults.
  const effective: AutopilotSettings = product
    ? await getEffectiveAutopilotSettings(ctx, product.id)
    : base;
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
        emergencyPause: formData.get('emergencyPause') === 'on',
        enableAutoApproveProjects: formData.get('enableAutoApproveProjects') === 'on',
        autoApproveThreshold: num('autoApproveThreshold'),
        enableAutoEnqueueOutreach: formData.get('enableAutoEnqueueOutreach') === 'on',
        enableAutoDrainQueue: formData.get('enableAutoDrainQueue') === 'on',
        enableAutoSyncInbound: formData.get('enableAutoSyncInbound') === 'on',
        enableAutoCrmContactSync: formData.get('enableAutoCrmContactSync') === 'on',
        enableAutoCrmDealOnQualified: formData.get('enableAutoCrmDealOnQualified') === 'on',
        maxApprovalsPerRun: num('maxApprovalsPerRun'),
        maxEnqueuesPerRun: num('maxEnqueuesPerRun'),
        defaultMailboxId: big('defaultMailboxId'),
        defaultCrmConnectionId: big('defaultCrmConnectionId'),
      });
      redirect('/autopilot?message=Workspace+defaults+saved');
    } catch (err) {
      const m = err instanceof AutopilotError ? err.message : 'failed';
      redirect(`/autopilot?error=${encodeURIComponent(m)}`);
    }
  }

  async function saveProductOverlay(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const pid = BigInt(String(formData.get('productProfileId')));
    // Tri-state inputs from the form: "inherit", "on", "off".
    const tri = (k: string): boolean | null | undefined => {
      const v = String(formData.get(k) ?? '');
      if (v === 'inherit') return null;
      if (v === 'on') return true;
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
        autopilotEnabled: tri('autopilotEnabled'),
        emergencyPause: tri('emergencyPause'),
        enableAutoApproveProjects: tri('enableAutoApproveProjects'),
        autoApproveThreshold: num('autoApproveThreshold'),
        enableAutoEnqueueOutreach: tri('enableAutoEnqueueOutreach'),
        enableAutoCrmContactSync: tri('enableAutoCrmContactSync'),
        enableAutoCrmDealOnQualified: tri('enableAutoCrmDealOnQualified'),
        defaultMailboxId: big('defaultMailboxId'),
      });
      redirect(`/autopilot?scope=${pid}&message=Product+overlay+saved`);
    } catch (err) {
      const m = err instanceof AutopilotError ? err.message : 'failed';
      redirect(`/autopilot?scope=${pid}&error=${encodeURIComponent(m)}`);
    }
  }

  async function clearOverlay(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const pid = BigInt(String(formData.get('productProfileId')));
    await clearProductAutopilotSettings(c, pid);
    redirect(`/autopilot?scope=${pid}&message=Overlay+cleared`);
  }

  async function runNow() {
    'use server';
    const c = await getWorkspaceContext();
    const r = await runOnce(c);
    redirect(
      `/autopilot?message=${encodeURIComponent(`runOnce — ${r.steps.length} steps`)}`,
    );
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> / Autopilot
      </p>
      <h1>Autopilot</h1>
      <p className="muted">
        Workspace-wide orchestrator with per-product overrides. Pick a
        product to dial in how far automation runs for that specific
        product.
      </p>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <MasterStrip settings={base} runNow={runNow} />

      <AutonomousFlow
        eff={effective}
        scopeLabel={product ? product.name : 'Workspace defaults'}
      />

      <ScopePicker
        products={products}
        overlayByProduct={overlayByProduct}
        currentScope={isProductScope ? productId!.toString() : 'default'}
      />

      {canEdit ? (
        isProductScope && product ? (
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
  runNow,
}: Readonly<{
  settings: AutopilotSettings;
  runNow: () => Promise<void>;
}>) {
  return (
    <section>
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <strong>Master state:</strong>
        <span
          className={
            settings.autopilotEnabled && !settings.emergencyPause
              ? 'badge badge-good'
              : 'badge badge-bad'
          }
        >
          {settings.emergencyPause
            ? '🛑 emergency pause'
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

function AutonomousFlow({
  eff,
  scopeLabel,
}: Readonly<{ eff: AutopilotSettings; scopeLabel: string }>) {
  const steps: FlowStep[] = [
    {
      key: 'discovery',
      label: '1. Discovery',
      blurb: 'Connectors fetch source records.',
      scope: 'manual',
    },
    {
      key: 'classify',
      label: '2. Classify',
      blurb: 'AI scores relevance per product. Runs as records land.',
      scope: 'inline',
    },
    {
      key: 'auto_approve',
      label: '3. Auto-approve',
      blurb: `Threshold ${eff.autoApproveThreshold}/100`,
      scope: 'workspace',
      enabled: eff.enableAutoApproveProjects,
      field: 'enableAutoApproveProjects',
    },
    {
      key: 'auto_send',
      label: '4. Generate + queue',
      blurb: 'Auto-generate outreach drafts & enqueue.',
      scope: 'workspace',
      enabled: eff.enableAutoEnqueueOutreach,
      field: 'enableAutoEnqueueOutreach',
    },
    {
      key: 'auto_drain',
      label: '5. Send queue',
      blurb: 'Drain the send queue with daily caps + cooldowns.',
      scope: 'workspace',
      enabled: eff.enableAutoDrainQueue,
      field: 'enableAutoDrainQueue',
    },
    {
      key: 'classify_reply',
      label: '6. Classify replies',
      blurb: 'Inbound classification + auto-actions. Always on.',
      scope: 'inline',
    },
    {
      key: 'auto_handover',
      label: '7. Hand over to CRM',
      blurb: 'Sync contacts + create deals on qualified leads.',
      scope: 'workspace',
      enabled: eff.enableAutoCrmContactSync || eff.enableAutoCrmDealOnQualified,
      field: 'enableAutoCrmContactSync',
    },
  ];
  return (
    <section>
      <h2>Autonomous flow — {scopeLabel}</h2>
      <p className="muted">
        Each step shows whether it is currently running for the scope above.
      </p>
      <ol className="autopilot-flow">
        {steps.map((s, idx) => (
          <li key={s.key}>
            <div className={`flow-step flow-step-${stepBadgeClass(s)}`}>
              <span className="flow-step-icon">{stepIcon(s)}</span>
              <div>
                <strong>{s.label}</strong>
                <p className="muted" style={{ margin: 0, fontSize: '0.825rem' }}>
                  {s.blurb}
                </p>
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
        Pick what to edit: the workspace-wide defaults, or a per-product
        overlay that overrides specific steps for that product.
      </p>
      <nav className="scope-tabs">
        <Link
          href="/autopilot"
          className={currentScope === 'default' ? 'active' : ''}
        >
          Workspace defaults
        </Link>
        {products.map((p) => {
          const has = overlayByProduct.has(p.id.toString());
          return (
            <Link
              key={p.id.toString()}
              href={`/autopilot?scope=${p.id}`}
              className={currentScope === p.id.toString() ? 'active' : ''}
            >
              {p.name}
              {has ? <span className="badge"> override</span> : null}
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
          <legend className="muted">Master switches</legend>
          <label className="checkbox-row">
            <input
              type="checkbox"
              name="autopilotEnabled"
              defaultChecked={settings.autopilotEnabled}
            />
            <span>Autopilot enabled (master)</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              name="emergencyPause"
              defaultChecked={settings.emergencyPause}
            />
            <span>🛑 Emergency pause (kill switch)</span>
          </label>
        </fieldset>

        <fieldset className="ks-kind-fields">
          <legend className="muted">Per-step toggles</legend>
          <Step
            name="enableAutoSyncInbound"
            label="Sync inbound mail (workspace-wide)"
            checked={settings.enableAutoSyncInbound}
          />
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
            label="Auto-generate + enqueue outreach drafts"
            checked={settings.enableAutoEnqueueOutreach}
          />
          <Step
            name="enableAutoDrainQueue"
            label="Auto-drain the send queue (workspace-wide)"
            checked={settings.enableAutoDrainQueue}
          />
          <Step
            name="enableAutoCrmContactSync"
            label="Auto-sync qualified leads' contacts to CRM"
            checked={settings.enableAutoCrmContactSync}
          />
          <Step
            name="enableAutoCrmDealOnQualified"
            label="Auto-create CRM deals on qualified state"
            checked={settings.enableAutoCrmDealOnQualified}
          />
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
  return (
    <section>
      <h2>Overrides for {product.name}</h2>
      <p className="muted">
        Each toggle can <strong>inherit</strong> the workspace default, or
        explicitly turn that step on/off for this product. Workspace-wide
        steps (sync inbound, drain queue) cannot be overridden — they
        always use the workspace setting.
      </p>
      <form action={saveProductOverlay} className="edit-draft-form">
        <input
          type="hidden"
          name="productProfileId"
          value={product.id.toString()}
        />

        <fieldset className="ks-kind-fields">
          <legend className="muted">Master switches</legend>
          <TriToggle
            name="autopilotEnabled"
            label="Autopilot enabled (master)"
            base={base.autopilotEnabled}
            override={overlay?.autopilotEnabled ?? null}
          />
          <TriToggle
            name="emergencyPause"
            label="🛑 Emergency pause"
            base={base.emergencyPause}
            override={overlay?.emergencyPause ?? null}
          />
        </fieldset>

        <fieldset className="ks-kind-fields">
          <legend className="muted">Per-step (overridable)</legend>
          <TriToggle
            name="enableAutoApproveProjects"
            label="Auto-approve relevant review items"
            base={base.enableAutoApproveProjects}
            override={overlay?.enableAutoApproveProjects ?? null}
          />
          <label>
            <span>
              Approval threshold (workspace default {base.autoApproveThreshold})
            </span>
            <input
              type="number"
              name="autoApproveThreshold"
              defaultValue={overlay?.autoApproveThreshold ?? ''}
              placeholder={`inherit (${base.autoApproveThreshold})`}
              min={0}
              max={100}
            />
          </label>
          <TriToggle
            name="enableAutoEnqueueOutreach"
            label="Auto-generate + enqueue outreach drafts"
            base={base.enableAutoEnqueueOutreach}
            override={overlay?.enableAutoEnqueueOutreach ?? null}
          />
          <TriToggle
            name="enableAutoCrmContactSync"
            label="Auto-sync qualified leads' contacts to CRM"
            base={base.enableAutoCrmContactSync}
            override={overlay?.enableAutoCrmContactSync ?? null}
          />
          <TriToggle
            name="enableAutoCrmDealOnQualified"
            label="Auto-create CRM deals on qualified state"
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

        <div className="action-row" style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="submit" className="primary-btn">
            Save overlay
          </button>
        </div>
      </form>

      {overlay ? (
        <form action={clearOverlay} style={{ marginTop: '1rem' }}>
          <input
            type="hidden"
            name="productProfileId"
            value={product.id.toString()}
          />
          <button type="submit" className="ghost-btn">
            Clear all overrides for {product.name}
          </button>
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

/** Inherit | On | Off radio group — used by per-product overlay form. */
function TriToggle({
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
  const value = override === null ? 'inherit' : override ? 'on' : 'off';
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
            value="on"
            defaultChecked={value === 'on'}
          />{' '}
          on
        </label>
        <label>
          <input
            type="radio"
            name={name}
            value="off"
            defaultChecked={value === 'off'}
          />{' '}
          off
        </label>
      </span>
    </div>
  );
}

function stepBadgeClass(s: FlowStep): string {
  if (s.scope === 'manual') return 'manual';
  if (s.scope === 'inline') return 'inline';
  return s.enabled ? 'on' : 'off';
}

function stepIcon(s: FlowStep): string {
  if (s.scope === 'manual') return '👤';
  if (s.scope === 'inline') return '⚡';
  return s.enabled ? '✓' : '–';
}

function outcomeClass(o: string): string {
  if (o === 'success') return 'badge badge-good';
  if (o === 'error') return 'badge badge-bad';
  return 'badge';
}
