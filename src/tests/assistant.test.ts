// "Ask the platform" guide tests — the prompt must carry the handbook
// AND the live workspace snapshot, so answers are diagnoses.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { db } from '@/lib/db/client';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenOptions,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { AssistantError, askAssistant } from '@/lib/services/assistant';
import { createProductProfile } from '@/lib/services/product-profile';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

class CapturingProvider implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public lastInput: AIGenInput | null = null;
  async generateText(input: AIGenInput, _o?: AIGenOptions): Promise<AIGenResult> {
    this.lastInput = input;
    return {
      text: '  Check [/settings/billing].  ',
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
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

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'assistant@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('askAssistant', () => {
  it('grounds the prompt in the handbook AND the live workspace snapshot', async () => {
    const s = await setup();
    const stub = new CapturingProvider();
    _setAIProviderForTests(stub);
    await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'Sealer' });

    const result = await askAssistant(
      ctx(s.workspaceA, s.ownerA),
      'why am I getting no leads?',
    );
    expect(result.answer).toBe('Check [/settings/billing].'); // trimmed

    const prompt = stub.lastInput!.prompt;
    expect(prompt).toContain('PLATFORM HANDBOOK');
    expect(prompt).toContain('GEOGRAPHY GATE IS HARD');
    expect(prompt).toContain('THIS WORKSPACE RIGHT NOW');
    expect(prompt).toContain('Token balance: 500');
    expect(prompt).toContain('Active products: 1');
    expect(prompt).toContain('why am I getting no leads?');
    expect(stub.lastInput!.system).toContain('guide of the Lead Discovery Platform');
  });

  it('carries short conversation history', async () => {
    const s = await setup();
    const stub = new CapturingProvider();
    _setAIProviderForTests(stub);
    await askAssistant(ctx(s.workspaceA, s.ownerA), 'and then?', [
      { role: 'user', content: 'how do I add a mailbox?' },
      { role: 'assistant', content: 'Go to [/mailbox/new].' },
    ]);
    const prompt = stub.lastInput!.prompt;
    expect(prompt).toContain('how do I add a mailbox?');
    expect(prompt).toContain('Go to [/mailbox/new].');
  });

  it('rejects empty and oversized questions', async () => {
    const s = await setup();
    _setAIProviderForTests(new CapturingProvider());
    await expect(
      askAssistant(ctx(s.workspaceA, s.ownerA), '   '),
    ).rejects.toThrow(AssistantError);
    await expect(
      askAssistant(ctx(s.workspaceA, s.ownerA), 'x'.repeat(2001)),
    ).rejects.toThrow(AssistantError);
  });
});
