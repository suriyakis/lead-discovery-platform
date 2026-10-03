// PC-36 (I065): the dedicated background-job worker (ROLE=worker).
//
// Production: the `worker` service of docker-compose.prod.yml runs
// `node worker.cjs`, this file bundled by scripts/build-worker.mjs (the
// image has no tsx on its PATH). Locally: `pnpm worker:dev` (tsx) or
// `pnpm build:worker && node dist/worker/worker.cjs`, with
// JOB_QUEUE_PROVIDER=bullmq and the web server on ROLE=web.
//
// Everything lives in src/lib/jobs/worker-process.ts so it can be tested.

import { runWorkerMain } from '@/lib/jobs/worker-process';

runWorkerMain();
