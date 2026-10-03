// DS-07 / MOB-03: a workspace page's notFound() (an id that does not exist,
// or belongs to another workspace) renders here, inside the workspace
// frame, with the navigation intact. Unmatched URLs still get
// app/not-found.tsx.

import type { Metadata } from 'next';
import { NotFoundCard } from '@/components/NotFoundCard';
import { BRAND_NAME } from '@/lib/brand';
import { cx } from '@/lib/ui/cx';
import styles from './status.module.css';

export const metadata: Metadata = {
  title: `Page not found · ${BRAND_NAME}`,
};

export default function WorkspacePageNotFound() {
  return (
    <div className={cx('workspace-page-not-found', styles.status)} data-shell-not-found="">
      <NotFoundCard />
    </div>
  );
}
