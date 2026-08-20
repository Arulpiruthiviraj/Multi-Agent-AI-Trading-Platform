/**
 * MODE B — full Argus historical replay.
 * Clock + HistoricalReplayBroker replace wall clock / live broker.
 * Quant evaluate → ChiefTrader vote math → RiskEngine → OMS. No VectorBT broker.
 * Does not emit TRADE_IDEA_GENERATED onto the live EventBus (would mix live agents).
 */
import crypto from 'node:crypto';
import { ReplayClock } from '../engines/backtest/ReplayClock';
import { InformationCutoff } from './InformationCutoff';
import { HistoricalReplayBroker } from '../../brokers/HistoricalReplayBroker';
import {
  defaultReplayConfig,
  getActiveReplaySession,
  isReplayActive,
  notifyReplayOrder,
  setActiveReplaySession,
  waitReplayOrder,
  type ActiveReplaySession,
  type ReplayConfig,
  type ReplayEvent,
  type ReplayRunStatus,
} from './ReplayContext';
import { replaySafety } from './replaySafety';
import { getHistoricalProvider } from './HistoricalDataProviderRegistry';
import { loadGoldenReplayDataset } from './loadGoldenReplayDataset';
import { buildHighConfidenceAgreeingIdeas, scheduleSignalAtBar } from './goldenReplaySchedule';
import { goldenReplayNewsProvider, newsVisibleAt, unavailableHistoricalNewsProvider } from './HistoricalNewsProvider';
import { assessDataQuality } from '../research/dataQuality';
import { hashCanonicalDataset } from '../research/datasetHash';
import { replayArgusStrategy } from '../research/argusStrategyReplay';
import { MIN_BARS } from '../quant/RegimeEngine';
import { evaluateReplayTechnical } from './replayTechnicalEvaluation';
import { cacheReplayQuote, clearReplayQuotes } from './HistoricalReplayMarketDataContext';
import { evidenceFromPitIdeas, replayChiefTraderFromEvidence } from '../engines/backtest/PitReplay';
import { riskEngine } from '../engines/RiskEngine';
import { tradingSafety } from '../config/tradingSafety';
import { tradingEngine } from '../engines/TradingEngine';
import { emptyEvidence, deriveLifecycleStatus, liveGoNoGo } from '../research/promotionEngine';
import { getVectorBTStatus } from '../research/VectorBTService';
import { freezeStrategyVersion } from '../research/strategySpecs';
import { hashReplayConfiguration, hashReplayIdentity } from './replayHash';
import { appendReplayEvent, writeReplayJson } from './replayStore';
import { buildReplayPerformance, buildDecisionFunnel, buildAgentEvaluation } from './replayReport';
import { analyzeMissedOpportunities } from './MissedOpportunityAnalysis';
import { classifyMarketSession } from './marketSession';
import { getHistoricalDiscoveryUniverse, screenHistoricalCandidates } from './HistoricalUniverseProvider';
import { evaluateExit } from '../services/ExitIntelligenceEngine';
import { evaluateThesisInvalidation, type StoredThesis } from '../quant/analysis/ThesisInvalidation';
import { classifyRegime } from '../quant/RegimeEngine';
import { computeVolumeFeatures } from '../quant/indicators/volume';
import type { CanonicalDataset, ResearchBar } from '../research/ohlcvTypes';
import type { Evidence } from '../services/EvidenceAggregator';
import { oms } from '../services/OrderManagement';
import { db } from '../db';
import { replayRuns, riskAssessments } from '../db/schema';
import { desc, eq } from 'drizzle-orm';

void oms; // ensure OMS constructor registers RISK_ASSESSMENT_COMPLETED → executeOrder

const runs = new Map<string, Record<string, unknown>>();

async function persistReplayRun(row: Record<string, unknown>) {
  const id = String(row.replayId || '');
  if (!id) return;
  const now = new Date().toISOString();
  try {
    const existing = db.select().from(replayRuns).where(eq(replayRuns.id, id)).limit(1).get();
    const payload = {
      id,
      status: String(row.status || 'READY'),
      configJson: JSON.stringify(row.config || {}),
      datasetHash: row.datasetHash ? String(row.datasetHash) : null,
      configurationHash: row.configurationHash ? String(row.configurationHash) : (row.hashes as any)?.configurationHash ?? null,
      replayHash: row.replayHash ? String(row.replayHash) : (row.hashes as any)?.replayHash ?? null,
      summaryJson: JSON.stringify({
        report: row.report,
        promotion: row.promotion,
        noTrade: (row.report as any)?.noTrade,
        live: 'NO-GO',
      }),
      executionEnvironment: 'REPLAY',
      updatedAt: now,
    };
    if (existing) {
      db.update(replayRuns).set(payload).where(eq(replayRuns.id, id)).run();
    } else {
      db.insert(replayRuns).values({ ...payload, createdAt: now }).run();
    }
  } catch (e) {
    console.error('[Replay] persistReplayRun failed', e);
  }
}

async function submitThroughRiskAndOms(session: ActiveReplaySession, opts: {
  symbol: string;
  side: 'BUY' | 'SELL';
  confidence: number;
  price: number;
  strategyId: string;
  stop: number | null;
  target: number | null;
  reasoning: string;
  exitReason?: string;
  thesisData?: { invalidationConditions: string[]; applicableRegimes: string[]; entryRegime: string | null } | null;
}) {
  const riskAndOmsStart = Date.now();
  try {
    return await submitThroughRiskAndOmsTimed(session, opts);
  } finally {
    recordStageDuration(session, 'RISK_AND_OMS', riskAndOmsStart);
  }
}

async function submitThroughRiskAndOmsTimed(session: ActiveReplaySession, opts: {
  symbol: string;
  side: 'BUY' | 'SELL';
  confidence: number;
  price: number;
  strategyId: string;
  stop: number | null;
  target: number | null;
  reasoning: string;
  exitReason?: string;
  thesisData?: { invalidationConditions: string[]; applicableRegimes: string[]; entryRegime: string | null } | null;
}) {
  const traceId = `${replaySafety.replayTracePrefix}${session.replayId}-${session.clock.now()}-${opts.symbol}-${opts.side}-${crypto.randomUUID().slice(0, 8)}`;
  const realizedBefore = session.broker.snapshotCosts().realizedPnl;
  const waitP = waitReplayOrder(traceId, 8000);
  await riskEngine.evaluateRisk({
    traceId,
    symbol: opts.symbol,
    side: opts.side,
    confidence: opts.confidence,
    reasoning: opts.reasoning,
    currentPrice: opts.price,
    selectedQuantStrategy: opts.strategyId,
    quantStopPrice: opts.stop,
    quantTargetPrice: opts.target,
  });
  // Only unblock early when OMS will not place — OMS notifies on placeOrder completion.
  try {
    const assessed = db.select().from(riskAssessments).where(eq(riskAssessments.traceId, traceId)).orderBy(desc(riskAssessments.createdAt)).limit(1).get();
    if (!assessed?.approved || !(Number(assessed.maxQuantity) > 0)) notifyReplayOrder(traceId);
  } catch {
    notifyReplayOrder(traceId);
  }
  await waitP;
  emit(session, 'RISK_GATE', { traceId, side: opts.side, exitReason: opts.exitReason }, opts.symbol);
  const realizedAfter = session.broker.snapshotCosts().realizedPnl;
  const costsSnap = session.broker.snapshotCosts();
  if (opts.side === 'SELL' && realizedAfter !== realizedBefore) {
    session.tradePnls.push(Number((realizedAfter - realizedBefore).toFixed(4)));
  }
  if (opts.side === 'BUY') {
    const pos = (await session.broker.positions()).find((p) => p.symbol === opts.symbol);
    if (pos && pos.quantity > 0) {
      // Real StoredThesis, built the same way RiskAgent.ts:53-60 builds one for live trades - from
      // the strategy's own invalidationConditions/applicableRegimes/entryRegime, not invented for
      // replay. Only present when the entry signal actually carried this data (the golden-schedule
      // fixture path does not, and correctly gets thesis: null - no fabricated thesis).
      const thesis: StoredThesis | null = opts.thesisData ? {
        texts: opts.thesisData.invalidationConditions,
        strategy: opts.strategyId,
        side: 'BUY',
        entryRegime: opts.thesisData.entryRegime,
        applicableRegimes: opts.thesisData.applicableRegimes,
        structuralLevel: null,
      } : null;
      session.openStops.set(opts.symbol, { stop: opts.stop, target: opts.target, entryTraceId: traceId, entryPrice: pos.entryPrice, peakPrice: pos.entryPrice, thesis });
      const lastBuy = (await session.broker.orders()).filter((o) => o.side === 'BUY' && o.status === 'FILLED' && o.symbol === opts.symbol).at(-1);
      session.tradeLedger.push({
        timestamp: session.clock.now(),
        symbol: opts.symbol,
        side: 'BUY',
        quantity: pos.quantity,
        price: lastBuy?.averageFillPrice ?? pos.entryPrice,
        strategyId: opts.strategyId,
        traceId,
        fees: 0,
        slippage: 0,
        realizedPnl: null,
        executionModel: 'NEXT_BAR_OPEN',
        executionEnvironment: 'HISTORICAL_REPLAY',
      });
      emit(session, 'ORDER_FILLED', { side: 'BUY', qty: pos.quantity, price: pos.entryPrice, executionModel: 'NEXT_BAR_OPEN' }, opts.symbol);
    } else {
      bumpNoTrade(session, 'RISK_REJECTED');
      session.rejectedOrders.push({
        timestamp: session.clock.now(),
        symbol: opts.symbol,
        side: 'BUY',
        reason: 'INSUFFICIENT_BUYING_POWER_OR_RISK',
        traceId,
      });
      emit(session, 'ORDER_REJECTED', { traceId, reason: 'INSUFFICIENT_BUYING_POWER_OR_RISK' }, opts.symbol);
    }
  } else {
    const stillOpen = (await session.broker.positions()).find((p) => p.symbol === opts.symbol && p.quantity > 0);
    if (!stillOpen) {
      const pnlDelta = Number((realizedAfter - realizedBefore).toFixed(4));
      const lastSell = (await session.broker.orders()).filter((o) => o.side === 'SELL' && o.status === 'FILLED' && o.symbol === opts.symbol).at(-1);
      session.tradeLedger.push({
        timestamp: session.clock.now(),
        symbol: opts.symbol,
        side: 'SELL',
        quantity: lastSell?.filledQuantity ?? lastSell?.quantity ?? 0,
        price: lastSell?.averageFillPrice ?? 0,
        strategyId: opts.strategyId,
        traceId,
        fees: 0,
        slippage: 0,
        realizedPnl: pnlDelta,
        executionModel: 'NEXT_BAR_OPEN',
        executionEnvironment: 'HISTORICAL_REPLAY',
      });
      session.openStops.delete(opts.symbol);
      emit(session, 'ORDER_FILLED', { side: 'SELL', exitReason: opts.exitReason || 'SELL', pnl: pnlDelta, executionModel: 'NEXT_BAR_OPEN' }, opts.symbol);
    } else {
      bumpNoTrade(session, 'RISK_REJECTED');
      session.rejectedOrders.push({
        timestamp: session.clock.now(),
        symbol: opts.symbol,
        side: 'SELL',
        reason: 'RISK_REJECTED',
        traceId,
      });
      emit(session, 'ORDER_REJECTED', { traceId, exitReason: opts.exitReason }, opts.symbol);
    }
  }
  void costsSnap;
  return traceId;
}

function bumpNoTrade(session: ActiveReplaySession, reason: string) {
  session.noTrade[reason] = (session.noTrade[reason] || 0) + 1;
}

/** Real replay-processing wall-clock time per stage - not simulated market latency. */
function recordStageDuration(session: ActiveReplaySession, stage: string, startedAtMs: number) {
  const elapsed = Date.now() - startedAtMs;
  const s = session.stageDurations[stage] || { totalMs: 0, count: 0 };
  s.totalMs += elapsed;
  s.count += 1;
  session.stageDurations[stage] = s;
}

/** Pure, unit-testable: strategy-level stop/target check against one bar's low/high. */
export function determineStopTargetExit(
  openMeta: { stop: number | null; target: number | null },
  bar: { low: number; high: number },
): 'STOP' | 'TARGET' | null {
  if (openMeta.stop != null && bar.low <= openMeta.stop) return 'STOP';
  if (openMeta.target != null && bar.high >= openMeta.target) return 'TARGET';
  return null;
}

/**
 * Pure, unit-testable: generic cost-basis take-profit/stop-loss backstop, mirroring
 * PortfolioMonitor.ts's own "generic" fallback branch (reached live only when a lot has no quant
 * stop/target) - same tradingSafety.json fallback percentages, not replay-only numbers.
 */
export function determineGenericExit(entryPrice: number, closePrice: number): 'TAKE_PROFIT' | 'HARD_STOP' | null {
  const pnlPct = ((closePrice - entryPrice) / entryPrice) * 100;
  if (pnlPct > tradingSafety.fallbackTakeProfitPct) return 'TAKE_PROFIT';
  if (pnlPct < -tradingSafety.fallbackTrailingStopPct) return 'HARD_STOP';
  return null;
}

/**
 * Pure, unit-testable: builds a real LiveMarketRead from point-in-time bars (the exact recipe
 * PortfolioMonitor.ts:295-314 uses live: classifyRegime + computeVolumeFeatures) and calls the
 * real production evaluateThesisInvalidation() - not reimplemented. `visible` must already be
 * point-in-time filtered (timestamp < t) by the caller.
 */
export function checkThesisInvalidation(
  thesis: StoredThesis | null,
  visible: ResearchBar[],
): { invalidated: boolean; reasons: string[] } {
  if (!thesis) return { invalidated: false, reasons: [] };
  const regime = classifyRegime(visible);
  const volume = computeVolumeFeatures(visible);
  const trend = regime.features.trend;
  const last = visible[visible.length - 1];
  const result = evaluateThesisInvalidation(thesis, {
    regime: regime.insufficientData ? null : regime.regime,
    rvol: volume.relativeVolume,
    adx: trend.dmi?.adx ?? null,
    structureEvent: trend.structure.event,
    structureTrend: trend.structure.trend,
    lastClose: last?.close ?? null,
    bars: visible,
  });
  return { invalidated: result.invalidated, reasons: result.reasons };
}

function emit(session: ActiveReplaySession, type: string, payload: Record<string, unknown>, symbol?: string) {
  if (session.events.length >= replaySafety.jsonlEventCap) return;
  const event: ReplayEvent = {
    replayId: session.replayId,
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    historicalTimestamp: session.clock.now(),
    type,
    symbol,
    payload,
    source: 'FullArgusReplayEngine',
    engine: replaySafety.replayEngineVersion,
    dataHash: session.datasetHash,
  };
  session.events.push(event);
  appendReplayEvent(session.replayId, event);
}

function aiLabel(mode: ReplayConfig['aiMode']): string {
  if (mode === 'DISABLED') return 'DISABLED';
  if (mode === 'RECORDED_DECISION_REPLAY') return 'RECORDED_DECISION_REPLAY';
  return 'MODEL_REPLAY NOT_HISTORICAL_AI_STATE';
}

async function loadDatasets(config: ReplayConfig): Promise<CanonicalDataset[] | { error: string; code: string }> {
  const provider = getHistoricalProvider(config.dataProvider);
  if (!provider) return { error: `DATA_PROVIDER_UNAVAILABLE: ${config.dataProvider}`, code: 'DATA_PROVIDER_UNAVAILABLE' };
  const desc = provider.describe();
  if (desc.availability === 'DATA_PROVIDER_UNAVAILABLE') {
    return { error: desc.note, code: 'DATA_PROVIDER_UNAVAILABLE' };
  }
  const freqOk = replaySafety.supportedFrequencies.map((f) => f.toLowerCase()).includes(config.frequency.toLowerCase())
    || config.frequency === '1Day';
  if (!freqOk) {
    return { error: `DATA_UNAVAILABLE: frequency ${config.frequency} is not in replaySafety.supportedFrequencies`, code: 'DATA_UNAVAILABLE' };
  }
  if (config.dataProvider === 'golden_replay') {
    return config.symbols.map((symbol) => {
      const ds = loadGoldenReplayDataset();
      ds.symbol = symbol;
      return ds;
    });
  }
  const startMs = Date.parse(`${config.startDate}T${config.startTime || '09:30:00'}`);
  const endMs = Date.parse(`${config.endDate}T${config.endTime || '16:00:00'}`);
  // Real historical-data providers hit a real network API per symbol. ARGUS_DISCOVERY loads the
  // full curated candidate pool (config/replaySafety.json historicalDiscoveryUniverse, up to ~31
  // symbols - screening down to the active few happens later, inside the tick loop, not here), so
  // fetching one-at-a-time reliably exceeded server.ts's 15s request-timeout watchdog and 504'd the
  // create call. Bounded concurrency (not unbounded Promise.all, to stay gentle on the real
  // provider's own rate limit) cuts wall-clock roughly to (symbolCount / concurrency) round-trips.
  const concurrency = Math.max(1, Math.min(6, config.symbols.length));
  const results: Array<CanonicalDataset | { error: string; code: string }> = new Array(config.symbols.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const idx = nextIndex++;
      if (idx >= config.symbols.length) return;
      results[idx] = await provider.fetch({ symbol: config.symbols[idx], startMs, endMs, frequency: config.frequency });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const firstError = results.find((r): r is { error: string; code: string } => 'error' in r);
  if (firstError) return firstError;
  return results as CanonicalDataset[];
}

function mergeTimestamps(datasets: CanonicalDataset[]): number[] {
  const set = new Set<number>();
  for (const ds of datasets) for (const b of ds.bars) set.add(b.timestamp);
  return [...set].sort((a, b) => a - b);
}

export function getReplayRun(id: string) {
  return runs.get(id) || null;
}

export function listReplayRuns() {
  return [...runs.values()];
}

/** Snapshot while session may still be attached (running) or from completed row. */
export function getReplayTrades(id: string) {
  const row = runs.get(id) as any;
  if (!row) return null;
  if (row.trades) return row.trades;
  if (row.session?.tradeLedger) return row.session.tradeLedger;
  const { readReplayJson } = require('./replayStore') as typeof import('./replayStore');
  return readReplayJson(id, 'trades.json') || [];
}

export async function getReplayPortfolio(id: string) {
  const row = runs.get(id) as any;
  if (!row) return null;
  if (row.portfolio) return row.portfolio;
  if (row.session) return row.session.broker.portfolio();
  const { readReplayJson } = await import('./replayStore');
  return readReplayJson(id, 'portfolio_final.json');
}

export function getReplayEquity(id: string) {
  const row = runs.get(id) as any;
  if (!row) return null;
  if (row.equity) return row.equity;
  if (row.session?.equity) return row.session.equity;
  const { readReplayJson } = require('./replayStore') as typeof import('./replayStore');
  return readReplayJson(id, 'equity_curve.json') || [];
}

export async function createReplayRun(body: Partial<ReplayConfig> & { python?: unknown; code?: unknown; placeOrder?: unknown } = {}) {
  if (body && (body.python || body.code || body.placeOrder)) {
    throw new Error('Arbitrary code/broker payloads are not allowed');
  }
  const config = defaultReplayConfig(body);
  // ARGUS_DISCOVERY mode: the operator provides capital + dates only, never a symbol list.
  // config.symbols is overridden with the static candidate universe (config/replaySafety.json
  // historicalDiscoveryUniverse) whose bars all get loaded; processTimestamp then screens this
  // pool down to whichever symbols are "active" at each historical moment (see
  // HistoricalUniverseProvider.screenHistoricalCandidates), rather than trading the whole list.
  if (config.universeSource === 'ARGUS_DISCOVERY') {
    config.symbols = getHistoricalDiscoveryUniverse();
  }
  if (tradingEngine.state.tradingMode === 'LIVE') {
    throw new Error('Replay refused while tradingMode is LIVE');
  }
  if (isReplayActive()) {
    throw new Error('A replay session is already active');
  }
  const datasets = await loadDatasets(config);
  if (!Array.isArray(datasets)) {
    const replayId = crypto.randomUUID();
    const row = {
      replayId,
      status: 'DATA_UNAVAILABLE' as ReplayRunStatus,
      error: datasets.error,
      code: datasets.code,
      live: 'NO-GO',
      executionEnvironment: 'REPLAY',
      organicPaper: false,
    };
    runs.set(replayId, row);
    return row;
  }
  const combinedIssues = datasets.flatMap((ds) => assessDataQuality(ds).issues);
  const quality = assessDataQuality(datasets[0]);
  if (datasets.length > 1) {
    for (const ds of datasets.slice(1)) {
      const q = assessDataQuality(ds);
      if (q.quality === 'RED') Object.assign(quality, q);
    }
  }
  quality.issues = [...new Set([...quality.issues, ...combinedIssues])];
  if (quality.quality === 'RED') {
    const replayId = crypto.randomUUID();
    const row = {
      replayId,
      status: 'FAILED' as ReplayRunStatus,
      error: 'RED dataset cannot execute',
      quality,
      live: 'NO-GO',
      executionEnvironment: 'REPLAY',
    };
    runs.set(replayId, row);
    return row;
  }
  const datasetHash = datasets.map((d) => hashCanonicalDataset(d)).join('|');
  const configurationHash = hashReplayConfiguration(config);
  const strategyVersions = config.strategyIds.map((id) => freezeStrategyVersion(id)?.strategyVersion ?? id);
  const replayHash = hashReplayIdentity({
    datasetHash,
    configurationHash,
    strategyVersions,
    argusVersion: replaySafety.replayEngineVersion,
  });
  const replayId = crypto.randomUUID();
  const costs = replaySafety.costProfiles[config.costProfile] || replaySafety.costProfiles[replaySafety.defaultCostProfile];
  const startMs = datasets[0].bars[0]?.timestamp ?? Date.parse(config.startDate);
  const clock = new ReplayClock(startMs);
  const broker = new HistoricalReplayBroker({
    initialCash: config.initialCapital,
    costs,
    timezone: config.timezone,
    extendedHours: config.extendedHours,
    shortSelling: config.shortSelling,
    fractional: config.fractionalShares,
    maxVolumeParticipationPct: replaySafety.maxVolumeParticipationPct,
  });
  const barsBySymbol = new Map<string, ResearchBar[]>();
  for (const ds of datasets) barsBySymbol.set(ds.symbol.toUpperCase(), [...ds.bars].sort((a, b) => a.timestamp - b.timestamp));
  const news = config.newsProvider === 'golden_replay_news' ? goldenReplayNewsProvider() : unavailableHistoricalNewsProvider();
  const session: ActiveReplaySession = {
    replayId,
    status: 'READY',
    config,
    clock,
    cutoff: new InformationCutoff(clock),
    broker,
    datasets,
    quality,
    datasetHash,
    configurationHash,
    replayHash,
    news,
    events: [],
    noTrade: {},
    equity: [],
    peakEquity: config.initialCapital,
    pauseRequested: false,
    stopRequested: false,
    stepRequested: false,
    aiCalls: 0,
    aiCostUsd: 0,
    aiLabel: aiLabel(config.aiMode),
    partial: quality.quality === 'YELLOW',
    waiters: new Map(),
    barsBySymbol,
    openStops: new Map(),
    activeDiscoveredSymbols: new Set(),
    discoveredAt: new Map(),
    discoveryTickCounter: 0,
    evaluationsAttempted: 0,
    strategyPassesAttempted: 0,
    totalBars: 0,
    currentBarIndex: 0,
    currentTimestamp: null,
    rejectionsForRetrospective: [],
    agentIdeaStats: {},
    stageDurations: {},
    replayStartedAtMs: Date.now(),
    tradePnls: [],
    tradeLedger: [],
    rejectedOrders: [],
    agentAvailability: {
      QuantEngine: { status: 'ENABLED', reason: 'PIT bars + strategy evaluate / golden schedule' },
      TechnicalAgent: {
        status: 'PARTIAL',
        reason: 'RSI/MACD/SMA/Bollinger on PIT bars via production engines; not full live tick-driven TechnicalAgent loop or EventBus',
      },
      NewsAgent: {
        status: config.newsProvider === 'golden_replay_news' ? 'CATALYST_ONLY' : 'UNAVAILABLE',
        reason: config.newsProvider === 'golden_replay_news'
          ? 'Fixture news PIT-filtered; not a live NewsAgent voter'
          : 'Historical news unavailable. NewsAgent excluded from this replay.',
      },
      FundamentalAgent: { status: 'UNAVAILABLE', reason: 'Point-in-time fundamentals not loaded' },
      MacroAgent: { status: 'UNAVAILABLE', reason: 'Point-in-time macro releases not loaded' },
      ChiefTrader: { status: 'ENABLED', reason: 'replayChiefTraderFromEvidence vote math (no live EventBus)' },
      RiskAgent: { status: 'ENABLED', reason: 'RiskEngine.evaluateRisk on replay path' },
      ExitIntelligenceEngine: {
        status: 'ENABLED',
        reason: 'Real production evaluateExit() from src/server/services/ExitIntelligenceEngine.ts called directly with point-in-time bars (not reimplemented). Only TAKE_PROFIT/EXIT/EMERGENCY_EXIT can trigger a replay order - PARTIAL_TAKE_PROFIT/TRAIL stay telemetry-only, matching the same limitation live PortfolioMonitor has (no live partial-sell path exists either).',
      },
      ThesisInvalidation: {
        status: 'ENABLED',
        reason: 'Real production evaluateThesisInvalidation() from src/server/quant/analysis/ThesisInvalidation.ts, fed a real StoredThesis built at BUY time from the strategy\'s own invalidationConditions/applicableRegimes (same fields RiskAgent.ts uses live) and a LiveMarketRead built via classifyRegime()+computeVolumeFeatures() on point-in-time bars, matching PortfolioMonitor.ts\'s exact live recipe. Only active for entries whose strategy evaluation actually produced thesis data - golden-schedule fixture entries have no thesis and are correctly excluded, not faked.',
      },
      Discovery: config.universeSource === 'ARGUS_DISCOVERY'
        ? {
            status: 'ACTIVE_POINT_IN_TIME_SCREEN',
            reason: `Universe is ARGUS_DISCOVERY - candidates come from a static curated pool (config/replaySafety.json historicalDiscoveryUniverse, ${replaySafety.historicalDiscoveryFidelityWarning}), screened by trailing point-in-time dollar volume (bars strictly < each historical timestamp) down to at most ${replaySafety.historicalDiscoveryMaxActiveCandidates} active names, rescanned every ${replaySafety.historicalDiscoveryRescanEveryBars} bars. This is NOT OpportunityDiscovery/OpportunityScreener/MarketUniverseScanner running inside the replay clock (those still do not execute here) - it is a separate, replay-specific point-in-time screen over a fixed candidate pool, not a reconstructed historical market listing.`,
          }
        : {
            status: 'NOT_ACTIVE_IN_REPLAY',
            reason: `Universe is ${config.universeSource} (config.symbols, fixed at replay creation). OpportunityDiscovery/OpportunityScreener/MarketUniverseScanner do not run inside the replay clock - the symbols below are what you typed or configured, not what Argus would have discovered on these historical dates.`,
          },
      AI: {
        status: aiLabel(config.aiMode),
        reason: config.aiMode === 'DISABLED'
          ? 'AI_DISABLED — no fabricated LLM votes'
          : 'Historical LLM consensus weights UNAVAILABLE; mode is labeled honestly',
      },
    },
  };
  const row = {
    replayId,
    status: session.status,
    config,
    quality,
    datasetHash,
    configurationHash,
    replayHash,
    live: 'NO-GO',
    executionEnvironment: 'REPLAY',
    organicPaper: false,
    labels: ['HISTORICAL_SIMULATION', 'HISTORICAL REPLAY', 'SIMULATION ONLY', 'NOT LIVE', 'NOT PAPER', 'NOT ORGANIC_PAPER', 'NOT ACTUAL TRADING', session.aiLabel],
    universeSource: config.universeSource,
    discoveryActiveInReplay: false,
    survivorshipBiasWarning: config.universeSource === 'OPERATOR_SELECTED' ? replaySafety.survivorshipBiasWarning : null,
    delistedWarning: replaySafety.delistedWarning,
    lookAheadProtection: 'INFORMATION_AVAILABLE_AT_TIME_T',
    vectorbtMode: 'MODE_A_SEPARATE',
    canPlaceOrdersViaVectorBT: false,
  };
  runs.set(replayId, { ...row, session });
  await persistReplayRun(row);
  writeReplayJson(replayId, 'configuration.json', config);
  writeReplayJson(replayId, 'dataset.json', {
    datasetHash,
    symbols: datasets.map((d) => d.symbol),
    provenance: datasets.map((d) => d.provenance),
    quality,
  });
  return row;
}

export function pauseReplay(id: string) {
  const session = getActiveReplaySession();
  if (!session || session.replayId !== id) return { ok: false, error: 'NO_ACTIVE_REPLAY' };
  session.pauseRequested = true;
  session.status = 'PAUSED';
  return { ok: true, status: session.status };
}

export function resumeReplay(id: string) {
  const session = getActiveReplaySession();
  if (!session || session.replayId !== id) return { ok: false, error: 'NO_ACTIVE_REPLAY' };
  session.pauseRequested = false;
  session.status = 'RUNNING';
  return { ok: true, status: session.status };
}

export function stopReplay(id: string) {
  const session = getActiveReplaySession();
  if (!session || session.replayId !== id) return { ok: false, error: 'NO_ACTIVE_REPLAY' };
  session.stopRequested = true;
  return { ok: true, status: 'STOP_REQUESTED' };
}

async function processTimestamp(session: ActiveReplaySession, t: number, nextOpenBySymbol: Map<string, number>) {
  session.clock.advance(t);
  session.broker.clockNowMs = t;
  const sessionName = classifyMarketSession(t, session.config.timezone, session.config.extendedHours);
  emit(session, 'MARKET_SESSION', { session: sessionName }, undefined);
  const prices: Record<string, number> = {};
  const useGoldenSchedule = session.config.dataProvider === 'golden_replay';

  // ARGUS_DISCOVERY mode: which symbols get evaluated this timestamp is decided by a point-in-time
  // liquidity screen over the static candidate universe (session.config.symbols was overridden to
  // that universe at creation), not by a fixed operator-typed list. Rescanned every
  // historicalDiscoveryRescanEveryBars ticks to bound cost, not every single bar. A symbol that
  // already has an open position is always kept in the evaluation set regardless of the current
  // screen result - a held position must never stop being monitored for exit just because it fell
  // out of the top-N candidates.
  let evaluationSymbols: string[];
  if (session.config.universeSource === 'ARGUS_DISCOVERY') {
    session.discoveryTickCounter += 1;
    const rescanDue = session.discoveryTickCounter === 1
      || session.discoveryTickCounter % replaySafety.historicalDiscoveryRescanEveryBars === 0;
    if (rescanDue) {
      const discoveryStart = Date.now();
      const screened = screenHistoricalCandidates(session.config.symbols, session.barsBySymbol, t, {
        lookbackBars: replaySafety.historicalDiscoveryLookbackBars,
        minDollarVolume: replaySafety.historicalDiscoveryMinDollarVolume,
        maxActive: replaySafety.historicalDiscoveryMaxActiveCandidates,
      });
      recordStageDuration(session, 'DISCOVERY', discoveryStart);
      const nextActive = new Set(screened.map((s) => s.symbol));
      for (const symbol of nextActive) {
        if (!session.activeDiscoveredSymbols.has(symbol)) {
          session.discoveredAt.set(symbol, t);
          const match = screened.find((s) => s.symbol === symbol);
          emit(session, 'DISCOVERY', { symbol, avgDollarVolume: match?.avgDollarVolume ?? null, discoveredAt: t }, symbol);
        }
      }
      session.activeDiscoveredSymbols = nextActive;
    }
    evaluationSymbols = [...new Set([...session.activeDiscoveredSymbols, ...session.openStops.keys()])];
  } else {
    evaluationSymbols = session.config.symbols;
  }

  for (const symbol of evaluationSymbols) {
    session.evaluationsAttempted += 1;
    const bars = session.barsBySymbol.get(symbol.toUpperCase()) || [];
    const visible = bars.filter((b) => b.timestamp < t);
    const last = visible[visible.length - 1];
    if (!last) {
      bumpNoTrade(session, 'DATA_UNAVAILABLE');
      emit(session, 'NO_TRADE', { reason: 'DATA_UNAVAILABLE' }, symbol);
      continue;
    }
    session.cutoff.assertNotFuture(last.timestamp, `bar ${symbol}`);
    prices[symbol] = last.close;
    cacheReplayQuote(symbol, last.close, t);
    const next = bars.find((b) => b.timestamp === t);
    if (next) {
      session.broker.nextFillPrice.set(symbol, next.open);
      session.broker.nextFillVolume.set(symbol, next.volume);
    } else if (nextOpenBySymbol.has(symbol)) {
      session.broker.nextFillPrice.set(symbol, nextOpenBySymbol.get(symbol)!);
      session.broker.nextFillVolume.delete(symbol); // volume unknown for this fallback path - cap does not apply, matches unbounded-by-default design
    }
    emit(session, 'MARKET_DATA', { close: last.close, visibleBars: visible.length }, symbol);

    const news = newsVisibleAt(session.news, session.cutoff, symbol);
    emit(session, 'NEWS', {
      count: news.length,
      status: session.news.status,
      mode: 'CATALYST_ONLY',
      headlines: news.map((n) => n.headline),
    }, symbol);

    // Stop / target exits before new entries (PortfolioMonitor-equivalent for replay).
    const openMeta = session.openStops.get(symbol);
    if (openMeta) {
      openMeta.peakPrice = Math.max(openMeta.peakPrice, last.high);
      let exitReason: string | null = determineStopTargetExit(openMeta, last);
      // Generic cost-basis take-profit/stop-loss backstop - mirrors PortfolioMonitor.ts's live
      // "generic" branch (its own fallback for a lot with no quant stop/target), reusing the same
      // tradingSafety.json fallback percentages rather than inventing replay-only numbers. Real
      // peak-trailing is deliberately NOT added here: live PortfolioMonitor's own "TRAILING_STOP"
      // label is itself a cost-basis stop, not an actual high-water trail, so adding a real trail
      // only in replay would make replay behave differently from what Argus actually does live -
      // exactly the divergence this fix is meant to close, not introduce.
      if (!exitReason) {
        exitReason = determineGenericExit(openMeta.entryPrice, last.close);
      }
      // ExitIntelligenceEngine.evaluateExit() is the REAL production function (src/server/
      // services/ExitIntelligenceEngine.ts) - pure, takes bars/entry/peak/qty, no live singletons
      // - called directly here rather than reimplemented. `visible` is already point-in-time
      // filtered (timestamp < t), matching ReplayContext.replayVisibleBars' own cutoff discipline.
      // Only TAKE_PROFIT/EXIT/EMERGENCY_EXIT trigger an order here, matching PortfolioMonitor.ts's
      // own live limitation that PARTIAL_TAKE_PROFIT/TRAIL remain telemetry-only (no live partial-
      // sell path exists either) - this is intentional parity, not a replay shortcut.
      let exitIntelEvidence: string[] | null = null;
      if (!exitReason) {
        const opinion = evaluateExit({
          symbol,
          entryPrice: openMeta.entryPrice,
          currentPrice: last.close,
          peakPriceSinceEntry: openMeta.peakPrice,
          quantity: 1,
          bars: visible,
        });
        emit(session, 'EXIT_INTELLIGENCE', { decision: opinion.decision, exitScore: opinion.exitScore, evidence: opinion.evidence }, symbol);
        if (opinion.decision === 'TAKE_PROFIT' || opinion.decision === 'EXIT' || opinion.decision === 'EMERGENCY_EXIT') {
          exitReason = opinion.decision;
          exitIntelEvidence = opinion.evidence;
        }
      }
      // Thesis invalidation - the REAL production evaluateThesisInvalidation() (src/server/quant/
      // analysis/ThesisInvalidation.ts), fed a real StoredThesis built at BUY time (see
      // submitThroughRiskAndOms) and a real LiveMarketRead built the exact same way
      // PortfolioMonitor.ts:295-314 builds one live - classifyRegime(bars) + computeVolumeFeatures
      // (bars), not reimplemented. Only present when the entry signal actually carried thesis data
      // (golden-schedule fixture ideas correctly have thesis: null - no fabricated thesis).
      let thesisInvalidationReason: string | null = null;
      if (!exitReason && openMeta.thesis) {
        const result = checkThesisInvalidation(openMeta.thesis, visible);
        emit(session, 'THESIS_INVALIDATION', { invalidated: result.invalidated, reasons: result.reasons }, symbol);
        if (result.invalidated) {
          exitReason = 'THESIS_INVALIDATION';
          thesisInvalidationReason = result.reasons.join(' ');
        }
      }
      if (exitReason) {
        const eventType = exitReason === 'STOP' ? 'STOP_TRIGGERED'
          : exitReason === 'TARGET' ? 'TARGET_TRIGGERED'
          : exitReason === 'THESIS_INVALIDATION' ? 'THESIS_INVALIDATION_TRIGGERED'
          : exitIntelEvidence ? 'EXIT_INTELLIGENCE_TRIGGERED'
          : 'GENERIC_EXIT_TRIGGERED';
        emit(session, eventType, { price: last.close, stop: openMeta.stop, target: openMeta.target, exitReason, evidence: exitIntelEvidence, thesisInvalidationReason }, symbol);
        await submitThroughRiskAndOms(session, {
          symbol,
          side: 'SELL',
          confidence: 0.9,
          price: last.close,
          strategyId: session.config.strategyIds[0] || 'MOMENTUM_BREAKOUT',
          stop: null,
          target: null,
          reasoning: `HISTORICAL_REPLAY executionEnvironment=REPLAY exitReason=${exitReason} replayId=${session.replayId}`,
          exitReason,
        });
        continue;
      }
    }

    if (visible.length < MIN_BARS && !useGoldenSchedule) {
      bumpNoTrade(session, 'INSUFFICIENT_SAMPLE');
      emit(session, 'NO_TRADE', { reason: 'INSUFFICIENT_SAMPLE' }, symbol);
      continue;
    }

    const technical = evaluateReplayTechnical(visible);
    emit(session, 'AGENT_ASSESSMENT', {
      agent: 'TechnicalAgent',
      ...(technical ?? { status: 'INSUFFICIENT_SAMPLE', data: 'PIT_BARS_ONLY' }),
    }, symbol);

    if (session.config.aiMode === 'LIVE_MODEL_REPLAY') {
      emit(session, 'AI', { mode: session.aiLabel, executed: false, reason: 'LLM not invoked in default replay (cost + not historical weights)' }, symbol);
    } else if (session.config.aiMode === 'RECORDED_DECISION_REPLAY') {
      emit(session, 'AI', { mode: 'RECORDED_DECISION_REPLAY', ledger: 'empty_or_unused' }, symbol);
    } else {
      emit(session, 'AI', { mode: 'DISABLED' }, symbol);
    }

    for (const strategyId of session.config.strategyIds) {
      session.strategyPassesAttempted += 1;
      let side: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
      let confidence = 0;
      let stop: number | null = null;
      let target: number | null = null;
      let ideas: Array<{ kind: string; agent: string; side: string; confidence: number; publishedAtMs: number; payloadJson?: string }> = [];
      let thesisData: { invalidationConditions: string[]; applicableRegimes: string[]; entryRegime: string | null } | null = null;

      if (useGoldenSchedule) {
        const sched = scheduleSignalAtBar(bars, last.timestamp);
        if (!sched || sched.side === 'HOLD') {
          bumpNoTrade(session, 'NO_VALID_STRATEGY');
          emit(session, 'NO_TRADE', { reason: 'NO_VALID_STRATEGY', note: 'golden schedule HOLD' }, symbol);
          continue;
        }
        side = sched.side;
        confidence = sched.confidence;
        stop = side === 'BUY' ? Number((last.close * (1 - sched.stopPct)).toFixed(4)) : null;
        target = side === 'BUY' ? Number((last.close * (1 + sched.targetPct)).toFixed(4)) : null;
        ideas = buildHighConfidenceAgreeingIdeas({ side, confidence, publishedAtMs: t, strategyId });
        emit(session, 'AGENT_ASSESSMENT', {
          agent: 'QuantEngine',
          strategyId,
          side,
          confidence,
          schedule: true,
          note: 'UNIT_FIXTURE schedule — not REAL_MARKET_DATA edge',
        }, symbol);
      } else {
        const replayed = replayArgusStrategy({
          strategyId,
          bars: visible.map((b) => ({ ...b })),
          provenance: session.datasets[0].provenance ?? 'UNIT_FIXTURE',
        });
        const lastSignal = replayed.signals[replayed.signals.length - 1];
        side = lastSignal && lastSignal.timestamp === last.timestamp ? lastSignal.side : 'HOLD';
        confidence = lastSignal?.confidence ?? 0;
        stop = lastSignal?.stop ?? null;
        target = lastSignal?.target ?? null;
        thesisData = lastSignal ? {
          invalidationConditions: lastSignal.invalidationConditions,
          applicableRegimes: lastSignal.applicableRegimes,
          entryRegime: lastSignal.entryRegime,
        } : null;
        emit(session, 'AGENT_ASSESSMENT', {
          agent: 'QuantEngine',
          strategyId,
          side,
          confidence,
          rejection: replayed.rejection,
          canPlaceOrders: false,
        }, symbol);
        if (side === 'HOLD' || !lastSignal) {
          bumpNoTrade(session, 'NO_VALID_STRATEGY');
          emit(session, 'NO_TRADE', { reason: 'NO_VALID_STRATEGY' }, symbol);
          continue;
        }
        ideas = [
          { kind: 'AGENT_REASONING', agent: 'QuantEngine', side, confidence, publishedAtMs: t, payloadJson: strategyId },
          ...(technical && technical.side !== 'HOLD'
            ? [{ kind: 'AGENT_REASONING', agent: 'TechnicalAgent', side: technical.side, confidence: technical.confidence, publishedAtMs: t, payloadJson: `rsi=${technical.rsi}` }]
            : technical
              ? [{ kind: 'AGENT_REASONING', agent: 'TechnicalAgent', side, confidence: technical.rsi > 50 ? 0.55 : 0.45, publishedAtMs: t, payloadJson: `rsi=${technical.rsi}` }]
              : []),
        ];
      }

      // Per-agent idea tally (§11) - built from the same `ideas` array that feeds consensus,
      // not a separate/parallel count. Real per-run statistics, not fabricated.
      for (const idea of ideas) {
        const stat = session.agentIdeaStats[idea.agent] || { ideas: 0, buyIdeas: 0, sellIdeas: 0, confidenceSum: 0 };
        stat.ideas += 1;
        if (idea.side === 'BUY') stat.buyIdeas += 1;
        else if (idea.side === 'SELL') stat.sellIdeas += 1;
        stat.confidenceSum += idea.confidence;
        session.agentIdeaStats[idea.agent] = stat;
      }

      const evidence: Evidence[] = evidenceFromPitIdeas(ideas, symbol, last.close);
      const chief = replayChiefTraderFromEvidence(evidence, false);
      emit(session, 'CHIEF_DECISION', { ...chief, debateUsed: false, aiLabel: session.aiLabel }, symbol);
      if (!chief.approved) {
        bumpNoTrade(session, 'NO_CHIEF_APPROVAL');
        emit(session, 'NO_TRADE', { reason: 'NO_CHIEF_APPROVAL', detail: chief.reason }, symbol);
        // Post-run-only retrospective candidate (§12) - recorded here, never read until after the
        // replay reaches a terminal status. Consensus rejections only (not risk rejections) - a
        // deliberately narrower scope than the full spec, stated honestly rather than implied.
        session.rejectionsForRetrospective.push({ symbol, timestamp: t, reason: chief.reason || 'NO_CHIEF_APPROVAL', referencePrice: last.close });
        continue;
      }

      if (side === 'BUY' && session.openStops.has(symbol)) {
        bumpNoTrade(session, 'DUPLICATE_SIGNAL');
        emit(session, 'NO_TRADE', { reason: 'DUPLICATE_SIGNAL' }, symbol);
        continue;
      }
      if (side === 'SELL' && !session.openStops.has(symbol)) {
        bumpNoTrade(session, 'NO_POSITION');
        emit(session, 'NO_TRADE', { reason: 'NO_POSITION' }, symbol);
        continue;
      }

      await submitThroughRiskAndOms(session, {
        symbol,
        side,
        confidence: chief.confidence,
        price: last.close,
        strategyId,
        stop,
        target,
        reasoning: `HISTORICAL_REPLAY executionEnvironment=REPLAY replayId=${session.replayId}`,
        exitReason: side === 'SELL' ? 'SCHEDULE_SELL' : undefined,
        thesisData: side === 'BUY' ? thesisData : null,
      });
    }
  }
  session.broker.markToMarket(prices);
  const port = await session.broker.portfolio();
  if (port.equity > session.peakEquity) session.peakEquity = port.equity;
  const dd = session.peakEquity > 0 ? (session.peakEquity - port.equity) / session.peakEquity : 0;
  session.equity.push({ t, equity: port.equity, cash: port.cash, drawdownPct: dd });
  emit(session, 'PORTFOLIO_UPDATE', { equity: port.equity, cash: port.cash, drawdownPct: dd });
}

export async function startReplay(id: string, opts?: { async?: boolean }) {
  const row = runs.get(id) as { session?: ActiveReplaySession; status?: string } | undefined;
  if (!row?.session) return { ok: false, error: 'REPLAY_NOT_FOUND' };
  if (tradingEngine.state.tradingMode === 'LIVE') return { ok: false, error: 'Replay refused while LIVE' };
  if (getActiveReplaySession() && getActiveReplaySession()?.replayId !== id) {
    return { ok: false, error: 'A replay session is already active' };
  }
  if (opts?.async) {
    void runReplayLoop(id).catch((e) => {
      console.error('[Replay] async start failed', e);
    });
    return { ok: true, replayId: id, status: 'RUNNING', async: true, live: 'NO-GO' };
  }
  return runReplayLoop(id);
}

async function runReplayLoop(id: string) {
  const row = runs.get(id) as { session?: ActiveReplaySession; status?: string } | undefined;
  if (!row?.session) return { ok: false, error: 'REPLAY_NOT_FOUND' };
  if (tradingEngine.state.tradingMode === 'LIVE') return { ok: false, error: 'Replay refused while LIVE' };
  if (getActiveReplaySession() && getActiveReplaySession()?.replayId !== id) {
    return { ok: false, error: 'A replay session is already active' };
  }
  const session = row.session;
  clearReplayQuotes();
  setActiveReplaySession(session);
  session.status = 'RUNNING';
  row.status = 'RUNNING';
  emit(session, 'REPLAY_STARTED', {
    executionModel: replaySafety.executionModel,
    initialCapital: session.config.initialCapital,
    symbols: session.config.symbols,
  });
  const timestamps = mergeTimestamps(session.datasets);
  session.totalBars = timestamps.length;
  try {
    for (let i = 1; i < timestamps.length; i++) {
      session.currentBarIndex = i;
      session.currentTimestamp = timestamps[i];
      if (session.stopRequested) {
        session.status = 'CANCELLED';
        break;
      }
      while (session.pauseRequested && !session.stopRequested) {
        session.status = 'PAUSED';
        if (session.config.speed === 'STEP' && !session.stepRequested) {
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        if (session.config.speed !== 'STEP') await new Promise((r) => setTimeout(r, 25));
        else break;
      }
      session.stepRequested = false;
      session.status = 'RUNNING';
      const nextOpen = new Map<string, number>();
      const t = timestamps[i];
      for (const symbol of session.config.symbols) {
        const bars = session.barsBySymbol.get(symbol.toUpperCase()) || [];
        const bar = bars.find((b) => b.timestamp === t);
        if (bar) nextOpen.set(symbol, bar.open);
      }
      const timestampStart = Date.now();
      await processTimestamp(session, t, nextOpen);
      recordStageDuration(session, 'PROCESS_TIMESTAMP', timestampStart);
      if (session.config.speed === '1x') await new Promise((r) => setTimeout(r, 1000));
      else if (session.config.speed === '10x') await new Promise((r) => setTimeout(r, 100));
      else if (session.config.speed === '100x') await new Promise((r) => setTimeout(r, 10));
    }
    // Flatten leftover positions so report is not silently open-ended.
    // Do not mark COMPLETED until the finally block attaches report — UI polls stop on COMPLETED.
    for (const symbol of [...session.openStops.keys()]) {
      const pos = (await session.broker.positions()).find((p) => p.symbol === symbol);
      const px = pos?.currentPrice || session.broker.nextFillPrice.get(symbol);
      if (pos && pos.quantity > 0 && typeof px === 'number') {
        session.broker.nextFillPrice.set(symbol, px);
        // End-of-replay forced flatten, not a normal tick-driven fill - clear any stale volume
        // figure from an earlier timestamp so the participation cap doesn't wrongly apply here.
        session.broker.nextFillVolume.delete(symbol);
        await submitThroughRiskAndOms(session, {
          symbol,
          side: 'SELL',
          confidence: 0.9,
          price: px,
          strategyId: session.config.strategyIds[0] || 'MOMENTUM_BREAKOUT',
          stop: null,
          target: null,
          reasoning: `HISTORICAL_REPLAY executionEnvironment=REPLAY exitReason=END_OF_REPLAY replayId=${session.replayId}`,
          exitReason: 'END_OF_REPLAY',
        });
      }
    }
  } catch (e: any) {
    session.status = 'FAILED';
    emit(session, 'FAILED', { error: e.message });
    (row as any).error = e.message;
  } finally {
    const st = session.status as ReplayRunStatus;
    if (st === 'RUNNING' || st === 'PAUSED' || st === 'READY') {
      session.status = session.partial ? 'PARTIAL' : 'COMPLETED';
    }
    const costs = session.broker.snapshotCosts();
    const port = await session.broker.portfolio();
    const brokerOrders = await session.broker.orders();
    const sells = brokerOrders.filter((o) => o.side === 'SELL' && o.status === 'FILLED');
    const buys = brokerOrders.filter((o) => o.side === 'BUY' && o.status === 'FILLED');
    const equityValues = session.equity.map((e) => e.equity);
    const minEquity = equityValues.length ? Math.min(...equityValues) : session.peakEquity;
    let benchmarkBars: Array<{ timestamp: number; close: number }> | null = null;
    try {
      const benchSym = 'SPY';
      const already = session.datasets.find((d) => d.symbol.toUpperCase() === benchSym);
      if (already?.bars?.length) {
        benchmarkBars = already.bars.map((b) => ({ timestamp: b.timestamp, close: b.close }));
      } else if (session.config.dataProvider === 'golden_replay') {
        // Golden fixture is UNIT_FIXTURE — no inventing SPY. Leave UNAVAILABLE.
        benchmarkBars = null;
      } else {
        const { getHistoricalProvider } = await import('./HistoricalDataProviderRegistry');
        const provider = getHistoricalProvider(session.config.dataProvider);
        if (provider) {
          const startMs = session.datasets[0]?.startTimestamp ?? session.datasets[0]?.bars[0]?.timestamp;
          const endMs = session.datasets[0]?.endTimestamp ?? session.datasets[0]?.bars.at(-1)?.timestamp;
          if (typeof startMs === 'number' && typeof endMs === 'number') {
            const fetched = await provider.fetch({
              symbol: benchSym,
              startMs,
              endMs,
              frequency: session.config.frequency,
            });
            if (!('error' in fetched) && fetched.bars?.length) {
              benchmarkBars = fetched.bars.map((b) => ({ timestamp: b.timestamp, close: b.close }));
            }
          }
        }
      }
    } catch {
      benchmarkBars = null;
    }
    const report = buildReplayPerformance({
      startingCapital: session.config.initialCapital,
      endingCapital: port.equity,
      grossPnl: costs.realizedPnl + costs.feesPaid,
      fees: costs.feesPaid,
      slippage: costs.slippagePaid,
      maxDrawdown: session.peakEquity - minEquity,
      maxDrawdownPct: Math.max(...session.equity.map((e) => e.drawdownPct), 0),
      tradePnls: session.tradePnls,
      buyTrades: buys.length,
      sellTrades: sells.length,
      noTrade: session.noTrade,
      costProfile: session.config.costProfile,
      equityCurve: session.equity,
      trades: session.tradeLedger,
      benchmarkBars,
    });
    const evidence = emptyEvidence(session.config.strategyIds[0] || 'MOMENTUM_BREAKOUT');
    const promo = { status: deriveLifecycleStatus(evidence), live: liveGoNoGo(evidence) };
    const vbt = await getVectorBTStatus();
    const missedOpportunities = analyzeMissedOpportunities(session.rejectionsForRetrospective, session.barsBySymbol);
    writeReplayJson(session.replayId, 'trades.json', session.tradeLedger);
    writeReplayJson(session.replayId, 'rejected_orders.json', session.rejectedOrders);
    writeReplayJson(session.replayId, 'missed_opportunities.json', missedOpportunities);
    writeReplayJson(session.replayId, 'portfolio_final.json', port);
    emit(session, 'REPLAY_COMPLETED', { status: session.status, netPnl: report.netPnl });
    const summary = {
      replayId: session.replayId,
      status: session.status,
      report,
      trades: session.tradeLedger,
      rejectedOrders: session.rejectedOrders,
      equity: session.equity,
      portfolio: port,
      agentAvailability: session.agentAvailability,
      promotion: promo,
      vectorbt: { ...vbt, comparisonNote: 'VectorBT is MODE A research. Not equivalent to full Argus replay.' },
      ai: { mode: session.aiLabel, calls: session.aiCalls, costUsd: session.aiCostUsd, limit: replaySafety.aiCallLimit },
      hashes: { datasetHash: session.datasetHash, configurationHash: session.configurationHash, replayHash: session.replayHash },
      live: 'NO-GO',
      executionEnvironment: 'REPLAY',
      organicPaper: false,
      canPromoteFromThisReplay: false,
      executionModel: replaySafety.executionModel,
      universeSource: session.config.universeSource,
      discoveredSymbols: session.config.universeSource === 'ARGUS_DISCOVERY'
        ? [...session.discoveredAt.entries()].map(([symbol, discoveredAt]) => ({ symbol, discoveredAt }))
        : null,
      historicalUniverseMethodology: session.config.universeSource === 'ARGUS_DISCOVERY'
        ? `ARGUS_DISCOVERY: static curated candidate pool (config/replaySafety.json historicalDiscoveryUniverse, ${session.config.symbols.length} symbols) screened by trailing point-in-time dollar volume (bars strictly before each historical timestamp) down to at most ${replaySafety.historicalDiscoveryMaxActiveCandidates} active names, rescanned every ${replaySafety.historicalDiscoveryRescanEveryBars} bars. Not a reconstructed historical market listing.`
        : 'OPERATOR_SELECTED: fixed symbol list supplied at replay creation, not discovered.',
      dataAvailabilityWarning: replaySafety.historicalDiscoveryFidelityWarning,
      partialFillModel: 'VOLUME_PARTICIPATION_CAPPED',
      partialFillModelDescription: replaySafety.partialFillModelDescription,
      maxVolumeParticipationPct: replaySafety.maxVolumeParticipationPct,
      consensusMode: replaySafety.consensusModeDefault,
      consensusModeDescription: replaySafety.consensusModeDescription,
      historicalEvaluation: {
        productName: 'Argus Historical Evaluation',
        runId: session.replayId,
        capital: session.config.initialCapital,
        startDate: session.config.startDate,
        endDate: session.config.endDate,
        universeMode: session.config.universeSource,
        candidatePool: session.config.universeSource === 'ARGUS_DISCOVERY' ? session.config.symbols : session.config.symbols,
        discoveryMethodology: session.config.universeSource === 'ARGUS_DISCOVERY'
          ? 'Point-in-time dollar-volume screen over static curated pool (replayDiscoveryAdapter)'
          : 'Fixed operator symbol list',
        historicalDataProvider: session.config.dataProvider,
        dataCoverage: session.quality,
        survivorshipWarning: replaySafety.survivorshipBiasWarning,
        delistedWarning: replaySafety.delistedWarning,
        historicalDiscoveryFidelity: replaySafety.historicalDiscoveryFidelityWarning,
        agentAvailability: session.agentAvailability,
        consensusMode: replaySafety.consensusModeDefault,
        riskEngineVersion: 'production RiskEngine.evaluateRisk (replay session scoped)',
        riskGateConfiguration: 'config/tradingSafety.json + config/riskGateOrder.json',
        omsMode: 'production OrderManagementService → HistoricalReplayBroker',
        fillModel: replaySafety.executionModel,
        slippageModel: session.config.costProfile,
        volumeParticipationModel: 'VOLUME_PARTICIPATION_CAPPED',
        benchmark: report.benchmark,
        lookAheadProtections: [
          'InformationCutoff on all decision bars (timestamp < T)',
          'Discovery uses bars strictly before each historical timestamp',
          'Missed-opportunity analysis post-run only',
          'Isolated replay quote cache (no live MarketDataWorker mutation)',
          'No live EventBus trade ideas from replay',
        ],
        replayEngineVersion: replaySafety.replayEngineVersion,
        deterministicSeed: session.config.randomSeed,
        historicalFidelity: replaySafety.historicalFidelityLabel,
        disclaimer: replaySafety.historicalEvaluationDisclaimer,
        warnings: [
          replaySafety.survivorshipBiasWarning,
          replaySafety.historicalDiscoveryFidelityWarning,
          replaySafety.zeroCostWarning,
        ].filter(Boolean),
        limitations: [
          'Does not reconstruct complete historical market universe',
          'Fundamental/Macro/News/Kronos historical inputs unavailable or partial',
          'Consensus is CONSENSUS_MATH_REPLAY — not live ChiefTrader + LLM debate',
        ],
      },
      decisionFunnel: buildDecisionFunnel({
        evaluationsAttempted: session.evaluationsAttempted,
        strategyPassesAttempted: session.strategyPassesAttempted,
        noTrade: session.noTrade,
        tradeLedger: session.tradeLedger,
        rejectedOrders: session.rejectedOrders,
      }),
      agentEvaluation: buildAgentEvaluation(session.agentIdeaStats),
      // Post-run only (§12) - computed above, after session.status is already terminal, from full
      // (non-point-in-time-filtered) bars. Never called from processTimestamp().
      missedOpportunities,
      missedOpportunityLabel: replaySafety.missedOpportunityLabel,
      performanceDiagnostics: {
        totalReplayDurationMs: Date.now() - session.replayStartedAtMs,
        stages: Object.fromEntries(
          Object.entries(session.stageDurations).map(([stage, s]) => [
            stage,
            { totalMs: s.totalMs, count: s.count, avgMs: s.count > 0 ? Number((s.totalMs / s.count).toFixed(3)) : 0 },
          ]),
        ),
        note: 'Real replay processing wall-clock time on this machine, not simulated market latency. PROCESS_TIMESTAMP covers one full historical tick (discovery/agents/consensus/risk/OMS combined); RISK_AND_OMS isolates just the RiskEngine+OMS submission; DISCOVERY isolates the point-in-time liquidity screen.',
      },
    };
    writeReplayJson(session.replayId, 'summary.json', summary);
    writeReplayJson(session.replayId, 'equity_curve.json', session.equity);
    writeReplayJson(session.replayId, 'README.json', {
      note: 'This directory is a replay package. HISTORICAL REPLAY / SIMULATION ONLY / NOT LIVE / NOT PAPER.',
    });
    Object.assign(row, summary, { session: undefined, events: session.events.slice(-200), config: session.config });
    runs.set(id, row);
    await persistReplayRun(row as any);
    setActiveReplaySession(null);
    clearReplayQuotes();
  }
  return runs.get(id);
}

export function stepReplay(id: string) {
  const session = getActiveReplaySession();
  if (!session || session.replayId !== id) return { ok: false, error: 'NO_ACTIVE_REPLAY' };
  session.stepRequested = true;
  session.pauseRequested = false;
  return { ok: true };
}