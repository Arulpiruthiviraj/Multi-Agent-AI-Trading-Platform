/**
 * Adversarial Synthetic Market & Trading Validation Framework, §36 (Golden Critical Scenarios).
 *
 * This is a CURATION, not a new test suite - every scenario below is covered by a real, existing,
 * already-passing test file (verified to exist and to actually exercise the named failure mode
 * before being added here, 2026-09-30). Building a second, duplicate implementation of any of these
 * would violate the framework's own "do not create a second test architecture" instruction. This
 * script exists purely to name the release-blocker subset and run it as one fast, addressable
 * `npm run test:golden` command, per §36's own requirement that these be release blockers.
 *
 * Adding a scenario here requires verifying (read the file, not just its name) that it genuinely
 * covers the named failure mode - do not add a file just because its name sounds relevant.
 */
// @ts-nocheck

const GOLDEN_SCENARIOS: Record<string, string> = {
  'duplicate order protection': 'src/server/integration/failureInjectionSuite.test.ts',
  'stale data rejection': 'src/server/engines/RiskEngine.test.ts',
  'delayed data rejection': 'src/server/services/MarketDataWorker.test.ts',
  'RiskEngine fail-closed (gate ladder, never skipped)': 'src/server/engines/RiskEngine.gates.test.ts',
  'broker disconnect recovery (DEF-28)': 'src/brokers/__tests__/IbkrSocketSession.reconnect.test.ts',
  'partial-fill recovery': 'src/server/services/OrderManagement.syntheticBrokerPartialFill.test.ts',
  'restart reconciliation (DEF-27/29/30)': 'src/server/services/OrderManagement.crashRecovery.test.ts',
  'restart drain ordering (DEF-27/29)': 'src/server/core/gracefulShutdown.test.ts',
  'AI-total-outage quant operation': 'src/server/ai/AIRouter.test.ts',
  'Java failure isolation': 'src/server/services/QuantCoreBridge.test.ts',
  'cross-broker retry protection': 'src/server/services/OrderManagement.crashRecovery.test.ts',
  'synthetic provenance isolation (crypto)': 'src/server/crypto/synthetic/productionPollutionGuard.test.ts',
  'synthetic provenance isolation (replay)': 'src/server/replay/SyntheticSimulationSafety.test.ts',
};

const files = [...new Set(Object.values(GOLDEN_SCENARIOS))];
console.log(`[golden-critical-scenarios] ${Object.keys(GOLDEN_SCENARIOS).length} named scenarios, ${files.length} distinct files:`);
for (const [scenario, file] of Object.entries(GOLDEN_SCENARIOS)) {
  console.log(`  - ${scenario} -> ${file}`);
}

import { spawnSync } from 'node:child_process';
const result = spawnSync('npx', ['vitest', 'run', ...files], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
