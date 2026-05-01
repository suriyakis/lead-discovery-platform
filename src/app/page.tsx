import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signIn } from '@/lib/auth';

export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect('/dashboard');
  }

  return (
    <>
      <BrandHeader />
      <main>
        <section className="hero">
          <p className="eyebrow">Commercial Intelligence Platform</p>
          <h1>Find the right opportunities for the products you sell.</h1>
          <p className="lede">
            Multi-tenant B2B lead discovery, qualification, outreach, and intelligence — with
            evidence, traceability, and a learning layer.
          </p>
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
        </section>
      </main>
    </>
  );
}
