// The readiness state of one job on Settings → AI & search
// (src/lib/services/provider-readiness.ts). A leaf module so the signal
// maps (src/lib/ui/tone.ts, src/lib/ui/labels.ts) can name the values
// without importing the service.

/**
 * ready       will run (on the job's key). A job whose entry points never
 *             check the wallet (lead research, reading scanned PDFs) stays
 *             ready on an empty wallet: it still runs
 * rules_only  qualification without an AI key: every company is still
 *             scored, by the keyword rules engine (qualification.ts falls
 *             back on any AI failure) — degraded, not stopped
 * no_tokens   provider and key are fine, but the wallet is empty and the
 *             job's entry points refuse new work (only the wallet-gated
 *             jobs: JobReadiness.walletGated)
 * no_key      the provider needs an API key and neither the workspace nor
 *             the platform has one — the job fails when it starts
 * not_set_up  no real provider at all (the mock) — it would only produce
 *             sample data
 */
export const PROVIDER_JOB_STATES = [
  'ready',
  'rules_only',
  'no_tokens',
  'no_key',
  'not_set_up',
] as const;

export type ProviderJobState = (typeof PROVIDER_JOB_STATES)[number];

/**
 * What a vendor without a key (neither the workspace's own nor the
 * platform's) does to the work — the badge on that vendor's line
 * (vendorKeyGap in provider-readiness.ts):
 * stops_jobs   a job runs on this vendor and will not run without the key
 * limits_jobs  nothing stops, but something is less than it could be: a
 *              job runs on keyword rules only, or a feature that calls
 *              this vendor directly (Suggest with AI on products) loses
 *              this model or stops working
 * unused       no job or feature uses the vendor now
 */
export const PROVIDER_KEY_GAPS = ['stops_jobs', 'limits_jobs', 'unused'] as const;

export type ProviderKeyGap = (typeof PROVIDER_KEY_GAPS)[number];
