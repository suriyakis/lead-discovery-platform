'use server';

// MOB-06: both actions are guarded — ComposeForm passes the page's
// workspace as `expectedWorkspaceId`, and after a switch in another tab
// they answer { ok: false, code: 'workspace_changed' } before anything is
// translated (spent) or sent.

import { getWorkspaceContext } from '@/lib/services/auth-context';
import { getWorkspaceNativeLanguage } from '@/lib/services/workspace';
import { translateText } from '@/lib/services/translation';
import { MailServiceError, sendMessage } from '@/lib/services/mail';
import { AutomationGateError } from '@/lib/services/automation-gate';
import { MailboxServiceError } from '@/lib/services/mailbox';
import { withWorkspaceGuard, type WorkspaceMismatch } from '@/lib/workspace-guard/server';
import { buildComposeSendInput, type SendComposeInput } from './compose-input';

const refused = (m: WorkspaceMismatch) => ({ ok: false as const, error: m.message, code: m.code });

/** Translate the composed subject + body into the target language. No-op
 *  (returns the input) when target is empty or equals the native language. */
async function translateCompose(input: {
  subject: string;
  body: string;
  targetLanguage: string;
  /** MOB-06: the workspace the compose page was rendered for. */
  expectedWorkspaceId?: string;
}): Promise<
  | { ok: true; subject: string; body: string }
  | { ok: false; error: string; code?: 'workspace_changed' }
> {
  const ctx = await getWorkspaceContext();
  const native = await getWorkspaceNativeLanguage(ctx);
  const target = (input.targetLanguage ?? '').toLowerCase().split('-')[0] ?? '';
  if (!target || target === native) {
    return { ok: true, subject: input.subject, body: input.body };
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
    ok: true,
    subject: subjT?.translatedText ?? input.subject,
    body: bodyT.translatedText,
  };
}
export const translateComposeAction = withWorkspaceGuard(
  'communication.compose_translate',
  translateCompose,
  { onMismatch: refused },
);

async function sendCompose(
  input: SendComposeInput,
): Promise<
  | { ok: true; threadId: string | null }
  | { ok: false; error: string; needsPauseConfirm?: boolean; code?: 'workspace_changed' }
> {
  const ctx = await getWorkspaceContext();
  const native = await getWorkspaceNativeLanguage(ctx);
  // flow:F-05: one-to-one mode, signature appended once by sendMessage.
  const built = buildComposeSendInput(input, native);
  if (!built.ok) return built;

  try {
    const created = await sendMessage(ctx, built.input);
    return { ok: true, threadId: created.threadId?.toString() ?? null };
  } catch (err) {
    // PC-05: paused — the form shows the "send anyway" confirm and retries.
    if (err instanceof AutomationGateError) {
      return {
        ok: false,
        error: err.message,
        ...(err.reason === 'paused' && err.overridable ? { needsPauseConfirm: true } : {}),
      };
    }
    if (err instanceof MailServiceError || err instanceof MailboxServiceError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'send failed' };
  }
}
export const sendComposeAction = withWorkspaceGuard('communication.compose', sendCompose, {
  onMismatch: refused,
});
