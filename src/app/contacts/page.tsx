import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Search,
  Sparkles,
  Tags,
  Users,
  UserCheck,
  UserX,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import {
  ContactsListView,
  type ContactRow,
} from '@/components/ContactsListView';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  ContactServiceError,
  contactsDashboardSummary,
  countContacts,
  listAllContactTags,
  listContacts,
  upsertContact,
} from '@/lib/services/contacts';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  addTagSelected,
  archiveSelected,
  removeTagSelected,
  unarchiveSelected,
} from './actions';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const PAGE_SIZE_DEFAULT = 25;
function clampPageSize(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return PAGE_SIZE_DEFAULT;
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n)
    ? n
    : PAGE_SIZE_DEFAULT;
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    company?: string;
    status?: 'active' | 'archived';
    tag?: string;
    page?: string;
    perPage?: string;
    error?: string;
    message?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
          <h1>Contacts</h1>
          <p>You don&apos;t belong to a workspace yet.</p>
        </AppShell>
      );
    }
    throw err;
  }

  const search = sp.q?.trim() ?? '';
  const companyFilter = sp.company?.trim() ?? '';
  const statusFilter: 'active' | 'archived' | undefined =
    sp.status === 'active' || sp.status === 'archived' ? sp.status : undefined;
  const tagFilter = sp.tag?.trim() ?? '';
  const pageSize = clampPageSize(sp.perPage);
  const pageNum = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const offset = (pageNum - 1) * pageSize;

  const filter = {
    q: search || undefined,
    companyDomain: companyFilter || undefined,
    status: statusFilter,
    tag: tagFilter || undefined,
  };

  const [contacts, totalMatching, summary, knownTags] = await Promise.all([
    listContacts(ctx, { ...filter, limit: pageSize, offset }),
    countContacts(ctx, filter),
    contactsDashboardSummary(ctx),
    listAllContactTags(ctx),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalMatching / pageSize));
  const safePage = Math.min(pageNum, totalPages);

  async function quickCreate(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const email = String(formData.get('email') ?? '').trim();
    const name = String(formData.get('name') ?? '').trim() || null;
    const companyName = String(formData.get('companyName') ?? '').trim() || null;
    try {
      const created = await upsertContact(c, { email, name, companyName });
      redirect(`/contacts/${created.id}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof ContactServiceError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'failed';
      redirect(`/contacts?error=${encodeURIComponent(m)}`);
    }
  }

  function buildHref(overrides: Partial<{
    q: string;
    company: string;
    status: 'active' | 'archived' | '';
    tag: string;
    page: number;
    perPage: number;
  }>): string {
    const params = new URLSearchParams();
    const q = overrides.q !== undefined ? overrides.q : search;
    if (q) params.set('q', q);
    const co = overrides.company !== undefined ? overrides.company : companyFilter;
    if (co) params.set('company', co);
    const st = overrides.status !== undefined ? overrides.status : statusFilter ?? '';
    if (st) params.set('status', st);
    const tg = overrides.tag !== undefined ? overrides.tag : tagFilter;
    if (tg) params.set('tag', tg);
    const pg = overrides.page ?? 1;
    if (pg > 1) params.set('page', String(pg));
    const ps = overrides.perPage ?? pageSize;
    if (ps !== PAGE_SIZE_DEFAULT) params.set('perPage', String(ps));
    const qs = params.toString();
    return qs ? `/contacts?${qs}` : '/contacts';
  }

  const rows: ContactRow[] = contacts.map((c) => ({
    id: c.id.toString(),
    email: c.email,
    name: c.name,
    role: c.role,
    companyName: c.companyName,
    companyDomain: c.companyDomain,
    tags: c.tags,
    status: c.status,
    updatedAt: c.updatedAt.toISOString(),
  }));

  const hasActiveFilters = !!(
    search ||
    companyFilter ||
    statusFilter ||
    tagFilter
  );

  return (
    <AppShell>
      <div className="contacts-page">
        {/* ============ Dashboard ============ */}
        <section className="contacts-dashboard" aria-label="Contacts summary">
          <div className="contacts-metric" data-accent="blue">
            <div className="contacts-metric-label">
              <Users className="lucide" /> Total
            </div>
            <div className="contacts-metric-value">{summary.total}</div>
            <div className="contacts-metric-sub">across workspace</div>
          </div>
          <div className="contacts-metric" data-accent="teal">
            <div className="contacts-metric-label">
              <UserCheck className="lucide" /> Active
            </div>
            <div className="contacts-metric-value">{summary.active}</div>
            <div className="contacts-metric-sub">currently reachable</div>
          </div>
          <div className="contacts-metric" data-accent="amber">
            <div className="contacts-metric-label">
              <Sparkles className="lucide" /> New this week
            </div>
            <div className="contacts-metric-value">{summary.newThisWeek}</div>
            <div className="contacts-metric-sub">added in last 7 days</div>
          </div>
          <div className="contacts-metric" data-accent="violet">
            <div className="contacts-metric-label">
              <Building2 className="lucide" /> Companies
            </div>
            <div className="contacts-metric-value">{summary.uniqueCompanies}</div>
            <div className="contacts-metric-sub">unique organisations</div>
          </div>
          <div className="contacts-metric" data-accent="muted">
            <div className="contacts-metric-label">
              <UserX className="lucide" /> Archived
            </div>
            <div className="contacts-metric-value">{summary.archived}</div>
            <div className="contacts-metric-sub">hidden from default view</div>
          </div>
        </section>

        {/* ============ Quick create ============ */}
        <details className="contacts-quick-create">
          <summary>+ Add contact manually</summary>
          <form action={quickCreate} className="contacts-quick-create-form">
            <input
              type="email"
              name="email"
              placeholder="Email *"
              required
              aria-label="Email"
            />
            <input
              type="text"
              name="name"
              placeholder="Name"
              maxLength={200}
              aria-label="Name"
            />
            <input
              type="text"
              name="companyName"
              placeholder="Company"
              maxLength={200}
              aria-label="Company"
            />
            <button type="submit" className="primary-btn">
              Save
            </button>
          </form>
        </details>

        {/* ============ Filters ============ */}
        <form
          method="get"
          action="/contacts"
          className="contacts-filters"
          role="search"
        >
          <div className="contacts-filter-search">
            <Search className="lucide" style={{ opacity: 0.6 }} />
            <input
              type="search"
              name="q"
              defaultValue={search}
              placeholder="Search by name, email, or company…"
            />
          </div>
          <label>
            <span>Company domain</span>
            <input
              type="text"
              name="company"
              defaultValue={companyFilter}
              placeholder="acme.com"
            />
          </label>
          <label>
            <span>Status</span>
            <select name="status" defaultValue={statusFilter ?? ''}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label>
            <span>
              <Tags className="lucide" /> Tag
            </span>
            <select name="tag" defaultValue={tagFilter}>
              <option value="">Any</option>
              {knownTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <div className="contacts-filter-actions">
            <button type="submit" className="primary-btn">Search</button>
            {hasActiveFilters ? (
              <Link href="/contacts" className="ghost-btn">
                Reset
              </Link>
            ) : null}
          </div>
        </form>

        {sp.message ? <p className="mail-flash info">{sp.message}</p> : null}
        {sp.error ? <p className="mail-flash error">{sp.error}</p> : null}

        {/* ============ List ============ */}
        {rows.length === 0 ? (
          <div className="mail-empty">
            <div className="mail-empty-icon">
              <Users className="lucide" />
            </div>
            <p className="mail-empty-title">
              {hasActiveFilters
                ? 'No contacts match these filters'
                : 'No contacts yet'}
            </p>
            <p style={{ margin: 0 }}>
              {hasActiveFilters
                ? 'Reset the filters or widen the search to see results.'
                : 'Sent mail auto-creates contacts. Or click "Add contact manually" above.'}
            </p>
          </div>
        ) : (
          <>
            <ContactsListView
              rows={rows}
              hiddenInputs={{
                q: search,
                company: companyFilter,
                status: statusFilter ?? '',
                tag: tagFilter,
                page: String(safePage),
                perPage: String(pageSize),
              }}
              knownTags={knownTags}
              actions={{
                archive: archiveSelected,
                unarchive: unarchiveSelected,
                addTag: addTagSelected,
                removeTag: removeTagSelected,
              }}
            />

            <div className="mail-pagination">
              <span>
                Showing {offset + 1}–
                {Math.min(offset + rows.length, totalMatching)} of {totalMatching}
              </span>
              <div className="mail-pagination-perpage">
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <Link
                    key={size}
                    href={buildHref({ perPage: size, page: 1 })}
                    className={size === pageSize ? 'is-active' : ''}
                  >
                    {size}
                  </Link>
                ))}
                <span className="muted small" style={{ marginLeft: '0.4rem' }}>
                  per page
                </span>
              </div>
              <div className="mail-pagination-controls">
                {safePage > 1 ? (
                  <Link href={buildHref({ page: safePage - 1 })}>
                    <ChevronLeft className="lucide" /> Prev
                  </Link>
                ) : (
                  <span className="is-disabled">
                    <ChevronLeft className="lucide" /> Prev
                  </span>
                )}
                <span>
                  Page {safePage} of {totalPages}
                </span>
                {safePage < totalPages ? (
                  <Link href={buildHref({ page: safePage + 1 })}>
                    Next <ChevronRight className="lucide" />
                  </Link>
                ) : (
                  <span className="is-disabled">
                    Next <ChevronRight className="lucide" />
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
