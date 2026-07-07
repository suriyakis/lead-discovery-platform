// In-thread composer tests — conversation coherence. The model must see
// the WHOLE conversation (not a 6-message window), know who it's talking
// to, and be told to escalate instead of inventing answers.

import { describe, expect, it } from 'vitest';
import type { ProductProfile } from '@/lib/db/schema/products';
import type { AIGenInput, AIGenOptions, AIGenResult, IAIProvider } from '@/lib/ai';
import {
  composeEngagementDraft,
  composeFollowUpDraft,
  composePitchDraft,
  type ThreadMessage,
} from '@/lib/services/outreach-engine';

function product(overrides: Partial<ProductProfile> = {}): ProductProfile {
  return {
    id: 1n,
    name: 'Vetrofluid Sealer',
    language: 'en',
    shortDescription: 'Deep-penetrating concrete waterproofing',
    fullDescription: null,
    targetSectors: ['infrastructure'],
    targetProjectTypes: ['bridges'],
    targetCustomerTypes: ['civil engineers'],
    includeKeywords: [],
    excludeKeywords: [],
    forbiddenPhrases: [],
    outreachInstructions: null,
    negativeOutreachInstructions: null,
    discoveryAngle: null,
    engagementAngle: null,
    pitchAngle: null,
    ...overrides,
  } as unknown as ProductProfile;
}

class CapturingProvider implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public lastInput: AIGenInput | null = null;
  async generateText(input: AIGenInput, _o?: AIGenOptions): Promise<AIGenResult> {
    this.lastInput = input;
    return { text: 'Reply body.', model: this.model, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  async generateJson<T>(): Promise<T> {
    throw new Error('not used');
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true, detail: 'stub' };
  }
}

function msg(
  direction: 'inbound' | 'outbound',
  body: string,
  i: number,
): ThreadMessage {
  return {
    direction,
    body,
    at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    fromName: direction === 'inbound' ? 'Anna Kowalska' : null,
    fromAddress: direction === 'inbound' ? 'anna@acme.pl' : 'us@nulife.pl',
  };
}

/** A 10-message thread whose FIRST message holds a unique marker that the
 *  old slice(-6) window used to drop. */
function tenMessageThread(): ThreadMessage[] {
  const thread: ThreadMessage[] = [
    msg('outbound', 'UNIQUE-OPENER: we asked who handles waterproofing at Acme.', 0),
  ];
  for (let i = 1; i < 10; i++) {
    thread.push(
      msg(i % 2 === 0 ? 'outbound' : 'inbound', `Message number ${i} in the thread.`, i),
    );
  }
  return thread;
}

const ctx = { channel: 'email', language: 'en' };

describe('conversation coherence', () => {
  it('engagement prompt contains the FULL thread, including the opener', async () => {
    const ai = new CapturingProvider();
    await composeEngagementDraft(tenMessageThread(), product(), ctx, ai);
    const prompt = ai.lastInput!.prompt;
    // The old slice(-6) dropped messages 1-4; the opener must now survive.
    expect(prompt).toContain('UNIQUE-OPENER');
    expect(prompt).toContain('Message number 1');
    expect(prompt).toContain('Message number 9');
  });

  it('pitch and follow-up prompts also carry the opener', async () => {
    const ai = new CapturingProvider();
    await composePitchDraft(tenMessageThread(), product(), ctx, ai);
    expect(ai.lastInput!.prompt).toContain('UNIQUE-OPENER');

    const ai2 = new CapturingProvider();
    await composeFollowUpDraft(tenMessageThread(), product(), 1, 3, ctx, ai2);
    expect(ai2.lastInput!.prompt).toContain('UNIQUE-OPENER');
  });

  it('over-budget threads keep the opener + newest messages full, digest the middle', async () => {
    const big = 'x'.repeat(1500);
    const thread: ThreadMessage[] = [
      msg('outbound', `UNIQUE-OPENER ${big}`, 0),
      ...Array.from({ length: 12 }, (_, i) =>
        msg(i % 2 === 0 ? 'inbound' : 'outbound', `MIDDLE-${i} ${big}`, i + 1),
      ),
      msg('inbound', `NEWEST-QUESTION what is the price? ${big}`, 20),
    ];
    const ai = new CapturingProvider();
    await composeEngagementDraft(thread, product(), ctx, ai);
    const prompt = ai.lastInput!.prompt;
    // Opener fully present (its full 1500-char body survived).
    expect(prompt).toContain('UNIQUE-OPENER');
    expect(prompt).toContain(`UNIQUE-OPENER ${big}`);
    // Newest message fully present.
    expect(prompt).toContain('NEWEST-QUESTION');
    // Middle messages digested, with the digest marker visible.
    expect(prompt).toContain('digested');
    expect(prompt).toContain('[truncated]');
    // Every middle message still referenced at least by its digest head.
    expect(prompt).toContain('MIDDLE-0');
  });

  it('prompts carry the recipient identity when the lead is known', async () => {
    const ai = new CapturingProvider();
    await composeEngagementDraft(
      tenMessageThread(),
      product(),
      { ...ctx, lead: { contactName: 'Anna Kowalska', contactEmail: 'anna@acme.pl' } },
      ai,
    );
    const prompt = ai.lastInput!.prompt;
    expect(prompt).toContain('Anna Kowalska');
    expect(prompt).toContain('acme.pl');
  });

  it('engagement system prompt names the product and forbids re-introductions', async () => {
    const ai = new CapturingProvider();
    await composeEngagementDraft(tenMessageThread(), product(), ctx, ai);
    const system = ai.lastInput!.system!;
    expect(system).toContain('Vetrofluid Sealer');
    expect(system).toContain('never re-introduce yourself');
  });

  it('engagement + pitch prompts instruct escalation instead of invention', async () => {
    const ai = new CapturingProvider();
    await composeEngagementDraft(tenMessageThread(), product(), ctx, ai);
    expect(ai.lastInput!.system).toContain("you'll check with the team");

    const ai2 = new CapturingProvider();
    await composePitchDraft(tenMessageThread(), product(), ctx, ai2);
    expect(ai2.lastInput!.system).toContain("you'll check with the team");
  });
});
