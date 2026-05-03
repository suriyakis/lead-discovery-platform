// Shared app shell: BrandHeader at the top + Sidebar + main content.
// Pages opt in by wrapping their content in <AppShell>. Public pages
// (signed-out landing, /pending) can render BrandHeader on its own.

import { BrandHeader } from './BrandHeader';
import { Sidebar } from './Sidebar';

export interface AppShellProps {
  children: React.ReactNode;
  /** Active sidebar item key. */
  active?: string;
  /** Show the Admin section in the sidebar. */
  isSuperAdmin?: boolean;
  /** Right slot of the header (account menu, sign-out form, etc.). */
  rightSlot?: React.ReactNode;
}

export function AppShell({
  children,
  active,
  isSuperAdmin,
  rightSlot,
}: Readonly<AppShellProps>) {
  return (
    <div className="app-shell">
      <BrandHeader rightSlot={rightSlot} />
      <div className="app-body">
        <Sidebar active={active} isSuperAdmin={isSuperAdmin} />
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
