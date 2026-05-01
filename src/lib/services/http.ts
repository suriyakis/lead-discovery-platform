import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AuthRequiredError, NoWorkspaceError } from './auth-context';
import { WorkspaceContextError } from './context';
import { ProductProfileServiceError } from './product-profile';
import { WorkspaceServiceError } from './workspace';

/**
 * Translate any thrown error from the service / context layer into an
 * appropriate HTTP response. Route handlers wrap their bodies in try/catch
 * and call `errorResponse(err)` from the catch.
 *
 * Unexpected errors (anything we don't recognize) get logged and returned
 * as a generic 500 — the route never leaks stack traces or internal detail.
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuthRequiredError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (err instanceof NoWorkspaceError) {
    return NextResponse.json(
      { error: 'No workspace membership for this user' },
      { status: 403 },
    );
  }
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
