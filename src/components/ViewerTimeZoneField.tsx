'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  /**
   * The zone the server rendered this page in: the `tz` the URL carried,
   * or null when it carried none (the server then fell back to UTC).
   */
  current: string | null;
}

/**
 * Hidden `tz` field for GET filter forms with datetime-local inputs, so
 * the server reads Since / Until in the viewer's time zone instead of
 * its own (see src/lib/time-zone.ts).
 *
 * When the URL already names a zone, the page's inputs and timestamps
 * are shown in it, so the field keeps it: re-submitting must read the
 * inputs in the zone they are displayed in. On a first visit (no `tz`
 * yet) the field takes the browser's zone and the page reloads once in
 * it, so the timestamps a viewer copies into Since / Until are already
 * in the zone the form will read them in. Without JavaScript the field
 * stays empty and the server keeps using UTC, which the page labels.
 */
export function ViewerTimeZoneField({ current }: Props) {
  const router = useRouter();
  const [browserZone, setBrowserZone] = useState('');

  useEffect(() => {
    if (current) return;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!detected) return;
    setBrowserZone(detected);
    // The server already rendered in UTC; nothing to reload for.
    if (detected === 'UTC') return;
    const url = new URL(window.location.href);
    url.searchParams.set('tz', detected);
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }, [current, router]);

  return <input type="hidden" name="tz" value={current ?? browserZone} readOnly />;
}
