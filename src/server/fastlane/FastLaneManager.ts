/**
 * Fast Opportunity Lane — candidate lifecycle manager.
 *
 * 2026-10-05: Manages FastOpportunityCandidate lifecycle from detection through
 * expiration. This manager has NO broker authority, places NO orders, and
 * bypasses NOTHING. When a candidate becomes ACTIONABLE, it is handed to the
 * EXISTING ChiefTraderAgent consensus path — the same path the normal lane uses.
 *
 * Safety invariants (enforced by architecture tests):
 * - No import of BrokerManager, no placeOrder/cancelOrder calls
 * - No direct RiskEngine mutation (evaluation only via existing interfaces)
 * - No OMS order creation
 * - Feature-flagged: all methods no-op when FAST_OPPORTUNITY_LANE_ENABLED != 'true'
 */

import { randomUUID } from 'node:crypto';
import type {
  FastOpportunityCandidate,
  FastDetectionSource,
  FastOpportunityState,
  DataTier,
  StrategyApplicability,
} from './FastOpportunityCandidate';
import { isFastLaneEnabled } from './fastLaneConfig';
import {
  logFastOpportunityDetected,
  logFastExpired,
} from './fastLaneObservability';

// Default time-to-live for fast candidates by detection source (ms).
// Intraday opportunities decay — a news catalyst from 3 hours ago is not actionable.
const DEFAULT_TTL_MS: Record<FastDetectionSource, number> = {
  NEWS_CATALYST: 60 * 60_000,       // 1 hour
  SEC_FILING: 2 * 60 * 60_000,      // 2 hours (filings have longer shelf life)
  PRICE_ACCELERATION: 30 * 60_000,  // 30 min (momentum decays fast)
  RVOL_SPIKE: 30 * 60_000,          // 30 min
  RELATIVE_STRENGTH: 60 * 60_000,   // 1 hour
  OPENING_RANGE: 90 * 60_000,       // 90 min (opening range valid through midday)
  GAP_CONTINUATION: 45 * 60_000,    // 45 min
  MACRO_THEME: 2 * 60 * 60_000,     // 2 hours
};

export interface FastCandidateInput {
  symbol: string;
  detectionSource: FastDetectionSource;
  catalyst?: string;
  priceAnomaly?: FastOpportunityCandidate['priceAnomaly'];
  volumeAnomaly?: FastOpportunityCandidate['volumeAnomaly'];
  relativeStrength?: FastOpportunityCandidate['relativeStrength'];
  liquidityEvidence: FastOpportunityCandidate['liquidityEvidence'];
  requiredDataTier?: DataTier;
  applicableStrategies?: StrategyApplicability[];
  ttlMs?: number;
}

class FastLaneManager {
  private candidates = new Map<string, FastOpportunityCandidate>();
  private static instance: FastLaneManager | null = null;

  static getInstance(): FastLaneManager {
    if (!FastLaneManager.instance) {
      FastLaneManager.instance = new FastLaneManager();
    }
    return FastLaneManager.instance;
  }

  /**
   * Inject a new fast opportunity candidate (event-driven).
   * Returns null if the lane is disabled or the candidate is a duplicate.
   */
  injectCandidate(input: FastCandidateInput): FastOpportunityCandidate | null {
    if (!isFastLaneEnabled()) return null;
    const symbol = input.symbol.toUpperCase();

    // 2026-10-08 (D3): expiry was previously enforced only opportunistically inside
    // getActiveCandidates(), which has no production callers - a never-evaluated,
    // never-converted candidate could sit non-EXPIRED forever and, via the dedup below,
    // silently block re-injection for its symbol. Sweep on every injection (cheap O(n)
    // over a small map) so TTLs are actually enforced.
    this.expireStale();

    // Deduplicate: one active candidate per symbol at a time.
    for (const c of this.candidates.values()) {
      if (c.symbol === symbol && c.state !== 'EXPIRED' && c.state !== 'NO_SETUP') {
        return null;
      }
    }

    const now = Date.now();
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS[input.detectionSource];
    const candidate: FastOpportunityCandidate = {
      id: randomUUID(),
      symbol,
      detectedAt: now,
      expiresAt: now + ttl,
      lastEvidenceAt: now,
      detectionSource: input.detectionSource,
      catalyst: input.catalyst,
      priceAnomaly: input.priceAnomaly,
      volumeAnomaly: input.volumeAnomaly,
      relativeStrength: input.relativeStrength,
      liquidityEvidence: input.liquidityEvidence,
      requiredDataTier: input.requiredDataTier ?? 'TIER_1',
      currentDataTier: 'TIER_0',
      applicableStrategies: input.applicableStrategies ?? [],
      state: 'DETECTED',
      stateHistory: [{ state: 'DETECTED', at: now, reason: `injected via ${input.detectionSource}` }],
    };

    this.candidates.set(candidate.id, candidate);
    logFastOpportunityDetected(candidate);
    return candidate;
  }

  /** Get all non-expired candidates. */
  getActiveCandidates(): FastOpportunityCandidate[] {
    this.expireStale();
    return [...this.candidates.values()].filter(
      (c) => c.state !== 'EXPIRED' && c.state !== 'NO_SETUP',
    );
  }

  /** Get a candidate by ID. */
  getCandidate(id: string): FastOpportunityCandidate | undefined {
    return this.candidates.get(id);
  }

  /** Transition a candidate to a new state (with history). */
  transitionState(id: string, to: FastOpportunityState, reason: string): boolean {
    const c = this.candidates.get(id);
    if (!c) return false;
    const now = Date.now();
    c.state = to;
    c.lastEvidenceAt = now;
    c.stateHistory.push({ state: to, at: now, reason });
    if (to === 'EXPIRED') {
      logFastExpired(id, c.symbol, to);
    }
    return true;
  }

  /**
   * Expire candidates past their TTL. Returns count expired.
   *
   * 2026-10-08 (D2): this manager previously never deleted anything - expireStale() only
   * transitioned state, so every injected candidate (including every per-symbol news injection)
   * accumulated in the Map forever: a slow, unbounded memory leak in a 24/7 process.
   * Terminal candidates are now REMOVED after their terminal transition is logged:
   * EXPIRED always, and NO_SETUP/WATCH/ACTIONABLE once also past TTL (a past-TTL ACTIONABLE is
   * no longer valid by definition - intraday opportunities decay - and the dedup in
   * injectCandidate already ignores EXPIRED/NO_SETUP, so removal changes no live decision).
   */
  expireStale(): number {
    const now = Date.now();
    let expired = 0;
    for (const c of this.candidates.values()) {
      if (c.state !== 'EXPIRED' && now > c.expiresAt) {
        this.transitionState(c.id, 'EXPIRED', 'TTL elapsed');
        expired++;
      }
    }
    for (const [id, c] of this.candidates) {
      const terminal = c.state === 'EXPIRED' || c.state === 'NO_SETUP' || c.state === 'WATCH' || c.state === 'ACTIONABLE';
      // EXPIRED is by construction always past TTL (both transition sites check Date.now() >
      // expiresAt first). Other terminal states are removed once their TTL elapses too - a
      // past-TTL ACTIONABLE is no longer valid by definition (intraday opportunities decay),
      // and the inject dedup already ignores EXPIRED/NO_SETUP, so removal changes no decision.
      if (terminal && (c.state === 'EXPIRED' || now > c.expiresAt)) {
        this.candidates.delete(id);
      }
    }
    return expired;
  }

  /** For tests: clear all candidates. */
  resetForTests(): void {
    this.candidates.clear();
  }

  /** For tests: get count. */
  countForTests(): number {
    return this.candidates.size;
  }
}

export const fastLaneManager = FastLaneManager.getInstance();
