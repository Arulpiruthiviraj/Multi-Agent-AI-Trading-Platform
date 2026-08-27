/**
 * Phase 7E (Self-improving calibration, observational stage, 2026-08-27). Periodically re-runs
 * runCalibrationValidationCycle() (CalibrationCandidateBuilder.ts) against real, current
 * prediction_outcomes data. Purely additive: writes only to learning_versions/promotion_decisions
 * (Phase 4H's existing ledger) - never to agent_confidence_calibration, never imports
 * ChiefTraderAgent/RiskEngine/OMS/BrokerManager, never emits a trade-affecting event. Starting or
 * stopping this worker has zero effect on live consensus.
 */
import { runtimeIntervals } from '../config/runtimeIntervals';
import { runCalibrationValidationCycle } from './CalibrationCandidateBuilder';

class CalibrationValidationWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private lastRunAt: string | null = null;
  private lastRunCount: number = 0;

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

  private async runOnce(): Promise<void> {
    try {
      const results = await runCalibrationValidationCycle();
      this.lastRunAt = new Date().toISOString();
      this.lastRunCount = results.length;
    } catch (e) {
      console.error('[CalibrationValidationWorker] cycle failed', e);
    }
  }

  getStatus(): { lastRunAt: string | null; lastRunCount: number; running: boolean } {
    return { lastRunAt: this.lastRunAt, lastRunCount: this.lastRunCount, running: this.intervalId !== null };
  }
}

export const calibrationValidationWorker = new CalibrationValidationWorker();
