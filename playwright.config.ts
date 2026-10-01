// Playwright smoke tests (e2e/). They need a RUNNING app seeded with
// scripts/seed-demo.ts — the config does not start one:
//
//   DATABASE_URL=postgres://lead:lead@localhost:5432/lead_e2e pnpm db:migrate
//   DATABASE_URL=… SEED_DEMO_PASSWORD=… pnpm db:seed-demo
//   DATABASE_URL=… SCHEDULE_BACKGROUND_JOBS=0 AUTH_URL=http://localhost:3200 \
//     ENABLE_TEST_ROUTES=1 pnpm exec next dev -p 3200   (or next build && next start -p 3200)
//   BASE_URL=http://localhost:3200 SEED_DEMO_PASSWORD=… ENABLE_TEST_ROUTES=1 pnpm test:e2e
//
// ENABLE_TEST_ROUTES=1 on both sides turns on /test-only/error-boundary
// and the smoke test that expects it to render app/error.tsx; without it
// that one test is skipped. Known issues marked devServerOnly are only
// tolerated against `next dev` — the runner assumes that unless CI is set
// (CI runs `next start`); E2E_SERVER=dev|prod overrides.
//
// Browsers: `pnpm exec playwright install chromium` once per machine.

import { defineConfig } from '@playwright/test';

const baseURL = process.env.BASE_URL ?? 'http://localhost:3200';

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  // `next dev` compiles each route on its first visit, which can take
  // a minute on a busy machine; a production build answers in < 1s.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // One worker against `next dev` (parallel first-compiles thrash it);
  // CI runs against `next start` and can afford two.
  workers: process.env.CI ? 2 : 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]]
    : [['list']],
  use: {
    baseURL,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      // The phone width the DS-03 audit measured (iPhone 12–15 class).
      name: 'mobile',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
