// Hint badges. Phase 22.
//
// Small inline badges for list rows. Use HintBadgeList for multiple
// hints on a single entity (caps display at maxVisible).

import Link from 'next/link';
import type { Hint, HintSeverity } from '@/lib/services/hints';

// I151: info and action used to share the amber default and warning was
// red, so nothing told the operator what was merely informational, what
// needed them, and what had actually failed. Action stays amber — the
// "needs your attention" tone — and only critical (a failed send, a
// bounce) is red.
const HINT_BADGE_CLASS: Readonly<Record<HintSeverity, string>> = {
  info: 'badge badge-info',
  action: 'badge badge-warn',
  warning: 'badge badge-warn',
  critical: 'badge badge-bad',
  success: 'badge badge-good',
};

export function HintBadge({ hint }: Readonly<{ hint: Hint }>) {
  const className = HINT_BADGE_CLASS[hint.severity];
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
