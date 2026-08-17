import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eventBus } from '../core/EventBus';
import { validateTargetAllocations } from './PortfolioRebalance';

describe('validateTargetAllocations - pure input validation', () => {
  it('rejects a non-array or empty input', () => {
    expect(validateTargetAllocations(undefined).ok).toBe(false);
    expect(validateTargetAllocations([]).ok).toBe(false);
    expect(validateTargetAllocations('not an array').ok).toBe(false);
  });

  it('rejects a missing/empty symbol', () => {
    const r = validateTargetAllocations([{ symbol: '', targetPct: 10 }]);
    expect(r.ok).toBe(false);
  });

  it('rejects an out-of-range or non-finite targetPct', () => {
    expect(validateTargetAllocations([{ symbol: 'AAPL', targetPct: -1 }]).ok).toBe(false);
    expect(validateTargetAllocations([{ symbol: 'AAPL', targetPct: 101 }]).ok).toBe(false);
    expect(validateTargetAllocations([{ symbol: 'AAPL', targetPct: 'ten' }]).ok).toBe(false);
  });

  it('rejects a duplicate symbol', () => {
    const r = validateTargetAllocations([{ symbol: 'AAPL', targetPct: 10 }, { symbol: 'aapl', targetPct: 5 }]);
    expect(r.ok).toBe(false);
  });

  it('rejects targetPct values summing above 100%', () => {
    const r = validateTargetAllocations([{ symbol: 'AAPL', targetPct: 60 }, { symbol: 'MSFT', targetPct: 50 }]);
    expect(r.ok).toBe(false);
  });

  it('accepts and normalizes a real, valid request', () => {
    const r = validateTargetAllocations([{ symbol: 'aapl', targetPct: 20 }, { symbol: 'MSFT', targetPct: 15 }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targets).toEqual([{ symbol: 'AAPL', targetPct: 20 }, { symbol: 'MSFT', targetPct: 15 }]);
    }
  });
});

describe('executeRebalance - real pipeline submission, real drift math', () => {
  let tmpDbPath: string;
  let sqliteDb: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_rebalance_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    const { tradingEngine } = await import('../engines/TradingEngine');
    await tradingEngine.initialize();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('skips a symbol already within the drift tolerance instead of submitting a noise trade', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    (broker as any).portfolio = async () => ({
      cash: 50000, buyingPower: 50000, equity: 100000,
      positions: [{ symbol: 'ONTARGET', quantity: 100, entryPrice: 100, currentPrice: 100, marketValue: 10000, unrealizedPnl: 0, unrealizedPnlPercent: 0 }],
    });
    const { marketDataWorker } = await import('./MarketDataWorker');
    (marketDataWorker as any).latestPrices.set('ONTARGET', 100);

    const { executeRebalance } = await import('./PortfolioRebalance');
    // Real position is exactly 10% of equity ($10,000/$100,000) - request the same target.
    const result = await executeRebalance([{ symbol: 'ONTARGET', targetPct: 10 }]);
    expect(result.submitted).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].symbol).toBe('ONTARGET');
  });

  it('emits a real SELL idea for an overweight position and a real BUY idea for an underweight one', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    (broker as any).portfolio = async () => ({
      cash: 50000, buyingPower: 50000, equity: 100000,
      positions: [
        { symbol: 'OVERWT', quantity: 300, entryPrice: 100, currentPrice: 100, marketValue: 30000, unrealizedPnl: 0, unrealizedPnlPercent: 0 },
      ],
    });
    const { marketDataWorker } = await import('./MarketDataWorker');
    (marketDataWorker as any).latestPrices.set('OVERWT', 100);
    (marketDataWorker as any).latestPrices.set('UNDERWT', 50);

    const ideas: any[] = [];
    const onIdea = (idea: any) => ideas.push(idea);
    eventBus.on('CHIEF_APPROVED_IDEA', onIdea);
    try {
      const { executeRebalance } = await import('./PortfolioRebalance');
      // OVERWT is 30% of equity, target 10% -> real drift 20pp -> SELL.
      // UNDERWT has no position (0%), target 15% -> real drift 15pp -> BUY.
      const result = await executeRebalance([
        { symbol: 'OVERWT', targetPct: 10 },
        { symbol: 'UNDERWT', targetPct: 15 },
      ]);
      expect(result.refused).toHaveLength(0);
      expect(result.submitted).toHaveLength(2);
      const overwt = result.submitted.find((s) => s.symbol === 'OVERWT');
      const underwt = result.submitted.find((s) => s.symbol === 'UNDERWT');
      expect(overwt?.side).toBe('SELL');
      expect(underwt?.side).toBe('BUY');
      expect(ideas.some((i) => i.symbol === 'OVERWT' && i.side === 'SELL')).toBe(true);
      expect(ideas.some((i) => i.symbol === 'UNDERWT' && i.side === 'BUY')).toBe(true);
      // Never a raw broker call - only the real event pipeline.
      expect(ideas.every((i) => i.agentsContext === 'ManualOverride')).toBe(true);
    } finally {
      eventBus.off('CHIEF_APPROVED_IDEA', onIdea);
    }
  });

  it('refuses a symbol with no live price instead of guessing', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    (broker as any).portfolio = async () => ({ cash: 100000, buyingPower: 100000, equity: 100000, positions: [] });

    const { executeRebalance } = await import('./PortfolioRebalance');
    const result = await executeRebalance([{ symbol: 'NOPRICETICK', targetPct: 10 }]);
    expect(result.submitted).toHaveLength(0);
    expect(result.refused[0].reason).toMatch(/no live price/i);
  });
});
