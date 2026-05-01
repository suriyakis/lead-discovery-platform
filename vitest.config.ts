import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/tests/**/*.test.ts'],
    // DB-backed test files share a single `lead_test` database and each
    // truncates in beforeEach. Run files sequentially so they don't race;
    // within a file, tests still run in declaration order.
    fileParallelism: false,
    // Tests run against a dedicated lead_test database. Set up once via the
    // globalSetup; per-file truncate via beforeEach in the suites that need it.
    globalSetup: ['./src/tests/setup-global.ts'],
    env: {
      // Override DATABASE_URL before any module import that reads it.
      DATABASE_URL: 'postgres://lead:lead@localhost:5432/lead_test',
      // Auth.js complains if AUTH_SECRET is missing even in tests that don't
      // exercise auth — populate with a deterministic non-secret.
      AUTH_SECRET: 'test-secret-deterministic-not-for-production-use-only-tests',
      // Deterministic 32-byte hex for the at-rest secrets crypto.
      MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
