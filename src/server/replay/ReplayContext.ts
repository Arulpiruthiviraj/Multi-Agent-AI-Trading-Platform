/**
 * Active historical replay session. Replaces clock + broker only.
 * LIVE tradingEngine flags are not flipped on. Organic paper ignores REPLAY fills.
 */
import { ReplayClock } from '../engines/backtest/ReplayClock';
import { InformationCutoff } from './InformationCutoff';
import { HistoricalReplayBroker } from '../../brokers/HistoricalReplayBroker';
import type { CanonicalDataset, ResearchBar } from '../research/ohlcvTypes';
import type { DataQualityReport } from '../research/dataQuality';
import type { HistoricalNewsProvider } from './HistoricalNewsProvider';
import { replaySafety } from './replaySafety';

export type ReplayRunStatus =
  | 'READY'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'DATA_UNAVAILABLE'
  | 'PARTIAL';

export type ReplayAiMode = 'LIVE_MODEL_REPLAY' | 'RECORDED_DECISION_REPLAY' | 'DISABLED';
export type ReplaySpeed = '1x' | '10x' | '100x' | 'MAX' | 'STEP';

export interface ReplayConfig {
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  market: string;
  exchange: string;
  timezone: string;
  symbols: string[];
  universeSource: string;
  universeAsOf: string | null;
  frequency: string;
  initialCapital: number;
  allocationBudget: number;
  costProfile: string;
  buyingPower: number;
  shortSelling: boolean;
  fractionalShares: boolean;
  extendedHours: boolean;
  dataProvider: string;
  newsProvider: string;
  aiMode: ReplayAiMode;
  strategyIds: string[];
  agents: string[];
  riskProfile: string;
  maxDailyLoss: number;
  maxTradesPerDay: number;
  maxPositionSize: number;
  maxPortfolioExposure: number;
  randomSeed: number;
  speed: ReplaySpeed;
  /**
   * Daily Goal Campaign simulation (additive, off by default - matches settings.campaign_enabled's
   * own default-off). Advisory/soft-lock only, same as live: never lowers consensus, never invents
   * parallel sizing, never calls placeOrder/OMS directly - it only skips a BUY idea before
   * submitThroughRiskAndOms is called for it. See CampaignTracker.ts for the live equivalent this
   * mirrors (a separate, isolated simulation - live's in-memory campaignBuyLock/ideaGenerationGate
   * singletons are never touched from replay).
   */
  campaignEnabled: boolean;
  dailyTargetAmount: number;
  dailyTargetType: 'DOLLAR' | 'PERCENT';
  targetAchievedAction: 'LOCK_AND_IDLE' | 'TRAIL_STOPS_ONLY' | 'CONTINUE';
}

export interface ReplayEvent {
  replayId: string;
  eventId: string;
  timestamp: string;
  historicalTimestamp: number;
  type: string;
  symbol?: string;
  payload: Record<string, unknown>;
  source: string;
  engine: string;
  dataHash: string;
}

export interface ActiveReplaySession {
  replayId: string;
  status: ReplayRunStatus;
  config: ReplayConfig;
  clock: ReplayClock;
  cutoff: InformationCutoff;
  broker: HistoricalReplayBroker;
  datasets: CanonicalDataset[];
  quality: DataQualityReport;
  datasetHash: string;
  configurationHash: string;
  replayHash: string;
  news: HistoricalNewsProvider;
  events: ReplayEvent[];
  noTrade: Record<string, number>;
  equity: Array<{ t: number; equity: number; cash: number; drawdownPct: number }>;
  peakEquity: number;
  pauseRequested: boolean;
  stopRequested: boolean;
  stepRequested: boolean;
  aiCalls: number;
  aiCostUsd: number;
  aiLabel: string;
  partial: boolean;
  waiters: Map<string, () => void>;
  barsBySymbol: Map<string, ResearchBar[]>;
  openStops: Map<string, { stop: number | null; target: number | null; entryTraceId: string; entryPrice: number; peakPrice: number; thesis: import('../quant/analysis/ThesisInvalidation').StoredThesis | null }>;
  /** ARGUS_DISCOVERY mode only - currently "active" symbols per the point-in-time liquidity screen. */
  activeDiscoveredSymbols: Set<string>;
  /** ARGUS_DISCOVERY mode only - historical timestamp each symbol first became active. */
  discoveredAt: Map<string, number>;
  /** ARGUS_DISCOVERY mode only - counts processTimestamp calls to pace the rescan cadence. */
  discoveryTickCounter: number;
  tradePnls: number[];
  /** Auditable fill ledger for report / export — not organic paper. */
  tradeLedger: ReplayTradeRecord[];
  rejectedOrders: Array<{
    timestamp: number;
    symbol: string;
    side: string;
    reason: string;
    traceId?: string;
    rejectionGate?: string | null;
  }>;
  agentAvailability: Record<string, { status: string; reason: string }>;
  /**
   * Additive decision evidence for machine analysis (votes, consensus, risk gates).
   * Forward MFE/MAE attached only after terminal status — see decisionEvidence.ts.
   */
  decisionEvidence: import('./decisionEvidence').DecisionEvidenceRecord[];
  /** Total symbol-timestamp evaluation instances entering the main loop body (funnel denominator). */
  evaluationsAttempted: number;
  /**
   * Total symbol-timestamp-STRATEGY passes (one increment per iteration of the per-symbol
   * `for (const strategyId of session.config.strategyIds)` loop). With a single strategyId this
   * equals evaluationsAttempted minus DATA_UNAVAILABLE/INSUFFICIENT_SAMPLE/exit-continues, but with
   * ALL_CORE (multiple strategyIds) NO_VALID_STRATEGY is bumped once per strategy per symbol-tick,
   * so it must be compared against this counter, not evaluationsAttempted, or ideasGenerated
   * silently clamps to 0 once NO_VALID_STRATEGY exceeds the symbol-tick count.
   */
  strategyPassesAttempted: number;
  /** Real tick-loop progress (set in runReplayLoop) - not derived/approximated client-side. Used by the UI progress bar. */
  totalBars: number;
  currentBarIndex: number;
  currentTimestamp: number | null;
  /** Post-run-only retrospective candidate pool: consensus rejections with a reference price. Never read during the live decision loop. */
  rejectionsForRetrospective: Array<{
    symbol: string;
    timestamp: number;
    reason: string;
    referencePrice: number;
    agentVotes?: Array<{ agent: string; side: string; confidence: number; weight: number | null }>;
    weightedConfidence?: number;
    independentAgreeingAgents?: number;
  }>;
  /** Per-agent idea tally for the run (agent name -> counts), built up as ideas are generated. */
  agentIdeaStats: Record<string, { ideas: number; buyIdeas: number; sellIdeas: number; confidenceSum: number }>;
  /** Coarse per-stage wall-clock timing (replay processing time, not simulated market latency). */
  stageDurations: Record<string, { totalMs: number; count: number }>;
  replayStartedAtMs: number;
  /** Daily Goal Campaign simulation state - see ReplayConfig.campaignEnabled's header comment. */
  campaign: {
    /** NY trading-date string the BUY soft-lock currently applies to, or null if unlocked. Compared
     *  directly against the current trading date on every check - a stale prior-day lock therefore
     *  never needs an explicit day-boundary reset step, it just naturally stops matching. */
    lockedForDate: string | null;
    lockAction: 'LOCK_AND_IDLE' | 'TRAIL_STOPS_ONLY' | null;
    /** Realized P&L accumulated so far for each NY trading date seen in this replay. */
    dailyRealizedByDate: Map<string, number>;
    /** Every NY trading date on which the target was reached (locked or CONTINUE alike). */
    daysTargetMet: Set<string>;
    /** Equity peak observed after each date's target-reached moment, for post-target drawdown. */
    postTargetEquityPeakByDate: Map<string, number>;
    /** Worst post-target-reached drawdown fraction across the whole replay (0-1). */
    postTargetMaxDrawdownPct: number;
  };
}

export interface ReplayTradeRecord {
  timestamp: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  strategyId: string;
  traceId: string;
  fees: number;
  slippage: number;
  realizedPnl: number | null;
  executionModel: 'NEXT_BAR_OPEN';
  executionEnvironment: 'HISTORICAL_REPLAY';
}

let active: ActiveReplaySession | null = null;

export function getActiveReplaySession(): ActiveReplaySession | null {
  return active;
}

export function setActiveReplaySession(session: ActiveReplaySession | null): void {
  active = session;
}

export function isReplayActive(): boolean {
  return active != null && (active.status === 'RUNNING' || active.status === 'PAUSED');
}

export function notifyReplayOrder(traceId: string): void {
  const w = active?.waiters.get(traceId);
  if (w) {
    w();
    active?.waiters.delete(traceId);
  }
}

export function waitReplayOrder(traceId: string, timeoutMs = 8000): Promise<void> {
  if (!active) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      active?.waiters.delete(traceId);
      resolve();
    }, timeoutMs);
    active.waiters.set(traceId, () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Point-in-time bars for RiskEngine correlation / sizing.
 * Strict prefix: timestamp < clock.now() — same cutoff as decision bars in FullArgusReplayEngine.
 * The bar at T is the fill bar (NEXT_BAR_OPEN); it must not enter decision-time closes.
 */
export function replayVisibleBars(symbol: string): ResearchBar[] {
  if (!active) return [];
  const bars = active.barsBySymbol.get(symbol.toUpperCase()) || [];
  const t = active.clock.now();
  return bars.filter((b) => b.timestamp < t);
}

export function defaultReplayConfig(partial?: Partial<ReplayConfig>): ReplayConfig {
  const explicitSymbols = partial?.symbols;
  const hasExplicitSymbols = Array.isArray(explicitSymbols) && explicitSymbols.length > 0;
  const universeSource = partial?.universeSource
    ?? (hasExplicitSymbols ? 'OPERATOR_SELECTED' : replaySafety.universeSourceDefault);
  return {
    startDate: '2024-01-02',
    endDate: '2024-12-31',
    market: 'US',
    exchange: 'NYSE',
    timezone: replaySafety.defaultTimezone,
    symbols: hasExplicitSymbols ? explicitSymbols! : [],
    universeSource,
    universeAsOf: null,
    frequency: replaySafety.defaultFrequency,
    initialCapital: replaySafety.defaultInitialCapital,
    allocationBudget: replaySafety.defaultAllocationBudget,
    costProfile: replaySafety.defaultCostProfile,
    buyingPower: replaySafety.defaultInitialCapital,
    shortSelling: replaySafety.shortSellingDefault,
    fractionalShares: replaySafety.fractionalSharesDefault,
    extendedHours: replaySafety.extendedHoursDefault,
    dataProvider: 'golden_replay',
    newsProvider: 'golden_replay_news',
    aiMode: replaySafety.defaultAiMode as ReplayAiMode,
    strategyIds: ['MOMENTUM_BREAKOUT'],
    agents: ['QuantEngine', 'TechnicalAgent', 'NewsAgent', 'ChiefTrader', 'RiskAgent'],
    riskProfile: 'Balanced',
    maxDailyLoss: 1000,
    maxTradesPerDay: 20,
    maxPositionSize: replaySafety.defaultAllocationBudget,
    maxPortfolioExposure: 1,
    randomSeed: 1,
    speed: 'MAX',
    campaignEnabled: false,
    dailyTargetAmount: 0,
    dailyTargetType: 'DOLLAR',
    targetAchievedAction: 'CONTINUE',
    ...partial,
  };
}
