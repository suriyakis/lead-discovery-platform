// Remediation 2026-10-funnel (flow:F-06) — entry point. Usage: --help, or
// ./README.md. DATABASE_URL comes from the environment or .env.
//
//   pnpm tsx scripts/remediation/2026-10-funnel/index.ts --help

import 'dotenv/config';
import { RemediationError } from '../lib/report-io';
import { main } from './cli';

let code = 1;
main(process.argv.slice(2))
  .then((c) => {
    code = c;
  })
  .catch((err: unknown) => {
    console.error(err instanceof RemediationError ? `refused (${err.code}): ${err.message}` : err);
    code = 1;
  })
  .finally(async () => {
    try {
      if (process.env.DATABASE_URL) {
        const { db } = await import('@/lib/db/client');
        await (db.$client as unknown as { end: () => Promise<void> }).end();
      }
    } catch {
      // never connected
    }
    process.exit(code);
  });
