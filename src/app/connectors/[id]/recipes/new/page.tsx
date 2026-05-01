import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  ConnectorServiceError,
  createRecipe,
  getConnectorRow,
} from '@/lib/services/connector-run';
import type { Connector } from '@/lib/db/schema/connectors';

export default async function NewRecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/connectors');
  const connectorId = BigInt(idStr);
  const sp = await searchParams;

  let connector: Connector;
  try {
    const ctx = await getWorkspaceContext();
    connector = await getConnectorRow(ctx, connectorId);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/connectors');
    if (err instanceof ConnectorServiceError && err.code === 'not_found') redirect('/connectors');
    throw err;
  }

  async function create(formData: FormData): Promise<void> {
    'use server';
    const ctx = await getWorkspaceContext();
    const name = String(formData.get('name') ?? '').trim();
    if (!name) redirect(`/connectors/${connectorId}/recipes/new?error=name_required`);

    const selectors = buildSelectorsForTemplate(connector.templateType, formData);

    try {
      const recipe = await createRecipe(ctx, {
        connectorId,
        name,
        selectors,
      });
      redirect(`/connectors/${connectorId}/recipes/${recipe.id}`);
    } catch (err) {
      if (err instanceof ConnectorServiceError) {
        redirect(
          `/connectors/${connectorId}/recipes/new?error=${encodeURIComponent(err.code)}`,
        );
      }
      throw err;
    }
  }

  return (
    <>
      <BrandHeader />
      <main>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/connectors">Connectors</Link> /{' '}
          <Link href={`/connectors/${connectorId}`}>{connector.name}</Link> / New recipe
        </p>
        <h1>New recipe</h1>
        <p className="muted">
          Template: <code>{connector.templateType}</code>
        </p>

        <form action={create} className="card-form">
          <div className="form-grid">
            {sp.error ? <p className="form-error">Error: {sp.error}</p> : null}

            <label>
              <span>Recipe name *</span>
              <input
                name="name"
                type="text"
                required
                maxLength={120}
                placeholder="e.g. Acoustic glass — UK new builds"
              />
            </label>

            <RecipeFieldsForTemplate templateType={connector.templateType} />

            <div className="form-actions">
              <button type="submit" className="primary-btn">
                Create recipe
              </button>
            </div>
          </div>
        </form>
      </main>
    </>
  );
}

function RecipeFieldsForTemplate({ templateType }: { templateType: string }) {
  if (templateType === 'internet_search') {
    return (
      <fieldset>
        <legend>Internet Search</legend>
        <label>
          <span>Search queries *</span>
          <textarea
            name="searchQueries"
            rows={6}
            required
            placeholder={'one query per line\nexample acoustic glass London\nexample fire-rated facade UK'}
          />
          <small>One query per line. 1–50 queries.</small>
        </label>
        <label>
          <span>Country (optional)</span>
          <input name="country" type="text" maxLength={6} placeholder="e.g. uk, us, pl" />
          <small>BCP-47 region code passed to the search provider.</small>
        </label>
        <label>
          <span>Language (optional)</span>
          <input name="language" type="text" maxLength={6} placeholder="e.g. en, pl" />
        </label>
        <label>
          <span>Max results per query</span>
          <input
            name="maxResults"
            type="number"
            min={1}
            max={100}
            step={1}
            defaultValue={10}
          />
        </label>
      </fieldset>
    );
  }
  if (templateType === 'mock') {
    return (
      <fieldset>
        <legend>Mock</legend>
        <label>
          <span>Seed</span>
          <input name="seed" type="text" defaultValue="mock" maxLength={60} />
          <small>Determines which deterministic records are produced.</small>
        </label>
        <label>
          <span>Count</span>
          <input name="count" type="number" min={0} max={500} defaultValue={5} />
        </label>
      </fieldset>
    );
  }
  return (
    <p className="muted">
      No editor implemented for template <code>{templateType}</code> yet.
    </p>
  );
}

function buildSelectorsForTemplate(
  templateType: string,
  form: FormData,
): Record<string, unknown> {
  if (templateType === 'internet_search') {
    const raw = String(form.get('searchQueries') ?? '');
    const searchQueries = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 50);
    const country = String(form.get('country') ?? '').trim() || undefined;
    const language = String(form.get('language') ?? '').trim() || undefined;
    const maxResultsRaw = String(form.get('maxResults') ?? '').trim();
    const maxResults = maxResultsRaw ? Number(maxResultsRaw) : undefined;
    return {
      searchQueries,
      ...(country ? { country } : {}),
      ...(language ? { language } : {}),
      ...(maxResults !== undefined && Number.isFinite(maxResults) ? { maxResults } : {}),
    };
  }
  if (templateType === 'mock') {
    const seed = String(form.get('seed') ?? 'mock').trim() || 'mock';
    const count = Number(String(form.get('count') ?? '5')) || 5;
    return { seed, count };
  }
  return {};
}
