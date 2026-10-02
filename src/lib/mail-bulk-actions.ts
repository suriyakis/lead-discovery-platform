// Shared pieces of the mail bulk actions (trash, restore, spam, not-spam,
// delete permanently, retry) behind the folder views on /communication
// (src/app/communication/actions.ts) and /mailbox/[id]
// (src/app/mailbox/[id]/actions.ts). The two used to carry line-for-line
// copies; only where they redirect differs.
//
// A plain module, not 'use server': these are helpers, and every export
// of a 'use server' file becomes a client-callable endpoint.

/**
 * The message ids ticked in the folder list (`ids` checkboxes). Anything
 * that is not a plain positive integer is ignored.
 */
export function parseSelectedIds(formData: FormData): bigint[] {
  const out: bigint[] = [];
  for (const raw of formData.getAll('ids')) {
    const s = String(raw);
    if (/^\d+$/.test(s)) out.push(BigInt(s));
  }
  return out;
}

/** "3 messages moved to trash." for a bulk action that changed `n` rows. */
export function affectedNote(verb: string, n: number): string {
  if (n === 0) return `No messages ${verb} (nothing was selected or eligible).`;
  if (n === 1) return `1 message ${verb}.`;
  return `${n} messages ${verb}.`;
}

/** The parts of retrySend()'s result the summary reports. */
export interface RetryOutcome {
  retried: readonly unknown[];
  skippedHardBounce: readonly unknown[];
  skippedIneligible: readonly unknown[];
  errors: readonly unknown[];
}

/** "2 messages resent, 1 hard-bounced (skipped)." for a bulk retry. */
export function retrySummary(r: RetryOutcome): string {
  const parts: string[] = [];
  if (r.retried.length > 0) {
    parts.push(r.retried.length === 1 ? '1 message resent' : `${r.retried.length} messages resent`);
  }
  if (r.skippedHardBounce.length > 0) {
    parts.push(`${r.skippedHardBounce.length} hard-bounced (skipped)`);
  }
  if (r.skippedIneligible.length > 0) parts.push(`${r.skippedIneligible.length} ineligible`);
  if (r.errors.length > 0) parts.push(`${r.errors.length} failed`);
  return parts.length > 0 ? parts.join(', ') + '.' : 'Nothing to retry.';
}
