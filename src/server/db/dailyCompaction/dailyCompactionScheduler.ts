/**
 * Daily Learning Compaction, Phase 1 - scheduler. Mirrors operationalRetention.ts's own
 * start/stop/sweep pattern exactly rather than inventing a new one. Off by default
 * (observabilityConfig.dailyCompactionEnabled) and NOT yet called from the live boot sequence
 * (ArgusCoreBoot.ts / server.ts) - this phase ships the capability; wiring it into automatic daily
 * operation against the real production DB is a deliberate, separate operator decision once Phase 1
 * has been reviewed, matching this task's own "stop after Phase 1" instruction.
 */
import { observabilityConfig } from '../../config/observability';
import { observabilityEventsSource } from './observabilityEventsSource';
import { runDailyCompactionForDate, purgeVerifiedDays } from './DailyCompactionOrchestrator';
import { todayTradingDateStr } from './tradingDayWindow';

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Compacts every closed day back through the retention window that isn't yet VERIFIED/PURGED,
 *  then purges whatever is now eligible. Never touches today / the currently-open trading day. */
export async function runDailyCompactionSweep(nowMs: number = Date.now()): Promise<void> {
  const today = todayTradingDateStr(nowMs);
  // Walk back retentionDays+1 calendar days so a day that was never compacted (e.g. the scheduler
  // was off) still gets a real chance to compact before it ages past the retention cutoff.
  for (let i = 1; i <= observabilityConfig.retentionDays + 1; i++) {
    const d = new Date(nowMs - i * 24 * 60 * 60 * 1000);
    const tradingDate = todayTradingDateStr(d.getTime());
    if (tradingDate === today) continue;
    await runDailyCompactionForDate(observabilityEventsSource, tradingDate, nowMs);
  }
  await purgeVerifiedDays(observabilityEventsSource, observabilityConfig.retentionDays, nowMs);
}

export function startDailyCompactionSweep(): void {
  if (!observabilityConfig.dailyCompactionEnabled) return;
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void runDailyCompactionSweep(); }, observabilityConfig.dailyCompactionSweepMs);
  if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {
    (sweepTimer as NodeJS.Timeout).unref();
  }
  void runDailyCompactionSweep();
}

export function stopDailyCompactionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
