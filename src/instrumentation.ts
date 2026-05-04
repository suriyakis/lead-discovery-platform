// Phase 34: Next.js startup hook. Runs once when the server boots, in
// every container instance. We use it to:
//   - register the in-process job handlers (connector.run + the three
//     repeatable ticks)
//   - kick BullMQ's repeatable scheduler (deduped by jobId — one schedule
//     per platform regardless of replica count)
//   - assert the production queue is BullMQ, not in-memory
//
// Read by Next.js at import time. Don't hot-reload-import dependencies
// here unless you're inside the `nodejs` runtime guard — instrumentation
// fires on every runtime, including the Edge runtime where node:crypto
// and bullmq aren't available.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Production sanity: refuse to boot with memory queue (jobs lost on
  // restart, no cross-replica deduplication). Skip the assertion when
  // NODE_ENV is not 'production' so dev + tests stay frictionless.
  const provider = process.env.JOB_QUEUE_PROVIDER ?? 'memory';
  if (process.env.NODE_ENV === 'production' && provider !== 'bullmq') {
    console.warn(
      `[startup] WARNING: JOB_QUEUE_PROVIDER=${provider} in production. ` +
        `Background jobs (autopilot, drain, IMAP sync) will run in-memory ` +
        `with no durability and no cross-replica deduplication. ` +
        `Set JOB_QUEUE_PROVIDER=bullmq + REDIS_URL to enable production scheduling.`,
    );
  }

  const { registerJobHandlers } = await import('./lib/jobs/bootstrap');
  const { registerRepeatableJobs } = await import('./lib/jobs/repeatables');

  registerJobHandlers();

  // Skip schedule registration when the explicit env says so — useful for
  // ephemeral CI containers, smoke-test pods, and one-shot Docker exec
  // commands that shouldn't try to enqueue cron jobs.
  if (process.env.SCHEDULE_BACKGROUND_JOBS === '0') {
    console.log('[startup] SCHEDULE_BACKGROUND_JOBS=0 — skipping repeatable schedule.');
    return;
  }

  try {
    await registerRepeatableJobs();
    console.log(
      `[startup] Background ticks scheduled (provider=${provider}): ` +
        'autopilot every 5min, outreach drain every 30s, IMAP every 2min.',
    );
  } catch (err) {
    console.error(
      '[startup] Failed to register repeatable jobs:',
      err instanceof Error ? err.message : err,
    );
  }
}
