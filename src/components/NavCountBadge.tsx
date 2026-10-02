// A navigation badge (Sidebar, account menu, console nav): the number for
// the eye, the full phrase for a screen reader. Tone comes from the
// registry's count policy (resolveNavCount), never from the caller.

import type { ResolvedCount } from '@/lib/nav/resolve';

export function NavCountBadge({ count }: Readonly<{ count: ResolvedCount }>) {
  return (
    <span className="nav-count" data-tone={count.tone}>
      <span aria-hidden="true">{count.text}</span>
      <span className="sr-only">{count.label}</span>
    </span>
  );
}
