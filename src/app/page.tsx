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
            signal/works connects search, directories, tenders, company websites,
            documents, and team feedback into a single workspace for discovering
            and qualifying B2B leads — with evidence, traceability, and a
            learning layer.
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

        <section className="modules-grid">
          <h2 className="section-eyebrow">What is inside</h2>
          <div className="modules-row">
            <article className="module-card">
              <h3>Discover</h3>
              <p>
                Connectors run search, web, and directory recipes against the
                providers you configure (SerpAPI today; more coming). Every
                normalized record carries its source URL and run id.
              </p>
            </article>
            <article className="module-card">
              <h3>Qualify</h3>
              <p>
                A deterministic rule engine scores each record per product
                profile — keywords, sectors, lessons. Every verdict has a
                reason, evidence trail, and confidence.
              </p>
            </article>
            <article className="module-card">
              <h3>Learn</h3>
              <p>
                Reviewer feedback writes durable lessons. Future qualifications
                and outreach drafts read those lessons. Vector embeddings
                power similarity-ranked retrieval (Phase 12+).
              </p>
            </article>
            <article className="module-card">
              <h3>Outreach</h3>
              <p>
                Generate drafts grounded in product profile + lessons +
                indexed documents. Forbidden-phrase enforcement at the engine
                — never bypassable. Human approval before any send.
              </p>
            </article>
            <article className="module-card">
              <h3>Mailbox</h3>
              <p>
                SMTP + IMAP per workspace, threading, suppression list,
                signatures. RAG-grounded reply assistant pulls in chunks +
                lessons before drafting.
              </p>
            </article>
            <article className="module-card">
              <h3>Pipeline</h3>
              <p>
                Nine-state commercial pipeline from <code>relevant</code> to{' '}
                <code>closed</code>. Kanban + list views. Forward-only with
                admin-gated overrides; every transition audit-logged.
              </p>
            </article>
            <article className="module-card">
              <h3>Knowledge</h3>
              <p>
                Documents + URLs + text excerpts attached to product profiles.
                Indexed into pgvector chunks for retrieval. S3-compatible
                storage backend (local in dev).
              </p>
            </article>
            <article className="module-card">
              <h3>Export &amp; CRM</h3>
              <p>
                Bulk CSV with one click. HubSpot adapter pushes contacts +
                custom properties. Sync log per lead per connection. Future
                CRMs slot into the same shape.
              </p>
            </article>
          </div>
        </section>

        <section className="brand-footer-band">
          <p className="muted small">
            Multi-tenant from day one. Workspace-scoped audit on every
            mutation. BYOK for paid providers. Built block by block.
          </p>
        </section>
      </main>
    </>
  );
}
