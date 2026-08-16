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
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    // Parallel workers sharing Chronos/OpenAlice sockets produced ECONNRESET on in-process
    // supertest (GET /api/v2/quant/strategies) even though the handler is synchronous.
    fileParallelism: false,
  },
});
