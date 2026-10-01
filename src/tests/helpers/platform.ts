// Test helpers for platform (super-admin console) services.

import type { WorkspaceContext } from '@/lib/services/context';
import { makePlatformContext, type PlatformContext } from '@/lib/services/platform-context';

/** The PlatformContext a super-admin gets from requirePlatformAdmin(). */
export function platformCtx(actorUserId: string): PlatformContext {
  return makePlatformContext(actorUserId);
}

/**
 * A WorkspaceContext forced past the type system into a platform service.
 * Platform services must still reject it at runtime — this is the shape
 * of the old bug (an ambient workspace standing in for the platform).
 */
export function smuggled(ctx: WorkspaceContext): PlatformContext {
  return ctx as unknown as PlatformContext;
}
