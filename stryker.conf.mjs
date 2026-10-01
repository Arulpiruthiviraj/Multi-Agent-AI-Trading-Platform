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
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  reporters: ['html', 'clear-text', 'progress'],
  coverageAnalysis: 'perTest',
  mutate: [
    'src/server/core/brokerEnvironment.ts',
    'src/server/core/tradingModeEnv.ts',
    'src/server/core/liveOrderAuthorization.ts',
  ],
  vitest: {
    configFile: 'vitest.config.ts',
  },
  tempDirName: '.stryker-tmp',
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  timeoutMS: 30000,
  concurrency: 4,
};
