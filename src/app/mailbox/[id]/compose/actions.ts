'use server';

import { getWorkspaceContext } from '@/lib/services/auth-context';
import { getWorkspaceNativeLanguage } from '@/lib/services/workspace';
import { translateText } from '@/lib/services/translation';
import { MailServiceError, sendMessage } from '@/lib/services/mail';
import { MailboxServiceError } from '@/lib/services/mailbox';

function parseList(s: string) {
  return s
    .split(/[,\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((address) => ({ address }));
}

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

export interface SendComposeInput {
  mailboxId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** '' = send the native body as-is. */
  targetLanguage: string;
  /** Operator-reviewed translation (sent when targetLanguage is set). */
  translatedSubject: string;
  translatedBody: string;
  draftId?: string;
}

export async function sendComposeAction(
  input: SendComposeInput,
): Promise<{ ok: true; threadId: string | null } | { ok: false; error: string }> {
  const ctx = await getWorkspaceContext();
  const native = await getWorkspaceNativeLanguage(ctx);
  const target = (input.targetLanguage ?? '').toLowerCase().split('-')[0] ?? '';
  const useTranslation = Boolean(target && target !== native && input.translatedBody.trim());

  if (!input.to.trim()) return { ok: false, error: 'recipient is required' };
  if (!input.subject.trim()) return { ok: false, error: 'subject is required' };
  if (!input.body.trim()) return { ok: false, error: 'message is required' };

  try {
    const created = await sendMessage(ctx, {
      mailboxId: BigInt(input.mailboxId),
      to: parseList(input.to),
      cc: input.cc.trim() ? parseList(input.cc) : undefined,
      bcc: input.bcc.trim() ? parseList(input.bcc) : undefined,
      subject: useTranslation
        ? input.translatedSubject.trim() || input.subject
        : input.subject,
      text: useTranslation ? input.translatedBody : input.body,
      // Keep the native version as the reference for the thread dual view.
      bodyTextNative: useTranslation ? input.body : undefined,
      nativeLanguage: useTranslation ? native : undefined,
      targetLanguage: useTranslation ? target : undefined,
      sourceDraftId:
        input.draftId && /^\d+$/.test(input.draftId)
          ? BigInt(input.draftId)
          : undefined,
    });
    return { ok: true, threadId: created.threadId?.toString() ?? null };
  } catch (err) {
    if (err instanceof MailServiceError || err instanceof MailboxServiceError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'send failed' };
  }
}
