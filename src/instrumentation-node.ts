// Node-runtime half of the Next.js startup hook (see instrumentation.ts).
//   - register the in-process job handlers (connector.run + the repeatable ticks)
//   - kick BullMQ's repeatable scheduler (deduped by jobId — one schedule
//     per platform regardless of replica count)
//   - warn when production runs on the in-memory queue
//   - PC-07: fix this process's boot identity (boot_id + boot time for the
//     readiness deploy grace) and report a failed schedule registration as
//     a platform incident instead of a console line only

export async function registerNodeRuntime(): Promise<void> {
  const { getBootInfo } = await import('./lib/jobs/boot');
  const boot = getBootInfo();

  // Production sanity: warn loudly when booting with the memory queue (jobs
  // lost on restart, no cross-replica deduplication). Skip when NODE_ENV is
  // not 'production' so dev + tests stay frictionless.
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
  const { registerRepeatableJobs, reportScheduleRegistrationFailure } =
    await import('./lib/jobs/repeatables');

  registerJobHandlers();

  // Skip schedule registration when the explicit env says so — useful for
  // ephemeral CI containers, smoke-test pods, local demo copies and one-shot
  // Docker exec commands that shouldn't try to enqueue cron jobs.
  if (process.env.SCHEDULE_BACKGROUND_JOBS === '0') {
    console.log('[startup] SCHEDULE_BACKGROUND_JOBS=0 — skipping repeatable schedule.');
    return;
  }

  try {
    await registerRepeatableJobs();
    console.log(
      `[startup] Background ticks scheduled (provider=${provider}, boot=${boot.id}): ` +
        'autopilot every 5min, outreach drain every 30s, IMAP every 2min.',
    );
  } catch (err) {
    console.error(
      '[startup] Failed to register repeatable jobs:',
      err instanceof Error ? err.message : err,
    );
    await reportScheduleRegistrationFailure(err);
  }
}
