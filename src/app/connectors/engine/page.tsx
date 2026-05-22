import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowLeft,
  Clock,
  Globe2,
  Moon,
  Play,
  Plus,
  Save,
  Trash2,
  Zap,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listConnectors, listRecipes } from '@/lib/services/connector-run';
import {
  listCrawlPlans,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
} from '@/lib/services/crawl-engine';
import { listProductProfiles } from '@/lib/services/product-profile';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  createPlan,
  deletePlanAction,
  runPlanAction,
  savePlan,
} from './actions';

const COMMON_TIMEZONES = [
  'Europe/Warsaw',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Singapore',
  'UTC',
];

export default async function CrawlEnginePage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
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
    if (err instanceof NoWorkspaceError) redirect('/connectors');
    throw err;
  }

  const [plans, recipes, connectors, products] = await Promise.all([
    listCrawlPlans(ctx),
    listRecipes(ctx),
    listConnectors(ctx),
    listProductProfiles(ctx, { includeArchived: false }),
  ]);

  const connectorNameById = new Map(
    connectors.map((c) => [c.id.toString(), c.name]),
  );
  const recipeOptions = recipes.map((r) => ({
    id: r.id.toString(),
    label: `${connectorNameById.get(r.connectorId.toString()) ?? '?'} · ${r.name}`,
    active: r.active,
  }));

  return (
    <AppShell>
      <div className="crawl-page">
        <Link href="/connectors" className="crawl-back">
          <ArrowLeft className="lucide" /> Connectors
        </Link>

        <header className="crawl-header">
          <div>
            <h1 className="crawl-title">
              <Zap className="lucide" /> Crawl Engine
            </h1>
            <p className="crawl-lede">
              Scheduled bundles of recipes that fire automatically on a
              cadence. Each plan picks <strong>which recipes</strong>{' '}
              to run, an <strong>interval</strong>, and an optional{' '}
              <strong>quiet-hour window</strong> (so the engine
              respects the local working day at the host site).{' '}
              {products.length > 0 ? (
                <>
                  Discovered records are auto-qualified against{' '}
                  <Link href="/products">
                    all {products.length} active{' '}
                    product profile{products.length === 1 ? '' : 's'}
                  </Link>{' '}
                  in this workspace — the qualification engine picks the
                  best fit per record.
                </>
              ) : (
                <>
                  Discovered records will be auto-qualified once you{' '}
                  <Link href="/products">add a product profile</Link>.
                </>
              )}
            </p>
          </div>
        </header>

        {sp.message ? (
          <p className="mail-flash info">{sp.message}</p>
        ) : null}
        {sp.error ? <p className="mail-flash error">{sp.error}</p> : null}

        {/* Existing plans */}
        {plans.length === 0 ? (
          <div className="mail-empty">
            <div className="mail-empty-icon">
              <Zap className="lucide" />
            </div>
            <p className="mail-empty-title">No crawl plans yet</p>
            <p style={{ margin: 0 }}>
              Create the first plan below — pick a few recipes, the products
              you want to qualify against, and how often you want them to run.
            </p>
          </div>
        ) : (
          <section className="crawl-plans-list">
            {plans.map((p) => {
              const summary =
                (p.lastRunSummary as Record<string, unknown> | null) ?? null;
              const started = Number(summary?.started ?? 0);
              const failed = Number(summary?.failed ?? 0);
              const skipped = Number(summary?.skipped ?? 0);
              return (
                <article
                  key={p.id.toString()}
                  className={`crawl-plan-card${p.enabled ? '' : ' is-disabled'}`}
                >
                  <form action={savePlan} className="crawl-plan-form">
                    <input type="hidden" name="id" value={p.id.toString()} />
                    <header className="crawl-plan-head">
                      <input
                        type="text"
                        name="name"
                        defaultValue={p.name}
                        className="crawl-plan-name"
                        aria-label="Plan name"
                        required
                      />
                      <label className="crawl-plan-toggle">
                        <input
                          type="checkbox"
                          name="enabled"
                          defaultChecked={p.enabled}
                        />
                        <span>{p.enabled ? 'Enabled' : 'Disabled'}</span>
                      </label>
                    </header>

                    <div className="crawl-plan-grid">
                      <label>
                        <span>
                          <Clock className="lucide" /> Interval (minutes)
                        </span>
                        <input
                          type="number"
                          name="intervalMinutes"
                          defaultValue={p.intervalMinutes}
                          min={MIN_INTERVAL_MINUTES}
                          max={MAX_INTERVAL_MINUTES}
                          required
                        />
                      </label>
                      <label>
                        <span>
                          <Moon className="lucide" /> Quiet from (hour, 0–23)
                        </span>
                        <input
                          type="number"
                          name="quietStartHour"
                          defaultValue={p.quietStartHour ?? ''}
                          min={0}
                          max={23}
                          placeholder="—"
                        />
                      </label>
                      <label>
                        <span>
                          <Moon className="lucide" /> Quiet until (hour, 0–23)
                        </span>
                        <input
                          type="number"
                          name="quietEndHour"
                          defaultValue={p.quietEndHour ?? ''}
                          min={0}
                          max={23}
                          placeholder="—"
                        />
                      </label>
                      <label>
                        <span>
                          <Globe2 className="lucide" /> Timezone
                        </span>
                        <select name="timezone" defaultValue={p.timezone}>
                          {COMMON_TIMEZONES.map((tz) => (
                            <option key={tz} value={tz}>
                              {tz}
                            </option>
                          ))}
                          {COMMON_TIMEZONES.includes(p.timezone) ? null : (
                            <option value={p.timezone}>{p.timezone}</option>
                          )}
                        </select>
                      </label>
                    </div>

                    <fieldset className="crawl-plan-fieldset">
                      <legend>Recipes (will run as separate connector runs)</legend>
                      {recipeOptions.length === 0 ? (
                        <p className="muted small">
                          No recipes in this workspace yet —{' '}
                          <Link href="/connectors">create one</Link> first.
                        </p>
                      ) : (
                        <div className="crawl-checkbox-grid">
                          {recipeOptions.map((r) => (
                            <label key={r.id} className="crawl-checkbox-row">
                              <input
                                type="checkbox"
                                name="recipeIds"
                                value={r.id}
                                defaultChecked={p.recipeIds
                                  .map(String)
                                  .includes(r.id)}
                                disabled={!r.active}
                              />
                              <span>
                                {r.label}
                                {r.active ? null : (
                                  <span className="muted small">
                                    {' '}
                                    (archived)
                                  </span>
                                )}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </fieldset>

                    <footer className="crawl-plan-foot">
                      <div className="crawl-plan-status">
                        {p.lastRunAt ? (
                          <span>
                            Last run {p.lastRunAt.toLocaleString()} —{' '}
                            <strong>{started}</strong> started ·{' '}
                            <strong>{skipped}</strong> skipped ·{' '}
                            <strong>{failed}</strong> failed
                          </span>
                        ) : (
                          <span className="muted">Never run</span>
                        )}
                        {p.nextRunAt && p.enabled ? (
                          <span className="muted">
                            {' '}
                            · next {p.nextRunAt.toLocaleString()}
                          </span>
                        ) : null}
                      </div>
                      <div className="crawl-plan-actions">
                        <button
                          type="submit"
                          formAction={runPlanAction}
                          className="primary-btn"
                          title="Force this plan to run right now"
                        >
                          <Play className="lucide" /> Run now
                        </button>
                        <button type="submit" className="ghost-btn">
                          <Save className="lucide" /> Save
                        </button>
                        <ConfirmFormButton
                          formAction={deletePlanAction}
                          message={`Delete crawl plan "${p.name}"? This stops auto-runs and removes the schedule.`}
                          className="ghost-btn danger"
                        >
                          <Trash2 className="lucide" /> Delete
                        </ConfirmFormButton>
                      </div>
                    </footer>
                  </form>
                </article>
              );
            })}
          </section>
        )}

        {/* New plan form */}
        <section className="crawl-new">
          <h2 className="crawl-section-title">
            <Plus className="lucide" /> New crawl plan
          </h2>
          <form action={createPlan} className="crawl-plan-form">
            <header className="crawl-plan-head">
              <input
                type="text"
                name="name"
                placeholder="Plan name (e.g., Hourly construction tenders)"
                className="crawl-plan-name"
                required
              />
              <label className="crawl-plan-toggle">
                <input type="checkbox" name="enabled" defaultChecked />
                <span>Enabled</span>
              </label>
            </header>

            <div className="crawl-plan-grid">
              <label>
                <span>
                  <Clock className="lucide" /> Interval (minutes)
                </span>
                <input
                  type="number"
                  name="intervalMinutes"
                  defaultValue={60}
                  min={MIN_INTERVAL_MINUTES}
                  max={MAX_INTERVAL_MINUTES}
                  required
                />
              </label>
              <label>
                <span>
                  <Moon className="lucide" /> Quiet from (hour)
                </span>
                <input
                  type="number"
                  name="quietStartHour"
                  min={0}
                  max={23}
                  placeholder="— (off)"
                />
              </label>
              <label>
                <span>
                  <Moon className="lucide" /> Quiet until (hour)
                </span>
                <input
                  type="number"
                  name="quietEndHour"
                  min={0}
                  max={23}
                  placeholder="— (off)"
                />
              </label>
              <label>
                <span>
                  <Globe2 className="lucide" /> Timezone
                </span>
                <select name="timezone" defaultValue="Europe/Warsaw">
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <fieldset className="crawl-plan-fieldset">
              <legend>Recipes</legend>
              <div className="crawl-checkbox-grid">
                {recipeOptions.map((r) => (
                  <label key={r.id} className="crawl-checkbox-row">
                    <input
                      type="checkbox"
                      name="recipeIds"
                      value={r.id}
                      disabled={!r.active}
                    />
                    <span>
                      {r.label}
                      {r.active ? null : (
                        <span className="muted small"> (archived)</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="crawl-plan-actions">
              <button type="submit" className="primary-btn">
                <Plus className="lucide" /> Create plan
              </button>
            </div>
          </form>
        </section>
      </div>
    </AppShell>
  );
}
