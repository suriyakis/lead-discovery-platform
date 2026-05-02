import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  DocumentServiceError,
  archiveDocument,
  getDocument,
  restoreDocument,
  updateDocument,
} from '@/lib/services/documents';
import { listKnowledgeSources } from '@/lib/services/knowledge-sources';

export default async function DocumentDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/documents');
  const id = BigInt(idStr);

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/documents');
    throw err;
  }

  let detail;
  try {
    detail = await getDocument(ctx, id);
  } catch (err) {
    if (err instanceof DocumentServiceError && err.code === 'not_found') {
      redirect('/documents');
    }
    throw err;
  }

  const { document, url } = detail;
  const isArchived = document.status === 'archived';

  // Knowledge sources that reference this document
  const allKs = await listKnowledgeSources(ctx, { kind: 'document', limit: 1000 });
  const referencingKs = allKs.filter(
    (r) => r.source.documentId !== null && r.source.documentId === document.id,
  );

  async function saveEdits(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const name = String(formData.get('name') ?? '').trim();
    const rawTags = String(formData.get('tags') ?? '');
    const tags = rawTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    await updateDocument(c, id, {
      name: name || undefined,
      tags,
    });
    redirect(`/documents/${id}`);
  }

  async function archive() {
    'use server';
    const c = await getWorkspaceContext();
    await archiveDocument(c, id);
    redirect(`/documents/${id}`);
  }

  async function restore() {
    'use server';
    const c = await getWorkspaceContext();
    await restoreDocument(c, id);
    redirect(`/documents/${id}`);
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
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/documents">Documents</Link> / {document.name}
        </p>
        <h1>{document.name}</h1>
        <p>
          <span className={isArchived ? 'badge badge-bad' : 'badge badge-good'}>
            {document.status}
          </span>
        </p>

        <section>
          <h2>Metadata</h2>
          <dl>
            <dt>Filename</dt>
            <dd>{document.filename}</dd>
            <dt>MIME type</dt>
            <dd>
              <code>{document.mimeType}</code>
            </dd>
            <dt>Size</dt>
            <dd>{document.sizeBytes.toLocaleString()} bytes</dd>
            <dt>SHA-256</dt>
            <dd>
              <code>{document.sha256.slice(0, 16)}…</code>
            </dd>
            <dt>Storage</dt>
            <dd>
              <code>{document.storageProvider}</code>:{' '}
              <code>{document.storageKey}</code>
            </dd>
            <dt>Uploaded</dt>
            <dd>{document.createdAt.toLocaleString()}</dd>
            {document.tags.length > 0 ? (
              <>
                <dt>Tags</dt>
                <dd>{document.tags.join(', ')}</dd>
              </>
            ) : null}
          </dl>
        </section>

        {!isArchived ? (
          <section>
            <h2>Download</h2>
            <p className="muted">
              The link below uses the storage provider&apos;s URL strategy
              (presigned for S3, file:// for local).
            </p>
            <p>
              <a href={url} target="_blank" rel="noreferrer" className="primary-btn">
                Download {document.filename}
              </a>
            </p>
          </section>
        ) : null}

        {!isArchived ? (
          <section>
            <h2>Edit</h2>
            <form action={saveEdits} className="edit-draft-form">
              <label>
                <span>Display name</span>
                <input
                  type="text"
                  name="name"
                  defaultValue={document.name}
                  maxLength={200}
                />
              </label>
              <label>
                <span>Tags (comma-separated)</span>
                <input
                  type="text"
                  name="tags"
                  defaultValue={document.tags.join(', ')}
                  maxLength={400}
                />
              </label>
              <div className="action-row">
                <button type="submit" className="primary-btn">
                  Save
                </button>
              </div>
            </form>
          </section>
        ) : null}

        <section>
          <h2>Referenced by knowledge sources</h2>
          {referencingKs.length === 0 ? (
            <p className="muted">
              No knowledge sources reference this document yet.{' '}
              <Link href="/knowledge/new">Create one</Link>.
            </p>
          ) : (
            <ul className="profile-list">
              {referencingKs.map(({ source }) => (
                <li key={source.id.toString()}>
                  <Link href={`/knowledge/${source.id}`}>{source.title}</Link>
                  {source.summary ? <p className="muted">{source.summary}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canAdminWorkspace(ctx) ? (
          <section>
            <h2>Admin</h2>
            {isArchived ? (
              <form action={restore}>
                <button type="submit">Restore</button>
              </form>
            ) : (
              <form action={archive}>
                <button type="submit" className="ghost-btn">
                  Archive
                </button>
              </form>
            )}
          </section>
        ) : null}
      </main>
    </>
  );
}
