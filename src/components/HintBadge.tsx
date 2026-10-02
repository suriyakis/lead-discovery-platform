// Hint badges. Phase 22.
//
// Small inline badges for list rows. Use HintBadgeList for multiple
// hints on a single entity (caps display at maxVisible).
//
// DS-09 (I151): the tone comes from the meaning map (HINT_SEVERITY_TONE in
// src/lib/ui/tone.ts), never from a hand-picked class. Info used to share
// the amber default and warning was red, so nothing told the operator what
// was merely informational, what needed them, and what had failed: now
// 'action' and 'warning' wait on the operator (attention), only 'critical'
// (a failed send, a bounce) is danger, 'success' is good news and 'info'
// is progress.

import Link from 'next/link';
import { Badge, BadgeGroup } from '@/components/Badge';
import type { Hint } from '@/lib/services/hints';
import { HINT_SEVERITY_TONE } from '@/lib/ui/tone';

export function HintBadge({ hint }: Readonly<{ hint: Hint }>) {
  const inner = (
    <Badge tone={HINT_SEVERITY_TONE[hint.severity]} title={hint.detail ?? undefined}>
      {hint.text}
    </Badge>
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
    <BadgeGroup>
      {visible.map((h, i) => (
        <HintBadge key={`${h.type}-${i}`} hint={h} />
      ))}
      {overflow > 0 ? <Badge>+{overflow}</Badge> : null}
    </BadgeGroup>
  );
}
