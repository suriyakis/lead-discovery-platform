import { redirect, permanentRedirect } from 'next/navigation';

/**
 * Step A (IA cleanup): the thread viewer canonical URL is
 * /communication/[id]. /mailbox/threads/[id] is kept as a 308
 * redirect stub so old links (audit log entries, emails, bookmarks)
 * keep resolving — but the page itself is gone.
 *
 * Why permanentRedirect: search engines and link checkers should
 * remember the move; the route consolidation is intentional and
 * not coming back.
 */
export default async function MailboxThreadRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) redirect('/communication');
  permanentRedirect(`/communication/${id}`);
}
