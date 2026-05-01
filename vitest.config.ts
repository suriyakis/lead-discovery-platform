import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/tests/**/*.test.ts'],
    // Tests run against a dedicated lead_test database. Set up once via the
    // globalSetup; per-file truncate via beforeEach in the suites that need it.
    globalSetup: ['./src/tests/setup-global.ts'],
    env: {
      // Override DATABASE_URL before any module import that reads it.
      DATABASE_URL: 'postgres://lead:lead@localhost:5432/lead_test',
      // Auth.js complains if AUTH_SECRET is missing even in tests that don't
      // exercise auth — populate with a deterministic non-secret.
      AUTH_SECRET: 'test-secret-deterministic-not-for-production-use-only-tests',
      // Force mock providers for any code path that touches them.
      AI_PROVIDER: 'mock',
      SEARCH_PROVIDER: 'mock',
      JOB_QUEUE_PROVIDER: 'memory',
      STORAGE_PROVIDER: 'local',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
