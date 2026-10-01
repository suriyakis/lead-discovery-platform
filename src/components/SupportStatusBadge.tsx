// Status badge for a support thread (open | closed).
//
// Before DS-02 the bare .badge was amber, so `open → 'badge'` read as a
// highlight. The bare badge is neutral now (I151), so the tone is explicit:
// an open thread is info-blue for the customer ("we're on it") and amber in
// the admin inbox, where open means it still needs a reply. Closed is the
// neutral badge on both sides.

export type SupportBadgeAudience = 'customer' | 'admin';

export function supportStatusBadgeClass(status: string, audience: SupportBadgeAudience): string {
  if (status !== 'open') return 'badge';
  return audience === 'admin' ? 'badge badge-warn' : 'badge badge-info';
}

export function SupportStatusBadge({
  status,
  audience,
}: Readonly<{ status: string; audience: SupportBadgeAudience }>) {
  return <span className={supportStatusBadgeClass(status, audience)}>{status}</span>;
}
