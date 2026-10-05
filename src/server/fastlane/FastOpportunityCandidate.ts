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
 * Result of strategy evaluation for a fast candidate.
 * This feeds into the EXISTING ChiefTrader consensus — it does not bypass it.
 */
export interface FastEvaluationResult {
  candidateId: string;
  symbol: string;
  evaluatedAt: number;

  // Absolute eligibility (not relative ranking)
  triggerMet: boolean;
  expectedValuePasses: boolean;
  riskRewardPasses: boolean;
  freshnessPasses: boolean;
  dataSufficient: boolean;

  // Component scores for observability
  baseScore: number | null;
  momentumScore: number | null;
  gapPct: number | null;

  // Overall verdict
  verdict: 'ACTIONABLE' | 'WATCH' | 'NO_SETUP' | 'INSUFFICIENT_DATA' | 'EXPIRED';
  reasoning: string;
}
