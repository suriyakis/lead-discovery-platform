'use client';

// DS-07 / MOB-03 (I078 backstop): an error in a workspace page renders
// here, INSIDE the workspace frame — the header, the sidebar, the banners
// and (with ia:F-18) the pause control stay on screen, so the person can
// still navigate away or stop automation from a broken page. The (app)
// layout itself failing falls through to app/error.tsx.

import { useEffect } from 'react';
import { ErrorCard } from '@/components/StatusCards';
import { BRAND_NAME } from '@/lib/brand';
import { cx } from '@/lib/ui/cx';
import styles from './status.module.css';

export default function WorkspacePageError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <title>{`Something went wrong · ${BRAND_NAME}`}</title>
      <div className={cx('workspace-page-error', styles.status)} data-shell-error="">
        <ErrorCard digest={error.digest} reset={reset} />
      </div>
    </>
  );
}
