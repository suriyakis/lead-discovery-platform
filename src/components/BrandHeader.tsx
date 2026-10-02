import Link from 'next/link';
import { BrandLockup } from './Brand';
import { BRAND_NAME } from '@/lib/brand';

/**
 * Top-of-page brand header: the Leadsonar mark and the lead/sonar
 * wordmark (Brand.tsx) linking home, plus an optional right slot. It is
 * the one wordmark on every page that shows it: AppShell renders it once,
 * and the public pages and the backstops render it themselves. With
 * controls in the right slot, phones show the mark alone; without (the
 * landing page, the backstops) the name always shows.
 */
export function BrandHeader({
  rightSlot,
}: Readonly<{
  rightSlot?: React.ReactNode;
}>) {
  return (
    <header className="brand-header">
      <Link href="/" className="brand-link" aria-label={`${BRAND_NAME} home`}>
        <BrandLockup wordmark={rightSlot ? 'from-sm' : 'always'} />
      </Link>
      {rightSlot ? <div className="brand-header-right">{rightSlot}</div> : null}
    </header>
  );
}
