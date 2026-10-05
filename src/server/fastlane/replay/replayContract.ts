/**
 * Fast Opportunity Lane — replay input contract.
 *
 * 2026-10-05: Defines the deterministic replay format for comparing
 * CURRENT PIPELINE vs CURRENT + FAST OPPORTUNITY LANE.
 *
 * A replay input is a JSON event log with:
 * - events: time-ordered market/catalyst events (the "recorded" data)
 * - normalLaneTimeline: recorded normal-lane decisions (admissions, challenger appearances, evaluations)
 * - expectedClassifications: per-symbol expected outcomes for validation
 *
 * The replay runner feeds events through the fast-lane injection path and
 * measures latency, then compares against the normal-lane timeline.
 */

/** A single recorded market event for replay. */
export interface ReplayEvent {
  /** ISO timestamp of when the event occurred in the recorded session. */
  at: string;
  /** Event type. */
  type: 'NEWS_CATALYST' | 'PRICE_ACCELERATION' | 'RVOL_SPIKE' | 'SNAPSHOT' | 'ADMISSION' | 'CHALLENGER_APPEARANCE' | 'EVALUATION' | 'IDEA';
  symbol: string;
  /** Event-specific payload. */
  payload: Record<string, unknown>;
}

/** Recorded normal-lane decision for a symbol. */
export interface NormalLaneRecord {
  symbol: string;
  /** When the symbol was first admitted (ISO) or null if never. */
  firstAdmittedAt: string | null;
  /** When the symbol first appeared in challenger scoring (ISO) or null. */
  firstChallengerAt: string | null;
  /** When the symbol was first evaluated (ISO) or null. */
  firstEvaluatedAt: string | null;
  admissionCount: number;
  challengerAppearances: number;
  ideaCount: number;
}

/** Per-symbol classification after replay. */
export type SymbolClassification =
  | 'DETECTED_EARLIER'      // Fast lane detected before normal lane
  | 'SAME'                  // Same detection time (within tolerance)
  | 'DETECTED_BUT_NO_SETUP' // Fast lane detected, but no valid setup
  | 'VALID_SETUP'           // Fast lane found a valid setup
  | 'INSUFFICIENT_EVIDENCE' // Not enough data to evaluate
  | 'NOT_APPROPRIATE_FOR_STRATEGY'; // Symbol not suitable for fast-lane strategies

/** Complete replay input. */
export interface ReplayInput {
  /** Identifier for this replay (e.g., "oct05-2026"). */
  replayId: string;
  /** Trading date. */
  tradingDate: string;
  /** Time-ordered events. */
  events: ReplayEvent[];
  /** Normal-lane records for comparison. */
  normalLane: NormalLaneRecord[];
  /** Expected classifications for validation. */
  expected?: Record<string, SymbolClassification>;
}

/** Result of replaying one symbol. */
export interface SymbolReplayResult {
  symbol: string;
  /** When the fast lane first detected this symbol (ISO) or null. */
  fastDetectedAt: string | null;
  /** Latency from event to candidate creation (ms). */
  detectionLatencyMs: number | null;
  /** Normal lane's first detection (from normalLane records). */
  normalDetectedAt: string | null;
  /** Latency improvement: normal - fast (positive = fast lane was faster). */
  latencyImprovementMs: number | null;
  classification: SymbolClassification;
}

/** Complete replay result. */
export interface ReplayResult {
  replayId: string;
  ranAt: string;
  symbols: SymbolReplayResult[];
  summary: {
    totalSymbols: number;
    detectedEarlier: number;
    same: number;
    medianImprovementMs: number | null;
    p90ImprovementMs: number | null;
  };
}
