// Post-commit decision hooks (KL-02).
//
// A review decision's transaction is owned by the review service; other
// workstreams react to it AFTER it committed, through this registry
// instead of reaching into review.ts:
//
//   onApprovedProducts  — products a decision marked Fit (Outreach I001:
//                         create the pipeline lead on approve)
//   onRejectedProducts  — products a decision marked Not a fit, including
//                         archive / ignore (Outreach I015: cancel queued
//                         sends; I031: close the lead)
//
// Hooks run in registration order, one at a time; a hook that throws is
// logged and never undoes the decision or stops the next hook. Registering
// the same name again replaces the earlier hook (handler modules may be
// imported more than once).

import type { DecisionKind, DecisionOrigin } from './learning-decisions';
import type { WorkspaceContext } from './context';

export type DecisionHookKind = 'onApprovedProducts' | 'onRejectedProducts';

export interface ProductsDecidedEvent {
  ctx: WorkspaceContext;
  decisionId: string;
  kind: DecisionKind;
  origin: DecisionOrigin;
  reviewItemId: bigint;
  sourceRecordId: bigint;
  /** Never empty: hooks are not called for a decision with no products. */
  productProfileIds: readonly bigint[];
}

export type DecisionHook = (event: ProductsDecidedEvent) => Promise<void> | void;

const registry: Record<DecisionHookKind, Map<string, DecisionHook>> = {
  onApprovedProducts: new Map(),
  onRejectedProducts: new Map(),
};

/** Register (or replace) a named hook. Returns an unregister function. */
export function registerDecisionHook(
  kind: DecisionHookKind,
  name: string,
  hook: DecisionHook,
): () => void {
  registry[kind].set(name, hook);
  return () => {
    if (registry[kind].get(name) === hook) registry[kind].delete(name);
  };
}

/** Run every hook of `kind` for one decided subject. Never throws. */
export async function runDecisionHooks(
  kind: DecisionHookKind,
  event: ProductsDecidedEvent,
): Promise<void> {
  if (event.productProfileIds.length === 0) return;
  for (const [name, hook] of registry[kind]) {
    try {
      await hook(event);
    } catch (err) {
      console.error(
        `[decision-hooks] ${kind}:${name} failed for decision ${event.decisionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Names of the registered hooks (diagnostics / tests). */
export function listDecisionHooks(kind: DecisionHookKind): string[] {
  return [...registry[kind].keys()];
}
