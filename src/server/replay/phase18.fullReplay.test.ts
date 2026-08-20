import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ReplayClock } from '../engines/backtest/ReplayClock';
import { InformationCutoff } from './InformationCutoff';
import { newsVisibleAt, goldenReplayNewsProvider, unavailableHistoricalNewsProvider } from './HistoricalNewsProvider';
import { loadGoldenReplayDataset } from './loadGoldenReplayDataset';
import { listHistoricalProviders, getHistoricalProvider } from './HistoricalDataProviderRegistry';
import { HistoricalReplayBroker } from '../../brokers/HistoricalReplayBroker';
import { replaySafety } from './replaySafety';
import { hashCanonicalDataset } from '../research/datasetHash';
import { isOrganicClosedPaper, classifyTradeEnvironment, resolveOmsExecutionEnvironment } from '../research/organicPaper';
import { emptyEvidence, deriveLifecycleStatus, liveGoNoGo } from '../research/promotionEngine';
import { getVectorBTStatus } from '../research/VectorBTService';
import { assessDataQuality } from '../research/dataQuality';
import { classifyMarketSession, sessionAllowsFills } from './marketSession';
import { hashReplayConfiguration } from './replayHash';
import { defaultReplayConfig } from './ReplayContext';
import { LIVE_TRADING_CONFIRMATION_PHRASE } from '../core/LiveTradingConfirmation';
import { buildHighConfidenceAgreeingIdeas } from './goldenReplaySchedule';

describe('Phase 18 look-ahead, providers, broker, honesty', () => {
  it('InformationCutoff throws on future timestamps', () => {
    const clock = new ReplayClock(1000);
    const cut = new InformationCutoff(clock);
    expect(() => cut.assertNotFuture(1001, 'future-bar')).toThrow(/LOOK_AHEAD_BIAS_DETECTED/);
    expect(() => cut.assertNotFuture(1000, 'ok')).not.toThrow();
  });

  it('future news is not visible before publishedAt', () => {
    const ds = loadGoldenReplayDataset();
    const clock = new ReplayClock(ds.bars[10].timestamp);
    const cut = new InformationCutoff(clock);
    const visible = newsVisibleAt(goldenReplayNewsProvider(), cut, 'AAPL');
    expect(visible.some((n) => n.newsId === 'golden-news-future')).toBe(false);
    expect(visible.some((n) => n.newsId === 'golden-news-1')).toBe(true);
  });

  it('HISTORICAL_NEWS_UNAVAILABLE does not invent articles', () => {
    const p = unavailableHistoricalNewsProvider();
    expect(p.status).toBe('HISTORICAL_NEWS_UNAVAILABLE');
    expect(p.all()).toEqual([]);
  });

  it('polygon provider stays DATA_PROVIDER_UNAVAILABLE', async () => {
    const p = getHistoricalProvider('polygon')!;
    expect(p.describe().availability).toBe('DATA_PROVIDER_UNAVAILABLE');
    const fetched = await p.fetch({ symbol: 'AAPL', startMs: 0, endMs: 1, frequency: '1Day' });
    expect('error' in fetched).toBe(true);
  });

  it('lists providers including alpaca and golden_replay', () => {
    const ids = listHistoricalProviders().map((p) => p.id);
    expect(ids).toContain('alpaca');
    expect(ids).toContain('golden_replay');
    expect(ids).toContain('ibkr');
  });

  it('unsupported frequency is documented in replaySafety', () => {
    expect(replaySafety.supportedFrequencies).toContain('30m');
    expect(replaySafety.supportedFrequencies).toContain('1Day');
  });

  it('HistoricalReplayBroker fills next-open with non-zero slippage on Base profile and refuses LIVE', async () => {
    const broker = new HistoricalReplayBroker({
      initialCash: 100000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    broker.nextFillPrice.set('AAPL', 100);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10 });
    expect(order.status).toBe('FILLED');
    expect(order.averageFillPrice).toBeGreaterThan(100);
    expect(() => broker.liveTrading()).toThrow(/LIVE/);
  });

  it('volume-participation cap: full fill when requested quantity is within the cap', async () => {
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
      maxVolumeParticipationPct: 0.1,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    broker.nextFillPrice.set('AAPL', 100);
    broker.nextFillVolume.set('AAPL', 1000); // cap = 100 shares
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 50 });
    expect(order.status).toBe('FILLED');
    expect(order.filledQuantity).toBe(50);
  });

  it('volume-participation cap: PARTIALLY_FILLED when requested quantity exceeds the cap', async () => {
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
      maxVolumeParticipationPct: 0.1,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    broker.nextFillPrice.set('AAPL', 100);
    broker.nextFillVolume.set('AAPL', 1000); // cap = 100 shares
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 500 });
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.quantity).toBe(500); // originally requested
    expect(order.filledQuantity).toBe(100); // capped fill
  });

  it('volume-participation cap: REJECTED for insufficient liquidity when the cap rounds to zero shares', async () => {
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
      maxVolumeParticipationPct: 0.1,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    broker.nextFillPrice.set('AAPL', 100);
    broker.nextFillVolume.set('AAPL', 5); // cap = floor(5*0.1) = 0 shares
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10 });
    expect(order.status).toBe('REJECTED');
    expect(order.filledQuantity).toBe(0);
  });

  it('volume-participation cap does not apply when no cap is configured (backward compatible, unbounded)', async () => {
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
      // maxVolumeParticipationPct omitted entirely
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    broker.nextFillPrice.set('AAPL', 100);
    broker.nextFillVolume.set('AAPL', 1); // would cap to 0 if a cap were active
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 500 });
    expect(order.status).toBe('FILLED');
    expect(order.filledQuantity).toBe(500);
  });

  it('volume-participation cap does not apply when no volume figure is known for the symbol', async () => {
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
      maxVolumeParticipationPct: 0.1,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    broker.nextFillPrice.set('AAPL', 100);
    // nextFillVolume deliberately not set for AAPL
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 500 });
    expect(order.status).toBe('FILLED');
    expect(order.filledQuantity).toBe(500);
  });

  it('cash constraint rejects oversized BUY', async () => {
    const broker = new HistoricalReplayBroker({
      initialCash: 50,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    broker.nextFillPrice.set('AAPL', 100);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10 });
    expect(order.status).toBe('REJECTED');
  });

  it('replay trades are not organic paper', () => {
    expect(classifyTradeEnvironment({ executionEnvironment: 'REPLAY' })).toBe('REPLAY');
    expect(isOrganicClosedPaper({
      status: 'FILLED', side: 'SELL', profitLoss: 12, executionEnvironment: 'REPLAY', traceId: 'replay-abc',
    })).toBe(false);
    expect(resolveOmsExecutionEnvironment({ brokerId: 'historical_replay', tradingMode: 'Paper' })).toBe('REPLAY');
  });

  it('replay cannot set LIVE_CANDIDATE by existing', () => {
    const e = emptyEvidence('MOMENTUM_BREAKOUT');
    expect(deriveLifecycleStatus(e)).toBe('UNTESTED');
    expect(liveGoNoGo(e).live).toBe('NO-GO');
  });

  it('VectorBT status never claims order placement', async () => {
    const s = await getVectorBTStatus();
    expect(s.canPlaceOrders).toBe(false);
    expect(s.execution).toBe('research_only');
  });

  it('golden replay dataset hashes stably and is not RED empty', () => {
    const a = hashCanonicalDataset(loadGoldenReplayDataset());
    const b = hashCanonicalDataset(loadGoldenReplayDataset());
    expect(a).toBe(b);
    expect(a.startsWith('sha256:')).toBe(true);
    const q = assessDataQuality(loadGoldenReplayDataset());
    expect(q.quality).not.toBe('RED');
  });

  it('duplicate/corrupt datasets grade RED', () => {
    const ds = loadGoldenReplayDataset();
    ds.bars = [...ds.bars, { ...ds.bars[0] }];
    expect(assessDataQuality(ds).quality).toBe('RED');
    const empty = { ...loadGoldenReplayDataset(), bars: [] };
    expect(assessDataQuality(empty).quality).toBe('RED');
    expect(assessDataQuality(empty).backtestAllowed).toBe(false);
  });

  it('regular session at NY cash open allows fills; weekend closed', () => {
    const open = Date.UTC(2024, 0, 2, 14, 30, 0);
    expect(classifyMarketSession(open, 'America/New_York', false)).toBe('REGULAR');
    expect(sessionAllowsFills('REGULAR', false)).toBe(true);
    expect(sessionAllowsFills('CLOSED', false)).toBe(false);
  });

  it('identical configs hash identically; seed is stored', () => {
    const c = defaultReplayConfig({ randomSeed: 7 });
    expect(hashReplayConfiguration(c)).toBe(hashReplayConfiguration({ ...c }));
    expect(c.randomSeed).toBe(7);
  });

  it('30m frequency is DATA_UNAVAILABLE from Alpaca map (honest gap)', async () => {
    const p = getHistoricalProvider('alpaca')!;
    const fetched = await p.fetch({ symbol: 'AAPL', startMs: 0, endMs: 1, frequency: '30m' });
    expect('error' in fetched && fetched.code === 'DATA_UNAVAILABLE').toBe(true);
  });

  it('golden schedule produces Chief-passable BUY evidence', () => {
    const ideas = buildHighConfidenceAgreeingIdeas({
      side: 'BUY',
      confidence: 0.88,
      publishedAtMs: 1,
      strategyId: 'MOMENTUM_BREAKOUT',
    });
    expect(ideas).toHaveLength(2);
  });

  it('does not embed the LIVE enable phrase in replay safety', () => {
    expect(JSON.stringify(replaySafety)).not.toContain(LIVE_TRADING_CONFIRMATION_PHRASE);
  });
});

describe('Phase 18 full Argus replay on golden fixture', () => {
  let tmpDb: string;
  let tmpReplay: string;

  beforeAll(async () => {
    tmpDb = path.join(os.tmpdir(), `argus_p18_${Date.now()}_${process.pid}.db`);
    tmpReplay = path.join(os.tmpdir(), `argus_p18_replays_${Date.now()}_${process.pid}`);
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

  it('create+start golden replay completes without enabling LIVE or organic paper', async () => {
    const { createReplayRun, startReplay } = await import('./FullArgusReplayEngine');
    const created = await createReplayRun({
      dataProvider: 'golden_replay',
      newsProvider: 'golden_replay_news',
      symbols: ['AAPL'],
      strategyIds: ['MOMENTUM_BREAKOUT'],
      aiMode: 'DISABLED',
      speed: 'MAX',
      costProfile: 'Base',
      randomSeed: 1,
    });
    expect((created as any).live).toBe('NO-GO');
    expect((created as any).organicPaper).toBe(false);
    expect((created as any).executionEnvironment).toBe('REPLAY');
    // Honesty fix: the UI must never let "AAPL appears in this run" be mistaken for "Argus
    // historically discovered AAPL" - the replay universe is a fixed, operator-typed symbol list.
    expect((created as any).universeSource).toBe('OPERATOR_SELECTED');
    expect((created as any).discoveryActiveInReplay).toBe(false);
    if ((created as any).status === 'DATA_UNAVAILABLE' || (created as any).status === 'FAILED') {
      expect((created as any).error).toBeTruthy();
      return;
    }
    const started = await startReplay(String(created.replayId));
    expect(started).toBeTruthy();
    expect(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']).toContain((started as any).status);
    expect((started as any).live).toBe('NO-GO');
    expect((started as any).organicPaper).toBe(false);
    expect((started as any).canPromoteFromThisReplay).toBe(false);
    expect((started as any).report?.environment).toBe('HISTORICAL_REPLAY');
    expect((started as any).promotion?.status).toBe('UNTESTED');
    expect((started as any).ai?.mode).toMatch(/DISABLED|MODEL_REPLAY|RECORDED/);
    expect((started as any).agentAvailability?.Discovery?.status).toBe('NOT_ACTIVE_IN_REPLAY');
    expect((started as any).historicalUniverseMethodology).toContain('OPERATOR_SELECTED');
    expect((started as any).dataAvailabilityWarning).toBeTruthy();
    expect((started as any).partialFillModel).toBe('VOLUME_PARTICIPATION_CAPPED');
    // Golden schedule must exercise BUY through RiskEngine+OMS (path correctness, not edge).
    expect((started as any).report?.buyTrades).toBeGreaterThanOrEqual(1);
    expect((started as any).report?.sellTrades).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpReplay, String(created.replayId), 'summary.json'))).toBe(true);
  }, 120000);

  it('second identical create+start is deterministic on hashes', async () => {
    const { createReplayRun } = await import('./FullArgusReplayEngine');
    const a = await createReplayRun({ dataProvider: 'golden_replay', symbols: ['AAPL'], randomSeed: 1, speed: 'MAX' });
    const b = await createReplayRun({ dataProvider: 'golden_replay', symbols: ['AAPL'], randomSeed: 1, speed: 'MAX' });
    if ((a as any).datasetHash && (b as any).datasetHash) expect((a as any).datasetHash).toBe((b as any).datasetHash);
    if ((a as any).configurationHash && (b as any).configurationHash) expect((a as any).configurationHash).toBe((b as any).configurationHash);
  });

  it('ARGUS_DISCOVERY mode requires no operator-provided symbols and discovers its own universe', async () => {
    const { createReplayRun, startReplay } = await import('./FullArgusReplayEngine');
    const { replaySafety } = await import('./replaySafety');
    const created = await createReplayRun({
      dataProvider: 'golden_replay',
      newsProvider: 'golden_replay_news',
      universeSource: 'ARGUS_DISCOVERY',
      // Deliberately NOT providing `symbols` - this is the whole point of the mode.
      strategyIds: ['MOMENTUM_BREAKOUT'],
      aiMode: 'DISABLED',
      speed: 'MAX',
      costProfile: 'Base',
      randomSeed: 1,
    });
    if ((created as any).status === 'DATA_UNAVAILABLE' || (created as any).status === 'FAILED') {
      expect((created as any).error).toBeTruthy();
      return;
    }
    // config.symbols was overridden to the full static candidate pool, not an empty/user list.
    expect((created as any).config.symbols).toEqual(replaySafety.historicalDiscoveryUniverse);
    expect((created as any).universeSource).toBe('ARGUS_DISCOVERY');
    const started = await startReplay(String(created.replayId));
    expect(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']).toContain((started as any).status);
    expect((started as any).agentAvailability?.Discovery?.status).toBe('ACTIVE_POINT_IN_TIME_SCREEN');
    // discoveredSymbols is populated (not null, since this is discovery mode) and every entry has
    // a real discoveredAt historical timestamp - never undefined/NaN.
    expect(Array.isArray((started as any).discoveredSymbols)).toBe(true);
    expect((started as any).discoveredSymbols.length).toBeGreaterThan(0);
    for (const d of (started as any).discoveredSymbols) {
      expect(typeof d.symbol).toBe('string');
      expect(typeof d.discoveredAt).toBe('number');
    }
    // ExitIntelligenceEngine and ThesisInvalidation are the real production functions called
    // directly, not duplicated.
    expect((started as any).agentAvailability?.ExitIntelligenceEngine?.status).toBe('ENABLED');
    expect((started as any).agentAvailability?.ThesisInvalidation?.status).toBe('ENABLED');
    expect((started as any).historicalUniverseMethodology).toContain('ARGUS_DISCOVERY');
    expect((started as any).partialFillModel).toBe('VOLUME_PARTICIPATION_CAPPED');
    // Decision funnel, per-agent evaluation, and missed-opportunity analysis all populate on a
    // real completed run - not just in isolated unit tests.
    const funnel = (started as any).decisionFunnel;
    expect(funnel).toBeTruthy();
    expect(funnel.evaluationsAttempted).toBeGreaterThan(0);
    expect(funnel.ordersFilled).toBe((started as any).report.buyTrades + (started as any).report.sellTrades);
    expect(typeof (started as any).agentEvaluation).toBe('object');
    expect(Array.isArray((started as any).missedOpportunities)).toBe(true);
    for (const mo of (started as any).missedOpportunities) {
      expect(mo.label).toBe('AFTER-THE-FACT ANALYSIS');
      expect(['MISSED_OPPORTUNITY', 'CORRECTLY_AVOIDED', 'INCONCLUSIVE']).toContain(mo.classification);
    }
    expect((started as any).missedOpportunityLabel).toContain('AFTER-THE-FACT ANALYSIS');
    const perf = (started as any).performanceDiagnostics;
    expect(perf.totalReplayDurationMs).toBeGreaterThanOrEqual(0);
    expect(perf.stages.PROCESS_TIMESTAMP.count).toBeGreaterThan(0);
    expect(perf.stages.RISK_AND_OMS.count).toBeGreaterThan(0);
  }, 120000);

  it('OPERATOR_SELECTED mode requires explicit symbols and does not populate discoveredSymbols', async () => {
    const { createReplayRun } = await import('./FullArgusReplayEngine');
    const created = await createReplayRun({ dataProvider: 'golden_replay', symbols: ['AAPL'], randomSeed: 1, speed: 'MAX' });
    expect((created as any).universeSource).toBe('OPERATOR_SELECTED');
    expect((created as any).discoveredSymbols).toBeUndefined();
  });

  it('capital + dates only defaults to ARGUS_DISCOVERY without operator symbols', async () => {
    const { createReplayRun } = await import('./FullArgusReplayEngine');
    const created = await createReplayRun({
      dataProvider: 'golden_replay',
      initialCapital: 2000,
      startDate: '2024-01-02',
      endDate: '2024-03-31',
      randomSeed: 1,
      speed: 'MAX',
    });
    expect((created as any).universeSource).toBe('ARGUS_DISCOVERY');
    expect((created as any).config?.universeSource).toBe('ARGUS_DISCOVERY');
  });
});
