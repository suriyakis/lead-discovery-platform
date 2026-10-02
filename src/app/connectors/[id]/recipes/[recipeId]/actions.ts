'use server';

// "Run now" on the recipe detail page. It used to rethrow everything but
// ConnectorServiceError, so an empty token wallet (TokenError from the
// prepaid gate in startRun) crashed into Next's error page instead of
// showing the "No tokens left" message (I078).

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { describeActionError, withFlash } from '@/lib/action-errors';
import { AutomationGateError } from '@/lib/services/automation-gate';
import {
  ConnectorServiceError,
  RecipeRunInFlightError,
  startRun,
} from '@/lib/services/connector-run';
import { TokenError } from '@/lib/services/token-ledger';

function parseId(raw: unknown): bigint | null {
  return typeof raw === 'string' && /^\d{1,19}$/.test(raw) ? BigInt(raw) : null;
}

export async function runRecipeNowAction(
  rawConnectorId: string,
  rawRecipeId: string,
): Promise<void> {
  const connectorId = parseId(rawConnectorId);
  const recipeId = parseId(rawRecipeId);
  if (connectorId === null || recipeId === null) redirect('/connectors');
  const recipePath = `/connectors/${connectorId}/recipes/${recipeId}`;
  const ctx = await requireActionContext('/connectors');

  let runId: bigint;
  try {
    const { run } = await startRun(ctx, { connectorId, recipeId });
    runId = run.id;
  } catch (err) {
    // PC-12 (I068): a recipe runs once at a time — show the run in progress.
    if (err instanceof RecipeRunInFlightError) {
      redirect(withFlash(`/connectors/${connectorId}/runs/${err.runId}`, { message: err.message }));
    }
    const failure = describeActionError(
      err,
      [ConnectorServiceError, TokenError, AutomationGateError],
      {
        permission_denied:
          "Your role in this workspace is read-only, so you can't start runs. Ask a workspace admin if you need edit access.",
        // startRun's only conflict: the connector is switched off.
        conflict: 'This connector is inactive — activate it before running its recipes.',
        not_found: 'That recipe or connector no longer exists, so no run was started.',
      },
    );
    if (failure.code === 'not_found') {
      redirect(withFlash(`/connectors/${connectorId}`, { message: failure.message }));
    }
    redirect(withFlash(recipePath, { error: failure.message }));
  }
  redirect(`/connectors/${connectorId}/runs/${runId}`);
}
