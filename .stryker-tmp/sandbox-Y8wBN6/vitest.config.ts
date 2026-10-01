// @ts-nocheck
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    // .test.tsx added 2026-09-28 for the first real React component tests in this repo
    // (F33/F34 regression coverage) - every existing .test.ts file is untouched by this addition.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    // Parallel workers sharing Chronos/OpenAlice sockets produced ECONNRESET on in-process
    // supertest (GET /api/v2/quant/strategies) even though the handler is synchronous.
    fileParallelism: false,
    // Full-suite DB bootstrap in beforeAll can exceed the 10s default under load.
    hookTimeout: 60_000,
  },
});
