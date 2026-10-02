// Standalone console layout for every /admin/* route. Guards super-admin
// access once (pages and their server actions keep their own
// requirePlatformAdmin() calls as defense in depth) and swaps the
// workspace AppShell chrome for the distinct AdminShell topbar, which
// carries the registry's console nav and the Cmd-K palette.

import { AdminShell } from '@/components/AdminShell';
import { fetchCommandPaletteEntities } from '@/components/command-palette-action';
import { requirePlatformAdmin } from '@/lib/services/auth-context';
import { adminSupportUnreadCount } from '@/lib/services/support';

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requirePlatformAdmin();

  let supportUnread = 0;
  try {
    supportUnread = await adminSupportUnreadCount();
  } catch {
    // Table not migrated yet — badge stays hidden.
  }

  return (
    <AdminShell supportUnread={supportUnread} fetchEntities={fetchCommandPaletteEntities}>
      {children}
    </AdminShell>
  );
}
