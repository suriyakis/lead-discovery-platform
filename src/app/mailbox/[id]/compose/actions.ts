'use server';

import { getWorkspaceContext } from '@/lib/services/auth-context';
import { getWorkspaceNativeLanguage } from '@/lib/services/workspace';
import { translateText } from '@/lib/services/translation';
import { MailServiceError, sendMessage } from '@/lib/services/mail';
import { MailboxServiceError } from '@/lib/services/mailbox';
import { buildComposeSendInput, type SendComposeInput } from './compose-input';

/** Translate the composed subject + body into the target language. No-op
 *  (returns the input) when target is empty or equals the native language. */
export async function translateComposeAction(input: {
  subject: string;
  body: string;
  targetLanguage: string;
}): Promise<{ subject: string; body: string }> {
  const ctx = await getWorkspaceContext();
  const native = await getWorkspaceNativeLanguage(ctx);
  const target = (input.targetLanguage ?? '').toLowerCase().split('-')[0] ?? '';
  if (!target || target === native) {
    return { subject: input.subject, body: input.body };
  }
  const bodyT = await translateText(ctx, {
    text: input.body,
    targetLanguage: target,
    sourceLanguageHint: native,
  });
  const subjT = input.subject
    ? await translateText(ctx, {
        text: input.subject,
        targetLanguage: target,
        sourceLanguageHint: native,
      })
    : null;
  return {
    subject: subjT?.translatedText ?? input.subject,
    body: bodyT.translatedText,
  };
}

export async function sendComposeAction(
  input: SendComposeInput,
): Promise<{ ok: true; threadId: string | null } | { ok: false; error: string }> {
  const ctx = await getWorkspaceContext();
  const native = await getWorkspaceNativeLanguage(ctx);
  // flow:F-05: one-to-one mode, signature appended once by sendMessage.
  const built = buildComposeSendInput(input, native);
  if (!built.ok) return built;

  try {
    const created = await sendMessage(ctx, built.input);
    return { ok: true, threadId: created.threadId?.toString() ?? null };
  } catch (err) {
    if (err instanceof MailServiceError || err instanceof MailboxServiceError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'send failed' };
  }
}
