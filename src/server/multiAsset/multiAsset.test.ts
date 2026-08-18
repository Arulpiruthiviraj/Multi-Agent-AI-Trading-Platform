import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyAsset } from './AssetClassifier';
import { evaluateAssetSafety } from './SafetyFilter';
import { filterStrategiesForAsset, strategyPermissionForAsset } from './StrategyRouter';
import { applyAssetIdeaGate, applySubordinateAssetNotionalCap } from './ideaEligibility';
import { loadCanonicalCostsForAsset } from './researchCosts';
import { scanAssetOpportunity } from './OpportunityScanner';
import { loadCanonicalCosts } from '../research/canonicalNextBarEngine';
import { multiAssetConfig } from '../config/multiAsset';
import { CORE_STRATEGIES, evaluateAll } from '../quant/strategies/StrategyEngine';
import { evaluateLiveReadiness } from '../core/liveReadinessEngine';

const FLAG_A = multiAssetConfig.multiAssetEnabledEnvVar;
const FLAG_B = multiAssetConfig.pennyStockEnabledEnvVar;

function setFlags(multi: boolean, penny: boolean) {
  if (multi) process.env[FLAG_A] = 'true';
  else delete process.env[FLAG_A];
  if (penny) process.env[FLAG_B] = 'true';
  else delete process.env[FLAG_B];
}

afterEach(() => {
  delete process.env[FLAG_A];
  delete process.env[FLAG_B];
});

describe('AssetClassifier', () => {
  it('uses explicit overrides for AAPL/MSFT/NVDA without guessing market cap', () => {
    const aapl = classifyAsset({ symbol: 'AAPL', price: 190 });
    expect(aapl.assetClass).toBe('LARGE_CAP');
    expect(aapl.basis[0]).toMatch(/symbolOverride/);
  });

  it('classifies SPY/QQQ/IWM as ETF from allowlist', () => {
    expect(classifyAsset({ symbol: 'SPY' }).assetClass).toBe('ETF');
    expect(classifyAsset({ symbol: 'QQQ' }).assetClass).toBe('ETF');
    expect(classifyAsset({ symbol: 'IWM' }).assetClass).toBe('ETF');
  });

  it('prefers UNKNOWN when price and market cap are missing', () => {
    const row = classifyAsset({ symbol: 'ZZZZ' });
    expect(row.assetClass).toBe('UNKNOWN');
    expect(row.basis.join(' ')).toMatch(/UNKNOWN/);
  });

  it('price-only penny heuristic is marked uncalibrated', () => {
    const row = classifyAsset({ symbol: 'ABCD', price: 0.8 });
    expect(row.assetClass).toBe('PENNY_STOCK');
    expect(row.uncalibrated).toBe(true);
  });

  it('uses market cap buckets when provided', () => {
    expect(classifyAsset({ symbol: 'ZZZZ', marketCap: 20_000_000_000 }).assetClass).toBe('LARGE_CAP');
    expect(classifyAsset({ symbol: 'ZZZZ', marketCap: 3_000_000_000 }).assetClass).toBe('MID_CAP');
    expect(classifyAsset({ symbol: 'ZZZZ', marketCap: 400_000_000 }).assetClass).toBe('SMALL_CAP');
    expect(classifyAsset({ symbol: 'ZZZZ', marketCap: 80_000_000 }).assetClass).toBe('MICRO_CAP');
  });
});

describe('SafetyFilter', () => {
  it('passthrough SAFE for AAPL even with missing spread', () => {
    const result = evaluateAssetSafety({ symbol: 'AAPL', price: 190 });
    expect(result.verdict).toBe('SAFE');
    expect(result.reasons).toContain('passthrough_non_penny_micro');
  });

  it('BLOCKs penny/micro when spread is unknown and MARKET is unfit', () => {
    const result = evaluateAssetSafety({ symbol: 'ABCD', price: 0.8 });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons).toContain('ASSET_SPREAD_UNKNOWN');
    expect(result.reasons).toContain('ASSET_MARKET_ORDER_UNFIT');
  });

  it('BLOCKs excessive spread even when dollar volume is present', () => {
    const result = evaluateAssetSafety({
      symbol: 'ABCD',
      price: 1.2,
      bid: 1.0,
      ask: 1.5,
      averageDollarVolume: 5_000_000,
    });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons.some((r) => r.startsWith('ASSET_EXCESSIVE_SPREAD'))).toBe(true);
  });
});

describe('StrategyRouter / evaluateAll identity', () => {
  it('does not filter CORE when flags are off', () => {
    setFlags(false, false);
    expect(filterStrategiesForAsset(CORE_STRATEGIES, 'PENNY_STOCK')).toHaveLength(CORE_STRATEGIES.length);
    expect(strategyPermissionForAsset('PENNY_STOCK').mode).toBe('UNRESTRICTED');
  });

  it('empty penny allowlist filters live evaluateAll only when class is penny and flags are on', async () => {
    setFlags(true, true);
    const { baseFixture } = await import('../quant/strategies/testHelpers');
    const unrestricted = evaluateAll({ ...baseFixture(), assetClass: 'LARGE_CAP' });
    expect(unrestricted.length).toBe(5);
    const pennies = evaluateAll({ ...baseFixture(), symbol: 'ABCD', currentPrice: 0.9, assetClass: 'PENNY_STOCK' });
    expect(pennies.length).toBe(0);
  });
});

describe('idea eligibility', () => {
  it('is identity when flags are off, including a $0.80 ticker', () => {
    setFlags(false, false);
    const gated = applyAssetIdeaGate({ symbol: 'ABCD', side: 'BUY', currentPrice: 0.8 });
    expect(gated.ok).toBe(true);
  });

  it('AAPL BUY remains eligible when both flags are on', () => {
    setFlags(true, true);
    const gated = applyAssetIdeaGate({ symbol: 'AAPL', side: 'BUY', currentPrice: 190 });
    expect(gated.ok).toBe(true);
    if (gated.ok) expect(gated.idea.assetClass).toBe('LARGE_CAP');
  });

  it('blocks penny BUY when penny flag is on and spread is unknown', () => {
    setFlags(true, true);
    const gated = applyAssetIdeaGate({ symbol: 'ABCD', side: 'BUY', currentPrice: 0.8 });
    expect(gated.ok).toBe(false);
    expect(gated.ok === false && gated.reasons.length > 0).toBe(true);
  });

  it('does not block SELL exits for penny names', () => {
    setFlags(true, true);
    const gated = applyAssetIdeaGate({ symbol: 'ABCD', side: 'SELL', currentPrice: 0.8 });
    expect(gated.ok).toBe(true);
  });

  it('notional cap is identity when flags are off and never exceeds global', () => {
    setFlags(false, false);
    expect(applySubordinateAssetNotionalCap({ symbol: 'ABCD', currentPrice: 0.8, maxTradeSizeDollar: 3000 })).toBe(3000);
    setFlags(true, true);
    const clamped = applySubordinateAssetNotionalCap({ symbol: 'ABCD', currentPrice: 0.8, maxTradeSizeDollar: 3000 });
    const profileCap = multiAssetConfig.profiles.PENNY_STOCK.maxPositionNotional;
    expect(clamped).toBe(Math.min(3000, profileCap ?? 3000));
    expect(clamped).toBeLessThanOrEqual(3000);
    expect(applySubordinateAssetNotionalCap({ symbol: 'AAPL', currentPrice: 190, maxTradeSizeDollar: 3000 })).toBe(3000);
  });
});

describe('research costs', () => {
  it('matches global canonical costs when flags are off', () => {
    setFlags(false, false);
    expect(loadCanonicalCostsForAsset('PENNY_STOCK')).toEqual(loadCanonicalCosts());
  });

  it('never cheapens spread/slippage versus global researchSafety when penny flag is on', () => {
    setFlags(true, true);
    const base = loadCanonicalCosts();
    const penny = loadCanonicalCostsForAsset('PENNY_STOCK');
    expect(penny.spreadBps).toBeGreaterThanOrEqual(base.spreadBps);
    expect(penny.slippageBps).toBeGreaterThanOrEqual(base.slippageBps);
    expect(loadCanonicalCostsForAsset('ETF')).toEqual(base);
  });
});

describe('OpportunityScanner', () => {
  it('marks overlay opportunities as not orders', () => {
    const row = scanAssetOpportunity({ symbol: 'AAPL', price: 190 });
    expect(row.honesty).toMatch(/cannot place orders/i);
    expect(row.symbol).toBe('AAPL');
  });
});

describe('LIVE / spine', () => {
  it('does not change LIVE_NO_GO', () => {
    setFlags(true, true);
    expect(evaluateLiveReadiness().result).toBe('LIVE_NO_GO');
  });
});

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('adversarial isolation', () => {
  it('multiAsset modules never call placeOrder / OMS / BrokerManager / RiskEngine', () => {
    const dir = join(process.cwd(), 'src', 'server', 'multiAsset');
    const forbidden = ['placeOrder(', 'BrokerManager', 'OrderManagement', 'executeOrder', 'RiskEngine', 'RiskAgent'];
    for (const file of walkTs(dir)) {
      const text = readFileSync(file, 'utf8');
      const realHits: string[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        for (const token of forbidden) {
          if (line.includes(token)) realHits.push(`${file}: ${trimmed}`);
        }
      }
      expect(realHits).toEqual([]);
    }
  });

  it('multiAsset route cannot place orders', () => {
    const text = readFileSync(join(process.cwd(), 'src', 'server', 'routes', 'multiAssetRoutes.ts'), 'utf8');
    expect(text).not.toMatch(/placeOrder/);
    expect(text).not.toMatch(/BrokerManager/);
    expect(text).not.toMatch(/executeOrder/);
  });
});
