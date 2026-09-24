/**
 * Real defect fix (2026-09-09, operator-reported "why didn't Argus catch stocks that moved
 * yesterday" investigation). MissedOpportunityDetector.ts persists PENDING missed-opportunity
 * records (runMissedOpportunityDetectionCycle -> persistMissedOpportunities) but nothing in
 * production ever called its own evaluation half (getPendingEvaluations / evaluateAgainstPriceSeries
 * / persistEvaluation) - confirmed live: every one of 592 rows across this table's entire history
 * was still evaluation_status='PENDING'. This worker is that missing caller, mirroring
 * PredictionOutcomeEvaluator.ts's own proven pattern exactly (same real-bars source, same
 * never-fabricate-on-missing-data contract): only real HistoricalDataGateway 1Min bars decide
 * max favorable/adverse excursion; a symbol with no bar history in the window is left PENDING,
 * never guessed.
 *
 * Diagnostic-only, same as MissedOpportunityDetector.ts itself: never imports RiskEngine, OMS, or
 * BrokerManager, never emits TRADE_IDEA_GENERATED, and this evaluation can never affect a live
 * decision - it only tells the operator, in hindsight, how large a miss actually was.
 */
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { continuousIntelligence } from '../config/continuousIntelligence';
import {
  getPendingEvaluations,
  evaluateAgainstPriceSeries,
  persistEvaluation,
  recordNoDataAttempt,
} from './MissedOpportunityDetector';
import { createSingleFlightGuard, type SingleFlightGuard, type SingleFlightIntervalMetrics } from '../core/singleFlightInterval';

export class MissedOpportunityEvaluator {
  private intervalId: NodeJS.Timeout | null = null;
  // P1-A remediation (2026-09-14) - see PredictionOutcomeEvaluator.ts's identical comment: the
  // guard is intrinsic to evaluatePending() itself, protecting every caller, not just the timer.
  private guard: SingleFlightGuard = createSingleFlightGuard((e) => console.error('[MissedOpportunityEvaluator] Cycle failed', e));

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => { void this.evaluatePending(); }, continuousIntelligence.missedOpportunityEvaluationIntervalMs);
    void this.evaluatePending();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** P1-A remediation observability (2026-09-14) - see ConsensusDebateOutcomeEvaluator.ts's
   *  identical comment: this evaluator's own query was already properly bounded/filtered, but the
   *  bare-setInterval overlap risk was structurally the same across every evaluator in this family. */
  getMetrics(): SingleFlightIntervalMetrics {
    return this.guard.getMetrics();
  }

  async evaluatePending(now: Date = new Date()): Promise<void> {
    await this.guard.run(() => this.runCycle(now));
  }

  private async runCycle(now: Date): Promise<void> {
    const nowMs = now.getTime();
    // A record is only due once its own evaluation window has actually elapsed - reusing a single
    // global cutoff (rather than per-record) is safe today because every live caller passes the
    // same configured horizon, matching getPendingEvaluations()'s own existing contract.
    const horizonMs = continuousIntelligence.missedOpportunityEvaluationHorizonMinutes * 60_000;
    const horizonElapsedBeforeIso = new Date(nowMs - horizonMs).toISOString();
    const pending = await getPendingEvaluations(horizonElapsedBeforeIso);

    for (const record of pending) {
      try {
        const detectedAtMs = new Date(record.detectedAt).getTime();
        const windowEndMs = detectedAtMs + record.evaluationHorizonMinutes * 60_000;

        let bars = await historicalDataGateway.getBars(record.symbol, '1Min', detectedAtMs, windowEndMs);
        if (bars.length < 2) {
          try {
            await historicalDataGateway.ensureBars(record.symbol, '1Min', detectedAtMs, windowEndMs);
          } catch {
            // Real defect fix (Batch 2, 2026-09-23): ensureBars() throws when the provider
            // genuinely has no bars for this symbol/window (HistoricalDataGateway.ts's own "No
            // historical bars available" error - delisted symbol, provider gap). This used to
            // propagate to the catch block below, which only logged and left the record PENDING -
            // re-selected and re-attempted on every single future cycle, forever. Swallow it here
            // (still never fabricates a bar) and fall through to the bounded-retry accounting.
          }
          bars = await historicalDataGateway.getBars(record.symbol, '1Min', detectedAtMs, windowEndMs);
        }
        if (bars.length < 2) {
          // Still no real data after a real fetch attempt - never fabricate. Bounded retry: only
          // after missedOpportunityMaxEvaluationAttempts real misses does this record stop being
          // re-selected (see recordNoDataAttempt()'s own doc comment for why this is safe).
          await recordNoDataAttempt(record.id, continuousIntelligence.missedOpportunityMaxEvaluationAttempts, now);
          continue;
        }

        // Prefer the record's own stored detection price (real quote at detection time, now that
        // the write-side hardcoded-null bug is fixed) when present; fall back to the first real
        // bar in the window for older/legacy rows that still predate that fix.
        const priceAtDetection = record.priceAtDetection ?? bars[0].close;
        const observedPrices = bars.map((b) => b.close);
        const evaluation = evaluateAgainstPriceSeries(priceAtDetection, observedPrices);
        if (!evaluation) continue;

        await persistEvaluation(record.id, evaluation, now);
      } catch (e) {
        console.error(`[MissedOpportunityEvaluator] Failed to evaluate ${record.symbol} (${record.id})`, e);
      }
    }
  }
}

export const missedOpportunityEvaluator = new MissedOpportunityEvaluator();
