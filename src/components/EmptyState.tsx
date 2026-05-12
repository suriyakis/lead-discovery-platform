// Empty-state placeholder used across list pages. Gives the operator a
// next-step hint + optional CTA so an empty page doesn't feel like a
// dead end.

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
    <div
      style={{
        padding: '2rem 1.5rem',
        textAlign: 'center',
        borderRadius: '0.6rem',
        border: '1px dashed oklch(0.85 0 0)',
        background: 'oklch(0.99 0 0 / 0.4)',
      }}
    >
      <p style={{ margin: 0, fontWeight: 600, fontSize: '1.05em' }}>{title}</p>
      <p className="muted" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
        {hint}
      </p>
      {ctaLabel && ctaHref ? (
        <div style={{ marginTop: '1rem' }}>
          <Link href={ctaHref} className="primary-btn">
            {ctaLabel}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
