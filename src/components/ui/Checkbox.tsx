// Checkbox and Switch (DS-10): a native checkbox inside its own label, so
// the text names it and the whole row is the click target. Server-safe
// (useId only); styles in choice.module.css.
//
//   <Checkbox name="includeSignature" label="Include signature" defaultChecked />
//   <Switch name="autoDraftReplies" label="Auto-draft replies"
//           description="Generate the next reply and queue it for review."
//           position="end" defaultChecked={ws.autoDraftReplies} />
//
// A Switch is input[type=checkbox][role=switch]: it submits "on" when on,
// like any checkbox, so server actions read it with no JavaScript. Either
// a visible `label` or an `aria-label` is required (the type says so); a
// description is announced through aria-describedby.

import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from './Input';
import { joinIds } from './Field';
import styles from './choice.module.css';

type NativeCheckboxProps = Omit<
  ComponentPropsWithRef<'input'>,
  'type' | 'role' | 'size' | 'children' | 'className' | 'aria-label'
>;

/** A visible label, or (for a row checkbox in a list) an aria-label. */
export type ChoiceName =
  | { label: NonNullable<ReactNode>; 'aria-label'?: undefined }
  | { label?: undefined; 'aria-label': string };

export type ChoiceProps = NativeCheckboxProps &
  ChoiceName & {
    /** A second line under the label, announced as the description. */
    description?: ReactNode;
    /** start (default): the box before the text. end: text left, box at the row's end. */
    position?: 'start' | 'end';
    /** The label row's class (the input keeps its own). */
    className?: string;
  };

function Choice({
  kind,
  label,
  description,
  position = 'start',
  className,
  id,
  'aria-describedby': describedBy,
  'aria-label': ariaLabel,
  ...input
}: ChoiceProps & { kind: 'checkbox' | 'switch' }) {
  const generated = useId();
  const base = id ?? `choice${generated.replace(/[^\w-]/g, '')}`;
  const descriptionId = description ? `${base}-description` : undefined;
  return (
    <label
      className={cx(styles.choice, className)}
      data-position={position}
      data-described={description ? '' : undefined}
    >
      <input
        {...input}
        id={id}
        type="checkbox"
        role={kind === 'switch' ? 'switch' : undefined}
        className={kind === 'switch' ? cx(styles.box, styles.switch) : styles.box}
        aria-label={ariaLabel}
        aria-describedby={joinIds(descriptionId, describedBy)}
      />
      {label !== undefined || description ? (
        <span className={styles.text}>
          {label !== undefined ? <span className={styles.label}>{label}</span> : null}
          {description ? (
            <span id={descriptionId} className={styles.description}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}

export type CheckboxProps = ChoiceProps;

export function Checkbox(props: CheckboxProps) {
  return <Choice {...props} kind="checkbox" />;
}

export type SwitchProps = ChoiceProps;

/** An on/off setting: role=switch on a native checkbox. */
export function Switch(props: SwitchProps) {
  return <Choice {...props} kind="switch" />;
}
