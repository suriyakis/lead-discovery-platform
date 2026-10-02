// /dashboard is retired: Today (/today) replaced it (DS-05). Kept as a
// permanent redirect so bookmarks, stored notification links and old
// e-mails land on the Overview view of Today with their query intact
// (src/lib/nav/redirects.ts holds the table).

import { permanentRedirect } from 'next/navigation';
import { legacyRedirectTarget } from '@/lib/nav/redirects';

export default async function DashboardRedirect({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  permanentRedirect(legacyRedirectTarget('/dashboard', (await searchParams) ?? {}));
}
