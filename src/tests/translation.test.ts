import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import {
  mailMessages,
  mailThreads,
  mailboxes,
} from '@/lib/db/schema/mailing';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import { detectLanguageFromText } from '@/lib/i18n/language';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  TranslationError,
  maybeAutoTranslateInbound,
  translateFromEnglish,
  translateInboundToEnglish,
  translateInboundToNative,
  translateText,
  translateToEnglish,
} from '@/lib/services/translation';
import { updateWorkspaceNativeLanguage } from '@/lib/services/workspace';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
  mailboxId: bigint;
  threadId: bigint;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA-trans@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A-trans', ownerUserId: ownerA });
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId: workspaceA,
      name: 'sales',
      fromAddress: 'sales@nulife.pl',
      smtpHost: 'smtp.x',
      smtpUser: 'sales@nulife.pl',
      smtpPasswordSecretKey: 'mailbox.smtpPassword_translation_tests',
      imapFolder: 'INBOX',
      status: 'active',
      isDefault: true,
    })
    .returning();
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId: workspaceA,
      mailboxId: mb!.id,
      subject: 'hi',
      externalThreadKey: `subj:trans-${Date.now()}`,
      participants: ['anna@target.com', 'sales@nulife.pl'],
    })
    .returning();
  return { workspaceA, ownerA, mailboxId: mb!.id, threadId: thread!.id };
}

async function seedInbound(s: Setup, body: string): Promise<bigint> {
  const [m] = await db
    .insert(mailMessages)
    .values({
      workspaceId: s.workspaceA,
      mailboxId: s.mailboxId,
      threadId: s.threadId,
      direction: 'inbound',
      status: 'received',
      messageId: `<inbound-${Math.random().toString(36).slice(2)}@x>`,
      fromAddress: 'anna@target.com',
      toAddresses: ['sales@nulife.pl'],
      subject: 'hi',
      bodyText: body,
    })
    .returning();
  return m!.id;
}

async function seedOutbound(s: Setup, body: string): Promise<bigint> {
  const [m] = await db
    .insert(mailMessages)
    .values({
      workspaceId: s.workspaceA,
      mailboxId: s.mailboxId,
      threadId: s.threadId,
      direction: 'outbound',
      status: 'sent',
      messageId: `<outbound-${Math.random().toString(36).slice(2)}@x>`,
      fromAddress: 'sales@nulife.pl',
      toAddresses: ['anna@target.com'],
      subject: 'hi',
      bodyText: body,
    })
    .returning();
  return m!.id;
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

/**
 * Stub AI provider that echoes a deterministic translation back so tests
 * can assert what was passed without spending tokens. The generateJson
 * impl returns the schema-compatible shape the translation service
 * expects.
 */
const stubAi: IAIProvider = {
  id: 'stub',
  model: 'stub-model',
  async generateText() {
    throw new Error('generateText not used by translation');
  },
  async generateJson(input) {
    const sys = input.system ?? '';
    // Legacy translateFromEnglish path.
    if (sys.includes('Translate the user-supplied English text')) {
      return { translatedText: `[FR] ${input.prompt}` } as never;
    }
    // Generic translateText path carries a "(xx)" target code in the
    // system prompt. Tag the output with the target and detect the source
    // realistically so native-pivot assertions are meaningful.
    const m = sys.match(/natural .+ \(([a-z]{2})\)/);
    if (m) {
      const tgt = m[1]!;
      const detected = detectLanguageFromText(input.prompt) ?? 'pl';
      return {
        translatedText: `[${tgt.toUpperCase()}] ${input.prompt}`,
        detectedLanguage: detected,
        isSameLanguage: detected === tgt,
      } as never;
    }
    // Legacy translateToEnglish path.
    return {
      translatedText: `[EN] ${input.prompt}`,
      detectedLanguage: 'pl',
      isAlreadyEnglish: false,
    } as never;
  },
  estimateCost() {
    return 0;
  },
  async healthCheck() {
    return { ok: true };
  },
};

beforeEach(async () => {
  _setAIProviderForTests(stubAi);
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ─── translateToEnglish ────────────────────────────────────────────────

describe('translateToEnglish', () => {
  it('translates text and emits an audit event', async () => {
    const s = await setup();
    const result = await translateToEnglish(ctx(s.workspaceA, s.ownerA), {
      text: 'Dzień dobry, jesteśmy zainteresowani waszą ofertą.',
    });
    expect(result.translatedText).toContain('[EN]');
    expect(result.detectedLanguage).toBe('pl');
    expect(result.isAlreadyEnglish).toBe(false);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceA));
    const translateRow = audits.find((a) => a.kind === 'translation.to_english');
    expect(translateRow).toBeTruthy();
    const payload = translateRow!.payload as Record<string, unknown>;
    expect(payload.detectedLanguage).toBe('pl');
    expect(payload.provider).toBe('stub');
  });

  it('rejects empty text', async () => {
    const s = await setup();
    await expect(
      translateToEnglish(ctx(s.workspaceA, s.ownerA), { text: '   ' }),
    ).rejects.toThrow(TranslationError);
  });

  it('rejects oversized text', async () => {
    const s = await setup();
    await expect(
      translateToEnglish(ctx(s.workspaceA, s.ownerA), {
        text: 'a'.repeat(50_001),
      }),
    ).rejects.toThrow(/exceeds/);
  });
});

// ─── translateFromEnglish ─────────────────────────────────────────────

describe('translateFromEnglish', () => {
  it('translates English to a target language', async () => {
    const s = await setup();
    const result = await translateFromEnglish(ctx(s.workspaceA, s.ownerA), {
      text: 'Good morning, we are interested in your offer.',
      targetLanguage: 'fr',
    });
    expect(result.translatedText).toContain('[FR]');
    expect(result.targetLanguage).toBe('fr');

    const audits = await db.select().from(auditLog).where(eq(auditLog.workspaceId, s.workspaceA));
    expect(audits.some((a) => a.kind === 'translation.from_english')).toBe(true);
  });

  it('skips translation when target is English', async () => {
    const s = await setup();
    const result = await translateFromEnglish(ctx(s.workspaceA, s.ownerA), {
      text: 'Hello world',
      targetLanguage: 'en',
    });
    expect(result.translatedText).toBe('Hello world');
    // No-op should NOT touch the AI provider, so no audit entry either.
    const audits = await db.select().from(auditLog).where(eq(auditLog.workspaceId, s.workspaceA));
    expect(audits.some((a) => a.kind === 'translation.from_english')).toBe(false);
  });

  it('also short-circuits regional English (en-GB)', async () => {
    const s = await setup();
    const result = await translateFromEnglish(ctx(s.workspaceA, s.ownerA), {
      text: 'Hello world',
      targetLanguage: 'en-GB',
    });
    expect(result.translatedText).toBe('Hello world');
  });

  it('lowercases the target language for storage', async () => {
    const s = await setup();
    const result = await translateFromEnglish(ctx(s.workspaceA, s.ownerA), {
      text: 'Hello',
      targetLanguage: 'FR',
    });
    expect(result.targetLanguage).toBe('fr');
  });
});

// ─── translateInboundToEnglish ────────────────────────────────────────

describe('translateInboundToEnglish', () => {
  it('translates an inbound message and persists the cache', async () => {
    const s = await setup();
    const mid = await seedInbound(s, 'Dzień dobry, witam was serdecznie.');

    const r1 = await translateInboundToEnglish(ctx(s.workspaceA, s.ownerA), mid);
    expect(r1.freshlyTranslated).toBe(true);
    expect(r1.message.bodyTextEn).toContain('[EN]');
    expect(r1.message.translatedFromLanguage).toBe('pl');
    expect(r1.message.translatedAt).toBeInstanceOf(Date);
  });

  it('returns the cached translation without re-billing on second call', async () => {
    const s = await setup();
    const mid = await seedInbound(s, 'cześć');

    await translateInboundToEnglish(ctx(s.workspaceA, s.ownerA), mid);
    const r2 = await translateInboundToEnglish(ctx(s.workspaceA, s.ownerA), mid);
    expect(r2.freshlyTranslated).toBe(false);

    const audits = await db.select().from(auditLog).where(eq(auditLog.workspaceId, s.workspaceA));
    // Exactly one to_english audit entry — second call hit the cache.
    expect(audits.filter((a) => a.kind === 'translation.to_english')).toHaveLength(1);
  });

  it('refuses outbound messages', async () => {
    const s = await setup();
    const mid = await seedOutbound(s, 'we sent this');
    await expect(
      translateInboundToEnglish(ctx(s.workspaceA, s.ownerA), mid),
    ).rejects.toThrow(/inbound/);
  });

  it('refuses empty bodies', async () => {
    const s = await setup();
    const mid = await seedInbound(s, '');
    await expect(
      translateInboundToEnglish(ctx(s.workspaceA, s.ownerA), mid),
    ).rejects.toThrow(/no plain-text body/);
  });

  it('refuses cross-workspace access', async () => {
    const s = await setup();
    const mid = await seedInbound(s, 'witam');
    const otherUser = await seedUser({ email: 'other@test.local' });
    const otherWorkspace = await seedWorkspace({ name: 'Other', ownerUserId: otherUser });
    await expect(
      translateInboundToEnglish(ctx(otherWorkspace, otherUser), mid),
    ).rejects.toThrow(TranslationError);
  });
});

// ─── maybeAutoTranslateInbound ────────────────────────────────────────

describe('maybeAutoTranslateInbound', () => {
  it('translates a non-English inbound', async () => {
    const s = await setup();
    const mid = await seedInbound(
      s,
      'Vetrofluid to innowacyjny system uszczelniający dla betonu, który zapewnia trwałą ochronę przed wodą i wilgocią. Nasz produkt jest stosowany w budownictwie komercyjnym.',
    );
    const outcome = await maybeAutoTranslateInbound(ctx(s.workspaceA, s.ownerA), mid);
    expect(outcome).toBe('translated');

    const [row] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, mid));
    // Default workspace native is English, so the cache lands in
    // body_text_native tagged [EN].
    expect(row!.bodyTextNative).toContain('[EN]');
    expect(row!.nativeLanguage).toBe('en');
  });

  it('skips an inbound already in the native language without billing the AI', async () => {
    const s = await setup();
    const mid = await seedInbound(
      s,
      'Hello, we are interested in your offer for the construction project at our headquarters site.',
    );
    const outcome = await maybeAutoTranslateInbound(ctx(s.workspaceA, s.ownerA), mid);
    expect(outcome).toBe('skipped:already_native');
    const [row] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, mid));
    expect(row!.bodyTextNative).toBeNull();
    // No translation audit row.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceA));
    expect(audits.some((a) => a.kind === 'translation.to_english')).toBe(false);
  });

  it('skips short/ambiguous inbound (heuristic too uncertain)', async () => {
    const s = await setup();
    const mid = await seedInbound(s, 'OK thanks');
    const outcome = await maybeAutoTranslateInbound(ctx(s.workspaceA, s.ownerA), mid);
    expect(outcome).toBe('skipped:undetermined');
  });

  it('skips outbound messages', async () => {
    const s = await setup();
    const mid = await seedOutbound(s, 'we sent this');
    const outcome = await maybeAutoTranslateInbound(ctx(s.workspaceA, s.ownerA), mid);
    expect(outcome).toBe('skipped:not_inbound');
  });

  it('skips when body_text_native is already populated', async () => {
    const s = await setup();
    const mid = await seedInbound(s, 'cześć, mam pytanie odnośnie projektu budowlanego');
    await db
      .update(mailMessages)
      .set({ bodyTextNative: 'pre-existing' })
      .where(eq(mailMessages.id, mid));
    const outcome = await maybeAutoTranslateInbound(ctx(s.workspaceA, s.ownerA), mid);
    expect(outcome).toBe('skipped:already_translated');
  });

  it('pivots on the workspace native language (pl), not English', async () => {
    const s = await setup();
    await updateWorkspaceNativeLanguage(ctx(s.workspaceA, s.ownerA), 'pl');
    // German inbound, native Polish → should translate into Polish.
    const mid = await seedInbound(
      s,
      'Vetrofluid ist ein innovatives Betonabdichtungssystem, das dauerhaften Schutz gegen Wasser und Feuchtigkeit bietet und im gewerblichen Bau eingesetzt wird.',
    );
    const outcome = await maybeAutoTranslateInbound(ctx(s.workspaceA, s.ownerA), mid);
    expect(outcome).toBe('translated');
    const [row] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, mid));
    expect(row!.bodyTextNative).toContain('[PL]');
    expect(row!.nativeLanguage).toBe('pl');
    expect(row!.translatedFromLanguage).toBe('de');
  });

  it('skips an inbound that is already in a non-English native language', async () => {
    const s = await setup();
    await updateWorkspaceNativeLanguage(ctx(s.workspaceA, s.ownerA), 'pl');
    const mid = await seedInbound(
      s,
      'Dzień dobry, jesteśmy bardzo zainteresowani waszą ofertą dla naszego projektu budowlanego i prosimy o więcej informacji.',
    );
    const outcome = await maybeAutoTranslateInbound(ctx(s.workspaceA, s.ownerA), mid);
    expect(outcome).toBe('skipped:already_native');
  });

  it('honours the AUTO_TRANSLATE_INBOUND=0 env kill switch', async () => {
    const s = await setup();
    const mid = await seedInbound(
      s,
      'Vetrofluid to innowacyjny system uszczelniający dla betonu, który zapewnia trwałą ochronę przed wodą i wilgocią.',
    );
    const prior = process.env.AUTO_TRANSLATE_INBOUND;
    process.env.AUTO_TRANSLATE_INBOUND = '0';
    try {
      const outcome = await maybeAutoTranslateInbound(ctx(s.workspaceA, s.ownerA), mid);
      expect(outcome).toBe('skipped:disabled');
    } finally {
      if (prior === undefined) delete process.env.AUTO_TRANSLATE_INBOUND;
      else process.env.AUTO_TRANSLATE_INBOUND = prior;
    }
  });
});

// ─── translateText (generic native-pivot) ─────────────────────────────

describe('translateText', () => {
  it('translates into an arbitrary target language and audits', async () => {
    const s = await setup();
    const result = await translateText(ctx(s.workspaceA, s.ownerA), {
      text: 'Vetrofluid ist ein innovatives Betonabdichtungssystem, das einen dauerhaften Schutz gegen Wasser und Feuchtigkeit bietet und im gewerblichen Bau eingesetzt wird.',
      targetLanguage: 'pl',
    });
    expect(result.translatedText).toContain('[PL]');
    expect(result.targetLanguage).toBe('pl');
    expect(result.detectedLanguage).toBe('de');

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceA));
    const row = audits.find((a) => a.kind === 'translation.text');
    expect(row).toBeTruthy();
    expect((row!.payload as Record<string, unknown>).targetLanguage).toBe('pl');
  });

  it('is a no-op when the source hint already equals the target', async () => {
    const s = await setup();
    const result = await translateText(ctx(s.workspaceA, s.ownerA), {
      text: 'Already Polish text here',
      targetLanguage: 'pl',
      sourceLanguageHint: 'pl-PL',
    });
    expect(result.isSameLanguage).toBe(true);
    expect(result.translatedText).toBe('Already Polish text here');
    // No AI call ⇒ no audit row.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceA));
    expect(audits.some((a) => a.kind === 'translation.text')).toBe(false);
  });

  it('normalises the target language code', async () => {
    const s = await setup();
    const result = await translateText(ctx(s.workspaceA, s.ownerA), {
      text: 'Bonjour, nous sommes intéressés.',
      targetLanguage: 'DE',
    });
    expect(result.targetLanguage).toBe('de');
    expect(result.translatedText).toContain('[DE]');
  });

  it('rejects empty and oversized text', async () => {
    const s = await setup();
    await expect(
      translateText(ctx(s.workspaceA, s.ownerA), { text: '   ', targetLanguage: 'pl' }),
    ).rejects.toThrow(TranslationError);
    await expect(
      translateText(ctx(s.workspaceA, s.ownerA), {
        text: 'a'.repeat(50_001),
        targetLanguage: 'pl',
      }),
    ).rejects.toThrow(/exceeds/);
  });
});

// ─── translateInboundToNative ─────────────────────────────────────────

describe('translateInboundToNative', () => {
  it('translates an inbound message into the native language and caches it', async () => {
    const s = await setup();
    const mid = await seedInbound(
      s,
      'Vetrofluid ist ein innovatives Betonabdichtungssystem für gewerbliche Bauprojekte.',
    );
    const r1 = await translateInboundToNative(ctx(s.workspaceA, s.ownerA), mid, 'pl');
    expect(r1.freshlyTranslated).toBe(true);
    expect(r1.message.bodyTextNative).toContain('[PL]');
    expect(r1.message.nativeLanguage).toBe('pl');
    expect(r1.message.translatedFromLanguage).toBe('de');
    expect(r1.message.translatedAt).toBeInstanceOf(Date);
  });

  it('returns the cache without re-billing on the second call', async () => {
    const s = await setup();
    const mid = await seedInbound(s, 'Guten Tag, wir haben eine Frage zum Projekt.');
    await translateInboundToNative(ctx(s.workspaceA, s.ownerA), mid, 'pl');
    const r2 = await translateInboundToNative(ctx(s.workspaceA, s.ownerA), mid, 'pl');
    expect(r2.freshlyTranslated).toBe(false);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceA));
    expect(audits.filter((a) => a.kind === 'translation.text')).toHaveLength(1);
  });

  it('refuses outbound messages', async () => {
    const s = await setup();
    const mid = await seedOutbound(s, 'we sent this');
    await expect(
      translateInboundToNative(ctx(s.workspaceA, s.ownerA), mid, 'pl'),
    ).rejects.toThrow(/inbound/);
  });
});
