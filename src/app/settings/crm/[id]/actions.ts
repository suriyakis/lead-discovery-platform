'use server';

// Server actions for /settings/crm/[id] (deliverable ia:F-08, audit I115).
//
// They used to be inline actions in page.tsx, and the Test form was
// nested inside the Save form. The HTML parser drops a nested <form>, so
// React failed to hydrate the page, a click on "Test connection" after
// hydration did nothing, and a click on Save before hydration ran the test
// and threw the edits away. The page now renders one form: Save submits
// it, and Test is a formAction button on the same form.
//
// Each action is bound to the connection id by the page:
//   formAction={testCrmConnectionAction.bind(null, conn.id.toString())}
// Bound arguments come back from the client as-is, so the id is
// re-validated before it is used.

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireActionContext } from '@/lib/action-context';
import {
  CrmServiceError,
  archiveCrmConnection,
  getCrmConnection,
  restoreCrmConnection,
  testCrmConnection,
  updateCrmConnection,
} from '@/lib/services/crm';
import { isNextRedirectError } from '@/lib/server-redirect';

const saveFormSchema = z.object({
  name: z.string().trim().min(1, 'Display name is required.').max(120),
  credential: z.string().max(4000),
  baseUrl: z.string().trim().max(500),
});

export async function saveCrmConnectionAction(
  connectionId: string,
  formData: FormData,
): Promise<void> {
  const id = parseConnectionId(connectionId);
  const parsed = saveFormSchema.safeParse({
    name: String(formData.get('name') ?? ''),
    credential: String(formData.get('credential') ?? ''),
    baseUrl: String(formData.get('baseUrl') ?? ''),
  });
  if (!parsed.success) {
    redirect(detailUrl(id, { error: parsed.error.issues[0]?.message ?? 'Invalid input.' }));
  }
  const ctx = await requireActionContext();
  try {
    // Merge into the stored config as it is now, not as it was when the
    // page rendered. An empty base URL clears the override.
    const current = await getCrmConnection(ctx, id);
    const config: Record<string, unknown> = {
      ...(current.config as Record<string, unknown>),
    };
    if (parsed.data.baseUrl) config.baseUrl = parsed.data.baseUrl;
    else delete config.baseUrl;
    await updateCrmConnection(ctx, id, {
      name: parsed.data.name,
      credential: parsed.data.credential || undefined,
      config,
    });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(detailUrl(id, { error: errorText(err, 'save', ADMIN_ONLY) }));
  }
  redirect(detailUrl(id, { message: 'Saved.' }));
}

export async function testCrmConnectionAction(connectionId: string): Promise<void> {
  const id = parseConnectionId(connectionId);
  const ctx = await requireActionContext();
  let result: { ok: boolean; detail?: string };
  try {
    result = await testCrmConnection(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      detailUrl(id, { error: errorText(err, 'test', 'Viewers cannot test CRM connections.') }),
    );
  }
  redirect(
    result.ok
      ? detailUrl(id, { message: 'Connection OK.' })
      : detailUrl(id, {
          error: `Connection test failed: ${result.detail ?? 'no detail from the CRM'}`,
        }),
  );
}

export async function archiveCrmConnectionAction(connectionId: string): Promise<void> {
  const id = parseConnectionId(connectionId);
  const ctx = await requireActionContext();
  try {
    await archiveCrmConnection(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(detailUrl(id, { error: errorText(err, 'archive', ADMIN_ONLY) }));
  }
  redirect(
    detailUrl(id, {
      message: 'Connection archived. Nothing is pushed to it until you restore it.',
    }),
  );
}

export async function restoreCrmConnectionAction(connectionId: string): Promise<void> {
  const id = parseConnectionId(connectionId);
  const ctx = await requireActionContext();
  try {
    await restoreCrmConnection(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(detailUrl(id, { error: errorText(err, 'restore', ADMIN_ONLY) }));
  }
  redirect(detailUrl(id, { message: 'Connection restored. Test it to check the credential.' }));
}

function parseConnectionId(raw: string): bigint {
  if (!/^\d{1,19}$/.test(raw)) redirect('/settings/crm');
  return BigInt(raw);
}

function detailUrl(id: bigint, flash: { message?: string; error?: string }): string {
  const params = new URLSearchParams();
  if (flash.message) params.set('message', flash.message);
  if (flash.error) params.set('error', flash.error);
  return `/settings/crm/${id}?${params.toString()}`;
}

const ADMIN_ONLY = 'Only workspace admins can change CRM connections.';

/** Flash text for a failed action. Service errors are written for
 *  operators; anything else is logged and summarised. */
function errorText(err: unknown, op: string, deniedText: string): string {
  if (err instanceof CrmServiceError) {
    if (err.code === 'permission_denied') return deniedText;
    if (err.code === 'not_found') return 'This CRM connection no longer exists.';
    return err.message;
  }
  console.error(`[settings/crm] ${op} failed:`, err instanceof Error ? err.message : err);
  return `The ${op} failed unexpectedly. Try again, and contact support if it keeps failing.`;
}
