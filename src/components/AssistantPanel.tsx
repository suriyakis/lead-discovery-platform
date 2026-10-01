'use client';

// Floating "Ask the platform" guide — bottom-right launcher opening a
// small chat panel. Single-shot request/response against /api/assistant
// with a short client-held history. [/path] references in answers are
// rendered as in-app links.
//
// On failure (AP-02) the question goes back into the input, the
// unanswered bubble is removed and a Retry button resends it. The state
// machine (panelReducer) and the ask itself (runAsk) live in
// src/lib/assistant/panel-state.ts; AssistantPanelView only renders a
// state, so tests can drive the same flow and render it without a DOM.

import { useReducer, useRef, useState, type RefObject } from 'react';
import Link from 'next/link';
import { HelpCircle, RotateCcw, Send, X } from 'lucide-react';
import {
  INITIAL_PANEL_STATE,
  panelReducer,
  runAsk,
  type PanelState,
} from '@/lib/assistant/panel-state';

/** Render "[/path]" handbook references as links, everything else as text. */
function AnswerText({ text }: { text: string }) {
  const parts = text.split(/(\[\/[a-z0-9/\-[\]]*?\])/gi);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[(\/[^\]]*)\]$/.exec(p);
        if (m) {
          return (
            <Link key={i} href={m[1]!}>
              {m[1]}
            </Link>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

export interface AssistantPanelViewProps {
  open: boolean;
  state: PanelState;
  onOpen: () => void;
  onClose: () => void;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onRetry: (question: string) => void;
  listRef?: RefObject<HTMLDivElement | null>;
}

/** The panel for a given state. No state of its own. */
export function AssistantPanelView({
  open,
  state,
  onOpen,
  onClose,
  onInput,
  onSubmit,
  onRetry,
  listRef,
}: AssistantPanelViewProps) {
  const { turns, input, busy, failure } = state;

  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title="Ask the platform — how-to help and diagnosis"
        style={{
          position: 'fixed',
          bottom: '1.25rem',
          right: '1.25rem',
          zIndex: 60,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.4rem',
          padding: '0.6rem 0.9rem',
          borderRadius: '999px',
          border: '1px solid var(--brand-border)',
          background: 'var(--brand-card-elevated)',
          color: 'var(--brand-fg)',
          cursor: 'pointer',
          boxShadow: 'var(--brand-shadow)',
          fontSize: '0.88rem',
        }}
      >
        <HelpCircle className="lucide" aria-hidden="true" /> Ask the platform
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.25rem',
        right: '1.25rem',
        zIndex: 60,
        width: 'min(26rem, calc(100vw - 2rem))',
        maxHeight: 'min(34rem, calc(100vh - 4rem))',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--brand-card)',
        border: '1px solid var(--brand-border)',
        borderRadius: 'var(--brand-radius)',
        boxShadow: 'var(--brand-shadow-hover)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.6rem 0.9rem',
          borderBottom: '1px solid var(--brand-border)',
        }}
      >
        <strong style={{ fontSize: '0.92rem' }}>
          <HelpCircle className="lucide" aria-hidden="true" /> Ask the platform
        </strong>
        <button
          type="button"
          onClick={onClose}
          className="ghost-btn"
          style={{ padding: '0.15rem 0.4rem' }}
          aria-label="Close"
        >
          <X className="lucide" aria-hidden="true" />
        </button>
      </header>

      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0.75rem 0.9rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.6rem',
          fontSize: '0.88rem',
          lineHeight: 1.5,
        }}
      >
        {turns.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            How-to questions and diagnosis, grounded in this workspace&apos;s
            actual state. Try: &ldquo;why am I getting no leads?&rdquo; or
            &ldquo;how do I set the target country?&rdquo;
          </p>
        ) : null}
        {turns.map((t, i) => (
          <div
            key={i}
            data-turn={t.role}
            style={{
              alignSelf: t.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '90%',
              padding: '0.45rem 0.7rem',
              borderRadius: 'var(--brand-radius)',
              background:
                t.role === 'user'
                  ? 'var(--brand-input)'
                  : 'var(--brand-card-elevated)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {t.role === 'assistant' ? <AnswerText text={t.content} /> : t.content}
          </div>
        ))}
        {busy ? <p className="muted" style={{ margin: 0 }}>Thinking…</p> : null}
        {failure ? (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <p className="form-error" style={{ margin: 0, fontSize: '0.82rem', flex: 1 }}>
              {failure.message}
            </p>
            {failure.retryable ? (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => onRetry(failure.question)}
                disabled={busy}
              >
                <RotateCcw className="lucide" aria-hidden="true" /> Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        style={{
          display: 'flex',
          gap: '0.5rem',
          padding: '0.6rem 0.9rem',
          borderTop: '1px solid var(--brand-border)',
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => onInput(e.target.value)}
          placeholder="Ask anything about the platform…"
          style={{ flex: 1 }}
          maxLength={2000}
        />
        <button type="submit" className="primary-btn" disabled={busy || !input.trim()}>
          <Send className="lucide" aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(panelReducer, INITIAL_PANEL_STATE);
  const listRef = useRef<HTMLDivElement | null>(null);

  async function ask(retryQuestion?: string) {
    const outcome = await runAsk(state, dispatch, retryQuestion);
    if (outcome?.ok) {
      queueMicrotask(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      });
    }
  }

  return (
    <AssistantPanelView
      open={open}
      state={state}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      onInput={(value) => dispatch({ type: 'input', value })}
      onSubmit={() => void ask()}
      onRetry={(question) => void ask(question)}
      listRef={listRef}
    />
  );
}
