// DS-09: the type-level half of the signal registries. `pnpm typecheck`
// compiles this file (tsconfig includes src/tests), and each
// `@ts-expect-error` below fails the build if the error it expects goes
// away. So these lines prove that
//   - notify() and notifyWorkspaceAdmins() reject an unregistered kind;
//   - recordAuditEvent, recordPlatformAuditEvent, recordUsage and the AI
//     metering kind do too;
//   - a tone map missing a value, holding a non-tone or an extra value does
//     not typecheck (every map in tone.ts and labels.ts is declared the
//     same way).
// Nothing here runs a producer: the calls sit in a function that is never
// invoked, so the file needs no database.

import { describe, expect, it } from 'vitest';
import type { ReviewItemState } from '@/lib/db/schema/review';
import { notify, notifyWorkspaceAdmins } from '@/lib/services/notifications';
import { recordAuditEvent, recordPlatformAuditEvent } from '@/lib/services/audit';
import { recordUsage } from '@/lib/services/usage';
import { getAIProviderForCtx } from '@/lib/ai';
import { LABEL_MAPS } from '@/lib/ui/labels';
import { TONE_MAPS, type Tone } from '@/lib/ui/tone';

const ws = 1n;
const ctx = { workspaceId: ws, userId: 'u' };

/** Never called: only compiled. */
export async function typeChecks(): Promise<void> {
  // Registered kinds compile.
  await notify(ws, { kind: 'run.failed', title: 'ok' });
  await recordAuditEvent(ctx, { kind: 'review.approved' });
  await recordUsage(ctx, { kind: 'ai.assistant', provider: 'mock', units: 1 });

  // @ts-expect-error an unregistered notification kind fails typecheck
  await notify(ws, { kind: 'lead.went_cold', title: 'no' });
  // @ts-expect-error notifyWorkspaceAdmins takes the same registry
  await notifyWorkspaceAdmins(ws, { kind: 'mailbox.melted', title: 'no' });
  // @ts-expect-error an unregistered audit kind fails typecheck
  await recordAuditEvent(ctx, { kind: 'product.create' });
  // @ts-expect-error platform audit events take the same registry
  await recordPlatformAuditEvent('u', { kind: 'user.teleport' });
  // @ts-expect-error an unregistered usage kind fails typecheck
  await recordUsage(ctx, { kind: 'ai.generate_text', provider: 'mock', units: 1 });
  // @ts-expect-error the AI metering kind must be an AI usage kind
  await getAIProviderForCtx({ workspaceId: ws }, 'search.query');

  const missing = {
    new: 'neutral',
    needs_review: 'attention',
    approved: 'success',
    rejected: 'danger',
    ignored: 'muted',
    duplicate: 'neutral',
    // @ts-expect-error 'archived' is missing, so the map does not satisfy the Record
  } as const satisfies Record<ReviewItemState, Tone>;

  const notATone = {
    // @ts-expect-error 'amber' is a hue, not a tone
    new: 'amber',
  } as const satisfies Partial<Record<ReviewItemState, Tone>>;

  const extra = {
    new: 'neutral',
    needs_review: 'attention',
    approved: 'success',
    rejected: 'danger',
    ignored: 'muted',
    duplicate: 'neutral',
    archived: 'muted',
    // @ts-expect-error a value the enum does not have is rejected
    pending: 'neutral',
  } as const satisfies Record<ReviewItemState, Tone>;

  void [missing, notATone, extra];
}

describe('signal registries are enforced by the type checker', () => {
  it('compiles (pnpm typecheck checks the @ts-expect-error lines above)', () => {
    expect(typeof typeChecks).toBe('function');
    expect(Object.keys(LABEL_MAPS).sort()).toEqual(Object.keys(TONE_MAPS).sort());
  });
});
