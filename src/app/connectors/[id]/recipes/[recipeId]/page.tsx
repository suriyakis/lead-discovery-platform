import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canWrite } from '@/lib/services/context';
import {
  ConnectorServiceError,
  getConnectorRow,
  getRecipe,
  startRun,
} from '@/lib/services/connector-run';

export default async function RecipeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; recipeId: string }>;
  searchParams: Promise<{ error?: string; ran?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr, recipeId: rIdStr } = await params;
  if (!/^\d+$/.test(idStr) || !/^\d+$/.test(rIdStr)) redirect('/connectors');
  const connectorId = BigInt(idStr);
  const recipeId = BigInt(rIdStr);
  const sp = await searchParams;

  let ctx;
  let connector;
  let recipe;
  try {
    ctx = await getWorkspaceContext();
    connector = await getConnectorRow(ctx, connectorId);
    recipe = await getRecipe(ctx, recipeId);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/connectors');
    if (err instanceof ConnectorServiceError && err.code === 'not_found') redirect(`/connectors/${connectorId}`);
    throw err;
  }
  if (recipe.connectorId !== connector.id) redirect(`/connectors/${connectorId}`);

  const canRun = canWrite(ctx);
  const selectors = recipe.selectors as Record<string, unknown>;

  async function runNow(): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const { run } = await startRun(c, { connectorId, recipeId });
      redirect(`/connectors/${connectorId}/runs/${run.id}`);
    } catch (err) {
      if (err instanceof ConnectorServiceError) {
        redirect(
          `/connectors/${connectorId}/recipes/${recipeId}?error=${encodeURIComponent(err.code)}`,
        );
      }
      throw err;
    }
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/connectors">Connectors</Link> /{' '}
          <Link href={`/connectors/${connectorId}`}>{connector.name}</Link> / {recipe.name}
        </p>
        <h1>{recipe.name}</h1>
        <p>
          <span className="badge">{recipe.templateType}</span>{' '}
          <span className={recipe.active ? 'badge badge-good' : 'badge badge-bad'}>
            {recipe.active ? 'active' : 'inactive'}
          </span>
        </p>

        {sp.error ? <p className="form-error">Error: {sp.error}</p> : null}
        {sp.ran ? <p className="form-success">Run started.</p> : null}

        <section>
          <h2>Configuration</h2>
          <pre className="json-block">{JSON.stringify(selectors, null, 2)}</pre>
          <p className="muted">
            (Inline editor for recipe configuration arrives with template-specific recipe edit
            forms in a later iteration. For now the configuration is read-only via the UI; you
            can re-run the recipe and create variants by adding new recipes.)
          </p>
        </section>

        {canRun ? (
          <section>
            <h2>Run this recipe</h2>
            <p className="muted">
              Starts the connector synchronously. The recipe is snapshotted into the run, so
              future edits don&apos;t affect this run&apos;s history.
            </p>
            <form action={runNow}>
              <button type="submit" className="primary-btn">
                Run now
              </button>
            </form>
          </section>
        ) : null}
      </AppShell>
  );
}
