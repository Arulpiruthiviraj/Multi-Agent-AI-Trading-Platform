import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { eventBus } from '../core/EventBus';
import { tradingWallTimeToIso } from '../core/TradingCalendar';
import { continuousIntelligence } from '../config/continuousIntelligence';
import {
  PRIMARY_DATA_RESERVATION_REQUESTED,
  PRIMARY_DATA_RESERVATION_GRANTED,
  PRIMARY_DATA_RESERVATION_DENIED,
  PRIMARY_DATA_RESERVATION_RELEASED,
} from './premarketRefreshEvents';

const TRADING_DATE = '2026-10-06';
function et(hhmm: string): Date {
  return new Date(tradingWallTimeToIso(TRADING_DATE, hhmm));
}

describe('PremarketDataReservation (bounded pre-open pool)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mgr: typeof import('./PremarketDataReservation');

  const events: Array<{ name: string; payload: any }> = [];
  const listeners: Array<[string, (p: any) => void]> = [];
  function watch(...names: string[]) {
    for (const n of names) {
      const fn = (payload: any) => { events.push({ name: n, payload }); };
      listeners.push([n, fn]);
      eventBus.on(n, fn);
    }
  }

  const fakeRescue = {
    requestTemporaryDataRescue: vi.fn((_symbol: string, _reason: string, _opts?: unknown) => ({
      granted: true, symbol: _symbol, alreadySubscribed: false, evictedSymbol: null,
    })),
  };

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_pmres_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    mgr = await import('./PremarketDataReservation');
    watch(
      PRIMARY_DATA_RESERVATION_REQUESTED,
      PRIMARY_DATA_RESERVATION_GRANTED,
      PRIMARY_DATA_RESERVATION_DENIED,
      PRIMARY_DATA_RESERVATION_RELEASED,
    );
  });

  afterAll(() => {
    for (const [n, fn] of listeners) eventBus.off(n, fn);
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    events.length = 0;
    fakeRescue.requestTemporaryDataRescue.mockClear();
    const { db } = await import('../db');
    const { premarketDataReservations } = await import('../db/schema');
    await db.delete(premarketDataReservations);
  });

  it('cap is derived from config: min(premarketReservedSlots, maxActiveSubscriptions)', () => {
    const expected = Math.min(
      continuousIntelligence.premarketReservedSlots,
      continuousIntelligence.maxActiveSubscriptions,
    );
    expect(mgr.getReservationCap()).toBe(expected);
    expect(mgr.getReservationCap()).toBeLessThan(continuousIntelligence.maxActiveSubscriptions);
  });

  it('priority ordering is ACTIVE_POSITION > PENDING_ORDER > PRIMARY_PLAN > FAST_ACTIONABLE > NORMAL_DISCOVERY', () => {
    const p = mgr.RESERVATION_PRIORITY;
    expect(p.ACTIVE_POSITION).toBeGreaterThan(p.PENDING_ORDER);
    expect(p.PENDING_ORDER).toBeGreaterThan(p.PRIMARY_PLAN);
    expect(p.PRIMARY_PLAN).toBeGreaterThan(p.FAST_ACTIONABLE);
    expect(p.FAST_ACTIONABLE).toBeGreaterThan(p.NORMAL_DISCOVERY);
  });

  it('PRIMARY grant persists priority 30, caps expiry at the 09:25 handover, and requests rescue', async () => {
    const res = await mgr.requestDataReservation('TSM', 'plan-1', 'PRIMARY', 'test', 25, {
      now: et('09:00'), rescuePort: fakeRescue,
    });
    expect(res.outcome).toBe('GRANTED');
    expect(res.reservation!.priority).toBe(mgr.RESERVATION_PRIORITY.PRIMARY_PLAN);
    expect(res.reservation!.expiresAt).toBe(et('09:25').toISOString());
    expect(res.reservation!.releaseCondition).toContain('MARKET_OPEN_HANDOVER');
    expect(res.rescueGranted).toBe(true);
    expect(fakeRescue.requestTemporaryDataRescue).toHaveBeenCalledTimes(1);
    expect(fakeRescue.requestTemporaryDataRescue.mock.calls[0][2]).toMatchObject({ requestClass: 'EXPLORATION' });
    expect(events.some((e) => e.name === PRIMARY_DATA_RESERVATION_REQUESTED)).toBe(true);
    expect(events.some((e) => e.name === PRIMARY_DATA_RESERVATION_GRANTED)).toBe(true);
  });

  it('a long TTL is still capped at the handover instant', async () => {
    const res = await mgr.requestDataReservation('OKTA', 'plan-2', 'PRIMARY', 'test', 120, {
      now: et('08:30'), rescuePort: fakeRescue,
    });
    expect(res.outcome).toBe('GRANTED');
    expect(res.reservation!.expiresAt).toBe(et('09:25').toISOString());
  });

  it('duplicate symbol requests are denied explicitly', async () => {
    await mgr.requestDataReservation('TSM', 'plan-1', 'PRIMARY', 'test', 25, { now: et('09:00'), rescuePort: fakeRescue });
    const dup = await mgr.requestDataReservation('TSM', 'plan-2', 'PRIMARY', 'test', 25, { now: et('09:01'), rescuePort: fakeRescue });
    expect(dup.outcome).toBe('DENIED');
    expect(dup.deniedReason).toBe('DUPLICATE_ACTIVE_RESERVATION');
    expect(events.some((e) => e.name === PRIMARY_DATA_RESERVATION_DENIED && e.payload.detail === 'DUPLICATE_ACTIVE_RESERVATION')).toBe(true);
  });

  it('pool exhaustion denies with an explicit reason and persists the denial', async () => {
    const cap = mgr.getReservationCap();
    expect(cap).toBeGreaterThanOrEqual(2);
    const symbols = ['TSM', 'OKTA', 'DELL', 'MRVL', 'HPE', 'NVDA'];
    for (let i = 0; i < cap; i++) {
      const r = await mgr.requestDataReservation(symbols[i], `plan-${i}`, 'PRIMARY', 'test', 25, {
        now: et('09:00'), rescuePort: fakeRescue,
      });
      expect(r.outcome).toBe('GRANTED');
    }
    const denied = await mgr.requestDataReservation(symbols[cap], 'plan-x', 'PRIMARY', 'test', 25, {
      now: et('09:00'), rescuePort: fakeRescue,
    });
    expect(denied.outcome).toBe('DENIED');
    expect(denied.deniedReason).toBe('POOL_EXHAUSTED');
    const { db } = await import('../db');
    const { premarketDataReservations } = await import('../db/schema');
    const rows = await db.select().from(premarketDataReservations);
    expect(rows.filter((r) => r.status === 'DENIED').length).toBe(1);
    expect(rows.filter((r) => r.status === 'ACTIVE').length).toBe(cap);
  });

  it('reservation expiry releases capacity for new requests', async () => {
    const cap = mgr.getReservationCap();
    const symbols = ['TSM', 'OKTA', 'DELL', 'MRVL', 'HPE', 'NVDA'];
    for (let i = 0; i < cap; i++) {
      await mgr.requestDataReservation(symbols[i], `plan-${i}`, 'PRIMARY', 'test', 25, {
        now: et('09:00'), rescuePort: fakeRescue,
      });
    }
    expect(await mgr.countActiveReservations()).toBe(cap);
    const expired = await mgr.sweepExpiredReservations(et('09:26'));
    expect(expired).toBe(cap);
    expect(await mgr.countActiveReservations()).toBe(0);
    const retry = await mgr.requestDataReservation('HPE', 'plan-x', 'PRIMARY', 'test', 10, {
      now: et('09:26'), rescuePort: fakeRescue,
    });
    // 09:26 is past the 09:25 handover: a new reservation would be born expired.
    expect(retry.outcome).toBe('DENIED');
    expect(retry.deniedReason).toBe('PAST_HANDOVER');
    // But an earlier expiry still frees capacity inside the window.
    await mgr.requestDataReservation('NVDA', 'plan-y', 'PRIMARY', 'test', 25, {
      now: et('09:00'), rescuePort: fakeRescue,
    });
    expect(await mgr.countActiveReservations()).toBe(1);
  });

  it('invalid input is denied explicitly', async () => {
    const badSymbol = await mgr.requestDataReservation('!!!', 'plan-1', 'PRIMARY', 'test', 25, {
      now: et('09:00'), rescuePort: fakeRescue,
    });
    expect(badSymbol.deniedReason).toBe('INVALID_SYMBOL');
    const badTtl = await mgr.requestDataReservation('TSM', 'plan-1', 'PRIMARY', 'test', 0, {
      now: et('09:00'), rescuePort: fakeRescue,
    });
    expect(badTtl.deniedReason).toBe('INVALID_TTL');
  });

  it('release is idempotent and scoped per plan', async () => {
    const a1 = await mgr.requestDataReservation('TSM', 'plan-a', 'PRIMARY', 'test', 25, { now: et('09:00'), rescuePort: fakeRescue });
    const a2 = await mgr.requestDataReservation('OKTA', 'plan-a', 'PRIMARY', 'test', 25, { now: et('09:00'), rescuePort: fakeRescue });
    await mgr.requestDataReservation('DELL', 'plan-b', 'PRIMARY', 'test', 25, { now: et('09:00'), rescuePort: fakeRescue });
    expect(a1.outcome).toBe('GRANTED');
    expect(a2.outcome).toBe('GRANTED');

    expect(await mgr.releaseDataReservation(a1.reservation!.id, 'test-release', et('09:10'))).toBe(true);
    expect(await mgr.releaseDataReservation(a1.reservation!.id, 'test-release', et('09:10'))).toBe(false);
    expect(events.some((e) => e.name === PRIMARY_DATA_RESERVATION_RELEASED)).toBe(true);

    expect(await mgr.releaseReservationsForPlan('plan-a', 'PLAN_EXPIRED', et('09:11'))).toBe(1);
    const active = await mgr.getActiveReservations();
    expect(active.map((r) => r.symbol)).toEqual(['DELL']);
  });

  it('releaseAllActiveReservations releases the whole ledger for the market-open handover', async () => {
    await mgr.requestDataReservation('TSM', 'plan-1', 'PRIMARY', 'test', 25, { now: et('09:00'), rescuePort: fakeRescue });
    await mgr.requestDataReservation('OKTA', 'plan-2', 'PRIMARY', 'test', 25, { now: et('09:00'), rescuePort: fakeRescue });
    const released = await mgr.releaseAllActiveReservations('MARKET_OPEN_HANDOVER', et('09:30'));
    expect(released).toBe(2);
    expect(await mgr.countActiveReservations()).toBe(0);
    const { db } = await import('../db');
    const { premarketDataReservations } = await import('../db/schema');
    const rows = await db.select().from(premarketDataReservations);
    expect(rows.every((r) => r.status === 'RELEASED' && r.releaseReason === 'MARKET_OPEN_HANDOVER')).toBe(true);
  });

  it('pool status reports cap, active, and headroom', async () => {
    await mgr.requestDataReservation('TSM', 'plan-1', 'PRIMARY', 'test', 25, { now: et('09:00'), rescuePort: fakeRescue });
    const status = await mgr.getReservationPoolStatus();
    expect(status.cap).toBe(mgr.getReservationCap());
    expect(status.active).toBe(1);
    expect(status.available).toBe(status.cap - 1);
    expect(status.maxActiveSubscriptions).toBe(continuousIntelligence.maxActiveSubscriptions);
  });
});
