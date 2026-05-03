// Hint badges. Phase 22.
//
// Small inline badges for list rows. Use HintBadgeList for multiple
// hints on a single entity (caps display at maxVisible).

import Link from 'next/link';
import type { Hint, HintSeverity } from '@/lib/services/hints';

const CLASS_FOR: Record<HintSeverity, string> = {
  info: 'badge',
  warning: 'badge badge-bad',
  action: 'badge',
  success: 'badge badge-good',
};

export function HintBadge({ hint }: Readonly<{ hint: Hint }>) {
  const className = CLASS_FOR[hint.severity];
  const inner = (
    <span className={className} title={hint.detail ?? undefined}>
      {hint.text}
    </span>
  );
  if (hint.href) {
    return (
      <Link href={hint.href} className="hint-link">
        {inner}
      </Link>
    );
  }
  return inner;
}

export function HintBadgeList({
  hints,
  maxVisible = 3,
}: Readonly<{ hints: ReadonlyArray<Hint>; maxVisible?: number }>) {
  if (hints.length === 0) return null;
  const visible = hints.slice(0, maxVisible);
  const overflow = hints.length - visible.length;
  return (
    <span className="hint-badge-list">
      {visible.map((h, i) => (
        <HintBadge key={`${h.type}-${i}`} hint={h} />
      ))}
      {overflow > 0 ? <span className="badge">+{overflow}</span> : null}
    </span>
  );
}
