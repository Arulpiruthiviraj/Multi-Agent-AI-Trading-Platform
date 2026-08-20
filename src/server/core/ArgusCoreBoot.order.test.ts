import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Static ordering invariant — DEF-01 broker before TradingEngine in ArgusCoreBoot. */
describe('ArgusCoreBoot startup order', () => {
  it('initializes BrokerManager before tradingEngine.initialize', () => {
    const src = readFileSync(join(process.cwd(), 'src/server/core/ArgusCoreBoot.ts'), 'utf8');
    const brokerIdx = src.indexOf('await BrokerManager.getInstance().initialize()');
    const teIdx = src.indexOf('await tradingEngine.initialize()');
    expect(brokerIdx).toBeGreaterThan(-1);
    expect(teIdx).toBeGreaterThan(brokerIdx);
  });
});
