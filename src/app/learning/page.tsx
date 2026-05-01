import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { LESSON_CATEGORIES, listLessons } from '@/lib/services/learning';

const CATEGORY_FILTERS = [
  { key: 'all' as const, label: 'All' },
  ...LESSON_CATEGORIES.map((c) => ({ key: c, label: c.replace(/_/g, ' ') })),
];

export default async function LearningPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; enabled?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  const categoryKey = sp.category && CATEGORY_FILTERS.some((f) => f.key === sp.category)
    ? sp.category
    : 'all';
  const showDisabled = sp.enabled === 'all';

  let lessons;
  try {
    const ctx = await getWorkspaceContext();
    lessons = await listLessons(ctx, {
      ...(categoryKey !== 'all'
        ? { category: categoryKey as (typeof LESSON_CATEGORIES)[number] }
        : {}),
      ...(showDisabled ? {} : { enabled: true }),
      limit: 500,
    });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <>
          <BrandHeader />
          <main>
            <h1>Learning memory</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
          </main>
        </>
      );
    }
    throw err;
  }

  return (
    <>
      <BrandHeader
        rightSlot={
          <>
            <span className="who">{session.user.email}</span>
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
          </>
        }
      />
      <main>
        <div className="page-header">
          <div>
            <p className="muted">
              <Link href="/dashboard">Dashboard</Link> / Learning
            </p>
            <h1>Learning memory</h1>
            <p className="muted">
              Structured lessons distilled from review feedback. Qualification and outreach in
              later phases will read these to refine their behavior.
            </p>
          </div>
          <Link href="/learning/new" className="primary-btn">
            + New lesson
          </Link>
        </div>

        <div className="state-tabs">
          {CATEGORY_FILTERS.map((f) => {
            const active = f.key === categoryKey;
            const href =
              f.key === 'all'
                ? showDisabled
                  ? '/learning?enabled=all'
                  : '/learning'
                : showDisabled
                  ? `/learning?category=${f.key}&enabled=all`
                  : `/learning?category=${f.key}`;
            return (
              <Link key={f.key} href={href} className={active ? 'tab active' : 'tab'}>
                {f.label}
              </Link>
            );
          })}
        </div>
        <p className="muted">
          {showDisabled ? (
            <Link
              href={categoryKey === 'all' ? '/learning' : `/learning?category=${categoryKey}`}
            >
              Hide disabled
            </Link>
          ) : (
            <Link
              href={
                categoryKey === 'all'
                  ? '/learning?enabled=all'
                  : `/learning?category=${categoryKey}&enabled=all`
              }
            >
              Show disabled
            </Link>
          )}
        </p>

        <section>
          {lessons.length === 0 ? (
            <p className="muted">
              No lessons yet. Comments on review items that mention things like &quot;don&apos;t
              target X&quot; or &quot;tone too formal&quot; auto-extract into lessons. You can also
              create one manually.
            </p>
          ) : (
            <ul className="profile-list">
              {lessons.map((l) => (
                <li key={l.id.toString()} className={l.enabled ? '' : 'archived'}>
                  <Link href={`/learning/${l.id}`}>{l.rule}</Link>
                  <div className="meta">
                    <span>category: {l.category}</span>
                    <span>conf {l.confidence}</span>
                    {l.productProfileId ? (
                      <span>product #{l.productProfileId.toString()}</span>
                    ) : (
                      <span>workspace-wide</span>
                    )}
                    {!l.enabled ? <span>disabled</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
