import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq, desc } from 'drizzle-orm';
import {
  ChevronRight,
  FileText,
  Globe,
  Network,
  PlugZap,
  Plus,
  Search,
  Wrench,
  Zap,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import {
  connectorRecipes,
  connectorRuns,
  type ConnectorTemplateType,
} from '@/lib/db/schema/connectors';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  consolidateConnectorsByTemplate,
  listConnectors,
} from '@/lib/services/connector-run';
import { isNextRedirectError } from '@/lib/server-redirect';

// User-facing label + blurb per template type. Anything not listed
// here falls through to the admin-only "Other" section.
const TEMPLATE_META: Record<
  ConnectorTemplateType,
  {
    label: string;
    blurb: string;
    icon: typeof Globe;
    hideFromUsers?: boolean;
  }
> = {
  internet_search: {
    label: 'Internet Search',
    blurb:
      'Google-style SERP + scrape — define a recipe with search queries and the engine harvests matching companies.',
    icon: Globe,
  },
  directory_harvester: {
    label: 'Directory Harvester',
    blurb:
      'Scrape a member list / exhibitor list / association directory by seed URL + selectors.',
    icon: FileText,
  },
  tender_api: {
    label: 'Tender API',
    blurb:
      'Pull tenders / projects from a public API (e.g. kompasinwestycji.pl).',
    icon: Wrench,
  },
  csv_import: {
    label: 'CSV Import',
    blurb: 'One-shot bulk import from a CSV file.',
    icon: FileText,
  },
  mock: {
    label: 'Mock (testing)',
    blurb: 'Deterministic test connector — only useful for QA.',
    icon: PlugZap,
    hideFromUsers: true,
  },
};

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  async function consolidate(formData: FormData): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    const templateType = String(formData.get('templateType') ?? '');
    if (!templateType) redirect('/connectors?error=missing+template');
    try {
      const r = await consolidateConnectorsByTemplate(c, templateType);
      const parts: string[] = [];
      if (r.recipesAdopted > 0)
        parts.push(`${r.recipesAdopted} recipe${r.recipesAdopted === 1 ? '' : 's'} adopted`);
      if (r.recipesCreatedFromInstance > 0)
        parts.push(
          `${r.recipesCreatedFromInstance} empty connector${r.recipesCreatedFromInstance === 1 ? '' : 's'} → recipe`,
        );
      if (r.connectorsDeleted > 0)
        parts.push(`${r.connectorsDeleted} connector${r.connectorsDeleted === 1 ? '' : 's'} removed`);
      redirect(
        `/connectors?message=${encodeURIComponent(
          `Consolidated into "${r.canonicalName}". ${parts.join(', ')}.`,
        )}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(
        `/connectors?error=${encodeURIComponent(
          err instanceof Error ? err.message : 'consolidate failed',
        )}`,
      );
    }
  }

  let ctx;
  let connectors;
  try {
    ctx = await getWorkspaceContext();
    connectors = await listConnectors(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
          <h1>Connectors</h1>
          <p>You don&apos;t belong to a workspace yet.</p>
        </AppShell>
      );
    }
    throw err;
  }

  const isAdmin = canAdminWorkspace(ctx);

  // Recipes + last-run per connector, fetched in two batch queries.
  const recipesByConnector = new Map<
    string,
    Array<{
      id: bigint;
      name: string;
      active: boolean;
      updatedAt: Date;
    }>
  >();
  const lastRunByConnector = new Map<string, { status: string; createdAt: Date }>();
  if (connectors.length > 0) {
    const recipes = await db
      .select({
        id: connectorRecipes.id,
        connectorId: connectorRecipes.connectorId,
        name: connectorRecipes.name,
        active: connectorRecipes.active,
        updatedAt: connectorRecipes.updatedAt,
      })
      .from(connectorRecipes)
      .where(eq(connectorRecipes.workspaceId, ctx.workspaceId))
      .orderBy(desc(connectorRecipes.updatedAt));
    for (const r of recipes) {
      const key = r.connectorId.toString();
      if (!recipesByConnector.has(key)) recipesByConnector.set(key, []);
      recipesByConnector.get(key)!.push(r);
    }
    const runs = await db
      .select({
        connectorId: connectorRuns.connectorId,
        status: connectorRuns.status,
        createdAt: connectorRuns.createdAt,
      })
      .from(connectorRuns)
      .where(eq(connectorRuns.workspaceId, ctx.workspaceId))
      .orderBy(desc(connectorRuns.createdAt));
    for (const r of runs) {
      const key = r.connectorId.toString();
      if (!lastRunByConnector.has(key)) {
        lastRunByConnector.set(key, { status: r.status, createdAt: r.createdAt });
      }
    }
  }

  // Group connectors by template type. End-users only see the
  // user-facing types; admins see Mock + other testing types in a
  // separate Admin section at the bottom.
  const byTemplate = new Map<ConnectorTemplateType, typeof connectors>();
  for (const c of connectors) {
    const tt = c.templateType as ConnectorTemplateType;
    if (!byTemplate.has(tt)) byTemplate.set(tt, []);
    byTemplate.get(tt)!.push(c);
  }

  const userFacingTemplates = (
    Object.keys(TEMPLATE_META) as ConnectorTemplateType[]
  ).filter((t) => !TEMPLATE_META[t].hideFromUsers);

  return (
    <AppShell>
      <div className="page-header">
        <div>
          <p className="page-eyebrow">Discovery</p>
          <h1 className="page-title">
            <Network className="lucide" /> Connectors
          </h1>
          <p className="page-lede">
            Sources of discovery. Each connector type ships a different
            harvesting strategy — define <strong>recipes</strong> under it
            to tell the Crawl Engine what to look for.
          </p>
        </div>
        <div className="action-row">
          <Link href="/connectors/engine" className="primary-btn">
            <Zap className="lucide" /> Crawl Engine
          </Link>
          {isAdmin ? (
            <Link href="/connectors/new" className="ghost-btn">
              <Plus className="lucide" /> New connector
            </Link>
          ) : null}
        </div>
      </div>

      {sp.message ? <p className="mail-flash info">{sp.message}</p> : null}
      {sp.error ? <p className="mail-flash error">{sp.error}</p> : null}

      <section className="connector-template-grid">
        {userFacingTemplates.map((tt) => {
          const meta = TEMPLATE_META[tt];
          const instances = byTemplate.get(tt) ?? [];
          const recipeCount = instances.reduce(
            (sum, c) => sum + (recipesByConnector.get(c.id.toString())?.length ?? 0),
            0,
          );
          const Icon = meta.icon;
          return (
            <article key={tt} className="connector-template-card">
              <header className="connector-template-head">
                <span className="connector-template-icon">
                  <Icon aria-hidden="true" />
                </span>
                <div>
                  <h2 className="connector-template-title">{meta.label}</h2>
                  <p className="connector-template-blurb">{meta.blurb}</p>
                </div>
                <span className="connector-template-count">
                  {recipeCount} recipe{recipeCount === 1 ? '' : 's'}
                </span>
              </header>

              {instances.length === 0 ? (
                <p className="muted small connector-template-empty">
                  {isAdmin ? (
                    <>
                      Not configured yet —{' '}
                      <form
                        action={consolidate}
                        style={{ display: 'inline' }}
                      >
                        <input
                          type="hidden"
                          name="templateType"
                          value={tt}
                        />
                        <button type="submit" className="ghost-btn small">
                          Set up {meta.label}
                        </button>
                      </form>
                    </>
                  ) : (
                    <>
                      Not configured yet. Ask a workspace admin to set this up.
                    </>
                  )}
                </p>
              ) : null}

              {instances.length > 1 && isAdmin ? (
                <div className="connector-template-tidy">
                  <p className="muted small" style={{ margin: 0 }}>
                    <strong>{instances.length} connector instances</strong> of
                    this type. Consolidate into one — the others become
                    recipes under it.
                  </p>
                  <form action={consolidate}>
                    <input type="hidden" name="templateType" value={tt} />
                    <button type="submit" className="primary-btn small">
                      Consolidate into one {meta.label}
                    </button>
                  </form>
                </div>
              ) : null}

              {instances.length > 0
                ? instances.map((connector) => {
                  const cid = connector.id.toString();
                  const recipes = recipesByConnector.get(cid) ?? [];
                  const lastRun = lastRunByConnector.get(cid);
                  return (
                    <div
                      key={cid}
                      className={`connector-template-instance${
                        connector.active ? '' : ' is-disabled'
                      }`}
                    >
                      <div className="connector-template-instance-head">
                        <span className="connector-template-instance-name">
                          {connector.name}
                        </span>
                        {instances.length > 1 ||
                        connector.name !== meta.label ? (
                          <span className="muted small">
                            {connector.active ? '● active' : '○ inactive'}
                          </span>
                        ) : null}
                        {lastRun ? (
                          <span className="muted small">
                            · last run {lastRun.status} ·{' '}
                            {lastRun.createdAt.toLocaleString()}
                          </span>
                        ) : null}
                      </div>

                      {recipes.length === 0 ? (
                        <p className="muted small">No recipes yet.</p>
                      ) : (
                        <ul className="connector-recipe-list">
                          {recipes.map((r) => (
                            <li key={r.id.toString()}>
                              <Link
                                href={`/connectors/${cid}/recipes/${r.id}`}
                                className={r.active ? '' : 'is-archived'}
                              >
                                <Search
                                  className="lucide"
                                  aria-hidden="true"
                                />
                                <span>{r.name}</span>
                                {!r.active ? (
                                  <span className="badge badge-bad">
                                    archived
                                  </span>
                                ) : null}
                                <ChevronRight className="lucide chevron" />
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="connector-template-instance-actions">
                        <Link
                          href={`/connectors/${cid}/recipes/new`}
                          className="primary-btn small"
                        >
                          <Plus className="lucide" /> New recipe
                        </Link>
                        {isAdmin ? (
                          <Link
                            href={`/connectors/${cid}`}
                            className="ghost-btn small"
                          >
                            Connector settings
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  );
                })
                : null}
            </article>
          );
        })}
      </section>

      {/* Admin-only: surface mock + any other hidden template instances
          if they exist so admins can manage them without losing the
          end-user simplification above. */}
      {isAdmin
        ? (() => {
            const hiddenInstances = connectors.filter(
              (c) => TEMPLATE_META[c.templateType as ConnectorTemplateType]?.hideFromUsers,
            );
            if (hiddenInstances.length === 0) return null;
            return (
              <section className="connector-admin-section">
                <h2>Admin: other connector instances</h2>
                <ul className="profile-list">
                  {hiddenInstances.map((c) => (
                    <li key={c.id.toString()}>
                      <Link href={`/connectors/${c.id}`}>{c.name}</Link>
                      <span className="muted small">
                        {' '}
                        · template <code>{c.templateType}</code>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })()
        : null}
    </AppShell>
  );
}
