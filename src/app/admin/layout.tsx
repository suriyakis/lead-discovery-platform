// Standalone console layout for every /admin/* route. Guards super-admin
// access once (pages keep their own checks as defense in depth) and swaps
// the workspace AppShell chrome for the distinct AdminShell topbar.

import { redirect } from 'next/navigation';
import { AdminShell } from '@/components/AdminShell';
import { auth } from '@/lib/auth';
import { adminSupportUnreadCount } from '@/lib/services/support';

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  if (session.user.role !== 'super_admin') redirect('/dashboard');

  let supportUnread = 0;
  try {
    supportUnread = await adminSupportUnreadCount();
  } catch {
    // Table not migrated yet — badge stays hidden.
  }

  return <AdminShell supportUnread={supportUnread}>{children}</AdminShell>;
}
