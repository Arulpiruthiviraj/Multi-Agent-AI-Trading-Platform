// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  runCausalCryptoStrategy,
  applyCryptoNextBarFills,
  summarizeCryptoBacktest,
} from './btcEthBacktestHarness';
import type { ResearchBar } from './ohlcvTypes';

function makeBars(n: number): ResearchBar[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: i * 86_400_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1000,
  }));
}

describe('runCausalCryptoStrategy - causality guarantee', () => {
  it('never passes a bar beyond the current index to fetchStrategy', async () => {
    const bars = makeBars(10);
    const seenLengths: number[] = [];
    const fetchStrategy = vi.fn(async (_id: string, _symbol: string, slice: ResearchBar[]) => {
      seenLengths.push(slice.length);
      return { position: 'FLAT' };
    });

    await runCausalCryptoStrategy({ strategyId: 'x', symbol: 'BTC', bars, minBars: 1, fetchStrategy });

    // Call k (0-indexed) must have received exactly k+1 bars - never more (no lookahead), never
    // fewer (every eligible bar gets evaluated once minBars is reached).
    seenLengths.forEach((len, k) => expect(len).toBe(k + 1));
    expect(seenLengths[seenLengths.length - 1]).toBe(10);
    expect(Math.max(...seenLengths)).toBeLessThanOrEqual(10);
  });

  it('produces a materially different signal sequence than an intentionally-lookahead variant would', async () => {
    // A hostile "strategy" that only goes LONG once it has seen bar index 9 (the LAST bar) in its
    // input - i.e. it requires lookahead to ever fire. Fed causally, it must NEVER go long before
    // bar 9 is legitimately reached, proving the harness supplies no future data early.
    const bars = makeBars(10);
    const fetchStrategy = vi.fn(async (_id: string, _symbol: string, slice: ResearchBar[]) => {
      const sawLastBar = slice.some((b) => b.close === bars[9].close);
      return { position: sawLastBar ? 'LONG' : 'FLAT' };
    });

    const { signals } = await runCausalCryptoStrategy({ strategyId: 'x', symbol: 'BTC', bars, minBars: 1, fetchStrategy });

    // The only BUY signal possible is at barIndex 9 (the first causal step where bar 9 is legitimately visible).
    expect(signals).toEqual([{ barIndex: 9, side: 'BUY' }]);
  });

  it('holds position (does not force FLAT) on a null/malformed response', async () => {
    const bars = makeBars(6);
    let call = 0;
    const fetchStrategy = vi.fn(async () => {
      call++;
      if (call === 1) return { position: 'LONG' };
      if (call === 2) return null; // simulate a transient bridge failure - must not fabricate an exit
      return { position: 'LONG' };
    });

    const { signals, nullResponseCount } = await runCausalCryptoStrategy({
      strategyId: 'x', symbol: 'BTC', bars, minBars: 1, fetchStrategy,
    });

    expect(nullResponseCount).toBe(1);
    // Exactly one BUY (the initial FLAT->LONG transition); the null response must not emit a SELL.
    expect(signals).toEqual([{ barIndex: 0, side: 'BUY' }]);
  });

  it('flags bridgeDegraded when a majority of responses are null (bridge outage, not real strategy behavior)', async () => {
    const bars = makeBars(10);
    const fetchStrategy = vi.fn(async () => null); // simulate a fully unresponsive/timing-out bridge
    const result = await runCausalCryptoStrategy({ strategyId: 'x', symbol: 'BTC', bars, minBars: 1, fetchStrategy });
    expect(result.nullResponseCount).toBe(10);
    expect(result.bridgeDegraded).toBe(true);
    expect(result.signals).toEqual([]); // never fabricates a signal from a dead bridge
  });

  it('does not flag bridgeDegraded for an occasional transient null', async () => {
    const bars = makeBars(10);
    let call = 0;
    const fetchStrategy = vi.fn(async () => {
      call++;
      return call === 3 ? null : { position: 'FLAT' };
    });
    const result = await runCausalCryptoStrategy({ strategyId: 'x', symbol: 'BTC', bars, minBars: 1, fetchStrategy });
    expect(result.nullResponseCount).toBe(1);
    expect(result.bridgeDegraded).toBe(false);
  });
});

describe('applyCryptoNextBarFills + summarizeCryptoBacktest', () => {
  it('fills a BUY/SELL pair at the NEXT bar open, never the signal bar itself', () => {
    const bars = makeBars(5); // opens: 100,101,102,103,104
    const signals = [
      { barIndex: 0 as const, side: 'BUY' as const },
      { barIndex: 2 as const, side: 'SELL' as const },
    ];
    const costs = { spreadBps: 0, slippageBps: 0, feeBps: 0, notionalPerTradeUsd: 1000 };
    const { trades, unclosedCount } = applyCryptoNextBarFills(bars, signals, costs);

    expect(unclosedCount).toBe(0);
    expect(trades).toHaveLength(1);
    expect(trades[0].fillBarIndex).toBe(3); // signal at bar 2 -> fills at bar 3's open (103), never bar 2's own open
    expect(trades[0].fillPrice).toBeCloseTo(103, 6);

    const metrics = summarizeCryptoBacktest(trades, 30);
    expect(metrics.tradeCount).toBe(1);
    expect(metrics.sharpe.status).toBe('INSUFFICIENT_SAMPLE'); // honest: 1 trade is not a valid Sharpe sample
  });

  it('leaves a final unclosed BUY out of the closed-trade metrics, never fabricating an exit', () => {
    const bars = makeBars(5);
    const signals = [{ barIndex: 3 as const, side: 'BUY' as const }];
    const costs = { spreadBps: 0, slippageBps: 0, feeBps: 0, notionalPerTradeUsd: 1000 };
    const { trades, unclosedCount } = applyCryptoNextBarFills(bars, signals, costs);
    expect(unclosedCount).toBe(1);
    const metrics = summarizeCryptoBacktest(trades, 30);
    expect(metrics.tradeCount).toBe(0);
  });

  it('applies fee/spread/slippage as real cost drag on pnl (non-zero costs reduce net pnl vs zero-cost)', () => {
    const bars = makeBars(5);
    const signals = [
      { barIndex: 0 as const, side: 'BUY' as const },
      { barIndex: 2 as const, side: 'SELL' as const },
    ];
    const zeroCost = applyCryptoNextBarFills(bars, signals, { spreadBps: 0, slippageBps: 0, feeBps: 0, notionalPerTradeUsd: 1000 });
    const realCost = applyCryptoNextBarFills(bars, signals, { spreadBps: 5, slippageBps: 5, feeBps: 10, notionalPerTradeUsd: 1000 });
    expect(realCost.trades[0].pnl!).toBeLessThan(zeroCost.trades[0].pnl!);
  });
});

describe('btcEthBacktestHarness.ts - architectural guarantee (research-only, never touches the protected spine)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'btcEthBacktestHarness.ts'), 'utf8');

  it('never imports OrderManagement, RiskEngine, ChiefTraderAgent, BrokerManager, or PositionSizing', () => {
    expect(source).not.toMatch(/from ['"].*OrderManagement['"]/);
    expect(source).not.toMatch(/from ['"].*\/RiskEngine['"]/);
    expect(source).not.toMatch(/from ['"].*ChiefTraderAgent['"]/);
    expect(source).not.toMatch(/from ['"].*BrokerManager['"]/);
    expect(source).not.toMatch(/from ['"].*PositionSizing['"]/);
  });

  it('never calls .placeOrder( or emitTradeIdea', () => {
    expect(source).not.toMatch(/\.placeOrder\(/);
    expect(source).not.toMatch(/emitTradeIdea/);
  });
});

describe('run_btc_eth_backtest.ts script - architectural guarantee', () => {
  const scriptPath = path.join(__dirname, '..', '..', '..', 'scripts', 'run_btc_eth_backtest.ts');
  const source = fs.readFileSync(scriptPath, 'utf8');

  it('never imports OrderManagement, RiskEngine, ChiefTraderAgent, BrokerManager, or PositionSizing', () => {
    expect(source).not.toMatch(/from ['"].*OrderManagement['"]/);
    expect(source).not.toMatch(/from ['"].*\/RiskEngine['"]/);
    expect(source).not.toMatch(/from ['"].*ChiefTraderAgent['"]/);
    expect(source).not.toMatch(/from ['"].*BrokerManager['"]/);
    expect(source).not.toMatch(/from ['"].*PositionSizing['"]/);
  });

  it('never calls .placeOrder( or emitTradeIdea', () => {
    expect(source).not.toMatch(/\.placeOrder\(/);
    expect(source).not.toMatch(/emitTradeIdea/);
  });
});
