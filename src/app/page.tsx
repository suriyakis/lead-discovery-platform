import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowRight,
  BookOpen,
  Boxes,
  Download,
  Inbox,
  KanbanSquare,
  ListChecks,
  type LucideIcon,
  Network,
  PencilLine,
  ShoppingBag,
  Sparkles,
} from 'lucide-react';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signIn } from '@/lib/auth';
import { teamLoginAction } from '@/lib/auth-actions';

interface ModuleTile {
  title: string;
  blurb: string;
  icon: LucideIcon;
  tone?: 'primary' | 'teal' | 'amber' | 'violet';
}

const LANDING_MODULES: ReadonlyArray<ModuleTile> = [
  {
    title: 'Discover',
    blurb:
      'Connectors run search, web, and directory recipes against the providers you configure. Every normalized record carries its source URL and run id.',
    icon: Network,
    tone: 'primary',
  },
  {
    title: 'Qualify',
    blurb:
      'A deterministic rule engine scores each record per product profile — keywords, sectors, lessons. Every verdict has reasons, evidence, and confidence.',
    icon: ListChecks,
    tone: 'amber',
  },
  {
    title: 'Learn',
    blurb:
      'Reviewer feedback writes durable lessons. Future qualifications and outreach drafts read those lessons. Vector embeddings power similarity-ranked retrieval.',
    icon: Sparkles,
    tone: 'violet',
  },
  {
    title: 'Outreach',
    blurb:
      'Generate drafts grounded in product profile, lessons, and indexed documents. Forbidden-phrase enforcement at the engine. Human approval before any send.',
    icon: PencilLine,
    tone: 'amber',
  },
  {
    title: 'Mailbox',
    blurb:
      'SMTP + IMAP per workspace, threading, suppression list, signatures. RAG-grounded reply assistant pulls in chunks + lessons before drafting.',
    icon: Inbox,
  },
  {
    title: 'Pipeline',
    blurb:
      'Nine-state commercial pipeline from relevant to closed. Kanban + list views. Forward-only with admin-gated overrides; every transition audit-logged.',
    icon: KanbanSquare,
    tone: 'teal',
  },
  {
    title: 'Knowledge',
    blurb:
      'Documents + URLs + text excerpts attached to product profiles. Indexed into pgvector chunks for retrieval. S3-compatible storage backend.',
    icon: BookOpen,
  },
  {
    title: 'Export & CRM',
    blurb:
      'Bulk CSV with one click. HubSpot adapter pushes contacts + custom properties. Sync log per lead per connection. Future CRMs slot into the same shape.',
    icon: Download,
  },
];

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user) {
    redirect('/dashboard');
  }
  const sp = await searchParams;
  const errorMsg =
    sp.error === 'invalid_credentials'
      ? 'Email or password is incorrect.'
      : sp.error === 'missing_credentials'
        ? 'Both fields are required.'
        : null;

  return (
    <>
      <BrandHeader />
      <main className="landing-main">
        <section className="landing-hero">
          <div className="landing-hero-bg-grid" aria-hidden="true" />
          <div className="landing-hero-glow" aria-hidden="true" />

          <div className="landing-hero-inner">
            <div className="hero-badge">
              <span className="hero-badge-dot" />
              <span>Commercial Intelligence Platform</span>
            </div>

            <h1 className="hero-h1">
              Find the right opportunities for the products you sell.
            </h1>
            <p className="hero-lede">
              signal/works connects search, directories, tenders, company
              websites, documents, and team feedback into a single workspace
              for discovering and qualifying B2B leads — with evidence,
              traceability, and a learning layer.
            </p>

            <div className="hero-cta-row">
              <form
                action={async () => {
                  'use server';
                  await signIn('google', { redirectTo: '/dashboard' });
                }}
              >
                <button type="submit" className="hero-cta-primary">
                  <span>Sign in with Google</span>
                  <ArrowRight className="hero-cta-arrow" aria-hidden="true" />
                </button>
              </form>
              <Link href="#modules" className="hero-cta-secondary">
                <Boxes className="hero-cta-icon" aria-hidden="true" />
                <span>What&apos;s inside</span>
              </Link>
            </div>

            <details className="hero-team-login">
              <summary>
                <span>or sign in with email + password</span>
              </summary>
              {errorMsg ? (
                <p className="form-error" style={{ marginTop: '0.75rem' }}>
                  {errorMsg}
                </p>
              ) : null}
              <form action={teamLoginAction} className="login-form">
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    name="email"
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    name="password"
                    required
                    autoComplete="current-password"
                  />
                </label>
                <button type="submit" className="signin-btn signin-btn-secondary">
                  Sign in
                </button>
              </form>
            </details>
          </div>
        </section>

        <section id="modules" className="landing-modules">
          <div className="landing-modules-inner">
            <header className="landing-modules-header">
              <p className="page-eyebrow">Modules</p>
              <h2 className="landing-modules-title">
                Eight components, one workspace.
              </h2>
              <p className="landing-modules-sub">
                Each module is independently testable, swappable, and
                workspace-scoped. Use the ones you need, ignore the rest.
              </p>
            </header>
            <div className="module-tile-grid landing-module-grid">
              {LANDING_MODULES.map((m) => {
                const Icon = m.icon;
                const toneClass = m.tone ? `module-tile-${m.tone}` : '';
                return (
                  <article
                    key={m.title}
                    className={`module-tile module-tile-static ${toneClass}`.trim()}
                  >
                    <div className="module-tile-icon">
                      <Icon aria-hidden="true" />
                    </div>
                    <div className="module-tile-body">
                      <h3>{m.title}</h3>
                      <p>{m.blurb}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="brand-footer-band">
          <p className="muted small">
            Multi-tenant from day one · Workspace-scoped audit on every
            mutation · BYOK for paid providers · Built block by block
          </p>
        </section>
      </main>
    </>
  );
}
