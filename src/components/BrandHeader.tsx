import Link from 'next/link';

/**
 * Top-of-page brand header. The signal/works mark is a 28px square with the
 * primary→accent-teal gradient and a small dark square inside, paired with
 * the brand wordmark in monospace. Pulled from the market-navigator
 * landing-page design and simplified for app surfaces.
 */
export function BrandHeader({
  rightSlot,
}: Readonly<{
  rightSlot?: React.ReactNode;
}>) {
  return (
    <header className="brand-header">
      <Link href="/" className="brand-link" aria-label="signal/works home">
        <span className="brand-mark" aria-hidden="true">
          <span className="brand-mark-inner" />
        </span>
        <span className="brand-wordmark">signal/works</span>
      </Link>
      {rightSlot ? <div className="brand-header-right">{rightSlot}</div> : null}
    </header>
  );
}
