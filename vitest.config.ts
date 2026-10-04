import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // API tests share one Postgres database.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
