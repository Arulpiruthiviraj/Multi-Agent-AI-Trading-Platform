/**
 * Phase 7E (Self-improving calibration, observational stage, 2026-08-27). Periodically re-runs
 * runCalibrationValidationCycle() (CalibrationCandidateBuilder.ts) against real, current
 * prediction_outcomes data. Purely additive: writes only to learning_versions/promotion_decisions
 * (Phase 4H's existing ledger) - never to agent_confidence_calibration, never imports
 * ChiefTraderAgent/RiskEngine/OMS/BrokerManager, never emits a trade-affecting event. Starting or
 * stopping this worker has zero effect on live consensus.
 */
import { timedWorkCycle } from '../observability/workCycle';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { runCalibrationValidationCycle } from './CalibrationCandidateBuilder';
import { createSingleFlightGuard, type SingleFlightGuard } from '../core/singleFlightInterval';
import { tradingSafety } from '../config/tradingSafety';
import { classifyMarketSession } from '../replay/marketSession';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

class CalibrationValidationWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private lastRunAt: string | null = null;
  private lastRunCount: number = 0;
  private deferredCycles = 0;
  // Real gap found and fixed (2026-09-15, post-forensic-audit timer sweep): runOnce() calls
  // runCalibrationValidationCycle(), which iterates every tracked (agent, bucket) pair and, per
  // pair, calls ChampionChallengerService.createShadowVersion()/promoteToCandidate() - an overlap
  // (a slow cycle outlasting the 900s interval) could create two concurrent shadow versions for
  // the SAME versionType, an avoidable ambiguity in the learning_versions ledger. Not a live-
  // decision-affecting risk (this worker never touches agent_confidence_calibration - see this
  // file's own header), but cheap, defensive, and consistent with every other periodic worker.
  private readonly guard: SingleFlightGuard = createSingleFlightGuard(
    (e) => console.error('[CalibrationValidationWorker] cycle failed', e),
  );

  start(): void {
    if (this.intervalId) return;
    void this.runOnce();
    this.intervalId = setInterval(() => { void this.runOnce(); }, runtimeIntervals.calibrationValidationCycleMs);
    console.log(`[CalibrationValidationWorker] Started (cycle every ${runtimeIntervals.calibrationValidationCycleMs}ms) - observational only, never touches live calibration.`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** True when this cycle must not run now: regular session + deferral enabled. Pure over its inputs for tests. */
  shouldDeferNow(nowMs: number = Date.now()): boolean {
    return tradingSafety.calibrationValidationDeferDuringRegularSession
      && classifyMarketSession(nowMs, 'America/New_York', false) === 'REGULAR';
  }

  async runOnce(): Promise<void> {
    if (this.shouldDeferNow()) {
      this.deferredCycles++;
      observeSafe(() => structuredLogger.info('calibration_validation_deferred', {
        category: 'SYSTEM', eventType: 'CALIBRATION_VALIDATION_DEFERRED', component: 'CalibrationValidationWorker',
        deferredCycles: this.deferredCycles,
        reasoning: 'Regular session: observational calibration validation skipped so the trading-critical event loop is not shared with 20-77s of research CPU. Runs outside the regular session.',
      }));
      return;
    }
    await this.guard.run(async () => {
      const results = await timedWorkCycle('CalibrationValidationWorker', () => runCalibrationValidationCycle());
      this.lastRunAt = new Date().toISOString();
      this.lastRunCount = results.length;
    });
  }

  getGuardMetrics() {
    return this.guard.getMetrics();
  }

  getStatus(): { lastRunAt: string | null; lastRunCount: number; running: boolean } {
    return { lastRunAt: this.lastRunAt, lastRunCount: this.lastRunCount, running: this.intervalId !== null };
  }
}

export const calibrationValidationWorker = new CalibrationValidationWorker();
