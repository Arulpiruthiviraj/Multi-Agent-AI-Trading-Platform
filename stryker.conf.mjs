// Adversarial Synthetic Market & Trading Validation Framework, §30 (Mutation Testing).
//
// Deliberately scoped to the 3 smallest, purest trading-mode/LIVE-safety guard files
// (brokerEnvironment.ts, tradingModeEnv.ts, liveOrderAuthorization.ts - ~191 lines combined), not
// the full RiskEngine.ts/OrderManagement.ts (1044/1164 lines - a full-file run against those would
// take far longer per mutant due to the real DB-bootstrapping test setup they require). This first
// pass directly answers the framework's own worked example - "if <= becomes <, is there a test
// capable of detecting it?" - for the exact functions propertyInvariants.test.ts (§27) was written
// against, proving whether property-based + existing example-based tests actually catch mutations
// in the code that decides whether a LIVE order is ever authorized.
//
// Scope this config to more files (RiskEngine.ts, OrderManagement.ts) as a follow-up once this
// first run's runtime/signal is known - do not widen `mutate` blindly.
// 2026-09-30 real incident: the first run of this config exhausted the host disk (100% full,
// 185GB of unrotated data/backups/ snapshots - unrelated to Stryker, fixed separately by pruning)
// because Stryker's default sandbox copies the ENTIRE working directory per concurrent sandbox,
// including data/argus.db (12GB+), data/backups/ (then 185GB), data/heap-snapshots/ (2.2GB), and
// .venv/ (1.6GB, which Stryker also tried to Babel-parse as source, producing the matplotlib HTML
// parse-error warnings in that run's log). `files` below scopes the sandbox to only what mutated
// code and its tests can actually need - never the real runtime data directory.
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  reporters: ['html', 'clear-text', 'progress', 'json'],
  coverageAnalysis: 'off',
  files: [
    'src/**/*.ts',
    'src/**/*.tsx',
    'scripts/**/*.ts',
    'config/**/*.json',
    'package.json',
    'tsconfig*.json',
    'vitest.config.ts',
    'vitest.mutation.config.ts',
    'vitest.setup.ts',
  ],
  mutate: [
    'src/server/core/brokerEnvironment.ts',
    'src/server/core/tradingModeEnv.ts',
    'src/server/core/liveOrderAuthorization.ts',
  ],
  vitest: {
    configFile: 'vitest.mutation.config.ts',
    // 2026-09-30 real bug found: Vitest's own --related file-detection heuristic failed to
    // associate liveOrderAuthorization.ts with liveReadiness.test.ts (which genuinely imports and
    // calls it), producing a false 0%-coverage/"no coverage" result for the entire file and masking
    // real mutation data behind a tooling artifact, not a real test gap. Disabling `related` runs
    // the full (small, 4-file/24-test) vitest.mutation.config.ts set per mutant instead of trying
    // to guess which subset is relevant - slower per mutant, but correct.
    related: false,
  },
  tempDirName: '.stryker-tmp',
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  timeoutMS: 30000,
  concurrency: 2,
};
