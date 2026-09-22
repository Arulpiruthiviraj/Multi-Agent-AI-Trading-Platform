import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { listCryptoInstruments } from '../config/cryptoInstruments';

/**
 * Crypto Expansion Phase 1 (2026-09-21). Same static-scan pattern as
 * src/server/crypto/cryptoArchitectureBoundary.test.ts, applied to the three new shared-plumbing
 * files this phase adds OUTSIDE src/server/crypto/ (that directory's own boundary test does not
 * cover them): the crypto instrument registry, the cross-asset symbol validator, and the quantity
 * quantization helper. None of these files places an order, registers a broker, or touches live
 * arming - they are pure data/validation utilities consumed by RiskEngine/PositionSizing, exactly
 * like every other config/validation module those files already import.
 */
const FILES = [
  path.join(__dirname, '..', 'config', 'cryptoInstruments.ts'),
  path.join(__dirname, 'InstrumentRegistry.ts'),
  path.join(__dirname, '..', 'engines', 'QuantityQuantization.ts'),
];

function sourceOf(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('Crypto Expansion Phase 1 - new shared plumbing stays non-executing', () => {
  it('all three files exist (sanity)', () => {
    for (const f of FILES) expect(fs.existsSync(f), f).toBe(true);
  });

  it('no file calls placeOrder or registers a broker', () => {
    for (const f of FILES) {
      const src = sourceOf(f);
      expect(src, f).not.toMatch(/\.placeOrder\s*\(/);
      expect(src, f).not.toMatch(/registerBroker\s*\(/);
    }
  });

  it('no file imports ChiefTraderAgent, RiskEngine, OrderManagement, BrokerManager, or a broker adapter', () => {
    for (const f of FILES) {
      const importLines = sourceOf(f).split('\n').filter((l) => /^\s*import\b/.test(l));
      const hit = importLines.some((l) =>
        /ChiefTraderAgent|RiskEngine|OrderManagement|BrokerManager|AlpacaBroker|IBGatewaySocketAdapter|InteractiveBrokersWebApiAdapter|CoinbaseBroker|QuestradeBroker|InternalPaperBroker/.test(l),
      );
      expect(hit, f).toBe(false);
    }
  });

  it('no file references PAPER_TRADING_ONLY, setLiveMode, evaluateLiveReadiness, or LIVE_ARM', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/PAPER_TRADING_ONLY|setLiveMode|evaluateLiveReadiness|LIVE_ARM\b/);
    }
  });

  it('no file mutates consensus thresholds', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/consensusApprovalThreshold\s*=|minIndependentAgreeingAgents\s*=/);
    }
  });

  it('the crypto instrument registry only ever registers BTC-USD/ETH-USD in Phase 1 - no silent broader-universe expansion', () => {
    const symbols = listCryptoInstruments().map((i) => i.canonicalSymbol).sort();
    expect(symbols).toEqual(['BTC-USD', 'ETH-USD']);
  });
});
