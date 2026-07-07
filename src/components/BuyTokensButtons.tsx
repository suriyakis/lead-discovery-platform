'use client';

// Token pack purchase buttons — POSTs the pack to /api/stripe/buy-tokens
// and redirects to the returned Stripe Checkout URL. The webhook credits
// the wallet after payment; the billing page shows the new balance.

import { useState } from 'react';
import { Coins } from 'lucide-react';

interface PackOption {
  id: string;
  name: string;
  tokens: number;
  display: string;
  purchasable: boolean;
}

export function BuyTokensButtons({ packs }: { packs: ReadonlyArray<PackOption> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function buy(packId: string) {
    setBusyId(packId);
    setError(null);
    try {
      const res = await fetch('/api/stripe/buy-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        url?: string;
        detail?: string;
        error?: string;
      };
      if (!res.ok || !j.url) {
        setError(j.detail || j.error || `purchase failed (${res.status})`);
        return;
      }
      window.location.href = j.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="plan-picker">
        {packs.map((p) => (
          <article key={p.id} className="plan-card">
            <header className="plan-card-head">
              <h3>
                <Coins className="lucide" aria-hidden="true" /> {p.name}
              </h3>
              <span className="plan-price">{p.display}</span>
            </header>
            <p className="plan-pitch">
              {p.tokens.toLocaleString()} tokens — spent on discovery search,
              AI qualification, drafting and translation.
            </p>
            <button
              type="button"
              className="primary-btn"
              disabled={!p.purchasable || busyId !== null}
              onClick={() => buy(p.id)}
            >
              {busyId === p.id
                ? 'Opening checkout…'
                : p.purchasable
                  ? 'Buy'
                  : 'Not available yet'}
            </button>
          </article>
        ))}
      </div>
      {error ? (
        <p className="form-error" style={{ marginTop: '0.75rem' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
