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
import { goldenReplayNewsProvider, newsVisibleAt, unavailableHistoricalNewsProvider, loadHistoricalNewsArchiveProvider } from './HistoricalNewsProvider';
import { loadHistoricalMacroProvider, macroReleasesVisibleAt, unavailableHistoricalMacroProvider } from './HistoricalMacroProvider';
import { loadHistoricalFundamentalProvider, latestFundamentalSnapshotAsOf, unavailableHistoricalFundamentalProvider } from './HistoricalFundamentalProvider';
import { assessDataQuality } from '../research/dataQuality';
import { hashCanonicalDataset } from '../research/datasetHash';
import { replayArgusStrategy } from '../research/argusStrategyReplay';
import { MIN_BARS } from '../quant/RegimeEngine';
import { evaluateReplayTechnical } from './replayTechnicalEvaluation';
import { cacheReplayQuote, clearReplayQuotes } from './HistoricalReplayMarketDataContext';
import { replayChiefTraderFromEvidence } from '../engines/backtest/PitReplay';
import {
  resolveReplayAiModeConsensus,
  mergeLiveConsensusDebateVote,
} from '../engines/backtest/replayAiModeConsensus';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
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
import {
  buildAiModeHonesty,
  buildDecisionEvidenceRecord,
  enrichDecisionEvidenceWithOutcomes,
  summarizeDecisionEvidence,
  type DecisionAgentVote,
  type DecisionRiskGateSnapshot,
} from './decisionEvidence';
import { classifyMarketSession } from './marketSession';
import { getHistoricalDiscoveryUniverse, screenHistoricalCandidates } from './HistoricalUniverseProvider';
import { evaluateExit } from '../services/ExitIntelligenceEngine';
import { evaluateThesisInvalidation, type StoredThesis } from '../quant/analysis/ThesisInvalidation';
import { classifyRegime } from '../quant/RegimeEngine';
import { computeVolumeFeatures } from '../quant/indicators/volume';
import type { CanonicalDataset, ResearchBar } from '../research/ohlcvTypes';
import type { Evidence } from '../services/EvidenceAggregator';
import { oms } from '../services/OrderManagement';
import { getTradingDateStr } from '../core/TradingCalendar';
import { resolveCampaignTargetDollars } from '../services/CampaignTracker';
import { db } from '../db';
import { replayRuns, riskAssessments, riskGateResults } from '../db/schema';
import { asc, desc, eq } from 'drizzle-orm';
import { aiHistoricalReplayAvailability } from './aiReplayAvailability';

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
  /** When set, persist additive decision evidence (votes/consensus/gates) for paper-learning analysis. */
  decisionContext?: {
    agentVotes: DecisionAgentVote[];
    independentAgreeingAgents: number;
    weightedConfidence: number;
    consensusApproved: boolean;
    consensusReason: string;
  };
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
  decisionContext?: {
    agentVotes: DecisionAgentVote[];
    independentAgreeingAgents: number;
    weightedConfidence: number;
    consensusApproved: boolean;
    consensusReason: string;
  };
}) {
  const traceId = `${replaySafety.replayTracePrefix}${session.replayId}-${session.clock.now()}-${opts.symbol}-${opts.side}-${crypto.randomUUID().slice(0, 8)}`;
  const costsBefore = session.broker.snapshotCosts();
  const realizedBefore = costsBefore.realizedPnl;
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
  const costsSnap = session.broker.snapshotCosts();
  const realizedAfter = costsSnap.realizedPnl;
  // Real per-order commission/slippage, not the broker's running total - matches how pnlDelta below
  // already isolates this one order's realizedPnl contribution the same way.
  const feesDelta = Number((costsSnap.feesPaid - costsBefore.feesPaid).toFixed(4));
  const slippageDelta = Number((costsSnap.slippagePaid - costsBefore.slippagePaid).toFixed(4));
  const gateSnap = loadRiskGateSnapshots(traceId);
  const pushDecisionEvidence = (stageOutcome: 'RISK_REJECTED' | 'ORDER_FILLED' | 'ORDER_REJECTED_OTHER') => {
    if (!opts.decisionContext) return;
    session.decisionEvidence.push(buildDecisionEvidenceRecord({
      symbol: opts.symbol,
      timestamp: session.clock.now(),
      strategyId: opts.strategyId,
      predictedSide: opts.side,
      referencePrice: opts.price,
      agentVotes: opts.decisionContext.agentVotes,
      independentAgreeingAgents: opts.decisionContext.independentAgreeingAgents,
      weightedConfidence: opts.decisionContext.weightedConfidence,
      consensusApproved: opts.decisionContext.consensusApproved,
      consensusReason: opts.decisionContext.consensusReason,
      stageOutcome,
      rejectionGate: gateSnap.rejectionGate,
      riskGates: gateSnap.riskGates,
      traceId,
    }));
  };
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
        fees: feesDelta,
        slippage: slippageDelta,
        realizedPnl: null,
        executionModel: 'NEXT_BAR_OPEN',
        executionEnvironment: 'HISTORICAL_REPLAY',
      });
      pushDecisionEvidence('ORDER_FILLED');
      emit(session, 'ORDER_FILLED', { side: 'BUY', qty: pos.quantity, price: pos.entryPrice, executionModel: 'NEXT_BAR_OPEN' }, opts.symbol);
    } else {
      bumpNoTrade(session, 'RISK_REJECTED');
      session.rejectedOrders.push({
        timestamp: session.clock.now(),
        symbol: opts.symbol,
        side: 'BUY',
        reason: 'INSUFFICIENT_BUYING_POWER_OR_RISK',
        traceId,
        rejectionGate: gateSnap.rejectionGate,
      });
      pushDecisionEvidence(gateSnap.approved ? 'ORDER_REJECTED_OTHER' : 'RISK_REJECTED');
      emit(session, 'ORDER_REJECTED', { traceId, reason: 'INSUFFICIENT_BUYING_POWER_OR_RISK', rejectionGate: gateSnap.rejectionGate }, opts.symbol);
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
        fees: feesDelta,
        slippage: slippageDelta,
        realizedPnl: pnlDelta,
        executionModel: 'NEXT_BAR_OPEN',
        executionEnvironment: 'HISTORICAL_REPLAY',
      });
      session.openStops.delete(opts.symbol);
      if (opts.side === 'SELL' && realizedAfter !== realizedBefore) {
        session.tradePnls.push(Number((realizedAfter - realizedBefore).toFixed(4)));
        updateCampaignStateAfterRealizedFill(session, pnlDelta);
      }
      pushDecisionEvidence('ORDER_FILLED');
      emit(session, 'ORDER_FILLED', { side: 'SELL', exitReason: opts.exitReason || 'SELL', pnl: pnlDelta, executionModel: 'NEXT_BAR_OPEN' }, opts.symbol);
    } else {
      bumpNoTrade(session, 'RISK_REJECTED');
      session.rejectedOrders.push({
        timestamp: session.clock.now(),
        symbol: opts.symbol,
        side: 'SELL',
        reason: 'RISK_REJECTED',
        traceId,
        rejectionGate: gateSnap.rejectionGate,
      });
      pushDecisionEvidence(gateSnap.approved ? 'ORDER_REJECTED_OTHER' : 'RISK_REJECTED');
      emit(session, 'ORDER_REJECTED', { traceId, exitReason: opts.exitReason, rejectionGate: gateSnap.rejectionGate }, opts.symbol);
    }
  }
  return traceId;
}

function bumpNoTrade(session: ActiveReplaySession, reason: string) {
  session.noTrade[reason] = (session.noTrade[reason] || 0) + 1;
}

/**
 * Daily Goal Campaign simulation (BACKTEST_FEATURE_PARITY_AUDIT.md's P4 gap). Entirely isolated from
 * live CampaignTracker.ts's in-memory campaignBuyLock/ideaGenerationGate singletons - this only ever
 * reads/writes session.campaign, computed from the replay's OWN tradeLedger and clock, never touching
 * live state. Off by default (config.campaignEnabled=false), matching settings.campaign_enabled's own
 * default-off. Disclosed simplification, same one already disclosed for the separate Java
 * CampaignPolicySimulator built earlier: TRAIL_STOPS_ONLY applies the same BUY soft-lock as
 * LOCK_AND_IDLE but does not additionally tighten trailing stops on open positions (that would mean
 * reimplementing PortfolioMonitor.trailingStopPct math a second time inside replay - out of scope
 * here; TRAIL_STOPS_ONLY's own live docs already separate "soft-lock" from "PortfolioMonitor already
 * owns trailingStopPct exits" as two different concerns).
 */
/**
 * Real NewsAgent PIT vote from historical_news_archive's own stored sentimentScore (a real numeric
 * field, not an LLM interpretation - same FinBERT-like local numeric helper role CLAUDE.md describes
 * live NewsAgent as also using). Only votes when `newsIsRealVoter` (the golden_replay_news fixture
 * stays CATALYST_ONLY / non-voting, unchanged from before this PIT ledger work) and at least one
 * visible article has a finite sentiment score whose magnitude clears the config floor - avoids a
 * near-zero/noise sentiment average being treated as a confident directional vote. Thresholds/scale
 * come from config/replaySafety.json, never hardcoded here.
 */
function buildRealNewsAgentIdea(
  newsIsRealVoter: boolean,
  news: Array<{ sentiment: number | null }>,
  publishedAtMs: number,
): Array<{ kind: string; agent: string; side: 'BUY' | 'SELL'; confidence: number; publishedAtMs: number; payloadJson: string }> {
  if (!newsIsRealVoter || news.length === 0) return [];
  const scored = news.filter((n): n is { sentiment: number } => typeof n.sentiment === 'number' && Number.isFinite(n.sentiment));
  if (scored.length === 0) return [];
  const avgSentiment = scored.reduce((sum, n) => sum + n.sentiment, 0) / scored.length;
  if (Math.abs(avgSentiment) < replaySafety.historicalNewsVoteMinAbsSentiment) return [];
  const side: 'BUY' | 'SELL' = avgSentiment > 0 ? 'BUY' : 'SELL';
  const confidence = Math.min(
    replaySafety.historicalNewsVoteMaxConfidence,
    Math.max(replaySafety.historicalNewsVoteMinConfidence, replaySafety.historicalNewsVoteMinConfidence + Math.abs(avgSentiment) * replaySafety.historicalNewsVoteConfidenceScale),
  );
  return [{
    kind: 'AGENT_REASONING',
    agent: 'NewsAgent',
    side,
    confidence,
    publishedAtMs,
    payloadJson: `avgSentiment=${avgSentiment.toFixed(3)} n=${scored.length}`,
  }];
}

function isCampaignBuyLockedToday(session: ActiveReplaySession): boolean {
  if (!session.config.campaignEnabled) return false;
  const today = getTradingDateStr(new Date(session.clock.now()));
  return session.campaign.lockedForDate === today;
}

/** Called once per realized SELL fill (BUY fills never realize P&L, so never move progress). */
function updateCampaignStateAfterRealizedFill(session: ActiveReplaySession, pnlDelta: number): void {
  if (!session.config.campaignEnabled || !Number.isFinite(pnlDelta) || pnlDelta === 0) return;
  const today = getTradingDateStr(new Date(session.clock.now()));
  const c = session.campaign;
  const priorRealized = c.dailyRealizedByDate.get(today) ?? 0;
  const dailyRealized = priorRealized + pnlDelta;
  c.dailyRealizedByDate.set(today, dailyRealized);

  if (c.daysTargetMet.has(today)) return; // already handled today - avoid re-emitting/re-locking
  const targetDollars = resolveCampaignTargetDollars(
    session.config.allocationBudget,
    session.config.dailyTargetAmount,
    session.config.dailyTargetType,
  );
  if (targetDollars <= 0) return;
  const progress = dailyRealized / targetDollars;
  if (progress < 1.0) return;

  c.daysTargetMet.add(today);
  const action = session.config.targetAchievedAction;
  if (action === 'LOCK_AND_IDLE' || action === 'TRAIL_STOPS_ONLY') {
    c.lockedForDate = today;
    c.lockAction = action;
  }
  emit(session, 'CAMPAIGN_TARGET_REACHED', {
    tradingDate: today,
    action,
    dailyRealized: Number(dailyRealized.toFixed(4)),
    targetDollars: Number(targetDollars.toFixed(4)),
  });
}

/** Called once per tick alongside the real equity/drawdown update - tracks drawdown only for dates already past their target. */
function updatePostTargetDrawdown(session: ActiveReplaySession, equity: number): void {
  if (!session.config.campaignEnabled) return;
  const today = getTradingDateStr(new Date(session.clock.now()));
  if (!session.campaign.daysTargetMet.has(today)) return;
  const c = session.campaign;
  const priorPeak = c.postTargetEquityPeakByDate.get(today) ?? equity;
  const peak = Math.max(priorPeak, equity);
  c.postTargetEquityPeakByDate.set(today, peak);
  if (peak > 0) {
    const dd = (peak - equity) / peak;
    if (dd > c.postTargetMaxDrawdownPct) c.postTargetMaxDrawdownPct = dd;
  }
}

function votesFromEvidence(evidence: Evidence[]): DecisionAgentVote[] {
  return evidence.map((e) => ({
    agent: e.agent,
    side: e.side,
    confidence: e.confidence,
    weight: typeof e.weight === 'number' ? e.weight : null,
  }));
}

function loadRiskGateSnapshots(traceId: string): {
  rejectionGate: string | null;
  riskGates: DecisionRiskGateSnapshot[];
  approved: boolean;
} {
  try {
    const assessed = db.select().from(riskAssessments).where(eq(riskAssessments.traceId, traceId)).limit(1).get();
    const gates = db.select().from(riskGateResults)
      .where(eq(riskGateResults.traceId, traceId))
      .orderBy(asc(riskGateResults.sequence))
      .all();
    return {
      rejectionGate: assessed?.rejectionGate ?? null,
      approved: !!assessed?.approved,
      riskGates: gates.map((g) => ({
        gateName: g.gateName,
        sequence: g.sequence,
        passed: !!g.passed,
      })),
    };
  } catch {
    return { rejectionGate: null, riskGates: [], approved: false };
  }
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
  // PIT Agent Ledger System: real historical_news_archive/historical_macro_releases/
  // historical_fundamental_snapshots reads, scoped to this replay's own symbol list and date
  // range (never today's live feeds). Falls back to the pre-existing golden fixture / unavailable
  // behavior whenever the archive has no rows for this window - never fabricated. See
  // config/replaySafety.json's historicalPitAgentDisclosure for why Macro/Fundamental stay
  // context-only (not a ChiefTrader vote) while News does vote once real data is loaded.
  const pitWindowEndMs = Math.max(startMs, ...datasets.map((d) => d.bars.at(-1)?.timestamp ?? startMs));
  const news = config.newsProvider === 'golden_replay_news'
    ? goldenReplayNewsProvider()
    : await loadHistoricalNewsArchiveProvider(config.symbols, startMs, pitWindowEndMs).catch(() => unavailableHistoricalNewsProvider());
  const macro = await loadHistoricalMacroProvider(startMs, pitWindowEndMs).catch(() => unavailableHistoricalMacroProvider());
  const fundamentals = await loadHistoricalFundamentalProvider(config.symbols).catch(() => unavailableHistoricalFundamentalProvider());
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
    macro,
    fundamentals,
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
    decisionEvidence: [],
    agentIdeaStats: {},
    stageDurations: {},
    replayStartedAtMs: Date.now(),
    campaign: {
      lockedForDate: null,
      lockAction: null,
      dailyRealizedByDate: new Map(),
      daysTargetMet: new Set(),
      postTargetEquityPeakByDate: new Map(),
      postTargetMaxDrawdownPct: 0,
    },
    tradePnls: [],
    tradeLedger: [],
    rejectedOrders: [],
    agentAvailability: {
      QuantEngine: { status: 'ENABLED', reason: 'PIT bars + strategy evaluate / golden schedule' },
      TechnicalAgent: {
        status: 'PARTIAL',
        reason: 'Live technicalSignal.ts rule math on PIT bars (confidence [0.55,0.95] when a rule fires); not the full live tick-driven TechnicalAgent loop or EventBus. Votes only when Technical independently fires BUY/SELL — never mirrors QuantEngine side.',
      },
      NewsAgent: config.newsProvider === 'golden_replay_news'
        ? { status: 'CATALYST_ONLY', reason: 'Fixture news PIT-filtered; not a live NewsAgent voter' }
        : news.available
          ? { status: 'AVAILABLE', reason: `${news.note} Real historical_news_archive PIT data for this window - independent NewsAgent voter using stored sentimentScore (config/replaySafety.json historicalNewsVoteMinAbsSentiment gate), not an LLM interpretation.` }
          : { status: 'UNAVAILABLE', reason: 'Historical news unavailable for this symbol/date range. NewsAgent excluded from this replay.' },
      FundamentalAgent: fundamentals.available
        ? { status: 'DATA_LOADED_CONTEXT_ONLY', reason: `${fundamentals.note} ${replaySafety.historicalPitAgentDisclosure}` }
        : { status: 'UNAVAILABLE', reason: 'Point-in-time fundamentals not loaded for these symbols.' },
      MacroAgent: macro.available
        ? { status: 'DATA_LOADED_CONTEXT_ONLY', reason: `${macro.note} ${replaySafety.historicalPitAgentDisclosure}` }
        : { status: 'UNAVAILABLE', reason: 'Point-in-time macro releases not loaded for this date range.' },
      KronosForecastAgent: { status: 'UNAVAILABLE', reason: 'Point-in-time AI time-series forecasts not loaded in replay' },
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
          ? `${replaySafety.aiModeHonestyDescription} (${aiHistoricalReplayAvailability().status})`
          : config.aiMode === 'RECORDED_DECISION_REPLAY'
            ? `RECORDED_DECISION_REPLAY wired to pit_decision_ledger (empty → DISABLED Quant+Technical). ${aiHistoricalReplayAvailability().why}`
            : `LIVE_MODEL_REPLAY may invoke live routeConsensus (fail-closed). ${aiHistoricalReplayAvailability().why}`,
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
    const newsIsRealVoter = session.news.id === 'historical_news_archive';
    emit(session, 'NEWS', {
      count: news.length,
      status: session.news.status,
      mode: newsIsRealVoter ? 'PIT_VOTER' : 'CATALYST_ONLY',
      headlines: news.map((n) => n.headline),
    }, symbol);

    // Macro/Fundamental PIT context (audit-only - see agentAvailability's DATA_LOADED_CONTEXT_ONLY
    // status and config/replaySafety.json's historicalPitAgentDisclosure for why these do not cast
    // a ChiefTrader vote here, unlike the real historical_news_archive-backed news vote below).
    if (session.macro.available) {
      const macroVisible = macroReleasesVisibleAt(session.macro, session.cutoff);
      emit(session, 'AGENT_ASSESSMENT', {
        agent: 'MacroAgent',
        status: 'DATA_LOADED_CONTEXT_ONLY',
        count: macroVisible.length,
        releases: macroVisible.map((r) => ({ metric: r.metric, actual: r.actual, forecast: r.forecast })),
      }, symbol);
    }
    if (session.fundamentals.available) {
      const fundamentalSnap = latestFundamentalSnapshotAsOf(session.fundamentals, session.cutoff, symbol);
      if (fundamentalSnap) {
        emit(session, 'AGENT_ASSESSMENT', {
          agent: 'FundamentalAgent',
          status: 'DATA_LOADED_CONTEXT_ONLY',
          peRatio: fundamentalSnap.peRatio,
          pbRatio: fundamentalSnap.pbRatio,
          roe: fundamentalSnap.roe,
          debtToEquity: fundamentalSnap.debtToEquity,
        }, symbol);
      }
    }

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
      emit(session, 'AI', { mode: session.aiLabel, executed: 'pending_per_bar', reason: 'LIVE_MODEL_REPLAY: optional routeConsensus per bar with fail-closed HOLD' }, symbol);
    } else if (session.config.aiMode === 'RECORDED_DECISION_REPLAY') {
      emit(session, 'AI', { mode: 'RECORDED_DECISION_REPLAY', ledger: 'pit_decision_ledger_when_present' }, symbol);
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
          // Only the last signal is ever read below - see onlyLatestBar's own comment
          // (argusStrategyReplay.ts) for why this is required to keep a multi-year replay
          // practical (O(N^3) total -> O(N^2) without it).
          onlyLatestBar: true,
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
          // TechnicalAgent only contributes a vote when its own rules independently fired a
          // BUY/SELL (technical.side !== 'HOLD') - matching live TechnicalAgent.checkStrategies,
          // which simply does not call emitTradeIdea when none of its three strategies trigger.
          // A prior version of this file mirrored QuantEngine's side with a crude rsi>50?0.55:0.45
          // confidence whenever TechnicalAgent itself said HOLD, fabricating a second "independent"
          // vote that was not actually independent (it copied QuantEngine's side rather than
          // reflecting TechnicalAgent's real - negative - assessment). That inflated
          // minIndependentAgreeingAgents/consensus math with a non-real agreement, which every
          // pass of this investigation has been explicit is not an acceptable way to make replay
          // consensus reachable. Removed rather than re-tuned.
          ...(technical && technical.side !== 'HOLD'
            ? [{ kind: 'AGENT_REASONING', agent: 'TechnicalAgent', side: technical.side, confidence: technical.confidence, publishedAtMs: t, payloadJson: `rsi=${technical.rsi}` }]
            : []),
          // Real PIT NewsAgent vote (historical_news_archive only) - see buildRealNewsAgentIdea's
          // own doc comment. Macro/Fundamental deliberately do not add a vote here - context-only,
          // see agentAvailability's DATA_LOADED_CONTEXT_ONLY status.
          ...buildRealNewsAgentIdea(newsIsRealVoter, news, t),
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

      let recordedIdeas: typeof ideas = [];
      if (session.config.aiMode === 'RECORDED_DECISION_REPLAY') {
        try {
          const pitRows = await historicalDataGateway.getPitAiRowsAsOf(
            symbol,
            t,
            t - tradingSafety.newsVetoWindowMs,
          );
          recordedIdeas = pitRows.map((r) => ({
            kind: r.kind,
            agent: r.agent,
            side: r.side,
            confidence: r.confidence,
            publishedAtMs: r.publishedAtMs,
            payloadJson: r.payloadJson ?? undefined,
          }));
        } catch (e) {
          console.warn('[Replay] PIT ledger read failed; RECORDED falls back to DISABLED path', e);
        }
      }

      let aiResolved = resolveReplayAiModeConsensus({
        aiMode: session.config.aiMode,
        symbol,
        currentPrice: last.close,
        asOfMs: t,
        baseIdeas: ideas,
        recordedIdeas,
      });

      if (session.config.aiMode === 'LIVE_MODEL_REPLAY' && session.aiCalls < replaySafety.aiCallLimit) {
        try {
          const { AIRouter } = await import('../ai/AIRouter');
          const router = AIRouter.getInstance();
          const debate = await Promise.race([
            router.routeConsensus(
              'ConsensusDebate',
              `Historical replay bar ${symbol} @ ${new Date(t).toISOString()}. Quant side=${side} conf=${confidence}. Technical=${technical?.side ?? 'HOLD'}. Return JSON decision.`,
              `replay-${session.replayId}-${symbol}-${t}`,
            ),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
          ]);
          session.aiCalls += 1;
          const first = (debate as any)?.results?.[0];
          const parsed = first?.parsed ?? first;
          const liveSide = parsed?.decision ?? parsed?.side;
          const liveConf = typeof parsed?.confidence === 'number'
            ? (parsed.confidence > 1 ? parsed.confidence / 100 : parsed.confidence)
            : 0;
          if (liveSide === 'BUY' || liveSide === 'SELL' || liveSide === 'HOLD') {
            aiResolved = mergeLiveConsensusDebateVote(
              aiResolved,
              { side: liveSide, confidence: liveConf, reasoning: parsed?.reasoning },
              symbol,
              last.close,
            );
          } else {
            aiResolved = mergeLiveConsensusDebateVote(aiResolved, null, symbol, last.close);
          }
        } catch {
          aiResolved = mergeLiveConsensusDebateVote(aiResolved, null, symbol, last.close);
        }
      }

      emit(session, 'AI_MODE_RESOLVED', {
        mode: aiResolved.mode,
        ledgerUsed: aiResolved.ledgerUsed,
        liveModelInvoked: aiResolved.liveModelInvoked,
        reason: aiResolved.reason,
      }, symbol);

      const evidence: Evidence[] = aiResolved.evidence;
      const chief = aiResolved.consensus ?? replayChiefTraderFromEvidence(evidence, false);
      const agentVotes = votesFromEvidence(evidence);
      emit(session, 'CHIEF_DECISION', { ...chief, debateUsed: aiResolved.liveModelInvoked, aiLabel: session.aiLabel }, symbol);
      if (!chief.approved) {
        bumpNoTrade(session, 'NO_CHIEF_APPROVAL');
        emit(session, 'NO_TRADE', { reason: 'NO_CHIEF_APPROVAL', detail: chief.reason }, symbol);
        // Post-run-only retrospective candidate (§12) - recorded here, never read until after the
        // replay reaches a terminal status. Consensus rejections only (not risk rejections) - a
        // deliberately narrower scope than the full spec, stated honestly rather than implied.
        session.rejectionsForRetrospective.push({
          symbol,
          timestamp: t,
          reason: chief.reason || 'NO_CHIEF_APPROVAL',
          referencePrice: last.close,
          agentVotes,
          weightedConfidence: chief.confidence,
          independentAgreeingAgents: chief.independentAgreeingAgents,
        });
        session.decisionEvidence.push(buildDecisionEvidenceRecord({
          symbol,
          timestamp: t,
          strategyId,
          predictedSide: side,
          referencePrice: last.close,
          agentVotes,
          independentAgreeingAgents: chief.independentAgreeingAgents,
          weightedConfidence: chief.confidence,
          consensusApproved: false,
          consensusReason: chief.reason,
          stageOutcome: 'CONSENSUS_REJECTED',
        }));
        continue;
      }

      if (side === 'BUY' && isCampaignBuyLockedToday(session)) {
        bumpNoTrade(session, 'CAMPAIGN_BUY_LOCKED');
        emit(session, 'NO_TRADE', { reason: 'CAMPAIGN_BUY_LOCKED', lockAction: session.campaign.lockAction }, symbol);
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
        decisionContext: {
          agentVotes,
          independentAgreeingAgents: chief.independentAgreeingAgents,
          weightedConfidence: chief.confidence,
          consensusApproved: true,
          consensusReason: chief.reason,
        },
      });
    }
  }
  session.broker.markToMarket(prices);
  const port = await session.broker.portfolio();
  if (port.equity > session.peakEquity) session.peakEquity = port.equity;
  const dd = session.peakEquity > 0 ? (session.peakEquity - port.equity) / session.peakEquity : 0;
  session.equity.push({ t, equity: port.equity, cash: port.cash, drawdownPct: dd });
  updatePostTargetDrawdown(session, port.equity);
  emit(session, 'PORTFOLIO_UPDATE', { equity: port.equity, cash: port.cash, drawdownPct: dd });
}

export async function startReplay(id: string, opts?: { async?: boolean }) {
  const row = runs.get(id) as { session?: ActiveReplaySession; status?: string; error?: string; code?: string } | undefined;
  // Real bug found and fixed this pass: a row that legitimately exists (e.g. createReplayRun's own
  // DATA_UNAVAILABLE/FAILED early-return, which always calls runs.set() before returning - see
  // createReplayRun) has no `session` field, since a session is only ever built once a dataset
  // actually loads. That got reported as the exact same generic REPLAY_NOT_FOUND as "this id was
  // never created / has expired from the in-memory runs Map" - masking a real, already-known
  // reason (e.g. an unavailable data provider) behind a misleading "not found" error instead of
  // surfacing why the run can't start.
  if (!row) return { ok: false, error: 'REPLAY_NOT_FOUND' };
  if (!row.session) {
    return {
      ok: false,
      error: row.error || `Replay ${id} has no runnable session (status=${row.status ?? 'UNKNOWN'}) - it never produced a session, most likely because its data provider returned no dataset at creation time.`,
      code: row.code,
      status: row.status,
    };
  }
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
  const row = runs.get(id) as { session?: ActiveReplaySession; status?: string; error?: string; code?: string } | undefined;
  if (!row) return { ok: false, error: 'REPLAY_NOT_FOUND' };
  if (!row.session) {
    return {
      ok: false,
      error: row.error || `Replay ${id} has no runnable session (status=${row.status ?? 'UNKNOWN'})`,
      code: row.code,
      status: row.status,
    };
  }
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
    const decisionEvidence = enrichDecisionEvidenceWithOutcomes(session.decisionEvidence, session.barsBySymbol);
    const decisionEvidenceSummary = summarizeDecisionEvidence(decisionEvidence);
    const aiModeHonesty = buildAiModeHonesty(session.config.aiMode);
    writeReplayJson(session.replayId, 'trades.json', session.tradeLedger);
    writeReplayJson(session.replayId, 'rejected_orders.json', session.rejectedOrders);
    writeReplayJson(session.replayId, 'missed_opportunities.json', missedOpportunities);
    writeReplayJson(session.replayId, 'decision_evidence.json', decisionEvidence);
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
      ai: { mode: session.aiLabel, calls: session.aiCalls, costUsd: session.aiCostUsd, limit: replaySafety.aiCallLimit, honesty: aiModeHonesty },
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
        consensusFloors: {
          consensusApprovalThreshold: tradingSafety.consensusApprovalThreshold,
          minIndependentAgreeingAgents: tradingSafety.minIndependentAgreeingAgents,
          notLowered: true,
        },
        aiModeHonesty,
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
          'Decision-evidence forward MFE/MAE post-run only',
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
          replaySafety.aiModeHonestyDescription,
        ].filter(Boolean),
        limitations: [
          'Does not reconstruct complete historical market universe',
          'Fundamental/Macro/News/Kronos historical inputs unavailable or partial',
          'Consensus is CONSENSUS_MATH_REPLAY — not live ChiefTrader + LLM debate',
          'aiMode RECORDED_DECISION_REPLAY reads pit_decision_ledger when present; LIVE_MODEL_REPLAY may invoke routeConsensus with fail-closed HOLD',
          'AI_DISABLED cannot approve with QuantEngine alone — needs ≥2 independent agreeing agents at threshold 0.75',
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
      decisionEvidence,
      decisionEvidenceSummary,
      predictionOutcomeEvidence: decisionEvidenceSummary,
      // Daily Goal Campaign simulation (BACKTEST_FEATURE_PARITY_AUDIT.md P4) - advisory-only, never
      // fed back into sizing/consensus. daysTargetMet/postTargetMaxDrawdownPct are empty/0 whenever
      // config.campaignEnabled is false (the default), never fabricated.
      campaign: {
        enabled: session.config.campaignEnabled,
        dailyTargetType: session.config.dailyTargetType,
        dailyTargetAmount: session.config.dailyTargetAmount,
        targetAchievedAction: session.config.targetAchievedAction,
        daysTargetMet: [...session.campaign.daysTargetMet].sort(),
        dailyRealizedByDate: Object.fromEntries(
          [...session.campaign.dailyRealizedByDate.entries()].map(([d, v]) => [d, Number(v.toFixed(4))]),
        ),
        postTargetMaxDrawdownPct: Number(session.campaign.postTargetMaxDrawdownPct.toFixed(4)),
        note: 'TRAIL_STOPS_ONLY applies the same BUY soft-lock as LOCK_AND_IDLE in this simulation - it does not additionally tighten open positions\' trailing stops (that math stays PortfolioMonitor.trailingStopPct\'s alone, not reimplemented here).',
      },
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