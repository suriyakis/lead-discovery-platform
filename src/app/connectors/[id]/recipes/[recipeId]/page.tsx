import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowLeft,
  Play,
  Save,
  Trash2,
  Archive,
  ArchiveRestore,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canWrite } from '@/lib/services/context';
import {
  ConnectorServiceError,
  deleteRecipe,
  getConnectorRow,
  getRecipe,
  startRun,
  updateRecipe,
} from '@/lib/services/connector-run';
import { isNextRedirectError } from '@/lib/server-redirect';

function parseJsonOrEmpty(raw: string, label: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default async function RecipeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; recipeId: string }>;
  searchParams: Promise<{ error?: string; ran?: string; message?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr, recipeId: rIdStr } = await params;
  if (!/^\d+$/.test(idStr) || !/^\d+$/.test(rIdStr)) redirect('/connectors');
  const connectorId = BigInt(idStr);
  const recipeId = BigInt(rIdStr);
  const sp = await searchParams;

  let ctx: import('@/lib/services/context').WorkspaceContext;
  let connector: import('@/lib/db/schema/connectors').Connector;
  let recipe: import('@/lib/db/schema/connectors').ConnectorRecipe;
  try {
    ctx = await getWorkspaceContext();
    connector = await getConnectorRow(ctx, connectorId);
    recipe = await getRecipe(ctx, recipeId);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/connectors');
    if (err instanceof ConnectorServiceError && err.code === 'not_found')
      redirect(`/connectors/${connectorId}`);
    throw err;
  }
  if (recipe.connectorId !== connector.id) redirect(`/connectors/${connectorId}`);

  const canEdit = canWrite(ctx);

  async function runNow(): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const { run } = await startRun(c, { connectorId, recipeId });
      redirect(`/connectors/${connectorId}/runs/${run.id}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      if (err instanceof ConnectorServiceError) {
        redirect(
          `/connectors/${connectorId}/recipes/${recipeId}?error=${encodeURIComponent(err.code)}`,
        );
      }
      throw err;
    }
  }

  async function save(formData: FormData): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const name = String(formData.get('name') ?? '').trim();
      const active = formData.get('active') === 'on';

      // Template-specific input parsing. The recipe schema has
      // generic columns (seedUrls, selectors, paginationRules, ...) but
      // each template only meaningfully uses a subset. We collect just
      // the fields that matter for the active template and rely on
      // updateRecipe to leave the others untouched (per partial-update
      // semantics).
      const update: Parameters<typeof updateRecipe>[2] = { name, active };

      if (connector.templateType === 'internet_search') {
        // Internet Search: queries + simple structured config in selectors.
        const searchQueries = parseLines(
          String(formData.get('searchQueries') ?? ''),
        );
        const country = String(formData.get('country') ?? '').trim();
        const language = String(formData.get('language') ?? '').trim();
        const maxResultsRaw = String(formData.get('maxResults') ?? '').trim();
        const maxResults =
          maxResultsRaw && /^\d+$/.test(maxResultsRaw)
            ? Math.min(Math.max(parseInt(maxResultsRaw, 10), 1), 200)
            : null;
        update.searchQueries = searchQueries;
        update.selectors = {
          ...(country ? { country } : {}),
          ...(language ? { language } : {}),
          ...(maxResults !== null ? { maxResults } : {}),
        };
      } else {
        // Other templates: keep the full set of fields exposed in raw
        // form (scraper-style recipes need selectors / pagination /
        // etc. — that complexity isn't going away).
        const seedUrls = parseLines(String(formData.get('seedUrls') ?? ''));
        const searchQueries = parseLines(
          String(formData.get('searchQueries') ?? ''),
        );
        const selectors = parseJsonOrEmpty(
          String(formData.get('selectors') ?? ''),
          'Selectors',
        );
        const paginationRules = parseJsonOrEmpty(
          String(formData.get('paginationRules') ?? ''),
          'Pagination rules',
        );
        const enrichmentRules = parseJsonOrEmpty(
          String(formData.get('enrichmentRules') ?? ''),
          'Enrichment rules',
        );
        const normalizationMapping = parseJsonOrEmpty(
          String(formData.get('normalizationMapping') ?? ''),
          'Normalization mapping',
        );
        const evidenceRules = parseJsonOrEmpty(
          String(formData.get('evidenceRules') ?? ''),
          'Evidence rules',
        );
        update.seedUrls = seedUrls;
        update.searchQueries = searchQueries;
        update.selectors = selectors;
        update.paginationRules = paginationRules;
        update.enrichmentRules = enrichmentRules;
        update.normalizationMapping = normalizationMapping;
        update.evidenceRules = evidenceRules;
      }

      await updateRecipe(c, recipeId, update);
      redirect(
        `/connectors/${connectorId}/recipes/${recipeId}?message=${encodeURIComponent('Recipe saved')}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof ConnectorServiceError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'save failed';
      redirect(
        `/connectors/${connectorId}/recipes/${recipeId}?error=${encodeURIComponent(m)}`,
      );
    }
  }

  async function archiveOrRestore(formData: FormData): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    const targetActive = formData.get('active') === 'on';
    try {
      await updateRecipe(c, recipeId, { active: targetActive });
      redirect(
        `/connectors/${connectorId}/recipes/${recipeId}?message=${encodeURIComponent(
          targetActive ? 'Recipe activated' : 'Recipe archived',
        )}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof Error ? err.message : 'failed';
      redirect(
        `/connectors/${connectorId}/recipes/${recipeId}?error=${encodeURIComponent(m)}`,
      );
    }
  }

  async function destroy(): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await deleteRecipe(c, recipeId);
      redirect(
        `/connectors/${connectorId}?message=${encodeURIComponent('Recipe deleted')}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'delete failed';
      redirect(
        `/connectors/${connectorId}/recipes/${recipeId}?error=${encodeURIComponent(m)}`,
      );
    }
  }

  return (
    <AppShell>
      <div className="recipe-page">
        <Link
          href={`/connectors/${connectorId}`}
          className="recipe-back"
          aria-label="Back to connector"
        >
          <ArrowLeft className="lucide" /> {connector.name}
        </Link>
        <header className="recipe-header">
          <div>
            <h1 className="recipe-title">{recipe.name}</h1>
            <div className="recipe-header-meta">
              <span className="badge">{recipe.templateType}</span>
              <span
                className={
                  recipe.active ? 'badge badge-good' : 'badge badge-bad'
                }
              >
                {recipe.active ? 'active' : 'archived'}
              </span>
              <span className="muted">
                last updated {recipe.updatedAt.toLocaleString()}
              </span>
            </div>
          </div>
          {canEdit ? (
            <div className="recipe-header-actions">
              <form action={runNow}>
                <button type="submit" className="primary-btn">
                  <Play className="lucide" /> Run now
                </button>
              </form>
            </div>
          ) : null}
        </header>

        {sp.message ? <p className="mail-flash info">{sp.message}</p> : null}
        {sp.error ? <p className="mail-flash error">Error: {sp.error}</p> : null}
        {sp.ran ? <p className="mail-flash info">Run started.</p> : null}

        {!canEdit ? (
          <p className="muted">Read-only — your role can&apos;t edit recipes.</p>
        ) : (
          <form action={save} className="recipe-form">
            <div className="recipe-form-grid">
              <label>
                <span>Name</span>
                <input
                  type="text"
                  name="name"
                  defaultValue={recipe.name}
                  maxLength={200}
                  required
                />
              </label>
              <label className="recipe-toggle-row">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked={recipe.active}
                />
                <span>Active (participates in crawl runs)</span>
              </label>
            </div>

            {connector.templateType === 'internet_search' ? (
              <InternetSearchFields recipe={recipe} />
            ) : (
              <ScraperFields recipe={recipe} />
            )}

            <div className="recipe-form-actions">
              <button type="submit" className="primary-btn">
                <Save className="lucide" /> Save changes
              </button>
            </div>
          </form>
        )}

        {canEdit ? (
          <section className="recipe-danger">
            <h2 className="recipe-danger-title">Lifecycle</h2>
            <p className="muted">
              Archiving keeps the recipe but stops it from participating in
              automated runs. Deleting removes it entirely — past runs keep
              their snapshot but lose the live link.
            </p>
            <div className="recipe-danger-actions">
              {recipe.active ? (
                <form action={archiveOrRestore}>
                  <button type="submit" className="ghost-btn">
                    <Archive className="lucide" /> Archive
                  </button>
                </form>
              ) : (
                <form action={archiveOrRestore}>
                  <input type="hidden" name="active" value="on" />
                  <button type="submit" className="ghost-btn">
                    <ArchiveRestore className="lucide" /> Restore
                  </button>
                </form>
              )}
              <form action={destroy}>
                <ConfirmFormButton
                  message={`Delete "${recipe.name}" permanently? Past runs keep their snapshot but lose the live link. This cannot be undone.`}
                  className="ghost-btn danger"
                >
                  <Trash2 className="lucide" /> Delete permanently
                </ConfirmFormButton>
              </form>
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

// ─── Field-group components ────────────────────────────────────────

// Per-template structured fields for Internet Search. Everything the
// operator actually needs to author a Wandizz-style search: queries +
// country filter + max results + language. Stored in the recipe's
// (schema-wide) searchQueries column + a small structured selectors
// JSON object the connector implementation reads.
function InternetSearchFields({
  recipe,
}: {
  recipe: {
    searchQueries: readonly string[];
    selectors: unknown;
  };
}) {
  const sel = (recipe.selectors as Record<string, unknown> | null) ?? {};
  const country = typeof sel.country === 'string' ? sel.country : '';
  const language = typeof sel.language === 'string' ? sel.language : '';
  const maxResults =
    typeof sel.maxResults === 'number' ? sel.maxResults : 20;
  return (
    <>
      <label>
        <span>Search queries (one per line)</span>
        <textarea
          name="searchQueries"
          rows={5}
          defaultValue={recipe.searchQueries.join('\n')}
          placeholder={
            'concrete repair contractor UK\nwaterproofing infrastructure UK'
          }
          required
        />
      </label>

      <div className="recipe-form-grid">
        <label>
          <span>Country</span>
          <input
            type="text"
            name="country"
            defaultValue={country}
            placeholder="e.g. UK, PL, DE"
            maxLength={4}
          />
        </label>
        <label>
          <span>Language</span>
          <input
            type="text"
            name="language"
            defaultValue={language}
            placeholder="e.g. en, pl"
            maxLength={4}
          />
        </label>
        <label>
          <span>Max results per query</span>
          <input
            type="number"
            name="maxResults"
            defaultValue={maxResults}
            min={1}
            max={200}
          />
        </label>
      </div>
    </>
  );
}

// Scraper-style recipes (directory harvester, tender API, csv import)
// still need the raw JSON config blocks — selectors / pagination /
// enrichment / etc. The complexity is real for those templates so we
// keep the full editor, but each block is collapsed by default.
function ScraperFields({
  recipe,
}: {
  recipe: {
    seedUrls: readonly string[];
    searchQueries: readonly string[];
    selectors: unknown;
    paginationRules: unknown;
    enrichmentRules: unknown;
    normalizationMapping: unknown;
    evidenceRules: unknown;
  };
}) {
  return (
    <>
      <label>
        <span>Seed URLs (one per line)</span>
        <textarea
          name="seedUrls"
          rows={4}
          defaultValue={recipe.seedUrls.join('\n')}
          placeholder={'https://example.com/listing\nhttps://example.com/page-2'}
        />
      </label>

      <label>
        <span>Search queries (one per line)</span>
        <textarea
          name="searchQueries"
          rows={4}
          defaultValue={recipe.searchQueries.join('\n')}
          placeholder={'EU CE marking 2026\nplaster spray applicator'}
        />
      </label>

      <details className="recipe-json-group">
        <summary>Selectors (JSON)</summary>
        <textarea
          name="selectors"
          rows={6}
          defaultValue={JSON.stringify(recipe.selectors, null, 2)}
        />
      </details>
      <details className="recipe-json-group">
        <summary>Pagination rules (JSON)</summary>
        <textarea
          name="paginationRules"
          rows={5}
          defaultValue={JSON.stringify(recipe.paginationRules, null, 2)}
        />
      </details>
      <details className="recipe-json-group">
        <summary>Enrichment rules (JSON)</summary>
        <textarea
          name="enrichmentRules"
          rows={5}
          defaultValue={JSON.stringify(recipe.enrichmentRules, null, 2)}
        />
      </details>
      <details className="recipe-json-group">
        <summary>Normalization mapping (JSON)</summary>
        <textarea
          name="normalizationMapping"
          rows={5}
          defaultValue={JSON.stringify(recipe.normalizationMapping, null, 2)}
        />
      </details>
      <details className="recipe-json-group">
        <summary>Evidence rules (JSON)</summary>
        <textarea
          name="evidenceRules"
          rows={5}
          defaultValue={JSON.stringify(recipe.evidenceRules, null, 2)}
        />
      </details>
    </>
  );
}
