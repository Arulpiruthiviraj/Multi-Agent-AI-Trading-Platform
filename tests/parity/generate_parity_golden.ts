/**
 * Generate tests/fixtures/strategy_parity_golden.json from live TS CORE evaluate().
 * Research-only. Usage: npx tsx tests/parity/generate_parity_golden.ts
 */
import { writeStrategyParityGolden, defaultStrategyParityFixturePath } from '../../src/server/research/strategyParityHarness';

const path = defaultStrategyParityFixturePath();
const golden = writeStrategyParityGolden(path);
console.log(JSON.stringify({
  ok: true,
  path,
  bars: golden.bars.length,
  strategies: golden.evaluations.map((e) => ({
    id: e.strategy,
    side: e.side,
    setupScore: e.setupScore,
    confidence: e.confidence,
    signalActive: e.signalActive,
  })),
  fullStrategyParity: golden.fullStrategyParity,
  canPlaceOrders: false,
}, null, 2));
