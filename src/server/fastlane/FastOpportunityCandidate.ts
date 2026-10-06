/**
 * Fast Opportunity Lane — candidate type definition.
 *
 * 2026-10-05: ChatGPT architecture review concluded that Argus couples opportunity
 * discovery too tightly to scarce streaming-subscription allocation. The normal
 * discovery lane (broad scanner → universe ranking → aging fairness → 90-line
 * allocation → challenger scoring) is preserved untouched. This parallel fast lane
 * handles event-driven opportunities that need evaluation in seconds/minutes,
 * not hours.
 *
 * CRITICAL SAFETY PROPERTIES:
 * - FastOpportunityCandidate has NO broker authority. It is a research object only.
 * - It NEVER bypasses ChiefTraderAgent, RiskEngine, PositionSizing, OMS, or BrokerManager.
 * - It NEVER places orders directly. There is no FastOrderService, no FastBrokerPath.
 * - Execution always goes through the existing protected spine.
 * - Feature-flagged: FAST_OPPORTUNITY_LANE_ENABLED (default false, PAPER/research only).
 */

/** How a fast opportunity was detected. */
export type FastDetectionSource =
  | 'NEWS_CATALYST'
  | 'SEC_FILING'
  | 'PRICE_ACCELERATION'
  | 'RVOL_SPIKE'
  | 'RELATIVE_STRENGTH'
  | 'OPENING_RANGE'
  | 'GAP_CONTINUATION'
  | 'MACRO_THEME';

/** Data tier required to evaluate this candidate. */
export type DataTier =
  | 'TIER_0'  // Broad low-cost observation (snapshots, news, periodic bars) — already have it
  | 'TIER_1'  // Candidate interrogation: fresh snapshot + recent 1m/5m bars + liquidity/spread
  | 'TIER_2'  // Temporary high-priority stream for serious candidate
  | 'TIER_3'; // Protected stream: active setup, pending order, open position

/** Lifecycle state of a fast opportunity candidate. */
export type FastOpportunityState =
  | 'DETECTED'    // Just created, awaiting data acquisition
  | 'DATA_READY'  // Sufficient data acquired, awaiting strategy evaluation
  | 'EVALUATING'  // Strategy/agents currently evaluating
  | 'NO_SETUP'    // Evaluated, no valid setup found
  | 'WATCH'       // Valid setup but not yet actionable (waiting for trigger/confirmation)
  | 'ACTIONABLE'  // Valid setup, ready for ChiefTrader consensus
  | 'EXPIRED';    // Past expiresAt, no longer valid

/** Strategy families that could apply to this candidate (for resource prioritization). */
export type StrategyApplicability =
  | 'MOMENTUM_CONTINUATION'
  | 'BREAKOUT'
  | 'RELATIVE_STRENGTH'
  | 'EVENT_MOMENTUM'
  | 'GAP_CONTINUATION'
  | 'OPENING_RANGE'
  | 'VWAP_CONTINUATION'
  | 'NOT_APPLICABLE';

/**
 * A fast opportunity candidate. Pure research object — no broker authority,
 * no order placement capability. Expires automatically.
 */
export interface FastOpportunityCandidate {
  /** Unique ID for tracing. */
  id: string;
  symbol: string;
  detectedAt: number;       // ms epoch
  expiresAt: number;        // ms epoch — intraday opportunities decay
  lastEvidenceAt: number;   // ms epoch of most recent supporting evidence

  detectionSource: FastDetectionSource;
  catalyst?: string;        // e.g., "Puma 9 launch", "earnings beat"

  // Anomaly evidence (whichever triggered detection)
  priceAnomaly?: {
    movePct: number;
    timeframeMin: number;
    vsBaseline: 'OPEN' | 'PREV_CLOSE' | 'VWAP' | 'SMA20';
  };
  volumeAnomaly?: {
    rvol: number;           // relative volume vs. average
    timeframeMin: number;
  };
  relativeStrength?: {
    vsBenchmark: 'SPY' | 'QQQ' | 'SECTOR_ETF';
    rsPct: number;
    timeframeMin: number;
  };

  sessionContext: {
    tradingDateStr: string;
    minutesSinceOpen: number;
    isRegularHours: boolean;
  };

  liquidityEvidence: {
    dollarVolume: number | null;
    spreadBps: number | null;
    meetsMinLiquidity: boolean;
  };

  // What data is needed to evaluate this candidate
  requiredDataTier: DataTier;
  currentDataTier: DataTier;

  // Which strategy families might apply (for prioritization, not approval)
  applicableStrategies: StrategyApplicability[];

  state: FastOpportunityState;
  stateHistory: Array<{ state: FastOpportunityState; at: number; reason: string }>;
}

/**
 * 2026-10-06 (Fast Opportunity Lane Evaluator, research/paper only): result of evaluating a fast
 * candidate through EXISTING strategy/quant logic. This object has NO execution authority - it is
 * never passed to BrokerManager, OMS, or RiskEngine, and this phase deliberately does NOT emit it
 * into ChiefTrader/emitTradeIdea either (see fastLaneEvaluator.ts's own header). Evaluation and
 * execution integration are kept separately testable; a later, separately-authorized phase may
 * convert a VALID_STRATEGY_EVIDENCE result into the existing canonical trade-idea pathway.
 */
export type FastEvaluationStatus =
  | 'INSUFFICIENT_DATA'
  | 'NO_VALID_SETUP'
  | 'VALID_STRATEGY_EVIDENCE'
  | 'EXPIRED'
  | 'DATA_STALE'
  | 'ERROR';

/** Per-required-feature data sufficiency, never fabricated when a strategy genuinely lacks it. */
export type DataSufficiencyGrade = 'AVAILABLE' | 'MISSING' | 'STALE' | 'NOT_APPLICABLE';

export interface FastEvaluationResult {
  /** 2026-10-06 (Fast Lane Canonical Integration): stable identity for this specific evaluation
   *  run - distinct from candidateId (one candidate can be evaluated more than once across its
   *  lifetime, e.g. after a cooldown). Used for provenance/idempotency when converting to a
   *  canonical idea. Deterministic (candidateId + evaluatedAt), never a random UUID, so the same
   *  evaluation result replayed through tests/logs always carries the same id. */
  id: string;
  candidateId: string;
  symbol: string;
  evaluatedAt: number;
  /** The real timestamp (ms epoch) of the underlying data this evaluation is based on - distinct
   *  from evaluatedAt, which is when the evaluation code ran. Never assumed equal. */
  dataAsOf: number | null;
  /** Real provenance of the price data this evaluation used - never silently upgraded to imply
   *  live quality when the underlying feed was delayed/cached. */
  marketDataType: 'REAL_TIME' | 'DELAYED' | 'CACHED_BARS' | 'UNKNOWN';

  /** Every strategy ID the real evaluateAll() call actually evaluated for this candidate. */
  strategiesEvaluated: string[];
  /** The subset of strategiesEvaluated whose triggerMet was true, by strategy ID. */
  validTriggers: string[];
  bestStrategy?: string;
  direction?: 'BUY' | 'SELL';
  confidence?: number;
  /** Real EV/RR only when the underlying strategy evaluation actually produced one - never
   *  fabricated for a status that didn't reach that stage. */
  expectedValue?: number | null;
  riskReward?: number | null;

  status: FastEvaluationStatus;
  reasonCodes: string[];

  /** Per-required-feature sufficiency, keyed by feature name (e.g. 'bars_1m', 'prevClose',
   *  'volume'). Populated honestly - a feature this evaluation path never checks is simply
   *  absent from this map, not defaulted to AVAILABLE. */
  dataSufficiency: Record<string, DataSufficiencyGrade>;
}
