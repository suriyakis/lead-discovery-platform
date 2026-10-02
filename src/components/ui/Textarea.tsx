// Textarea (DS-10): the native textarea; its rows set its height (three
// by default), never less than one control. See Input.tsx for the family.

import type { ComponentPropsWithRef } from 'react';
import { cx } from './Input';
import styles from './controls.module.css';

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  /** vertical (default) or none (a composer that grows by itself). */
  resize?: 'vertical' | 'none';
}

export function Textarea({ rows = 3, resize = 'vertical', className, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      className={cx(styles.control, styles.textarea, className)}
      data-resize={resize}
      {...rest}
    />
  );
}
