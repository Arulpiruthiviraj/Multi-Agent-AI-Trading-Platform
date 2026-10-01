import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Dedicated, minimal vitest config for mutation testing (§30 of the Adversarial Synthetic Market &
 * Trading Validation Framework). The main vitest.config.ts's `include` matches all 602 test files,
 * which Stryker's vitest runner uses as its dry-run baseline by default - running the FULL suite
 * per mutant (or even once as a dry run) inside a sandbox missing .env/DB migrations is both wrong
 * (many of those tests need real environment setup this sandbox doesn't have) and wasteful (§15:
 * "mutation testing should NOT become part of every normal developer test run" - it should run only
 * what's relevant to the mutated files, not the whole repo). This config's `include` is updated
 * every time stryker.conf.mjs's `mutate` list grows to a new safety domain.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/server/core/brokerEnvironment.test.ts',
      'src/server/core/tradingModeEnv.test.ts',
      'src/server/core/liveReadiness.test.ts',
      'src/server/testing/propertyInvariants.test.ts',
    ],
    globals: false,
    fileParallelism: false,
  },
});
