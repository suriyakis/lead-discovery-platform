import Link from 'next/link';

/**
 * Top-of-page brand header. The lead/sonar mark is a 28px square with the
 * primary→accent-teal gradient and a small dark square inside, paired with
 * the brand wordmark in monospace.
 */
export function BrandHeader({
  rightSlot,
}: Readonly<{
  rightSlot?: React.ReactNode;
}>) {
  return (
    <header className="brand-header">
      <Link href="/" className="brand-link" aria-label="lead/sonar home">
        <span className="brand-mark" aria-hidden="true">
          <span className="brand-mark-inner" />
        </span>
        <span className="brand-wordmark">lead/sonar</span>
      </Link>
      {rightSlot ? <div className="brand-header-right">{rightSlot}</div> : null}
    </header>
  );
}
