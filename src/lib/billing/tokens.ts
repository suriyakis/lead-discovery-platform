// Token economics — pure config + math, no I/O.
//
// The platform sells prepaid TOKENS (workspace wallet). 1 token = 1
// eurocent of retail value, so balances and pack sizes read naturally
// ("1 000 tokens" = €10 of usage). Metered actions debit
// ceil(providerCostCents × markup) tokens — cost-based pricing with the
// margin protected regardless of provider price changes.

/** Multiplier between our estimated provider cost and the retail price
 *  charged in tokens. Override per environment via TOKEN_MARKUP. */
export function tokenMarkup(): number {
  const raw = Number(process.env.TOKEN_MARKUP ?? '3');
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/**
 * Convert an estimated provider cost (cents) into a token debit.
 * Any non-zero cost charges at least 1 token; zero/unknown cost charges
 * nothing (mock providers, best-effort bookkeeping calls).
 */
export function costCentsToTokens(costCents: number | null | undefined): number {
  if (!costCents || costCents <= 0) return 0;
  return Math.max(1, Math.ceil(costCents * tokenMarkup()));
}

export interface TokenPack {
  id: string;
  name: string;
  tokens: number;
  /** Stripe Price id (one-time payment). Null = pack hidden (unset env). */
  priceId: string | null;
  /** Human display price, e.g. "€10". */
  display: string;
}

/** Purchasable packs. Price ids come from Stripe (one-time prices); the
 *  token amounts live here and travel to the webhook via metadata.
 *  Sonar-themed names (Leadsonar brand) — deliberately nothing like
 *  the Starter/Pro subscription plans, so the one-time-top-up vs
 *  monthly-allowance split stays unmistakable. */
export function tokenPacks(): TokenPack[] {
  return [
    {
      id: 'pack_s',
      name: 'Ping',
      tokens: 1_000,
      priceId: process.env.STRIPE_PRICE_TOKENS_S ?? null,
      display: process.env.STRIPE_PRICE_TOKENS_S_DISPLAY ?? '€10',
    },
    {
      id: 'pack_m',
      name: 'Pulse',
      tokens: 5_500,
      priceId: process.env.STRIPE_PRICE_TOKENS_M ?? null,
      display: process.env.STRIPE_PRICE_TOKENS_M_DISPLAY ?? '€49',
    },
    {
      id: 'pack_l',
      name: 'Deep Dive',
      tokens: 24_000,
      priceId: process.env.STRIPE_PRICE_TOKENS_L ?? null,
      display: process.env.STRIPE_PRICE_TOKENS_L_DISPLAY ?? '€199',
    },
  ];
}

export function tokenPackById(id: string): TokenPack | null {
  return tokenPacks().find((p) => p.id === id) ?? null;
}
