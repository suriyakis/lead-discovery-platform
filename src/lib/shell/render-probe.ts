// DS-07 / MOB-03 acceptance probe: "shell chrome queries run once per full
// load, not once per navigation". Off unless ENABLE_TEST_ROUTES=1 (the e2e
// server); everywhere else, including production, noteShellRender() returns
// at once and GET /api/test-only/shell-renders is a 404.
//
// A browser context that wants to be counted sets the SHELL_PROBE_COOKIE
// cookie to an id of its own; each server render of the workspace frame
// for a request carrying it adds one to that id. Counting per id (not one
// global number) keeps parallel e2e workers from disturbing each other.
// The tally lives on globalThis: the layout and the route handler are
// separate bundles of one server process.

import { cookies } from 'next/headers';

export const SHELL_PROBE_COOKIE = 'leadsonar-e2e-shell-probe';
const PROBE_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_IDS = 500;
const STORE_KEY = Symbol.for('leadsonar.shellRenderProbe');

type ProbeStore = Map<string, number>;

function probeStore(): ProbeStore {
  const g = globalThis as { [STORE_KEY]?: ProbeStore };
  g[STORE_KEY] ??= new Map();
  return g[STORE_KEY];
}

export function shellProbeEnabled(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.ENABLE_TEST_ROUTES === '1';
}

/** Count one frame render for the probe id on this request, if any. */
export async function noteShellRender(): Promise<void> {
  if (!shellProbeEnabled()) return;
  let id: string | undefined;
  try {
    id = (await cookies()).get(SHELL_PROBE_COOKIE)?.value;
  } catch {
    return; // not inside a request (scripts, tests)
  }
  if (!id || !PROBE_ID.test(id)) return;
  const store = probeStore();
  if (!store.has(id) && store.size >= MAX_IDS) store.clear();
  store.set(id, (store.get(id) ?? 0) + 1);
}

/** Frame renders counted for `id` so far (0 for an unknown id). */
export function shellRenderCount(id: string): number {
  return PROBE_ID.test(id) ? (probeStore().get(id) ?? 0) : 0;
}
