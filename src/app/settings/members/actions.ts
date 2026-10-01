'use server';

// Server actions for /settings/members: add a member, change a role,
// remove a member. They moved here from inline actions in page.tsx
// (audit I043, deliverable ia:F-04), so the form input is parsed with
// Zod at this boundary and the actions can be tested directly.
//
// Every permission rule lives in the users.ts member service, not
// here: only owners may grant or touch 'owner', nobody re-roles
// themselves, and the last owner stays. The page hides what a viewer
// may not do, but a hand-crafted POST still ends in that service.

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { workspaceMemberRole } from '@/lib/db/schema/workspaces';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { UserServiceError, addMember, removeMember, setMemberRole } from '@/lib/services/users';
import { isNextRedirectError } from '@/lib/server-redirect';

const MEMBERS_PATH = '/settings/members';

const userIdField = z.string().trim().min(1, 'user id is required').max(120, 'user id is too long');
const roleField = z.enum(workspaceMemberRole.enumValues, {
  errorMap: () => ({ message: 'invalid role' }),
});

const AddMemberForm = z.object({ userId: userIdField, role: roleField });
const ChangeRoleForm = z.object({ userId: userIdField, role: roleField });
const RemoveMemberForm = z.object({ userId: userIdField });

function field(formData: FormData, name: string): string | undefined {
  const v = formData.get(name);
  return typeof v === 'string' ? v : undefined;
}

function backWith(kind: 'message' | 'error', text: string): never {
  redirect(`${MEMBERS_PATH}?${kind}=${encodeURIComponent(text)}`);
}

/**
 * Parse the form, run the service call and redirect back with a
 * message, or with the error a UserServiceError carries.
 */
async function runMemberAction<I>(
  schema: z.ZodType<I, z.ZodTypeDef, unknown>,
  formData: FormData,
  run: (input: I) => Promise<unknown>,
  success: string,
): Promise<never> {
  const parsed = schema.safeParse({
    userId: field(formData, 'userId'),
    role: field(formData, 'role'),
  });
  if (!parsed.success) {
    backWith('error', parsed.error.issues[0]?.message ?? 'invalid input');
  }
  try {
    await run(parsed.data);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    backWith('error', err instanceof UserServiceError ? err.message : 'failed');
  }
  backWith('message', success);
}

export async function addMemberAction(formData: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  await runMemberAction(
    AddMemberForm,
    formData,
    ({ userId, role }) => addMember(ctx, userId, role),
    'Member added',
  );
}

export async function changeMemberRoleAction(formData: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  await runMemberAction(
    ChangeRoleForm,
    formData,
    ({ userId, role }) => setMemberRole(ctx, userId, role),
    'Role updated',
  );
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  await runMemberAction(
    RemoveMemberForm,
    formData,
    ({ userId }) => removeMember(ctx, userId),
    'Removed',
  );
}
