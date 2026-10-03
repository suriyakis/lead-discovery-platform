// SearchInput (DS-10): an Input of type search with the glyph inside its
// padding. Inside a Field it takes the Field's label; on its own it needs
// an aria-label. See Input.tsx for the family.

import { Search } from 'lucide-react';
import { cx, type InputProps } from './Input';
import styles from './controls.module.css';

export interface SearchInputProps extends Omit<InputProps, 'type' | 'align'> {
  /** The wrapper's class (the input keeps the control class). */
  className?: string;
}

/**
 * A search field: type=search with the glyph inside its padding. Field
 * props (id, aria-describedby) and every input prop reach the input.
 */
export function SearchInput({ size = 'md', className, ...rest }: SearchInputProps) {
  return (
    <span className={cx(styles.search, className)} data-size={size}>
      <Search className={styles.searchIcon} aria-hidden="true" />
      <input type="search" className={styles.control} data-size={size} {...rest} />
    </span>
  );
}
