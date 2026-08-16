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
import { RSIEngine } from '../engines/RSIEngine';
import { evidenceFromPitIdeas, replayChiefTraderFromEvidence } from '../engines/backtest/PitReplay';
import { riskEngine } from '../engines/RiskEngine';
import { marketDataWorker } from '../services/MarketDataWorker';
import { tradingEngine } from '../engines/TradingEngine';
import { emptyEvidence, deriveLifecycleStatus, liveGoNoGo } from '../research/promotionEngine';
import { getVectorBTStatus } from '../research/VectorBTService';
import { freezeStrategyVersion } from '../research/strategySpecs';
import { hashReplayConfiguration, hashReplayIdentity } from './replayHash';
import { appendReplayEvent, writeReplayJson } from './replayStore';
import { buildReplayPerformance } from './replayReport';
import { classifyMarketSession } from './marketSession';
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
      session.openStops.set(opts.symbol, { stop: opts.stop, target: opts.target, entryTraceId: traceId });
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
  const out: CanonicalDataset[] = [];
  for (const symbol of config.symbols) {
    if (config.dataProvider === 'golden_replay') {
      const ds = loadGoldenReplayDataset();
      ds.symbol = symbol;
      out.push(ds);
      continue;
    }
    const startMs = Date.parse(`${config.startDate}T${config.startTime || '09:30:00'}`);
    const endMs = Date.parse(`${config.endDate}T${config.endTime || '16:00:00'}`);
    const fetched = await provider.fetch({ symbol, startMs, endMs, frequency: config.frequency });
    if ('error' in fetched) return fetched;
    out.push(fetched);
  }
  return out;
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
    tradePnls: [],
    tradeLedger: [],
    rejectedOrders: [],
    agentAvailability: {
      QuantEngine: { status: 'ENABLED', reason: 'PIT bars + strategy evaluate / golden schedule' },
      TechnicalAgent: { status: 'PARTIAL', reason: 'RSI on PIT bars only; not full live agent loop' },
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
    labels: ['HISTORICAL REPLAY', 'SIMULATION ONLY', 'NOT LIVE', 'NOT PAPER', 'NOT ACTUAL TRADING', session.aiLabel],
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

  for (const symbol of session.config.symbols) {
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
    marketDataWorker.cacheObservedQuote(symbol, last.close, t);
    const next = bars.find((b) => b.timestamp === t);
    if (next) session.broker.nextFillPrice.set(symbol, next.open);
    else if (nextOpenBySymbol.has(symbol)) session.broker.nextFillPrice.set(symbol, nextOpenBySymbol.get(symbol)!);
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
      let exitReason: string | null = null;
      if (openMeta.stop != null && last.low <= openMeta.stop) exitReason = 'STOP';
      else if (openMeta.target != null && last.high >= openMeta.target) exitReason = 'TARGET';
      if (exitReason) {
        emit(session, exitReason === 'STOP' ? 'STOP_TRIGGERED' : 'TARGET_TRIGGERED', { price: last.close, stop: openMeta.stop, target: openMeta.target }, symbol);
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

    const rsi = new RSIEngine(14).calculate(visible.map((b) => b.close));
    emit(session, 'AGENT_ASSESSMENT', { agent: 'TechnicalAgent', rsi, data: 'PIT_BARS_ONLY' }, symbol);

    if (session.config.aiMode === 'LIVE_MODEL_REPLAY') {
      emit(session, 'AI', { mode: session.aiLabel, executed: false, reason: 'LLM not invoked in default replay (cost + not historical weights)' }, symbol);
    } else if (session.config.aiMode === 'RECORDED_DECISION_REPLAY') {
      emit(session, 'AI', { mode: 'RECORDED_DECISION_REPLAY', ledger: 'empty_or_unused' }, symbol);
    } else {
      emit(session, 'AI', { mode: 'DISABLED' }, symbol);
    }

    for (const strategyId of session.config.strategyIds) {
      let side: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
      let confidence = 0;
      let stop: number | null = null;
      let target: number | null = null;
      let ideas: Array<{ kind: string; agent: string; side: string; confidence: number; publishedAtMs: number; payloadJson?: string }> = [];

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
          { kind: 'AGENT_REASONING', agent: 'TechnicalAgent', side, confidence: rsi > 50 ? 0.55 : 0.45, publishedAtMs: t, payloadJson: `rsi=${rsi}` },
        ];
      }

      const evidence: Evidence[] = evidenceFromPitIdeas(ideas, symbol, last.close);
      const chief = replayChiefTraderFromEvidence(evidence, false);
      emit(session, 'CHIEF_DECISION', { ...chief, debateUsed: false, aiLabel: session.aiLabel }, symbol);
      if (!chief.approved) {
        bumpNoTrade(session, 'NO_CHIEF_APPROVAL');
        emit(session, 'NO_TRADE', { reason: 'NO_CHIEF_APPROVAL', detail: chief.reason }, symbol);
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
  setActiveReplaySession(session);
  session.status = 'RUNNING';
  row.status = 'RUNNING';
  emit(session, 'REPLAY_STARTED', {
    executionModel: replaySafety.executionModel,
    initialCapital: session.config.initialCapital,
    symbols: session.config.symbols,
  });
  const timestamps = mergeTimestamps(session.datasets);
  try {
    for (let i = 1; i < timestamps.length; i++) {
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
      await processTimestamp(session, t, nextOpen);
      if (session.config.speed === '1x') await new Promise((r) => setTimeout(r, 1000));
      else if (session.config.speed === '10x') await new Promise((r) => setTimeout(r, 100));
      else if (session.config.speed === '100x') await new Promise((r) => setTimeout(r, 10));
    }
    if (session.status !== 'CANCELLED') session.status = session.partial ? 'PARTIAL' : 'COMPLETED';
    // Flatten leftover positions so report is not silently open-ended.
    for (const symbol of [...session.openStops.keys()]) {
      const pos = (await session.broker.positions()).find((p) => p.symbol === symbol);
      const px = pos?.currentPrice || session.broker.nextFillPrice.get(symbol);
      if (pos && pos.quantity > 0 && typeof px === 'number') {
        session.broker.nextFillPrice.set(symbol, px);
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
    writeReplayJson(session.replayId, 'trades.json', session.tradeLedger);
    writeReplayJson(session.replayId, 'rejected_orders.json', session.rejectedOrders);
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