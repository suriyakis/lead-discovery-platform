import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/tests/**/*.test.ts'],
    // Phase 1 tests are fast and synchronous. We reach for higher concurrency
    // in later phases when DB-backed tests need isolation.
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
