// flow:F-05 — turns the compose form into a sendMessage input. Kept out of
// the 'use server' actions module so it stays a plain, testable function.
//
// Compose is one-to-one mail (no bulk unsubscribe footer, no
// List-Unsubscribe headers), and the signature is added exactly once: the
// form no longer pre-fills it into the body (I090); the operator picks it
// here and sendMessage appends it.
//
// PC-05 / flow:F-07: compose is manual mail — never held by the go-live
// hold — and while automation is paused it sends only after the operator
// confirmed "send anyway" (confirmPaused, audited by sendMessage).

import type { SendMailInput } from '@/lib/services/mail';

/** Signature pick values shared with the reply composer. */
export const SIGNATURE_DEFAULT = '__default__';
export const SIGNATURE_NONE = '__none__';

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
  /** SIGNATURE_DEFAULT (mailbox default), SIGNATURE_NONE, or a signature id. */
  signature?: string;
  /** PC-05: "send anyway" while automation is paused. */
  confirmPaused?: boolean;
  /** MOB-06: the workspace the compose page was rendered for. */
  expectedWorkspaceId?: string;
}

export type ComposeSendInputResult =
  | { ok: true; input: SendMailInput }
  | { ok: false; error: string };

function parseList(s: string) {
  return s
    .split(/[,\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((address) => ({ address }));
}

/** '' / default → undefined (mailbox default), none → null, id → bigint. */
export function parseSignaturePick(
  raw: string | undefined,
): { ok: true; signatureId: bigint | null | undefined } | { ok: false } {
  if (!raw || raw === SIGNATURE_DEFAULT) return { ok: true, signatureId: undefined };
  if (raw === SIGNATURE_NONE) return { ok: true, signatureId: null };
  if (/^\d+$/.test(raw)) return { ok: true, signatureId: BigInt(raw) };
  return { ok: false };
}

export function buildComposeSendInput(
  input: SendComposeInput,
  nativeLanguage: string,
): ComposeSendInputResult {
  if (!/^\d+$/.test(input.mailboxId)) return { ok: false, error: 'invalid mailbox' };
  if (!input.to.trim()) return { ok: false, error: 'recipient is required' };
  if (!input.subject.trim()) return { ok: false, error: 'subject is required' };
  if (!input.body.trim()) return { ok: false, error: 'message is required' };
  const signature = parseSignaturePick(input.signature);
  if (!signature.ok) return { ok: false, error: 'invalid signature choice' };

  const target = (input.targetLanguage ?? '').toLowerCase().split('-')[0] ?? '';
  const useTranslation = Boolean(
    target && target !== nativeLanguage && input.translatedBody.trim(),
  );

  return {
    ok: true,
    input: {
      mode: 'one_to_one',
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
      nativeLanguage: useTranslation ? nativeLanguage : undefined,
      targetLanguage: useTranslation ? target : undefined,
      signatureId: signature.signatureId,
      sourceDraftId:
        input.draftId && /^\d+$/.test(input.draftId) ? BigInt(input.draftId) : undefined,
      origin: 'manual',
      confirmPaused: input.confirmPaused === true,
    },
  };
}
