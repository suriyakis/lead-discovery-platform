'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import {
  browserConfirmUi,
  confirmAction,
  pickMessageForValue,
  type MessageByValue,
} from '@/lib/confirm';

interface BaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /**
   * Type-to-confirm: the operator must type this text (a slug or an
   * email) instead of clicking OK. For actions that are hard to notice
   * afterwards, such as granting super-admin.
   */
  confirmPhrase?: string;
}

type Props = BaseProps &
  (
    | { message: string; messageByValue?: undefined }
    | {
        /** Fallback when the field's value has no entry; omit for "no dialog". */
        message?: string;
        /** Pick the message from a form control's current value. */
        messageByValue: MessageByValue;
      }
  );

/**
 * Submit button that intercepts the click with a confirmation and
 * cancels the form submission when the operator declines, so nothing is
 * sent. Used for destructive and high-impact actions (permanent delete,
 * archive, role and billing changes — the wording for those lives in
 * src/lib/confirm-copy.ts). Pairs with `formAction` to target a specific
 * server action inside a multi-button form.
 */
export function ConfirmFormButton({
  message,
  messageByValue,
  confirmPhrase,
  children,
  onClick,
  ...rest
}: Props) {
  return (
    <button
      type="submit"
      {...rest}
      onClick={(e) => {
        const text = messageByValue
          ? pickMessageForValue(messageByValue, e.currentTarget.form) ?? message
          : message;
        if (
          text !== undefined &&
          !confirmAction({ message: text, confirmPhrase }, browserConfirmUi)
        ) {
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
