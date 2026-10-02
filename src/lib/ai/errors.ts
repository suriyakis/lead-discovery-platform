// Typed "the vendor answered, but there is no usable text" failure (AP-02).
//
// Lives in its own module (not ./index) so the Gemini adapter can throw
// it without an import cycle through the provider factory.

export type AIOutputFailureKind = 'empty' | 'refusal';

export interface AIOutputErrorInit {
  /** 'empty' — no visible text (typically the output budget ran out on
   *  hidden reasoning); 'refusal' — the model or its safety layer declined. */
  kind: AIOutputFailureKind;
  provider: string;
  model: string;
  /** Vendor stop / finish reason, e.g. 'max_tokens', 'length', 'refusal'. */
  stopReason: string | null;
  /** What the vendor billed for the attempt. The metering decorator logs
   *  it for cost tracking but never debits it to the tenant. */
  usage: { inputTokens: number; outputTokens: number };
}

export class AIOutputError extends Error {
  public readonly kind: AIOutputFailureKind;
  public readonly provider: string;
  public readonly model: string;
  public readonly stopReason: string | null;
  public readonly usage: { inputTokens: number; outputTokens: number };

  constructor(init: AIOutputErrorInit, message: string) {
    super(message);
    this.name = 'AIOutputError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.model = init.model;
    this.stopReason = init.stopReason;
    this.usage = init.usage;
  }
}
