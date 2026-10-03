// /inbox is retired: Today (/today) replaced it (DS-05). Kept as a
// permanent redirect that keeps ?tab, so /inbox?tab=drafts opens the
// Drafts section of Today (src/lib/nav/redirects.ts holds the table).

import { permanentRedirect } from 'next/navigation';
import { legacyRedirectTarget } from '@/lib/nav/redirects';

export default async function InboxRedirect({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  permanentRedirect(legacyRedirectTarget('/inbox', (await searchParams) ?? {}));
}
