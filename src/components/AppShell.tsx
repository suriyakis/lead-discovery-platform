// Shared app shell: BrandHeader at the top + Sidebar + main content.
// AppShell is a server component that pulls the current session itself
// so pages can render <AppShell>{...}</AppShell> without boilerplate.
//
// Sidebar auto-detects the active route via usePathname() — no `active`
// prop needed. Public pages (signed-out landing, /pending) bypass the
// shell and render BrandHeader on their own.

import { BrandHeader } from './BrandHeader';
import { Sidebar } from './Sidebar';
import { auth } from '@/lib/auth';
import { signOutAction } from '@/lib/auth-actions';

export interface AppShellProps {
  children: React.ReactNode;
  /**
   * Override `isSuperAdmin`. By default the shell reads `session.user.role`
   * and shows the Platform section only when role is `super_admin`.
   */
  isSuperAdmin?: boolean;
  /**
   * Override the header's right slot. Defaults to the signed-in user's
   * email + Sign-out button.
   */
  rightSlot?: React.ReactNode;
}

export async function AppShell({
  children,
  isSuperAdmin,
  rightSlot,
}: Readonly<AppShellProps>) {
  const session = await auth();
  const showAdmin =
    isSuperAdmin ?? session?.user?.role === 'super_admin';
  const slot =
    rightSlot ??
    (session?.user?.email ? <DefaultRightSlot email={session.user.email} /> : null);

  return (
    <div className="app-shell">
      <BrandHeader rightSlot={slot} />
      <div className="app-body">
        <Sidebar isSuperAdmin={showAdmin} />
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}

function DefaultRightSlot({ email }: Readonly<{ email: string }>) {
  return (
    <>
      <span className="who">{email}</span>
      <form action={signOutAction}>
        <button type="submit" className="ghost-btn">
          Sign out
        </button>
      </form>
    </>
  );
}
