// Empty-state placeholder used across list pages. Gives the operator a
// next-step hint + optional CTA so an empty page doesn't feel like a
// dead end.
//
// Styled by the shared dark-theme `.empty-state` pattern in globals.css
// (the same box /mailbox, /communication/follow-ups and signatures use).
// It used to carry inline light-theme colours — a milky slab with
// low-contrast text on the dark UI (I150).

import Link from 'next/link';

export function EmptyState({
  title,
  hint,
  ctaLabel,
  ctaHref,
}: Readonly<{
  title: string;
  hint: string;
  ctaLabel?: string;
  ctaHref?: string;
}>) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      <p className="muted">{hint}</p>
      {ctaLabel && ctaHref ? (
        <Link href={ctaHref} className="primary-btn">
          {ctaLabel}
        </Link>
      ) : null}
    </div>
  );
}
