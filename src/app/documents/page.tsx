import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  listDocuments,
  uploadDocument,
} from '@/lib/services/documents';
import type { Document } from '@/lib/db/schema/documents';

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const sp = await searchParams;
  const includeArchived = sp.archived === '1';

  let docs: Document[] = [];
  try {
    const ctx = await getWorkspaceContext();
    docs = await listDocuments(ctx, { includeArchived });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <>
          <BrandHeader />
          <main>
            <h1>Documents</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </main>
        </>
      );
    }
    throw err;
  }

  async function upload(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const file = formData.get('file');
    if (!(file instanceof File)) return;
    if (file.size === 0) return;
    const buffer = Buffer.from(await file.arrayBuffer());
    const name = String(formData.get('name') ?? '').trim() || null;
    const rawTags = String(formData.get('tags') ?? '');
    const tags = rawTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const result = await uploadDocument(c, {
      filename: file.name,
      mimeType: file.type || null,
      body: buffer,
      name,
      tags,
    });
    redirect(`/documents/${result.document.id}`);
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
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> / Documents
        </p>
        <h1>Documents</h1>
        <p className="muted">
          Files uploaded by your workspace — pricing sheets, product specs, case
          studies, anything you want to reference from the platform.
        </p>

        <section>
          <h2>Upload</h2>
          <form action={upload} className="upload-form" encType="multipart/form-data">
            <label>
              <span>File</span>
              <input type="file" name="file" required />
            </label>
            <label>
              <span>Display name (optional, defaults to filename)</span>
              <input type="text" name="name" maxLength={200} />
            </label>
            <label>
              <span>Tags (comma-separated)</span>
              <input
                type="text"
                name="tags"
                placeholder="e.g. pricing, q3, internal"
                maxLength={400}
              />
            </label>
            <button type="submit" className="primary-btn">
              Upload
            </button>
          </form>
        </section>

        <section>
          <h2>
            Library{' '}
            <Link
              href={includeArchived ? '/documents' : '/documents?archived=1'}
              className="muted"
              style={{ fontWeight: 400, fontSize: '0.875rem' }}
            >
              [{includeArchived ? 'hide archived' : 'show archived'}]
            </Link>
          </h2>
          {docs.length === 0 ? (
            <p className="muted">No documents yet. Upload above to get started.</p>
          ) : (
            <ul className="lead-list">
              {docs.map((doc) => (
                <li key={doc.id.toString()}>
                  <div className="lead-row">
                    <Link href={`/documents/${doc.id}`}>{doc.name}</Link>
                    {doc.status === 'archived' ? (
                      <span className="badge">archived</span>
                    ) : null}
                  </div>
                  <div className="lead-meta">
                    <span>{doc.filename}</span>
                    <span>{doc.mimeType}</span>
                    <span>{formatBytes(doc.sizeBytes)}</span>
                    {doc.tags.length > 0 ? <span>tags: {doc.tags.join(', ')}</span> : null}
                    <span>{doc.createdAt.toLocaleString()}</span>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
