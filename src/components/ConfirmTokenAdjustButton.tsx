'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { browserConfirmUi, confirmAction, readFieldValue } from '@/lib/confirm';
import { tokenAdjustmentConfirm } from '@/lib/confirm-copy';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  workspaceName: string;
  /** The workspace slug, shown next to the name (names are not unique). */
  workspaceSlug?: string | null;
  /** Current token balance as a decimal string (shows balance before → after). */
  balance?: string;
  billingExempt?: boolean;
  /** Name of the signed amount input. Default "tokens". */
  tokensField?: string;
  /** Name of the optional reason input. Default "reason". */
  reasonField?: string;
}

/**
 * Submit button for the super-admin token grant/deduct forms. Reads the
 * amount the operator typed and confirms the signed delta against the
 * named workspace ("+1,000 tokens to Acme (acme)" / "-1,000 tokens from
 * Acme (acme)"),
 * so a stray minus sign or an extra zero is caught before anything is
 * sent. An invalid amount skips the dialog; the server rejects it.
 */
export function ConfirmTokenAdjustButton({
  workspaceName,
  workspaceSlug,
  balance,
  billingExempt,
  tokensField = 'tokens',
  reasonField = 'reason',
  children,
  onClick,
  ...rest
}: Props) {
  return (
    <button
      type="submit"
      {...rest}
      onClick={(e) => {
        const form = e.currentTarget.form;
        const message = tokenAdjustmentConfirm({
          raw: readFieldValue(form, tokensField),
          reason: readFieldValue(form, reasonField),
          workspaceName,
          workspaceSlug,
          balance,
          billingExempt,
        });
        if (message !== null && !confirmAction({ message }, browserConfirmUi)) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
}
