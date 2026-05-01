import { redirect } from 'next/navigation';
import { auth, signIn } from '@/lib/auth';

export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect('/dashboard');
  }

  return (
    <main>
      <h1>Lead Discovery Platform</h1>
      <p>Multi-tenant B2B lead discovery, qualification, outreach, and intelligence.</p>
      <p>Phase 1 — workspace foundation. Sign in to get started.</p>
      <form
        action={async () => {
          'use server';
          await signIn('google', { redirectTo: '/dashboard' });
        }}
      >
        <button type="submit" className="signin-btn">
          Sign in with Google
        </button>
      </form>
    </main>
  );
}
