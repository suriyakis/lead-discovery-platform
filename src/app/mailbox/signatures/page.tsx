import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { SignaturesWorkspace } from '@/components/SignaturesWorkspace';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listMailboxes } from '@/lib/services/mailbox';
import {
  createSignature,
  deleteSignature,
  listSignatures,
  updateSignature,
  type CreateSignatureInput,
} from '@/lib/services/signatures';
import type { Mailbox, Signature } from '@/lib/db/schema/mailing';

export default async function SignaturesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  let mailboxes: Mailbox[] = [];
  let signatures: Signature[] = [];
  const sessionEmail = session.user.email ?? '';
  try {
    const ctx = await getWorkspaceContext();
    mailboxes = await listMailboxes(ctx);
    signatures = await listSignatures(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
          <h1>Signatures</h1>
          <p>You don&apos;t belong to a workspace yet.</p>
        </AppShell>
      );
    }
    throw err;
  }

  // Server actions — thin wrappers around the existing service calls.
  // The form fields are parsed identically for both create + update so
  // SignatureForm can hand its FormData to either action interchangeably.

  async function createAction(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    await createSignature(c, parseFormData(formData));
    redirect('/mailbox/signatures');
  }

  async function updateAction(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const idRaw = String(formData.get('id') ?? '');
    if (!/^\d+$/.test(idRaw)) redirect('/mailbox/signatures');
    const parsed = parseFormData(formData);
    await updateSignature(c, BigInt(idRaw), parsed);
    redirect('/mailbox/signatures');
  }

  async function deleteAction(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const idRaw = String(formData.get('id') ?? '');
    if (!/^\d+$/.test(idRaw)) redirect('/mailbox/signatures');
    await deleteSignature(c, BigInt(idRaw));
    redirect('/mailbox/signatures');
  }

  async function setDefaultAction(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const idRaw = String(formData.get('id') ?? '');
    if (!/^\d+$/.test(idRaw)) redirect('/mailbox/signatures');
    await updateSignature(c, BigInt(idRaw), { isDefault: true });
    redirect('/mailbox/signatures');
  }

  // Shape for the client component.
  const mailboxById = new Map(mailboxes.map((m) => [m.id.toString(), m]));
  const signatureRows = signatures.map((s) => ({
    id: s.id.toString(),
    name: s.name,
    mailboxId: s.mailboxId?.toString() ?? null,
    mailboxName: s.mailboxId
      ? mailboxById.get(s.mailboxId.toString())?.name ?? null
      : null,
    isDefault: s.isDefault,
    greeting: s.greeting,
    fullName: s.fullName,
    title: s.title,
    company: s.company,
    tagline: s.tagline,
    website: s.website,
    email: s.email,
    phones: coercePhonesForUi(s.phones),
    bodyText: s.bodyText,
    bodyHtml: s.bodyHtml,
    logoUrl: s.logoUrl,
  }));
  const mailboxOptions = mailboxes.map((m) => ({
    id: m.id.toString(),
    name: m.name,
    fromAddress: m.fromAddress,
  }));

  // Default the send-test recipient to the operator's own login email so
  // the loopback round-trip is one click. (Falls back to the first
  // configured mailbox's from-address.)
  const defaultTestRecipient =
    sessionEmail || mailboxes[0]?.fromAddress || '';

  return (
    <AppShell>
      <SignaturesWorkspace
        signatures={signatureRows}
        mailboxes={mailboxOptions}
        defaultTestRecipient={defaultTestRecipient}
        createAction={createAction}
        updateAction={updateAction}
        deleteAction={deleteAction}
        setDefaultAction={setDefaultAction}
      />
    </AppShell>
  );
}

function parseFormData(formData: FormData): CreateSignatureInput {
  const mailboxIdRaw = String(formData.get('mailboxId') ?? '');
  const phonesRaw = String(formData.get('phones') ?? '').trim();
  const phones = phonesRaw
    ? phonesRaw
        .split('\n')
        .map((line) => {
          const idx = line.indexOf(':');
          if (idx < 0) return { label: '', number: line.trim() };
          return {
            label: line.slice(0, idx).trim(),
            number: line.slice(idx + 1).trim(),
          };
        })
        .filter((p) => p.number)
    : [];
  return {
    name: String(formData.get('name') ?? '').trim(),
    bodyText: String(formData.get('bodyText') ?? ''),
    bodyHtml: String(formData.get('bodyHtml') ?? '').trim() || null,
    mailboxId: /^\d+$/.test(mailboxIdRaw) ? BigInt(mailboxIdRaw) : null,
    isDefault: formData.get('isDefault') === 'on',
    greeting: String(formData.get('greeting') ?? '').trim() || null,
    fullName: String(formData.get('fullName') ?? '').trim() || null,
    title: String(formData.get('title') ?? '').trim() || null,
    company: String(formData.get('company') ?? '').trim() || null,
    tagline: String(formData.get('tagline') ?? '').trim() || null,
    website: String(formData.get('website') ?? '').trim() || null,
    email: String(formData.get('email') ?? '').trim() || null,
    logoUrl: String(formData.get('logoUrl') ?? '').trim() || null,
    phones,
  };
}

function coercePhonesForUi(
  raw: unknown,
): Array<{ label: string; number: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; number: string }> = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as { label?: unknown; number?: unknown };
    const number = (typeof o.number === 'string' ? o.number : '').trim();
    if (!number) continue;
    out.push({
      label: (typeof o.label === 'string' ? o.label : '').trim(),
      number,
    });
    if (out.length >= 6) break;
  }
  return out;
}
