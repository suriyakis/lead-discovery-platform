'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  message: string;
  children: ReactNode;
}

/**
 * Submit button that intercepts the click with a native confirm() and
 * cancels the form submission when the operator declines. Used for
 * destructive actions (permanent delete). Pairs with `formAction` to
 * target a specific server action inside a multi-button form.
 */
export function ConfirmFormButton({ message, children, onClick, ...rest }: Props) {
  return (
    <button
      type="submit"
      {...rest}
      onClick={(e) => {
        if (!confirm(message)) {
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
