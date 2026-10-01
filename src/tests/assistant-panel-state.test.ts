// AP-02 — the "Ask the platform" panel's failure contract.
//
// There is no jsdom / React Testing Library harness in this repo yet
// (that is AP-00). So the panel is built to be tested without one: its
// state lives in panelReducer, every ask runs through runAsk (the exact
// function AssistantPanel calls), and AssistantPanelView renders a state
// with no state of its own. The flow tests below drive runAsk with a
// stubbed fetch and render the view with react-dom/server, which covers
// what the RTL test was meant to: after a 502 the input holds the
// question, no orphan bubble renders, and Retry resends it.

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HISTORY_TURN_MAX_CHARS,
  INITIAL_PANEL_STATE,
  PANEL_COPY,
  describeFailure,
  historyToSend,
  panelReducer,
  runAsk,
  settleAsk,
  type PanelAction,
  type PanelState,
  type Turn,
} from '@/lib/assistant/panel-state';
import { AssistantPanelView } from '@/components/AssistantPanel';

const PRIOR: Turn[] = [
  { role: 'user', content: 'how do I add a mailbox?' },
  { role: 'assistant', content: 'Go to [/mailbox/new].' },
];

describe('settleAsk', () => {
  it('appends the question and the answer on success', () => {
    const out = settleAsk(PRIOR, 'and then?', 200, { ok: true, answer: ' Send a test. ' });
    expect(out).toEqual({
      ok: true,
      turns: [
        ...PRIOR,
        { role: 'user', content: 'and then?' },
        { role: 'assistant', content: 'Send a test.' },
      ],
    });
  });

  it('after a 502 the input holds the question, no orphan bubble remains, and Retry is offered', () => {
    const out = settleAsk(PRIOR, 'and then?', 502, {
      error: 'empty_answer',
      detail: 'The guide came back with an empty answer. Your question is kept — try again.',
      retryable: true,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.input).toBe('and then?');
    expect(out.turns).toEqual(PRIOR); // the unanswered question is gone
    expect(out.failure.retryable).toBe(true);
    expect(out.failure.message).toMatch(/empty answer/);
  });

  it('the retry sends the same question with the same (orphan-free) history', () => {
    const failed = settleAsk(PRIOR, 'and then?', 502, { error: 'empty_answer', retryable: true });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    // What the panel sends on Retry: the question, and history built from
    // the settled turns — no duplicate user turn.
    expect(historyToSend(failed.turns)).toEqual(PRIOR);
    const retried = settleAsk(failed.turns, failed.input, 200, { ok: true, answer: 'Done.' });
    expect(retried.ok && retried.turns.filter((t) => t.role === 'user')).toHaveLength(2);
  });

  it('a 200 with a blank answer is a retryable failure, never "request failed (200)"', () => {
    const out = settleAsk([], 'q', 200, { ok: true, answer: '   ' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ message: PANEL_COPY.empty, retryable: true });
    expect(out.failure.message).not.toMatch(/request failed/);
  });

  it('a network failure keeps the question and offers Retry', () => {
    const out = settleAsk(PRIOR, 'q', null, null);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.input).toBe('q');
    expect(out.failure).toEqual({ message: PANEL_COPY.network, retryable: true });
  });
});

describe('describeFailure never shows raw provider or server text', () => {
  it('unknown error codes get generic copy even when detail is present', () => {
    const f = describeFailure(500, {
      error: 'translate_failed',
      detail: 'anthropic messages 529: {"type":"overloaded_error"}',
    });
    expect(f.message).toBe(PANEL_COPY.unavailable);
    expect(f.retryable).toBe(true);
  });

  it('an unparseable body (proxy HTML page) gets generic copy', () => {
    expect(describeFailure(504, null)).toEqual({
      message: PANEL_COPY.unavailable,
      retryable: true,
    });
  });

  it("shows the route's own copy for its own codes", () => {
    expect(
      describeFailure(403, {
        error: 'account_inactive',
        detail: 'Your account is suspended. Contact your workspace administrator or the platform team.',
      }),
    ).toEqual({
      message: 'Your account is suspended. Contact your workspace administrator or the platform team.',
      retryable: false,
    });
    expect(
      describeFailure(429, { error: 'rate_limited', detail: 'Too many questions — try again in a minute.' })
        .retryable,
    ).toBe(true);
  });

  it('auth and input problems are not retryable', () => {
    expect(describeFailure(401, { error: 'unauthorized' })).toEqual({
      message: PANEL_COPY.sessionExpired,
      retryable: false,
    });
    expect(describeFailure(400, { error: 'no_workspace' }).retryable).toBe(false);
    expect(describeFailure(400, { error: 'invalid_input' })).toEqual({
      message: PANEL_COPY.invalid,
      retryable: false,
    });
  });
});

describe('historyToSend', () => {
  it('sends at most the last 8 turns', () => {
    const many: Turn[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `t${i}`,
    }));
    const sent = historyToSend(many);
    expect(sent).toHaveLength(8);
    expect(sent[0]!.content).toBe('t4');
  });

  it('clips a long earlier answer so the next question is still accepted', () => {
    // A 4.6+ model may now answer with more than the old ~3,600
    // characters; the route used to 400 every later question for it.
    const long = 'x'.repeat(5000);
    const sent = historyToSend([
      { role: 'user', content: 'explain autopilot' },
      { role: 'assistant', content: long },
    ]);
    expect(sent[1]!.content).toHaveLength(HISTORY_TURN_MAX_CHARS);
    expect(HISTORY_TURN_MAX_CHARS).toBeLessThanOrEqual(2000);
    expect(sent[0]).toEqual({ role: 'user', content: 'explain autopilot' });
  });
});

// ---- the panel flow: panelReducer + runAsk + AssistantPanelView ------

/** A store that applies actions the way useReducer does. */
function panelStore(initial: PanelState = INITIAL_PANEL_STATE) {
  let state = initial;
  return {
    get state() {
      return state;
    },
    dispatch: (action: PanelAction) => {
      state = panelReducer(state, action);
    },
  };
}

function reply(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function sentBody(fetchMock: ReturnType<typeof reply>, call = 0) {
  return JSON.parse(String(fetchMock.mock.calls[call]![1]!.body)) as {
    question: string;
    history: Turn[];
  };
}

function render(state: PanelState): string {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(AssistantPanelView, {
      open: true,
      state,
      onOpen: noop,
      onClose: noop,
      onInput: noop,
      onSubmit: noop,
      onRetry: noop,
    }),
  );
}

const EMPTY_502 = {
  error: 'empty_answer',
  detail: 'The guide came back with an empty answer. Your question is kept — try again.',
  retryable: true,
};

describe('the panel flow (what AssistantPanel runs)', () => {
  it('after a mocked 502 the input holds the question, no orphan bubble renders, and Retry resends it', async () => {
    const store = panelStore({ ...INITIAL_PANEL_STATE, turns: [...PRIOR] });
    store.dispatch({ type: 'input', value: 'why am I getting no leads?' });

    const fail = reply(502, EMPTY_502);
    const pending = runAsk(store.state, store.dispatch, undefined, fail);
    // In flight: the question shows as a bubble, the input is cleared.
    expect(store.state.busy).toBe(true);
    expect(store.state.input).toBe('');
    expect(store.state.turns.at(-1)).toEqual({ role: 'user', content: 'why am I getting no leads?' });
    await pending;

    expect(sentBody(fail)).toEqual({ question: 'why am I getting no leads?', history: PRIOR });
    expect(store.state.busy).toBe(false);
    expect(store.state.input).toBe('why am I getting no leads?');
    expect(store.state.turns).toEqual(PRIOR);
    expect(store.state.failure).toEqual({
      message: EMPTY_502.detail,
      retryable: true,
      question: 'why am I getting no leads?',
    });

    // What the user sees: the question back in the input, no bubble for
    // it, our own message and a Retry button.
    const html = render(store.state);
    expect(html).toContain('value="why am I getting no leads?"');
    expect(html.match(/data-turn="user"/g)).toHaveLength(1); // only PRIOR's question
    expect(html).not.toMatch(/data-turn="user"[^>]*>why am I getting no leads\?</);
    expect(html).toContain('role="alert"');
    expect(html).toContain(EMPTY_502.detail);
    expect(html).toContain('Retry');

    // Retry resends the same question with the same, orphan-free history.
    const ok = reply(200, { ok: true, answer: 'Set the target country on [/connectors].' });
    await runAsk(store.state, store.dispatch, store.state.failure!.question, ok);
    expect(sentBody(ok)).toEqual({ question: 'why am I getting no leads?', history: PRIOR });
    expect(store.state.failure).toBeNull();
    expect(store.state.input).toBe('');
    expect(store.state.turns).toEqual([
      ...PRIOR,
      { role: 'user', content: 'why am I getting no leads?' },
      { role: 'assistant', content: 'Set the target country on [/connectors].' },
    ]);
    const after = render(store.state);
    expect(after).not.toContain('role="alert"');
    expect(after).toContain('href="/connectors"');
  });

  it('text typed while the request was in flight is not overwritten by the failed question', async () => {
    const store = panelStore();
    store.dispatch({ type: 'input', value: 'first question' });
    const pending = runAsk(store.state, store.dispatch, undefined, reply(500, { error: 'assistant_failed' }));
    store.dispatch({ type: 'input', value: 'a new question' });
    await pending;
    expect(store.state.input).toBe('a new question');
    expect(store.state.failure?.question).toBe('first question');
    expect(store.state.turns).toEqual([]);
  });

  it('a Retry keeps a new question the user has started typing', async () => {
    const store = panelStore();
    store.dispatch({ type: 'input', value: 'q1' });
    await runAsk(store.state, store.dispatch, undefined, reply(502, EMPTY_502));
    store.dispatch({ type: 'input', value: 'q2 draft' });
    const ok = reply(200, { ok: true, answer: 'A1' });
    await runAsk(store.state, store.dispatch, 'q1', ok);
    expect(sentBody(ok).question).toBe('q1');
    expect(store.state.input).toBe('q2 draft');
  });

  it('a network failure (fetch throws) keeps the question and offers Retry', async () => {
    const store = panelStore();
    store.dispatch({ type: 'input', value: 'hello?' });
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const outcome = await runAsk(store.state, store.dispatch, undefined, offline);
    expect(outcome?.ok).toBe(false);
    expect(store.state.input).toBe('hello?');
    expect(store.state.failure).toEqual({ message: PANEL_COPY.network, retryable: true, question: 'hello?' });
  });

  it('a proxy error page never reaches the user, and a non-retryable failure has no Retry button', async () => {
    const store = panelStore();
    store.dispatch({ type: 'input', value: 'x'.repeat(10) });
    const proxy = vi.fn(async () => new Response('<html>502 Bad Gateway nginx</html>', { status: 502 }));
    await runAsk(store.state, store.dispatch, undefined, proxy);
    expect(render(store.state)).not.toContain('nginx');
    expect(store.state.failure?.message).toBe(PANEL_COPY.unavailable);

    const expired = panelStore();
    expired.dispatch({ type: 'input', value: 'q' });
    await runAsk(expired.state, expired.dispatch, undefined, reply(401, { error: 'unauthorized' }));
    const html = render(expired.state);
    expect(html).toContain(PANEL_COPY.sessionExpired);
    expect(html).not.toContain('Retry');
  });

  it('does nothing for an empty input or while a request is in flight', async () => {
    const f = reply(200, { ok: true, answer: 'A' });
    const empty = panelStore();
    expect(await runAsk(empty.state, empty.dispatch, undefined, f)).toBeNull();
    const busy = panelStore({ ...INITIAL_PANEL_STATE, input: 'q', busy: true });
    expect(await runAsk(busy.state, busy.dispatch, undefined, f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
