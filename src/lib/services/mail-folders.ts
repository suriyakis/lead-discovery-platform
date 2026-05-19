import type { MailMessage } from '@/lib/db/schema/mailing';

export const MAIL_FOLDERS = [
  'inbox',
  'sent',
  'queued',
  'errors',
  'spam',
  'trash',
] as const;

export type MailFolder = (typeof MAIL_FOLDERS)[number];

export interface FolderInputs {
  direction: MailMessage['direction'];
  status: MailMessage['status'];
  trashedAt: Date | null;
  spamAt: Date | null;
}

/**
 * Priority: trash > spam > error > queued > sent > inbox.
 * A single source of truth — both the SQL filter (P61-03) and any
 * client-side display logic derive from this same ordering.
 */
export function deriveFolder(msg: FolderInputs): MailFolder {
  if (msg.trashedAt) return 'trash';
  if (msg.spamAt) return 'spam';
  if (msg.status === 'failed' || msg.status === 'bounced') return 'errors';
  if (msg.status === 'queued' || msg.status === 'sending') return 'queued';
  if (msg.direction === 'outbound') return 'sent';
  return 'inbox';
}
