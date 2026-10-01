// Server-rendered timestamps with an explicit zone. Server components and
// background jobs render in the container's zone (UTC in production), so a
// bare toLocaleString() reads as the operator's local time when it is not.
// Until per-user time zones land (F-12), say UTC.

/** "2026-10-01 14:05 UTC" */
export function formatUtc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
