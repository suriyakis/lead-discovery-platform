// Translation service. On-demand bidirectional translation backed by the
// workspace's AI provider (BYOK-aware via getAIProviderForCtx). Two
// surfaces:
//
//   translateInboundToEnglish(ctx, messageId)
//     For inbound foreign-language replies. Caches result on the
//     mail_messages row (body_text_en + translated_from_language +
//     translated_at) so repeat reads don't re-bill the AI.
//
//   translateText(ctx, { text, targetLanguage, sourceLanguageHint? })
//     Stateless one-shot. Used by the thread reply form to translate
//     a draft body before send. No caching — caller decides what to
//     do with the result.
//
// Both record an audit event with the byte counts and detected source
// language so the operator can reconcile spend.

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { mailMessages, type MailMessage } from '@/lib/db/schema/mailing';
import { getAIProviderForCtx } from '@/lib/ai';
import { detectLanguageFromText, getLanguageName } from '@/lib/i18n/language';
import { recordAuditEvent } from './audit';
import { getWorkspaceNativeLanguage } from './workspace';
import type { WorkspaceContext } from './context';

/** Normalise an ISO tag to its base, lowercased code ('en-GB' → 'en'). */
function baseLang(iso: string): string {
  return iso.toLowerCase().split('-')[0] ?? iso.toLowerCase();
}

export class TranslationError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
  }
}

const notFound = (kind: string) =>
  new TranslationError(`${kind} not found`, 'not_found');
const invalid = (msg: string) =>
  new TranslationError(msg, 'invalid_input');

// Schemas the LLM is asked to return. JSON-mode-friendly so any provider
// that supports structured outputs returns the right shape.
const fromEnglishSchema = z.object({
  translatedText: z.string(),
});
type FromEnglishResult = z.infer<typeof fromEnglishSchema>;

const toEnglishSchema = z.object({
  translatedText: z.string(),
  detectedLanguage: z.string().min(2).max(10).optional(),
  isAlreadyEnglish: z.boolean().optional(),
});
type ToEnglishParsed = z.infer<typeof toEnglishSchema>;

export interface TranslateToEnglishInput {
  text: string;
  /** Optional ISO hint for the source language. The LLM will still
   *  auto-detect, but a hint shortens its prompt. */
  sourceLanguageHint?: string | null;
}

export interface TranslateToEnglishResult {
  translatedText: string;
  detectedLanguage: string;
  isAlreadyEnglish: boolean;
}

export interface TranslateFromEnglishInput {
  text: string;
  targetLanguage: string;
}

export interface TranslateFromEnglishResult {
  translatedText: string;
  targetLanguage: string;
}

const MAX_TEXT_LEN = 50_000;

/**
 * Translate arbitrary text into English. Stateless — does NOT persist
 * the result. Callers decide whether to cache.
 */
export async function translateToEnglish(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  input: TranslateToEnglishInput,
): Promise<TranslateToEnglishResult> {
  const text = input.text?.trim() ?? '';
  if (!text) throw invalid('text is required');
  if (text.length > MAX_TEXT_LEN)
    throw invalid(`text exceeds ${MAX_TEXT_LEN} characters`);

  const provider = await getAIProviderForCtx(ctx);
  const langHint = input.sourceLanguageHint
    ? `The source language is ${getLanguageName(input.sourceLanguageHint)} (${input.sourceLanguageHint}).`
    : 'Auto-detect the source language.';

  const system = [
    'You are a professional translator. Translate the user-supplied text into fluent, natural English.',
    langHint,
    'Rules:',
    '- Preserve the original formatting (paragraphs, line breaks, bullet points).',
    '- Preserve proper nouns, company names, product names, and technical terms verbatim.',
    '- Preserve email greeting and closing conventions but render them naturally in English.',
    '- Do NOT add any commentary, notes, or explanations.',
    '- If the text is already in English, return it unchanged and set isAlreadyEnglish=true.',
    'Respond as JSON: { "translatedText": string, "detectedLanguage": ISO 639-1 code, "isAlreadyEnglish": boolean }.',
  ].join('\n');

  let parsed: ToEnglishParsed;
  try {
    parsed = await provider.generateJson(
      { system, prompt: text },
      toEnglishSchema,
    );
  } catch (err) {
    // Mock provider returns {} which fails the schema's required string;
    // surface a deterministic stub so dev environments still render.
    if (provider.id === 'mock') {
      parsed = { translatedText: text };
    } else {
      throw new TranslationError(
        `translation failed: ${err instanceof Error ? err.message : String(err)}`,
        'provider_error',
      );
    }
  }

  const detectedLanguage = parsed.detectedLanguage ?? input.sourceLanguageHint ?? 'unknown';
  const isAlreadyEnglish = parsed.isAlreadyEnglish ?? false;

  await recordAuditEvent(ctx, {
    kind: 'translation.to_english',
    payload: {
      bytesIn: text.length,
      bytesOut: parsed.translatedText.length,
      detectedLanguage,
      isAlreadyEnglish,
      provider: provider.id,
    },
  });

  return {
    translatedText: parsed.translatedText,
    detectedLanguage,
    isAlreadyEnglish,
  };
}

/**
 * Translate English text into the target language. Stateless. Used to
 * compose a message in English then ship it in the recipient's language.
 */
export async function translateFromEnglish(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  input: TranslateFromEnglishInput,
): Promise<TranslateFromEnglishResult> {
  const text = input.text?.trim() ?? '';
  if (!text) throw invalid('text is required');
  if (text.length > MAX_TEXT_LEN)
    throw invalid(`text exceeds ${MAX_TEXT_LEN} characters`);

  const targetLang = (input.targetLanguage ?? 'en').toLowerCase();

  // No-op if the target is already English.
  if (targetLang === 'en' || targetLang.startsWith('en-')) {
    return { translatedText: text, targetLanguage: targetLang };
  }

  const provider = await getAIProviderForCtx(ctx);
  const langName = getLanguageName(targetLang);

  const system = [
    `You are a professional translator. Translate the user-supplied English text into fluent, natural ${langName} (${targetLang}).`,
    'Rules:',
    `- Produce text that reads as if originally written in ${langName}.`,
    '- Preserve the original formatting (paragraphs, line breaks, bullet points).',
    '- Preserve proper nouns, company names, product names, and technical brand names verbatim.',
    '- Use formal/professional register appropriate for business communication.',
    '- Do NOT add any commentary, notes, or explanations.',
    'Respond as JSON: { "translatedText": string }.',
  ].join('\n');

  let parsed: FromEnglishResult;
  try {
    parsed = await provider.generateJson(
      { system, prompt: text },
      fromEnglishSchema,
    );
  } catch (err) {
    if (provider.id === 'mock') {
      parsed = { translatedText: text };
    } else {
      throw new TranslationError(
        `translation failed: ${err instanceof Error ? err.message : String(err)}`,
        'provider_error',
      );
    }
  }

  await recordAuditEvent(ctx, {
    kind: 'translation.from_english',
    payload: {
      bytesIn: text.length,
      bytesOut: parsed.translatedText.length,
      targetLanguage: targetLang,
      provider: provider.id,
    },
  });

  return {
    translatedText: parsed.translatedText,
    targetLanguage: targetLang,
  };
}

// ─── Generic bidirectional translation (native-pivot) ─────────────────

const translateTextSchema = z.object({
  translatedText: z.string(),
  detectedLanguage: z.string().min(2).max(10).optional(),
  isSameLanguage: z.boolean().optional(),
});
type TranslateTextParsed = z.infer<typeof translateTextSchema>;

export interface TranslateTextInput {
  text: string;
  /** ISO code to translate INTO. */
  targetLanguage: string;
  /** Optional ISO hint for the source language. When it equals the target
   *  the call short-circuits to a no-op (no AI, no audit). */
  sourceLanguageHint?: string | null;
}

export interface TranslateTextResult {
  translatedText: string;
  /** Best-effort source language (the hint, the model's detection, or
   *  'unknown'). */
  detectedLanguage: string;
  /** Normalised base code that was translated into. */
  targetLanguage: string;
  /** True when the source already equalled the target (no translation
   *  was needed). */
  isSameLanguage: boolean;
}

/**
 * Translate arbitrary text into an arbitrary target language. Stateless —
 * does NOT persist. Generalises translateToEnglish/translateFromEnglish so
 * the app can pivot on the workspace's native language rather than always
 * English (inbound foreign → native; outbound native → recipient target).
 */
export async function translateText(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  input: TranslateTextInput,
): Promise<TranslateTextResult> {
  const text = input.text?.trim() ?? '';
  if (!text) throw invalid('text is required');
  if (text.length > MAX_TEXT_LEN)
    throw invalid(`text exceeds ${MAX_TEXT_LEN} characters`);

  const targetLang = baseLang(input.targetLanguage ?? 'en');
  const hint = input.sourceLanguageHint ? baseLang(input.sourceLanguageHint) : null;

  // Known no-op: source hint already equals the target.
  if (hint && hint === targetLang) {
    return {
      translatedText: input.text,
      detectedLanguage: hint,
      targetLanguage: targetLang,
      isSameLanguage: true,
    };
  }

  const provider = await getAIProviderForCtx(ctx);
  const targetName = getLanguageName(targetLang);
  const hintLine = hint
    ? `The source language is ${getLanguageName(hint)} (${hint}).`
    : 'Auto-detect the source language.';

  const system = [
    `You are a professional translator. Translate the user-supplied text into fluent, natural ${targetName} (${targetLang}).`,
    hintLine,
    'Rules:',
    `- Produce text that reads as if originally written in ${targetName}.`,
    '- Preserve the original formatting (paragraphs, line breaks, bullet points).',
    '- Preserve proper nouns, company names, product names, and technical brand names verbatim.',
    '- Preserve email greeting and closing conventions, rendered naturally in the target language.',
    '- Use a formal/professional register appropriate for business communication.',
    '- Do NOT add any commentary, notes, or explanations.',
    `- If the text is already in ${targetName}, return it unchanged and set isSameLanguage=true.`,
    'Respond as JSON: { "translatedText": string, "detectedLanguage": ISO 639-1 code, "isSameLanguage": boolean }.',
  ].join('\n');

  let parsed: TranslateTextParsed;
  try {
    parsed = await provider.generateJson({ system, prompt: text }, translateTextSchema);
  } catch (err) {
    if (provider.id === 'mock') {
      parsed = { translatedText: input.text };
    } else {
      throw new TranslationError(
        `translation failed: ${err instanceof Error ? err.message : String(err)}`,
        'provider_error',
      );
    }
  }

  const detectedLanguage = parsed.detectedLanguage ?? hint ?? 'unknown';
  const isSameLanguage = parsed.isSameLanguage ?? detectedLanguage === targetLang;

  await recordAuditEvent(ctx, {
    kind: 'translation.text',
    payload: {
      bytesIn: text.length,
      bytesOut: parsed.translatedText.length,
      targetLanguage: targetLang,
      detectedLanguage,
      provider: provider.id,
    },
  });

  return {
    translatedText: parsed.translatedText,
    detectedLanguage,
    targetLanguage: targetLang,
    isSameLanguage,
  };
}

/**
 * Auto-translation outcomes. Returned by maybeAutoTranslateInbound so
 * callers (and tests) can assert which branch fired.
 */
export type AutoTranslateOutcome =
  | 'translated'
  | 'skipped:already_translated'
  | 'skipped:already_native'
  | 'skipped:undetermined'
  | 'skipped:no_body'
  | 'skipped:not_inbound'
  | 'skipped:disabled'
  | 'skipped:not_found';

/**
 * Best-effort auto-translate for an inbound message. Wired into
 * mail.persistInbound so foreign-language replies arrive pre-translated
 * and the operator sees the English version on first open.
 *
 * Decisions before billing:
 *   - AUTO_TRANSLATE_INBOUND=0 in env disables globally.
 *   - Outbound messages and rows that already have body_text_en are
 *     no-ops.
 *   - The heuristic language detector runs first. If it reads the body
 *     as English or can't decide (too short / mixed), we skip — both
 *     conditions cost nothing and matter most because most B2B inbound
 *     mail is English.
 *
 * Failures are surfaced via the return type, NOT by throwing — this
 * runs inline with mail receipt and must never break the receive path.
 */
export async function maybeAutoTranslateInbound(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  messageId: bigint,
): Promise<AutoTranslateOutcome> {
  if (process.env.AUTO_TRANSLATE_INBOUND === '0') {
    return 'skipped:disabled';
  }

  const [row] = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.id, messageId),
        eq(mailMessages.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!row) return 'skipped:not_found';
  if (row.direction !== 'inbound') return 'skipped:not_inbound';
  if (!row.bodyText || !row.bodyText.trim()) return 'skipped:no_body';
  if (row.bodyTextNative && row.bodyTextNative.trim())
    return 'skipped:already_translated';

  // Pivot on the workspace's native language, not a hardcoded English.
  const native = await getWorkspaceNativeLanguage(ctx);

  // Heuristic gate: skip the AI call entirely if the body already reads as
  // the native language or the detector is uncertain. A 0-cost short-
  // circuit for the common case (inbound mail already in the operator's
  // language).
  const detected = detectLanguageFromText(row.bodyText);
  if (detected === null) return 'skipped:undetermined';
  if (detected === native) return 'skipped:already_native';

  try {
    await translateInboundToNative(ctx, messageId, native);
    return 'translated';
  } catch (err) {
    console.error('[translation.maybeAutoTranslateInbound] failed:', err);
    return 'skipped:undetermined';
  }
}

/**
 * Translate an inbound mail message to English and cache the result on
 * the row. If body_text_en is already populated, returns it without
 * re-billing the AI. Idempotent — the cache is the source of truth.
 */
export async function translateInboundToEnglish(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  messageId: bigint,
): Promise<{ message: MailMessage; freshlyTranslated: boolean }> {
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.id, messageId),
        eq(mailMessages.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('mail_message');
  if (row.direction !== 'inbound') {
    throw invalid('only inbound messages can be translated');
  }
  if (!row.bodyText || !row.bodyText.trim()) {
    throw invalid('message has no plain-text body to translate');
  }

  // Cache hit: skip the AI call.
  if (row.bodyTextEn && row.bodyTextEn.trim()) {
    return { message: row, freshlyTranslated: false };
  }

  const result = await translateToEnglish(ctx, { text: row.bodyText });

  const [updated] = await db
    .update(mailMessages)
    .set({
      bodyTextEn: result.translatedText,
      translatedFromLanguage: result.detectedLanguage,
      translatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailMessages.id, messageId))
    .returning();
  if (!updated) throw notFound('mail_message');

  return { message: updated, freshlyTranslated: true };
}

/**
 * Translate an inbound mail message into the workspace's native language
 * and cache the result on the row (body_text_native + native_language +
 * translated_from_language + translated_at). Idempotent — if
 * body_text_native is already set, returns it without re-billing. This is
 * the native-pivot successor to translateInboundToEnglish and is what
 * maybeAutoTranslateInbound calls.
 */
export async function translateInboundToNative(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  messageId: bigint,
  nativeLanguage: string,
): Promise<{ message: MailMessage; freshlyTranslated: boolean }> {
  const native = baseLang(nativeLanguage || 'en');

  const [row] = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.id, messageId),
        eq(mailMessages.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('mail_message');
  if (row.direction !== 'inbound') {
    throw invalid('only inbound messages can be translated');
  }
  if (!row.bodyText || !row.bodyText.trim()) {
    throw invalid('message has no plain-text body to translate');
  }

  // Cache hit: skip the AI call.
  if (row.bodyTextNative && row.bodyTextNative.trim()) {
    return { message: row, freshlyTranslated: false };
  }

  const result = await translateText(ctx, {
    text: row.bodyText,
    targetLanguage: native,
  });

  const [updated] = await db
    .update(mailMessages)
    .set({
      bodyTextNative: result.translatedText,
      nativeLanguage: native,
      translatedFromLanguage: result.detectedLanguage,
      translatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailMessages.id, messageId))
    .returning();
  if (!updated) throw notFound('mail_message');

  return { message: updated, freshlyTranslated: true };
}
