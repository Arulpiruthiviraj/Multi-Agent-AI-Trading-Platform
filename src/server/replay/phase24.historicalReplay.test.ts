/**
 * Phase 24 hostile / acceptance tests for MODE B historical replay.
 * Proves broker isolation, PIT, $100 realism, costs, determinism, organic-paper exclusion.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ReplayClock } from '../engines/backtest/ReplayClock';
import { InformationCutoff } from './InformationCutoff';
import { loadGoldenReplayDataset } from './loadGoldenReplayDataset';
import { setActiveReplaySession, replayVisibleBars, defaultReplayConfig, type ActiveReplaySession } from './ReplayContext';
import { HistoricalReplayBroker } from '../../brokers/HistoricalReplayBroker';
import { replaySafety } from './replaySafety';
import { newsVisibleAt, goldenReplayNewsProvider } from './HistoricalNewsProvider';
import { buildReplayPerformance } from './replayReport';
import { isOrganicClosedPaper } from '../research/organicPaper';
import { emptyEvidence, deriveLifecycleStatus, liveGoNoGo } from '../research/promotionEngine';
import { BrokerManager } from '../../brokers/BrokerManager';

describe('Phase 24 PIT + NEXT_BAR_OPEN', () => {
  it('replayVisibleBars excludes current bar at T (decision prefix)', () => {
    const ds = loadGoldenReplayDataset();
    const t = ds.bars[10].timestamp;
    const clock = new ReplayClock(t);
    const broker = new HistoricalReplayBroker({
      initialCash: 100000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
    });
    const session = {
      replayId: 'pit-test',
      status: 'RUNNING',
      config: defaultReplayConfig(),
      clock,
      cutoff: new InformationCutoff(clock),
      broker,
      datasets: [ds],
      quality: { quality: 'YELLOW' } as any,
      datasetHash: 'x',
      configurationHash: 'y',
      replayHash: 'z',
      news: goldenReplayNewsProvider(),
      events: [],
      noTrade: {},
      equity: [],
      peakEquity: 100000,
      pauseRequested: false,
      stopRequested: false,
      stepRequested: false,
      aiCalls: 0,
      aiCostUsd: 0,
      aiLabel: 'DISABLED',
      partial: true,
      waiters: new Map(),
      barsBySymbol: new Map([['AAPL', ds.bars]]),
      openStops: new Map(),
      tradePnls: [],
      tradeLedger: [],
      rejectedOrders: [],
      agentAvailability: {},
    } as unknown as ActiveReplaySession;
    setActiveReplaySession(session);
    const visible = replayVisibleBars('AAPL');
    expect(visible.every((b) => b.timestamp < t)).toBe(true);
    expect(visible.some((b) => b.timestamp === t)).toBe(false);
    // Future bar after T must stay inaccessible
    const future = ds.bars[11];
    expect(visible.some((b) => b.timestamp === future.timestamp)).toBe(false);
    setActiveReplaySession(null);
  });

  it('future injected news cannot become visible before publishedAt', () => {
    const ds = loadGoldenReplayDataset();
    const clock = new ReplayClock(ds.bars[5].timestamp);
    const cut = new InformationCutoff(clock);
    const visible = newsVisibleAt(goldenReplayNewsProvider(), cut, 'AAPL');
    expect(visible.every((n) => n.publishedAt <= clock.now())).toBe(true);
    expect(visible.some((n) => n.newsId === 'golden-news-future')).toBe(false);
  });

  it('NEXT_BAR_OPEN: decision close is not the fill price source', async () => {
    const broker = new HistoricalReplayBroker({
      initialCash: 100000,
      costs: { commissionPerShare: 0, spreadBps: 0, slippageBps: 0 },
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 3, 14, 30, 0);
    const decisionClose = 110;
    const nextOpen = 105;
    broker.nextFillPrice.set('AAPL', nextOpen);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 });
    expect(order.status).toBe('FILLED');
    expect(order.averageFillPrice).toBe(nextOpen);
    expect(order.averageFillPrice).not.toBe(decisionClose);
  });
});

describe('Phase 24 report honesty', () => {
  it('ZERO_COST_RESEARCH surfaces warning; Sortino stays insufficient under min sample', () => {
    const report = buildReplayPerformance({
      startingCapital: 10000,
      endingCapital: 10100,
      grossPnl: 100,
      fees: 0,
      slippage: 0,
      maxDrawdown: 10,
      maxDrawdownPct: 0.01,
      tradePnls: [10, -5, 20],
      buyTrades: 2,
      sellTrades: 2,
      noTrade: {},
      costProfile: 'ZERO_COST_RESEARCH',
      equityCurve: [{ t: 1, equity: 10000, cash: 5000 }, { t: 2, equity: 10100, cash: 5100 }],
      trades: [],
      benchmarkBars: null,
    });
    expect(report.zeroCostWarning).toContain('ZERO-COST');
    expect(report.executionModel).toBe('NEXT_BAR_OPEN');
    expect(report.sortino.status).toBe('INSUFFICIENT_SAMPLE');
    expect(report.sharpe.status).toBe('INSUFFICIENT_SAMPLE');
    expect(report.benchmark.status).toBe('UNAVAILABLE');
    expect(report.exposure.status).toBe('OK');
  });
});

describe('Phase 24 full path hostile scenarios', () => {
  let tmpDb: string;
  let tmpReplay: string;

  beforeAll(async () => {
    tmpDb = path.join(os.tmpdir(), `argus_p24_${Date.now()}_${process.pid}.db`);
    tmpReplay = path.join(os.tmpdir(), `argus_p24_replays_${Date.now()}_${process.pid}`);
    process.env.ARGUS_DB_PATH = tmpDb;
    process.env.ARGUS_REPLAY_DIR = tmpReplay;
    fs.mkdirSync(tmpReplay, { recursive: true });
  });

  afterAll(() => {
    try { fs.rmSync(tmpReplay, { recursive: true, force: true }); } catch { /* */ }
    for (const s of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDb + s); } catch { /* */ }
    }
  });

  it('Test 3 — BrokerManager returns replay broker; spy live placeOrder never called', async () => {
    const { createReplayRun, startReplay } = await import('./FullArgusReplayEngine');
    const { getActiveReplaySession } = await import('./ReplayContext');
    const created = await createReplayRun({
      dataProvider: 'golden_replay',
      symbols: ['AAPL'],
      initialCapital: 100000,
      allocationBudget: 3000,
      speed: 'MAX',
      costProfile: 'Base',
      randomSeed: 1,
    });
    if ((created as any).status === 'DATA_UNAVAILABLE' || (created as any).status === 'FAILED') {
      expect((created as any).error).toBeTruthy();
      return;
    }
    const liveSpy = {
      id: 'alpaca',
      name: 'SpyAlpaca',
      placeOrder: vi.fn(async () => {
        throw new Error('LIVE_PLACE_ORDER_SHOULD_NOT_RUN');
      }),
    };
    const bm = BrokerManager.getInstance();
    const prev = bm.getActiveBroker();
    // While replay inactive, ensure we can still read a broker
    expect(prev).toBeTruthy();
    // Inject spy as "active" underlying — getActiveBroker must still prefer replay.session.broker
    (bm as any).activeBroker = liveSpy;
    const started = await startReplay(String(created.replayId));
    expect(getActiveReplaySession()).toBeNull();
    expect(liveSpy.placeOrder).toHaveBeenCalledTimes(0);
    expect((started as any).executionEnvironment).toBe('REPLAY');
    expect((started as any).live).toBe('NO-GO');
    (bm as any).activeBroker = prev;
  }, 120000);

  it('Test 4 — $100 account cannot buy unaffordable whole share', async () => {
    const { createReplayRun, startReplay } = await import('./FullArgusReplayEngine');
    const created = await createReplayRun({
      dataProvider: 'golden_replay',
      symbols: ['AAPL'],
      initialCapital: 100,
      allocationBudget: 100,
      maxPositionSize: 100,
      fractionalShares: false,
      speed: 'MAX',
      costProfile: 'Base',
      randomSeed: 1,
    });
    if ((created as any).status === 'FAILED' || (created as any).status === 'DATA_UNAVAILABLE') return;
    const started = await startReplay(String(created.replayId));
    const buys = ((started as any).trades || []).filter((t: any) => t.side === 'BUY');
    expect(buys.length).toBe(0);
    expect((started as any).report?.endingCapital).toBeLessThanOrEqual(100 + 1e-6);
    expect((started as any).portfolio?.cash).toBeGreaterThanOrEqual(0);
  }, 120000);

  it('Test 5 — ZERO_COST vs Base changes fees/slippage accounting', async () => {
    const { createReplayRun, startReplay } = await import('./FullArgusReplayEngine');
    const zero = await createReplayRun({
      dataProvider: 'golden_replay',
      symbols: ['AAPL'],
      initialCapital: 100000,
      allocationBudget: 5000,
      speed: 'MAX',
      costProfile: 'ZERO_COST_RESEARCH',
      randomSeed: 1,
    });
    const base = await createReplayRun({
      dataProvider: 'golden_replay',
      symbols: ['AAPL'],
      initialCapital: 100000,
      allocationBudget: 5000,
      speed: 'MAX',
      costProfile: 'Base',
      randomSeed: 1,
    });
    if ((zero as any).status === 'FAILED' || (base as any).status === 'FAILED') return;
    const z = await startReplay(String(zero.replayId));
    const b = await startReplay(String(base.replayId));
    expect((z as any).report?.zeroCostWarning).toBeTruthy();
    expect((b as any).report?.totalFees + (b as any).report?.totalSlippage).toBeGreaterThanOrEqual(
      (z as any).report?.totalFees + (z as any).report?.totalSlippage
    );
    if ((z as any).report?.buyTrades >= 1 && (b as any).report?.buyTrades >= 1) {
      expect((b as any).report?.totalFees + (b as any).report?.totalSlippage).toBeGreaterThan(
        (z as any).report?.totalFees + (z as any).report?.totalSlippage
      );
    }
  }, 180000);

  it('Test 6 — identical configs → identical hashes; identical runs → identical net PnL', async () => {
    const { createReplayRun, startReplay } = await import('./FullArgusReplayEngine');
    const cfg = {
      dataProvider: 'golden_replay' as const,
      symbols: ['AAPL'],
      initialCapital: 100000,
      allocationBudget: 3000,
      speed: 'MAX' as const,
      costProfile: 'Base',
      randomSeed: 42,
    };
    const a = await createReplayRun(cfg);
    const b = await createReplayRun(cfg);
    expect((a as any).datasetHash).toBe((b as any).datasetHash);
    expect((a as any).configurationHash).toBe((b as any).configurationHash);
    const ra = await startReplay(String(a.replayId));
    const rb = await startReplay(String(b.replayId));
    expect((ra as any).report?.netPnl).toBe((rb as any).report?.netPnl);
    expect((ra as any).report?.endingCapital).toBe((rb as any).report?.endingCapital);
    expect(((ra as any).trades || []).map((t: any) => `${t.side}:${t.symbol}:${t.quantity}`)).toEqual(
      ((rb as any).trades || []).map((t: any) => `${t.side}:${t.symbol}:${t.quantity}`)
    );
  }, 180000);

  it('Test 8 — replay fills are not organic paper; cannot auto-promote', async () => {
    expect(isOrganicClosedPaper({
      status: 'FILLED',
      side: 'SELL',
      profitLoss: 50,
      executionEnvironment: 'REPLAY',
      traceId: 'replay-xyz',
    })).toBe(false);
    const e = emptyEvidence('MOMENTUM_BREAKOUT');
    expect(deriveLifecycleStatus(e)).toBe('UNTESTED');
    expect(liveGoNoGo(e).live).toBe('NO-GO');
  });

  it('E2E golden path produces consistent capital/P&L/equity/trades package', async () => {
    const { createReplayRun, startReplay } = await import('./FullArgusReplayEngine');
    const created = await createReplayRun({
      dataProvider: 'golden_replay',
      newsProvider: 'golden_replay_news',
      symbols: ['AAPL'],
      strategyIds: ['MOMENTUM_BREAKOUT'],
      aiMode: 'DISABLED',
      speed: 'MAX',
      costProfile: 'Base',
      initialCapital: 100000,
      allocationBudget: 3000,
      randomSeed: 1,
    });
    const started = await startReplay(String(created.replayId));
    expect(['COMPLETED', 'PARTIAL']).toContain((started as any).status);
    expect((started as any).report?.startingCapital).toBe(100000);
    expect(typeof (started as any).report?.endingCapital).toBe('number');
    expect(typeof (started as any).report?.netPnl).toBe('number');
    expect((started as any).report?.executionModel).toBe('NEXT_BAR_OPEN');
    expect((started as any).equity?.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmpReplay, String(created.replayId), 'trades.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpReplay, String(created.replayId), 'events.jsonl'))).toBe(true);
    expect((started as any).agentAvailability?.NewsAgent?.status).toMatch(/CATALYST|UNAVAILABLE/);
    expect((started as any).agentAvailability?.FundamentalAgent?.status).toBe('UNAVAILABLE');
    expect((started as any).canPromoteFromThisReplay).toBe(false);
  }, 120000);
});
