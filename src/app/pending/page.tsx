import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';

export default async function PendingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  // If they're already active, send them to the dashboard.
  if (session.user.accountStatus === 'active' || session.user.role === 'super_admin') {
    redirect('/dashboard');
  }

  return (
    <>
      <BrandHeader
        rightSlot={
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/' });
            }}
          >
            <button type="submit" className="ghost-btn">
              Sign out
            </button>
          </form>
        }
      />
      <main>
        <h1>{labelFor(session.user.accountStatus)}</h1>
        <p className="lede">{copyFor(session.user.accountStatus, session.user.email ?? '')}</p>
        <p className="muted">
          If you believe this is a mistake, contact your workspace administrator.
        </p>
      </main>
    </>
  );
}

function labelFor(status: string): string {
  if (status === 'pending') return 'Account awaiting approval';
  if (status === 'suspended') return 'Account suspended';
  if (status === 'rejected') return 'Account rejected';
  return 'Account inactive';
}

function copyFor(status: string, email: string): string {
  switch (status) {
    case 'pending':
      return `Welcome — your account (${email}) is waiting for an administrator to grant access. You'll be able to sign back in once that happens.`;
    case 'suspended':
      return `Your account (${email}) is temporarily suspended. Reach out to your workspace administrator for the reason and a path forward.`;
    case 'rejected':
      return `Your account (${email}) was not approved. If this was a misunderstanding, your workspace administrator can reverse the decision.`;
    default:
      return `Your account (${email}) is not active. Contact your administrator.`;
  }
}
