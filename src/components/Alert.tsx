// Alert — the design-system message primitive (DS plan, Phase 4:
// "Alert({tone, title, children, action, onDismiss})": a grid of
// [icon 16][content][action], 12/16 padding, radius-md, a soft tinted
// background with a line border, brand tokens only).
//
// flow:F-04 lands it early for the failing-mailbox notice. This first cut
// is a server component, so it has no onDismiss (that needs a client
// wrapper); the Phase 4 codemod moves the ~135 legacy flash / callout
// usages onto it.

import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import styles from './Alert.module.css';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const ICONS = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
} as const;

export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: Readonly<{
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  /** A button / form / link shown at the end (wraps under the text on narrow screens). */
  action?: ReactNode;
}>) {
  const Icon = ICONS[tone];
  return (
    <div
      className={`${styles.alert} ${styles[tone]}`}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      data-tone={tone}
    >
      <Icon className={styles.icon} size={16} aria-hidden="true" />
      <div className={styles.content}>
        {title ? <p className={styles.title}>{title}</p> : null}
        {children}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
