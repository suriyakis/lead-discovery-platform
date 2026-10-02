'use server';

// PC-10 (I074): Cancel on the run page. A pending run is cancelled at
// once; a running one is asked to stop and ends 'cancelled' at its next
// step, whichever worker process runs it (connector_runs.cancel_requested_at,
// polled by the runner). Any write role; requestRunCancel enforces it.

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { describeActionError, withFlash } from '@/lib/action-errors';
import { ConnectorServiceError, requestRunCancel } from '@/lib/services/connector-run';

function parseId(raw: unknown): bigint | null {
  return typeof raw === 'string' && /^\d{1,19}$/.test(raw) ? BigInt(raw) : null;
}

export async function cancelRunAction(formData: FormData): Promise<void> {
  const connectorId = parseId(formData.get('connectorId'));
  const runId = parseId(formData.get('runId'));
  if (connectorId === null || runId === null) redirect('/connectors');
  const runPath = `/connectors/${connectorId}/runs/${runId}`;
  const ctx = await requireActionContext('/connectors');

  let message: string;
  try {
    const result = await requestRunCancel(ctx, runId);
    message = result.immediate
      ? 'Run cancelled before it started.'
      : 'Cancel requested. The run stops after the search it is on now; records found so far are kept.';
  } catch (err) {
    const failure = describeActionError(err, [ConnectorServiceError], {
      permission_denied:
        "Your role in this workspace is read-only, so you can't cancel runs. Ask a workspace admin if you need edit access.",
      not_found: 'That run no longer exists.',
    });
    if (failure.code === 'not_found') {
      redirect(withFlash(`/connectors/${connectorId}`, { error: failure.message }));
    }
    // conflict: the service says how it ended ("the run has already finished").
    const text =
      failure.code === 'conflict' && err instanceof Error
        ? `Nothing to cancel: ${err.message}.`
        : failure.message;
    redirect(withFlash(runPath, { error: text }));
  }
  redirect(withFlash(runPath, { message }));
}
