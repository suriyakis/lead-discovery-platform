// A navigation badge (Sidebar, area tabs, account menu, console nav): the
// number for the eye, the full phrase for a screen reader. Tone comes from
// the registry's count policy (resolveNavCount), never from the caller.
// Styles in NavCountBadge.module.css; `nav-count` stays as a stable hook.

import type { ResolvedCount } from '@/lib/nav/resolve';
import { cx } from '@/lib/ui/cx';
import styles from './NavCountBadge.module.css';

export function NavCountBadge({
  count,
  className,
}: Readonly<{ count: ResolvedCount; className?: string }>) {
  return (
    <span className={cx('nav-count', styles.count, className)} data-tone={count.tone}>
      <span aria-hidden="true">{count.text}</span>
      <span className="sr-only">{count.label}</span>
    </span>
  );
}
