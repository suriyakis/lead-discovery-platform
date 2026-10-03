// Field (DS-10): a label, one control, an optional error and hint, wired
// by id. Server-safe (useId and cloneElement only), so server pages and
// client components both use it; styles in Field.module.css.
//
//   <Field label="Role" hint="Owners can grant the owner role.">
//     <Select name="role" defaultValue="member">…</Select>
//   </Field>
//
// The control is the one child element: an Input, Select, Textarea,
// SearchInput or a bare <input>/<select>/<textarea>. Field gives it an id
// (its own, or a generated one), points the label at it, and sets
// aria-describedby to the error and hint (error first) plus any ids the
// control already carries; with an error it also sets aria-invalid.
// Checkbox and Switch carry their own label and are not wrapped in a Field.

import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from 'react';
import { TriangleAlert } from 'lucide-react';
import styles from './Field.module.css';

/** The props a Field sets on its control. */
export interface FieldControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

export type FieldLayout = 'stack' | 'inline';

/**
 * full: the control fills the field (stack default). num: a number or a
 * short code, 120px at most. auto: the control keeps its own width.
 */
export type FieldWidth = 'full' | 'num' | 'auto';

export interface FieldProps {
  /** The visible label; it names the control. */
  label: ReactNode;
  /** The one control element. */
  children: ReactElement<FieldControlProps>;
  /** Help under the control, read after the label. */
  hint?: ReactNode;
  /** What is wrong and how to fix it; marks the control invalid. */
  error?: ReactNode;
  /** Adds "(optional)" to the label. Fields are required by default in copy. */
  optional?: boolean;
  /** stack (default): label above. inline: label left, for filter bars. */
  layout?: FieldLayout;
  width?: FieldWidth;
  /** The control's id; defaults to the control's own id, else a generated one. */
  id?: string;
  className?: string;
}

/** Joins id lists, dropping empties and repeats. */
export function joinIds(
  ...lists: ReadonlyArray<string | undefined | null | false>
): string | undefined {
  const ids = [...new Set(lists.flatMap((l) => (l ? l.split(/\s+/) : [])).filter(Boolean))];
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export function Field({
  label,
  children,
  hint,
  error,
  optional = false,
  layout = 'stack',
  width,
  id,
  className,
}: Readonly<FieldProps>) {
  const generated = useId();
  const control = Children.only(children);
  if (!isValidElement<FieldControlProps>(control)) {
    throw new Error('Field takes exactly one control element.');
  }
  const controlId = id ?? control.props.id ?? `field${generated.replace(/[^\w-]/g, '')}`;
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const hasHint = hint !== undefined && hint !== null && hint !== false && hint !== '';
  const errorId = hasError ? `${controlId}-error` : undefined;
  const hintId = hasHint ? `${controlId}-hint` : undefined;

  const wired = cloneElement(control, {
    id: controlId,
    'aria-describedby': joinIds(errorId, hintId, control.props['aria-describedby']),
    ...(hasError ? { 'aria-invalid': true } : {}),
  });

  return (
    <div
      className={className ? `${styles.field} ${className}` : styles.field}
      data-layout={layout}
      data-width={width ?? (layout === 'stack' ? 'full' : 'auto')}
      data-invalid={hasError ? '' : undefined}
    >
      <label htmlFor={controlId} className={styles.label}>
        {label}
        {optional ? <span className={styles.optional}> (optional)</span> : null}
      </label>
      {wired}
      {hasError ? (
        <p id={errorId} className={styles.error}>
          <TriangleAlert className={styles.errorIcon} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
      {hasHint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
