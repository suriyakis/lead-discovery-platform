// Authenticated downloads (deliverable KL-11, audit I106).
//
// Document "Download" links used to be file://<server path>: the browser
// refused them and the page printed the server's storage path. The CRM
// CSV export link had the same flaw. Downloads now go through
// GET /api/documents/[id]/download and GET /api/crm/exports/[file], which
// resolve the session's workspace and stream from storage.
//
// These tests call the route handlers and render the pages directly, with
// next-auth's auth() mocked to the signed-in user.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db } from '@/lib/db/client';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { archiveDocument, uploadDocument } from '@/lib/services/documents';
import { exportLeadsToCsv } from '@/lib/services/crm';
import { LocalFileStorage, _setStorageForTests } from '@/lib/storage';
import { GET as downloadDocument } from '@/app/api/documents/[id]/download/route';
import { GET as downloadCsvExport } from '@/app/api/crm/exports/[file]/route';
import DocumentDetail from '@/app/documents/[id]/page';
import CrmSettingsPage from '@/app/settings/crm/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { renderToHtml } from './helpers/next-render';

type SessionUser = {
  id: string;
  role: 'member' | 'super_admin';
  accountStatus: 'active' | 'pending';
};
const session = vi.hoisted(() => ({ current: null as null | { user: SessionUser } }));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

function signInAs(userId: string, accountStatus: SessionUser['accountStatus'] = 'active'): void {
  session.current = { user: { id: userId, role: 'member', accountStatus } };
}

function signOut(): void {
  session.current = null;
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner') {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

interface Fixture {
  ownerA: string;
  ownerB: string;
  workspaceA: bigint;
  workspaceB: bigint;
}

async function setup(): Promise<Fixture> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { ownerA, ownerB, workspaceA, workspaceB };
}

async function addMember(
  workspaceId: bigint,
  role: 'admin' | 'member' | 'viewer',
): Promise<string> {
  const userId = await seedUser({ email: `${role}-${workspaceId}@test.local` });
  await db.insert(workspaceMembers).values({ workspaceId, userId, role });
  return userId;
}

/** Every byte value, so any text decoding along the way would show. */
const BINARY = Buffer.from([
  ...Array.from({ length: 256 }, (_, i) => i),
  ...Array.from({ length: 256 }, (_, i) => 255 - i),
]);

async function uploadPdf(f: Fixture, filename = 'Cennik zażółć 2026.pdf') {
  const r = await uploadDocument(ctx(f.workspaceA, f.ownerA), {
    filename,
    mimeType: 'application/pdf',
    body: Buffer.from(BINARY),
  });
  return r.document;
}

/** Headers of a browser following a link (a same-tab navigation). */
const NAVIGATION: Record<string, string> = {
  'sec-fetch-mode': 'navigate',
  accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
};

function getDocumentDownload(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return downloadDocument(new Request(`http://app.test/api/documents/${id}/download`, { headers }), {
    params: Promise.resolve({ id }),
  });
}

function getCsvExport(file: string, headers: Record<string, string> = {}): Promise<Response> {
  return downloadCsvExport(new Request(`http://app.test/api/crm/exports/${file}`, { headers }), {
    params: Promise.resolve({ file }),
  });
}

/** A 303's target, split into path and decoded query. */
function seeOtherTarget(res: Response): { path: string; error: string | null } {
  expect(res.status).toBe(303);
  const location = res.headers.get('location') ?? '';
  // Relative, so the public host behind the proxy is kept.
  expect(location.startsWith('/')).toBe(true);
  const url = new URL(location, 'http://app.test');
  return { path: url.pathname, error: url.searchParams.get('error') };
}

async function renderDocumentPage(id: bigint): Promise<string> {
  const tree = await DocumentDetail({
    params: Promise.resolve({ id: id.toString() }),
    searchParams: Promise.resolve({}),
  });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

let storageRoot: string;
let storage: LocalFileStorage;

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'lead-download-test-'));
  storage = new LocalFileStorage(storageRoot);
  _setStorageForTests(storage);
  await truncateAll();
  signOut();
});

afterEach(async () => {
  _setStorageForTests(null);
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ GET /api/documents/[id]/download ==========================

describe('GET /api/documents/[id]/download', () => {
  it('gives the owner the uploaded bytes unchanged, under the original filename', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    signInAs(f.ownerA);

    const res = await getDocumentDownload(doc.id.toString());

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(BINARY)).toBe(true);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-length')).toBe(String(BINARY.length));
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent('Cennik zażółć 2026.pdf')}`,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('lets every workspace role read, viewer included', async () => {
    const f = await setup();
    const doc = await uploadPdf(f, 'spec.pdf');
    for (const role of ['admin', 'member', 'viewer'] as const) {
      signInAs(await addMember(f.workspaceA, role));
      const res = await getDocumentDownload(doc.id.toString());
      expect(res.status, role).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(BINARY), role).toBe(true);
    }
  });

  it("answers 404 to another workspace's user, the same as for a missing id", async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    signInAs(f.ownerB);

    const res = await getDocumentDownload(doc.id.toString());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'document not found', code: 'not_found' });

    const missing = await getDocumentDownload((doc.id + 1000n).toString());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(body);
  });

  it('answers 401 to a signed-out request, whatever the id', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);

    const res = await getDocumentDownload(doc.id.toString());
    expect(res.status).toBe(401);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect((await getDocumentDownload('not-a-number')).status).toBe(401);
  });

  it('answers 403 to a signed-in account that is not active yet', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    signInAs(f.ownerA, 'pending');
    expect((await getDocumentDownload(doc.id.toString())).status).toBe(403);
  });

  it('answers 404 to ids that are not a document id', async () => {
    const f = await setup();
    signInAs(f.ownerA);
    for (const id of ['abc', '0', '-1', '1.5', '01', '99999999999999999999', '9223372036854775808']) {
      const res = await getDocumentDownload(id);
      expect(res.status, id).toBe(404);
    }
  });

  it('refuses an archived document with 409', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    await archiveDocument(ctx(f.workspaceA, f.ownerA), doc.id);
    signInAs(f.ownerA);

    const res = await getDocumentDownload(doc.id.toString());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('conflict');
  });

  it('answers 404 without the storage key when the bytes are gone', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    await storage.delete(doc.storageKey);
    signInAs(f.ownerA);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await getDocumentDownload(doc.id.toString());

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'The stored file is missing', code: 'file_missing' });
    expect(text).not.toContain(doc.storageKey);
    expect(text).not.toContain(storageRoot);
    // The operator still gets the key in the server log.
    expect(logged.mock.calls.flat().join(' ')).toContain(doc.storageKey);
    logged.mockRestore();
  });
});

// ============ a browser following a failed Download link ================
//
// The links are same-tab, so a JSON error body would replace the page.
// Browser navigations are sent back to a page with the reason instead;
// fetch() keeps the JSON (every test above sends no navigation headers).

describe('failed downloads send a browser back to a page', () => {
  it('archived: back to the document with the reason', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    await archiveDocument(ctx(f.workspaceA, f.ownerA), doc.id);
    signInAs(f.ownerA);

    const target = seeOtherTarget(await getDocumentDownload(doc.id.toString(), NAVIGATION));
    expect(target.path).toBe(`/documents/${doc.id}`);
    expect(target.error).toBe('This document is archived. Restore it to download it.');
  });

  it('bytes gone: back to the document, never the storage key', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    await storage.delete(doc.storageKey);
    signInAs(f.ownerA);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await getDocumentDownload(doc.id.toString(), NAVIGATION);

    logged.mockRestore();
    const target = seeOtherTarget(res);
    expect(target.path).toBe(`/documents/${doc.id}`);
    expect(target.error).toMatch(/stored file for this document is missing/);
    expect(res.headers.get('location')).not.toContain(doc.storageKey);
  });

  it("another workspace's document (a switch in another tab): back to the list", async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    signInAs(f.ownerB);

    const target = seeOtherTarget(await getDocumentDownload(doc.id.toString(), NAVIGATION));
    expect(target.path).toBe('/documents');
    expect(target.error).toMatch(/not in your current workspace/);
    // Same answer as an id that never existed or does not parse.
    for (const id of [(doc.id + 1000n).toString(), 'abc']) {
      expect(seeOtherTarget(await getDocumentDownload(id, NAVIGATION))).toEqual(target);
    }
  });

  it('signed out goes to sign-in, an inactive account to /pending', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    expect(seeOtherTarget(await getDocumentDownload(doc.id.toString(), NAVIGATION))).toEqual({
      path: '/',
      error: null,
    });
    signInAs(f.ownerA, 'pending');
    expect(seeOtherTarget(await getDocumentDownload(doc.id.toString(), NAVIGATION)).path).toBe(
      '/pending',
    );
  });

  it('an Accept: text/html request without Sec-Fetch-Mode counts as a navigation', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    await archiveDocument(ctx(f.workspaceA, f.ownerA), doc.id);
    signInAs(f.ownerA);

    const res = await getDocumentDownload(doc.id.toString(), { accept: 'text/html' });
    expect(seeOtherTarget(res).path).toBe(`/documents/${doc.id}`);
    // A fetch() that asks for HTML is still not a navigation.
    const fetched = await getDocumentDownload(doc.id.toString(), {
      'sec-fetch-mode': 'cors',
      accept: 'text/html',
    });
    expect(fetched.status).toBe(409);
  });

  it('a successful navigation still streams the file', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    signInAs(f.ownerA);

    const res = await getDocumentDownload(doc.id.toString(), NAVIGATION);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(BINARY)).toBe(true);
  });

  it('CSV export: a viewer or a stale file goes back to /settings/crm with the reason', async () => {
    const f = await setup();
    const exp = await exportLeadsToCsv(ctx(f.workspaceA, f.ownerA), {}, storage);

    signInAs(await addMember(f.workspaceA, 'viewer'));
    const denied = seeOtherTarget(await getCsvExport(exp.fileName, NAVIGATION));
    expect(denied).toEqual({
      path: '/settings/crm',
      error: 'Your role cannot download lead exports. Ask an admin.',
    });

    signInAs(f.ownerB);
    const elsewhere = seeOtherTarget(await getCsvExport(exp.fileName, NAVIGATION));
    expect(elsewhere.path).toBe('/settings/crm');
    expect(elsewhere.error).toMatch(/not available in your current workspace/);

    signOut();
    expect(seeOtherTarget(await getCsvExport(exp.fileName, NAVIGATION)).path).toBe('/');
  });
});

// ============ /documents/[id] page ======================================

describe('/documents/[id] page', () => {
  it('links Download to the authenticated route and never renders file://', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);
    signInAs(f.ownerA);

    const html = await renderDocumentPage(doc.id);

    expect(html).not.toContain('file://');
    expect(html).toContain(`href="/api/documents/${doc.id}/download"`);
    expect(html).toContain('Download Cennik zażółć 2026.pdf');
    expect(html).not.toContain(storageRoot);
  });

  it('shows the storage key and checksum to admins only', async () => {
    const f = await setup();
    const doc = await uploadPdf(f);

    signInAs(f.ownerA);
    const ownerHtml = await renderDocumentPage(doc.id);
    expect(ownerHtml).toContain(doc.storageKey);
    expect(ownerHtml).toContain(doc.sha256.slice(0, 16));

    signInAs(await addMember(f.workspaceA, 'admin'));
    expect(await renderDocumentPage(doc.id)).toContain(doc.storageKey);

    for (const role of ['member', 'viewer'] as const) {
      signInAs(await addMember(f.workspaceA, role));
      const html = await renderDocumentPage(doc.id);
      expect(html, role).not.toContain(doc.storageKey);
      expect(html, role).not.toContain(doc.sha256.slice(0, 16));
      expect(html, role).not.toContain('SHA-256');
      // Still downloadable for them.
      expect(html, role).toContain(`href="/api/documents/${doc.id}/download"`);
    }
  });
});

// ============ GET /api/crm/exports/[file] ==============================

describe('GET /api/crm/exports/[file]', () => {
  it('returns the export the owner just made, byte for byte', async () => {
    const f = await setup();
    const exp = await exportLeadsToCsv(ctx(f.workspaceA, f.ownerA), {}, storage);
    expect(exp.url).toBe(`/api/crm/exports/${exp.fileName}`);
    expect(exp.storageKey).toBe(`workspaces/${f.workspaceA}/exports/${exp.fileName}`);
    signInAs(f.ownerA);

    const res = await getCsvExport(exp.fileName);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(exp.csv);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="${exp.fileName}"; filename*=UTF-8''${exp.fileName}`,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it("answers 404 to another workspace's user", async () => {
    const f = await setup();
    const exp = await exportLeadsToCsv(ctx(f.workspaceA, f.ownerA), {}, storage);
    signInAs(f.ownerB);
    expect((await getCsvExport(exp.fileName)).status).toBe(404);
  });

  it('answers 401 signed out and 403 to a viewer (export needs write access)', async () => {
    const f = await setup();
    const exp = await exportLeadsToCsv(ctx(f.workspaceA, f.ownerA), {}, storage);
    expect((await getCsvExport(exp.fileName)).status).toBe(401);
    signInAs(await addMember(f.workspaceA, 'viewer'));
    expect((await getCsvExport(exp.fileName)).status).toBe(403);
    signInAs(await addMember(f.workspaceA, 'member'));
    expect((await getCsvExport(exp.fileName)).status).toBe(200);
  });

  it('refuses names that are not an export file name', async () => {
    const f = await setup();
    await storage.put(`workspaces/${f.workspaceA}/documents/secret.csv`, Buffer.from('x'));
    signInAs(f.ownerA);
    for (const file of [
      '../documents/secret.csv',
      '..%2Fdocuments%2Fsecret.csv',
      'secret.csv',
      'leads-1-zzzzzzzz.csv',
      'leads-1-abcdef12.csv.bak',
    ]) {
      expect((await getCsvExport(file)).status, file).toBe(404);
    }
  });
});

// ============ /settings/crm page =======================================

describe('/settings/crm export link', () => {
  async function renderCrm(sp: { message?: string; file?: string }) {
    const tree = await CrmSettingsPage({ searchParams: Promise.resolve(sp) });
    return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
  }

  it('builds the Download CSV link from the export file name', async () => {
    const f = await setup();
    signInAs(f.ownerA);
    const html = await renderCrm({
      message: 'Exported 3 leads',
      file: 'leads-1727790000000-abcdef12.csv',
    });
    expect(html).toContain('href="/api/crm/exports/leads-1727790000000-abcdef12.csv"');
    expect(html).toContain('Download CSV');
    expect(html).not.toContain('file://');
  });

  it('ignores a ?file= that is not an export file name', async () => {
    const f = await setup();
    signInAs(f.ownerA);
    for (const file of ['https://evil.example/leads.csv', 'javascript:alert(1)', '../x.csv']) {
      const html = await renderCrm({ message: 'Exported 3 leads', file });
      expect(html, file).not.toContain('Download CSV');
      expect(html, file).not.toContain('evil.example');
    }
  });
});
