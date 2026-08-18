/**
 * Optional scheduled auto-trading window. Off by default (`settings.autoTradeScheduleEnabled`).
 *
 * Design constraint: this must not become a second Autobot on/off mechanism living outside
 * TradingEngine. It only ever calls the existing `tradingEngine.toggle({ enabled })` - the exact
 * same call the UI's manual Start/Stop button makes - on a timer, when the real wall-clock time in
 * the user's configured `settings.autoTradeScheduleTimezone` (default America/New_York; any valid
 * IANA zone is accepted - see isValidTimezone in AutoTradeSchedule.ts) crosses the configured HH:MM
 * window (`autoTradeScheduleStartTime` / `autoTradeScheduleEndTime`). It never touches RiskEngine,
 * never adds a gate, and never places or blocks an individual order - once Autobot is "on" (by
 * schedule or by hand), every proposal still has to clear the real 24-gate RiskEngine ladder
 * exactly as before.
 *
 * Notably, RiskEngine's own `market_hours` gate (Alpaca /v2/clock; catalog order in
 * `config/riskGateOrder.json`) still independently blocks new entries whenever the real US
 * session is closed, regardless of what this schedule says. A window that starts before the
 * opening bell (engine already RUNNING) does not widen market hours: pre-open proposals still
 * fail `market_hours`, and at 09:30 America/New_York that gate evaluates from the clock, not
 * from this timer. This scheduler never calls RiskEngine and never auto-resumes
 * `TRADING_PAUSED` / `EMERGENCY_STOP`.
 *
 * Idempotent 09:30 activation: if Autobot is already `enabled` when the window says it should
 * be on, the tick is a no-op. It does not call `toggle()`, restart workers, respawn intervals,
 * or reset in-memory / SQLite positions and orders. `SystemBootstrap.start` and worker
 * `start()` methods are themselves guarded (`isRunning` / `intervalId` / open WebSocket).
 *
 * Ownership semantics while a schedule is enabled: the schedule is authoritative for the enabled
 * flag. If someone manually starts/stops Autobot mid-window while a schedule is active, the next
 * tick (`runtimeIntervals.autoTradeSchedulerMs`, default 60s) reconciles state back to what the
 * schedule says it should be. This is intentional - a schedule that a manual click can silently
 * and permanently override isn't a schedule - and is surfaced in the Settings UI copy so it isn't
 * a surprise.
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { tradingEngine } from '../engines/TradingEngine';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { getTimeHHMMInZone, getTradingDateStr, TRADING_TIMEZONE } from '../core/TradingCalendar';
import { isValidHHMM, isValidTimezone, isWithinScheduledWindow } from '../core/AutoTradeSchedule';

export class AutoTradeSchedulerWorker {
  private intervalId: NodeJS.Timeout | null = null;
  /** Once per NY session date + tradingState, so a 60s poll does not flood logs. */
  private lastIdempotentLogKey: string | null = null;

  start() {
    if (this.intervalId) return;
    console.log('[AutoTradeScheduler] Started.');
    this.intervalId = setInterval(() => this.tick().catch((e) => console.error('[AutoTradeScheduler] tick failed', e)), runtimeIntervals.autoTradeSchedulerMs);
    this.tick().catch((e) => console.error('[AutoTradeScheduler] initial tick failed', e));
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[AutoTradeScheduler] Stopped.');
    }
  }

  async tick() {
    const row = (await db.select().from(schema.settings).limit(1))[0];
    if (!row?.autoTradeScheduleEnabled) return; // feature off - no-op, zero behavior change

    const start = row.autoTradeScheduleStartTime;
    const end = row.autoTradeScheduleEndTime;
    const zone = isValidTimezone(row.autoTradeScheduleTimezone) ? row.autoTradeScheduleTimezone! : TRADING_TIMEZONE;
    if (!isValidHHMM(start) || !isValidHHMM(end)) {
      console.warn(`[AutoTradeScheduler] Schedule enabled but start/end time is invalid ("${start}"-"${end}"); skipping this tick rather than guessing.`);
      return;
    }

    const nowHHMM = getTimeHHMMInZone(new Date(), zone);
    const shouldBeEnabled = isWithinScheduledWindow(nowHHMM, start, end);
    const alreadyEnabled = tradingEngine.state.enabled === true;
    const tradingState = tradingEngine.state.tradingState;

    if (shouldBeEnabled === alreadyEnabled) {
      this.logIdempotentNoOp(shouldBeEnabled, tradingState, start, end, zone, nowHHMM);
      return;
    }

    const result = await tradingEngine.toggle({ enabled: shouldBeEnabled });
    if (!result.ok) {
      console.error(`[AutoTradeScheduler] Could not ${shouldBeEnabled ? 'enable' : 'disable'} Autobot per schedule (${start}-${end} ${zone}): ${result.error}`);
      return;
    }
    console.log(`[AutoTradeScheduler] ${shouldBeEnabled ? 'Enabled' : 'Disabled'} Autobot per configured schedule (${start}-${end} ${zone}, now ${nowHHMM}).`);
  }

  /**
   * Confirm the schedule already matches Autobot `enabled`. Must not call toggle(),
   * setTradingState(), or SystemBootstrap — a pause/kill-switch is operator-owned.
   */
  private logIdempotentNoOp(
    shouldBeEnabled: boolean,
    tradingState: string,
    start: string,
    end: string,
    zone: string,
    nowHHMM: string,
  ) {
    if (!shouldBeEnabled) return;
    const key = `${getTradingDateStr()}|on|${tradingState}`;
    if (this.lastIdempotentLogKey === key) return;
    this.lastIdempotentLogKey = key;
    if (tradingState === 'TRADING_ENABLED') {
      console.log(
        `[AutoTradeScheduler] Scheduled activation: engine already RUNNING/ENABLED (tradingState=${tradingState}, ${start}-${end} ${zone}, now ${nowHHMM}). No toggle, restart, or worker respawn.`,
      );
      return;
    }
    console.log(
      `[AutoTradeScheduler] Scheduled activation: Autobot already enabled (tradingState=${tradingState}). Not toggling, restarting, or auto-resuming pause/kill-switch (${start}-${end} ${zone}, now ${nowHHMM}).`,
    );
  }
}

export const autoTradeScheduler = new AutoTradeSchedulerWorker();
