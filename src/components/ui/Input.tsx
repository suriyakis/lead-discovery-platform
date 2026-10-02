// Text controls (DS-10): Input here, Select, Textarea and SearchInput
// beside it. Server-safe (no hooks), so server pages and client components
// both render them; styles in controls.module.css. Each takes the native
// element's props (name, defaultValue, required, form, ref, …) plus:
//
//   size     sm 28px | md 36px, 44px on a coarse pointer (default) | lg 44px
//
// Put one inside a Field for its label, hint and error; on its own it
// needs an aria-label (a toolbar filter, a table cell). There is no custom
// date picker: <Input type="date"> is the native one, styled.

import type { ComponentPropsWithRef } from 'react';
import styles from './controls.module.css';

export type ControlSize = 'sm' | 'md' | 'lg';

/** The text-like input types. Checkbox and radio are Checkbox and Switch. */
export const INPUT_TYPES = [
  'text',
  'email',
  'search',
  'number',
  'password',
  'url',
  'tel',
  'date',
  'datetime-local',
  'time',
  'month',
  'week',
] as const;
export type InputType = (typeof INPUT_TYPES)[number];

/** Joins class names, dropping empties. */
export const cx = (...names: ReadonlyArray<string | undefined | false>) =>
  names.filter(Boolean).join(' ');

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'size'> {
  type?: InputType;
  size?: ControlSize;
  /** Right-align the value (numbers in a column). */
  align?: 'start' | 'end';
}

export function Input({ type = 'text', size = 'md', align, className, ...rest }: InputProps) {
  return (
    <input
      type={type}
      className={cx(styles.control, className)}
      data-size={size}
      data-align={align === 'end' ? 'end' : undefined}
      {...rest}
    />
  );
}
