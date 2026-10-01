import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
} from './auth-context';
import { WorkspaceContextError } from './context';
import { ProductProfileServiceError } from './product-profile';
import { WorkspaceServiceError } from './workspace';

/**
 * Map the errors getWorkspaceContext() throws to the JSON every API route
 * returns for them (I183). Returns null for anything else, so the caller
 * can handle or rethrow it:
 *
 *   let ctx;
 *   try {
 *     ctx = await getWorkspaceContext();
 *   } catch (err) {
 *     const res = authErrorToResponse(err);
 *     if (res) return res;
 *     throw err;
 *   }
 *
 * - AuthRequiredError    → 401 { error: 'unauthorized' }
 * - NoWorkspaceError     → 400 { error: 'no_workspace' }
 * - AccountInactiveError → 403 { error: 'account_inactive', detail }
 *   (a suspended or rejected user whose page was already open — without
 *   this the route escaped with an empty-body 500).
 */
export function authErrorToResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthRequiredError) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (err instanceof NoWorkspaceError) {
    return NextResponse.json({ error: 'no_workspace' }, { status: 400 });
  }
  if (err instanceof AccountInactiveError) {
    return NextResponse.json(
      { error: 'account_inactive', detail: accountInactiveMessage(err.accountStatus) },
      { status: 403 },
    );
  }
  return null;
}

function accountInactiveMessage(status: string): string {
  switch (status) {
    case 'pending':
      return 'Your account is waiting for approval. You can use the app once an administrator approves it.';
    case 'suspended':
      return 'Your account is suspended. Contact your workspace administrator or the platform team.';
    case 'rejected':
      return 'Your account request was not approved. Contact the platform team if you think this is a mistake.';
    default:
      return 'Your account is not active. Contact your workspace administrator or the platform team.';
  }
}

/**
 * Translate any thrown error from the service / context layer into an
 * appropriate HTTP response. Route handlers wrap their bodies in try/catch
 * and call `errorResponse(err)` from the catch. Auth-context errors go
 * through authErrorToResponse, so every API route answers them the same.
 *
 * Unexpected errors (anything we don't recognize) get logged and returned
 * as a generic 500 — the route never leaks stack traces or internal detail.
 */
export function errorResponse(err: unknown): NextResponse {
  const authResponse = authErrorToResponse(err);
  if (authResponse) return authResponse;
  if (err instanceof WorkspaceContextError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: 'Invalid input', issues: err.issues },
      { status: 400 },
    );
  }
  if (
    err instanceof ProductProfileServiceError ||
    err instanceof WorkspaceServiceError
  ) {
    const status = mapErrorCode(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }

  console.error('[api] unhandled error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

function mapErrorCode(code: string): number {
  switch (code) {
    case 'permission_denied':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'invalid_input':
      return 400;
    default:
      return 400;
  }
}
