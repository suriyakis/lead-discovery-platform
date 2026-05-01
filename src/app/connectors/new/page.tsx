import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  ConnectorServiceError,
  createConnector,
} from '@/lib/services/connector-run';
import type { ConnectorTemplateType } from '@/lib/db/schema/connectors';

const TEMPLATES: ReadonlyArray<{ key: ConnectorTemplateType; label: string; description: string }> = [
  {
    key: 'internet_search',
    label: 'Internet Search',
    description:
      'Web search via the configured ISearchProvider (mock locally, SerpAPI in production).',
  },
  {
    key: 'mock',
    label: 'Mock',
    description: 'Deterministic synthetic records — for testing the pipeline end-to-end.',
  },
  {
    key: 'directory_harvester',
    label: 'Directory Harvester',
    description: 'Coming soon — selectors + pagination over a known directory.',
  },
  {
    key: 'tender_api',
    label: 'Tender API',
    description: 'Coming soon — typed pulls from public tender boards.',
  },
  {
    key: 'csv_import',
    label: 'CSV Import',
    description: 'Coming soon — file upload with column mapping.',
  },
];

const IMPLEMENTED: ReadonlySet<ConnectorTemplateType> = new Set(['internet_search', 'mock']);

export default async function NewConnectorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  try {
    await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/connectors');
    throw err;
  }

  async function create(formData: FormData): Promise<void> {
    'use server';
    const ctx = await getWorkspaceContext();
    const templateType = String(formData.get('templateType') ?? '') as ConnectorTemplateType;
    const name = String(formData.get('name') ?? '').trim();
    if (!name) redirect('/connectors/new?error=name_required');
    if (!IMPLEMENTED.has(templateType)) {
      redirect('/connectors/new?error=template_not_implemented');
    }
    try {
      const connector = await createConnector(ctx, {
        templateType,
        name,
        config: {},
      });
      redirect(`/connectors/${connector.id}`);
    } catch (err) {
      if (err instanceof ConnectorServiceError) {
        redirect(`/connectors/new?error=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  return (
    <>
      <BrandHeader />
      <main>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/connectors">Connectors</Link> / New
        </p>
        <h1>New connector</h1>
        <p className="muted">
          A connector is an instance of one template. Once created, add one or more recipes to
          configure searches.
        </p>

        <form action={create} className="card-form">
          <div className="form-grid">
            {sp.error ? <p className="form-error">Error: {sp.error}</p> : null}

            <label>
              <span>Name *</span>
              <input
                name="name"
                type="text"
                required
                maxLength={120}
                placeholder="e.g. Acoustic Glass — UK Search"
              />
            </label>

            <fieldset>
              <legend>Template</legend>
              <div className="template-grid">
                {TEMPLATES.map((t, idx) => (
                  <label key={t.key} className="template-option">
                    <input
                      type="radio"
                      name="templateType"
                      value={t.key}
                      defaultChecked={idx === 0}
                      disabled={!IMPLEMENTED.has(t.key)}
                    />
                    <div>
                      <strong>{t.label}</strong>
                      <span className="muted"> · {t.key}</span>
                      <p className="muted">
                        {t.description}
                        {!IMPLEMENTED.has(t.key) ? <em> (not yet implemented)</em> : null}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="form-actions">
              <button type="submit" className="primary-btn">
                Create connector
              </button>
            </div>
          </div>
        </form>
      </main>
    </>
  );
}
