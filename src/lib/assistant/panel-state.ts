// Conversation rules for the "Ask the platform" panel (AP-02), kept pure
// so they are unit-testable without a DOM. AssistantPanel.tsx is a thin
// view over these: its state lives in panelReducer and every ask runs
// through runAsk, so the tests drive exactly what the panel runs.
//
// The failure contract (I135/I136):
//   - the question goes back into the input, so nothing has to be retyped;
//   - the optimistic question bubble is removed, so no orphan turn is
//     left behind (and none is re-sent as history on the next ask);
//   - Retry is offered when asking again can help;
//   - only our own copy is ever shown — never raw provider/server text.

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** What /api/assistant returns, success or error. */
export interface AssistantReplyBody {
  ok?: boolean;
  answer?: string;
  source?: 'ai' | 'deterministic';
  error?: string;
  detail?: string;
  retryable?: boolean;
}

export interface AskFailure {
  message: string;
  retryable: boolean;
}

export type AskOutcome =
  | { ok: true; turns: Turn[] }
  | { ok: false; turns: Turn[]; input: string; failure: AskFailure };

/** How many prior turns travel with a question (the server keeps 8). */
export const HISTORY_TURNS_SENT = 8;

/**
 * Longest prior turn sent back, in characters. Answers are no longer
 * capped at ~3,600 characters (the per-model output floors raise the
 * budget), so a long answer must not make every later question fail.
 * The server reads only the first 500 characters of each turn anyway,
 * and /api/assistant clips (never rejects) to this same length.
 */
export const HISTORY_TURN_MAX_CHARS = 2000;

/** Error codes whose `detail` is written by /api/assistant itself (see
 *  the route header) — safe to show verbatim. Anything else gets generic
 *  copy, so a proxy page or vendor message can never reach the user. */
const OWN_COPY_CODES: ReadonlySet<string> = new Set([
  'account_inactive',
  'rate_limited',
  'empty_answer',
  'assistant_failed',
]);

export const PANEL_COPY = {
  network: "Couldn't reach the server. Your question is kept — try again.",
  empty: 'The guide came back with an empty answer. Your question is kept — try again.',
  unavailable: 'The guide is unavailable right now. Your question is kept — try again.',
  sessionExpired: 'Your session has ended — sign in again to keep asking.',
  noWorkspace: "You aren't in a workspace yet, so the guide has nothing to look at.",
  invalid: "That question couldn't be sent — keep it under 2,000 characters.",
} as const;

/** The prior turns that travel with the next question, each clipped. */
export function historyToSend(prior: ReadonlyArray<Turn>): Turn[] {
  return prior
    .slice(-HISTORY_TURNS_SENT)
    .map((t) => ({ role: t.role, content: t.content.slice(0, HISTORY_TURN_MAX_CHARS) }));
}

/**
 * Turn a failed reply into what the panel shows. `status` is null when
 * the request never got an HTTP response (offline, DNS, aborted).
 */
export function describeFailure(
  status: number | null,
  body: AssistantReplyBody | null,
): AskFailure {
  if (status === null) return { message: PANEL_COPY.network, retryable: true };
  const code = body?.error;
  const transient = status === 429 || status >= 500;
  if (code && OWN_COPY_CODES.has(code) && body?.detail) {
    return { message: body.detail, retryable: body.retryable ?? transient };
  }
  if (status >= 200 && status < 300) {
    // A 2xx without an answer — treat like an empty answer.
    return { message: PANEL_COPY.empty, retryable: true };
  }
  if (status === 401) return { message: PANEL_COPY.sessionExpired, retryable: false };
  if (code === 'no_workspace') return { message: PANEL_COPY.noWorkspace, retryable: false };
  if (code === 'invalid_input') return { message: PANEL_COPY.invalid, retryable: false };
  return { message: PANEL_COPY.unavailable, retryable: transient };
}

/**
 * Settle one ask. `prior` is the conversation BEFORE the optimistic
 * question bubble was added; `status`/`body` describe the reply (status
 * null = network failure, body null = unparseable).
 */
export function settleAsk(
  prior: ReadonlyArray<Turn>,
  question: string,
  status: number | null,
  body: AssistantReplyBody | null,
): AskOutcome {
  const answer = body?.answer?.trim();
  if (status !== null && status >= 200 && status < 300 && body?.ok && answer) {
    return {
      ok: true,
      turns: [
        ...prior,
        { role: 'user', content: question },
        { role: 'assistant', content: answer },
      ],
    };
  }
  return {
    ok: false,
    turns: [...prior],
    input: question,
    failure: describeFailure(status, body),
  };
}

// ---- the panel's state machine ---------------------------------------

export interface PanelState {
  turns: Turn[];
  input: string;
  busy: boolean;
  /** The last failure, with the question Retry would resend. */
  failure: (AskFailure & { question: string }) | null;
}

export const INITIAL_PANEL_STATE: PanelState = {
  turns: [],
  input: '',
  busy: false,
  failure: null,
};

export type PanelAction =
  | { type: 'input'; value: string }
  | { type: 'submit'; question: string; retry: boolean }
  | { type: 'settled'; question: string; outcome: AskOutcome };

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'input':
      return { ...state, input: action.value };
    case 'submit':
      return {
        ...state,
        busy: true,
        failure: null,
        // A Retry leaves anything newly typed in the input alone.
        input: !action.retry || state.input.trim() === action.question ? '' : state.input,
        // The optimistic bubble; 'settled' replaces the whole list.
        turns: [...state.turns, { role: 'user', content: action.question }],
      };
    case 'settled':
      if (action.outcome.ok) {
        return { ...state, busy: false, failure: null, turns: action.outcome.turns };
      }
      return {
        ...state,
        busy: false,
        // No orphan: the unanswered bubble is dropped.
        turns: action.outcome.turns,
        // Hand the question back unless something new was typed meanwhile
        // (the reducer sees the latest input, not the one at submit time).
        input: state.input.trim() ? state.input : action.outcome.input,
        failure: { ...action.outcome.failure, question: action.question },
      };
  }
}

/** One round trip to /api/assistant. Never throws: a network failure is
 *  settled like any other failure. */
export async function postQuestion(
  question: string,
  prior: ReadonlyArray<Turn>,
  fetchImpl: typeof fetch = fetch,
): Promise<AskOutcome> {
  let status: number | null = null;
  let body: AssistantReplyBody | null = null;
  try {
    const res = await fetchImpl('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history: historyToSend(prior) }),
    });
    status = res.status;
    body = (await res.json().catch(() => null)) as AssistantReplyBody | null;
  } catch {
    status = null; // never reached the server
  }
  return settleAsk(prior, question, status, body);
}

/**
 * One ask exactly as the panel runs it: pick the question (the input, or
 * `retryQuestion` for Retry), show it optimistically, POST it, settle.
 * `state` is the panel state the click saw. Returns null when there was
 * nothing to ask (empty input, or a request already in flight).
 */
export async function runAsk(
  state: PanelState,
  dispatch: (action: PanelAction) => void,
  retryQuestion?: string,
  fetchImpl?: typeof fetch,
): Promise<AskOutcome | null> {
  const question = (retryQuestion ?? state.input).trim();
  if (!question || state.busy) return null;
  const prior = state.turns;
  dispatch({ type: 'submit', question, retry: retryQuestion !== undefined });
  const outcome = await postQuestion(question, prior, fetchImpl);
  dispatch({ type: 'settled', question, outcome });
  return outcome;
}
