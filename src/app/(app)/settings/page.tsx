// /settings has no page of its own yet (General arrives with ia:F-19):
// it opens the first Settings page in the navigation registry, the same
// one the sidebar's Settings item points at.

import { redirect } from 'next/navigation';
import { areaById, areaHref } from '@/lib/nav/resolve';

export default function SettingsRoot() {
  redirect(areaHref(areaById('settings')));
}
