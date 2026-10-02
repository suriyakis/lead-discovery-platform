// Select (DS-10): the native select with the drawn chevron, at the control
// heights. See Input.tsx for the family; styles in controls.module.css.

import type { ComponentPropsWithRef } from 'react';
import { type ControlSize, cx } from './Input';
import styles from './controls.module.css';

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'size'> {
  size?: ControlSize;
  /** plain: no box of its own, inside a container that draws one. */
  variant?: 'default' | 'plain';
}

export function Select({ size = 'md', variant = 'default', className, ...rest }: SelectProps) {
  return (
    <select
      className={cx(styles.control, styles.select, className)}
      data-size={size}
      data-variant={variant}
      {...rest}
    />
  );
}
