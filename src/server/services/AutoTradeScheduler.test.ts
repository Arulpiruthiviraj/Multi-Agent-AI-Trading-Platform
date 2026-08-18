import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('AutoTradeScheduler.tick', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let autoTradeScheduler: any;
  let tradingEngine: any;
  let tradingCalendar: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_ats_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ autoTradeScheduler } = await import('./AutoTradeScheduler'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    tradingCalendar = await import('../core/TradingCalendar');
    await db.insert(schema.settings).values({});
  });

  afterEach(() => {
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    autoTradeScheduler.stop();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('is a no-op when the schedule is disabled (default, zero behavior change)', async () => {
    await db.update(schema.settings).set({ autoTradeScheduleEnabled: false }).run();
    const toggleSpy = vi.spyOn(tradingEngine, 'toggle');
    await autoTradeScheduler.tick();
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it('fails closed (skips, does not call toggle) when the configured window is invalid', async () => {
    await db.update(schema.settings).set({
      autoTradeScheduleEnabled: true,
      autoTradeScheduleStartTime: 'not-a-time',
      autoTradeScheduleEndTime: '16:00',
    }).run();
    const toggleSpy = vi.spyOn(tradingEngine, 'toggle');
    await autoTradeScheduler.tick();
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it('start() is interval-guarded and does not spawn a second polling loop', async () => {
    await db.update(schema.settings).set({ autoTradeScheduleEnabled: false }).run();
    const intervalSpy = vi.spyOn(global, 'setInterval');
    autoTradeScheduler.start();
    autoTradeScheduler.start();
    expect(intervalSpy).toHaveBeenCalledTimes(1);
  });

  it('scheduled activation is an idempotent no-op when Autobot is already RUNNING/ENABLED', async () => {
    vi.spyOn(tradingCalendar, 'getTimeHHMMInZone').mockReturnValue('09:30');
    await db.update(schema.settings).set({
      autoTradeScheduleEnabled: true,
      autoTradeScheduleStartTime: '09:30',
      autoTradeScheduleEndTime: '16:00',
      autoTradeScheduleTimezone: 'America/New_York',
    }).run();
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const toggleSpy = vi.spyOn(tradingEngine, 'toggle');
    const setStateSpy = vi.spyOn(tradingEngine, 'setTradingState');
    const logSpy = vi.spyOn(console, 'log');

    await autoTradeScheduler.tick();
    await autoTradeScheduler.tick();

    expect(toggleSpy).not.toHaveBeenCalled();
    expect(setStateSpy).not.toHaveBeenCalled();
    const activationLogs = logSpy.mock.calls.filter((args) =>
      String(args[0]).includes('Scheduled activation: engine already RUNNING/ENABLED'),
    );
    expect(activationLogs).toHaveLength(1);
  });

  it('does not auto-resume TRADING_PAUSED when the schedule window is already on', async () => {
    vi.spyOn(tradingCalendar, 'getTimeHHMMInZone').mockReturnValue('09:30');
    await db.update(schema.settings).set({
      autoTradeScheduleEnabled: true,
      autoTradeScheduleStartTime: '09:30',
      autoTradeScheduleEndTime: '16:00',
      autoTradeScheduleTimezone: 'America/New_York',
    }).run();
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_PAUSED';
    const toggleSpy = vi.spyOn(tradingEngine, 'toggle');
    const setStateSpy = vi.spyOn(tradingEngine, 'setTradingState');
    const logSpy = vi.spyOn(console, 'log');

    await autoTradeScheduler.tick();

    expect(toggleSpy).not.toHaveBeenCalled();
    expect(setStateSpy).not.toHaveBeenCalled();
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
    expect(logSpy.mock.calls.some((args) =>
      String(args[0]).includes('Not toggling, restarting, or auto-resuming pause/kill-switch'),
    )).toBe(true);
  });

  it('calls toggle({ enabled: true }) when the window is open and Autobot is off', async () => {
    vi.spyOn(tradingCalendar, 'getTimeHHMMInZone').mockReturnValue('09:30');
    await db.update(schema.settings).set({
      autoTradeScheduleEnabled: true,
      autoTradeScheduleStartTime: '09:30',
      autoTradeScheduleEndTime: '16:00',
      autoTradeScheduleTimezone: 'America/New_York',
    }).run();
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const toggleSpy = vi.spyOn(tradingEngine, 'toggle').mockResolvedValue({ ok: true });

    await autoTradeScheduler.tick();

    expect(toggleSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).toHaveBeenCalledWith({ enabled: true });
  });
});
