// AP-02 — the "Ask the platform" panel's failure contract, tested on the
// pure rules AssistantPanel.tsx renders (no DOM harness yet; the RTL
// version of these checks lands with AP-00).

import { describe, expect, it } from 'vitest';
import {
  PANEL_COPY,
  describeFailure,
  historyToSend,
  settleAsk,
  type Turn,
} from '@/lib/assistant/panel-state';

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
});
