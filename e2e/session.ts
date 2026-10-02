// A Playwright `test` signed in as the seeded super-admin, once per worker,
// through the team-login API (the same sign-in e2e/smoke.spec.ts uses).
// Needs SEED_DEMO_PASSWORD: the password scripts/seed-demo.ts seeded with.

import path from 'node:path';
import { expect, test as base } from '@playwright/test';

export const ADMIN_EMAIL = 'demo-admin@example.com';

export const signedInTest = base.extend<object, { workerStorageState: string }>({
  // (Playwright's fixture callback is usually called `use`; renamed so the
  // react-hooks lint rule doesn't mistake it for React's use().)
  storageState: ({ workerStorageState }, provide) => provide(workerStorageState),
  workerStorageState: [
    async ({ playwright }, provide, workerInfo) => {
      const password = process.env.SEED_DEMO_PASSWORD;
      if (!password) {
        throw new Error('Set SEED_DEMO_PASSWORD to the password scripts/seed-demo.ts seeded with.');
      }
      const file = path.join(
        workerInfo.project.outputDir,
        `.auth/session-${workerInfo.project.name}-${workerInfo.parallelIndex}.json`,
      );
      const api = await playwright.request.newContext({ baseURL: workerInfo.project.use.baseURL });
      const res = await api.post('/api/auth/team-login', {
        data: { email: ADMIN_EMAIL, password },
      });
      expect(res.status(), `team-login: ${await res.text()}`).toBe(200);
      await api.storageState({ path: file });
      await api.dispose();
      await provide(file);
    },
    { scope: 'worker' },
  ],
});
