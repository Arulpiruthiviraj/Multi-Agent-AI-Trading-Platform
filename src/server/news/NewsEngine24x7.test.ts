/**
 * 24/7 News Intel + pre-market catalyst staging — unit/integration coverage.
 * Does not place orders; verifies off-hours ingest/staging and open confluence semantics.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { resolveNewsEnginePollMs, isUsEquityRegularSession } from './newsSessionCadence';
import { computeCatalystExpiresAtMs } from './catalystStagingTtl';
import { runtimeIntervals } from '../config/runtimeIntervals';
import {
  recordNewsCatalyst,
  listStagedForOpenCatalysts,
  clearNewsCatalystsForTests,
  markStagedCatalystConsumed,
  markStagedCatalystExpired,
  rehydrateStagedCatalystsFromDb,
  flushPendingNewsCatalystWritesForTests,
} from '../services/NewsCatalystStore';
import { MarketOpenNewsConfluence } from './MarketOpenNewsConfluence';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { db } from '../db';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';

describe('NewsEngine 24x7 cadence & staging', () => {
  beforeEach(() => {
    clearNewsCatalystsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses off-hours poll interval when US equity session is closed', () => {
    const sat = Date.parse('2026-08-22T16:00:00.000Z');
    expect(isUsEquityRegularSession(sat)).toBe(false);
    expect(resolveNewsEnginePollMs(sat)).toBe(runtimeIntervals.newsEngineOffHoursMs);
  });

  it('uses RTH poll interval during regular session', () => {
    const wed = Date.parse('2026-08-19T15:00:00.000Z');
    expect(isUsEquityRegularSession(wed)).toBe(true);
    expect(resolveNewsEnginePollMs(wed)).toBe(runtimeIntervals.newsEngineMs);
  });

  it('stages overnight HIGH catalysts as STAGED_FOR_OPEN with TTL past next open', () => {
    vi.useFakeTimers();
    const afterClose = Date.parse('2026-08-18T22:00:00.000Z');
    vi.setSystemTime(afterClose);

    const recorded = recordNewsCatalyst({
      traceId: 'overnight-1',
      symbol: 'NVDA',
      headline: 'Q2 beat after hours',
      source: 'unit',
      publishedAtMs: afterClose,
      sentiment: 0.8,
      credibility: 0.9,
      catalystStrength: 'HIGH',
      tradingBias: 'BULLISH',
      contribution: 0.7,
      reasoning: 'earnings beat',
      recordedAt: new Date(afterClose).toISOString(),
      expectedHorizon: 'INTRADAY',
      referencePrice: 100,
    });

    expect(recorded.status).toBe('STAGED_FOR_OPEN');
    expect(recorded.expiresAtMs).toBeTruthy();
    const nextOpen = Date.parse('2026-08-19T13:30:00.000Z');
    expect(recorded.expiresAtMs!).toBeGreaterThan(nextOpen);
    expect(listStagedForOpenCatalysts()).toHaveLength(1);
  });

  describe('durable staging (Phase 2 carryover restart-recovery fix, 2026-09-27)', () => {
    it('write-through: a staged catalyst is persisted to staged_news_catalysts with STAGED_FOR_OPEN status', async () => {
      const afterClose = Date.parse('2026-08-18T22:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(afterClose);
      recordNewsCatalyst({
        traceId: 'durable-1', symbol: 'MSFT', headline: 'h', source: 'unit', publishedAtMs: afterClose,
        sentiment: 0.6, credibility: 0.9, catalystStrength: 'HIGH', tradingBias: 'BULLISH',
        contribution: 0.5, reasoning: 'r', recordedAt: new Date(afterClose).toISOString(),
        expectedHorizon: 'INTRADAY', referencePrice: 200,
      });
      vi.useRealTimers();
      await flushPendingNewsCatalystWritesForTests();
      const rows = await db.select().from(schema.stagedNewsCatalysts).where(eq(schema.stagedNewsCatalysts.traceId, 'durable-1'));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('STAGED_FOR_OPEN');
      expect(rows[0].symbol).toBe('MSFT');
    });

    it('restart recovery: rehydrateStagedCatalystsFromDb() repopulates the in-memory queue from a durable row this process never wrote (simulates a fresh boot after a crash)', async () => {
      // Simulate "a prior process staged this and then the machine restarted" by writing directly
      // to the durable table, bypassing recordNewsCatalyst()/its in-memory side entirely - exactly
      // what a real crash-then-reboot leaves behind: a DB row, an empty in-memory store.
      await db.insert(schema.stagedNewsCatalysts).values({
        traceId: 'durable-restart-1', symbol: 'TSLA', headline: 'Overnight guidance cut', source: 'unit',
        publishedAtMs: Date.now(), sentiment: -0.7, credibility: 0.85, catalystStrength: 'HIGH',
        tradingBias: 'BEARISH', contribution: -0.6, reasoning: 'r', recordedAt: new Date().toISOString(),
        expectedHorizon: 'INTRADAY', referencePrice: 300, status: 'STAGED_FOR_OPEN',
        expiresAtMs: Date.now() + 24 * 60 * 60 * 1000, clusterId: null, updatedAtMs: Date.now(),
      });
      expect(listStagedForOpenCatalysts().find((c) => c.traceId === 'durable-restart-1')).toBeUndefined();

      await rehydrateStagedCatalystsFromDb();

      const rehydrated = listStagedForOpenCatalysts().find((c) => c.traceId === 'durable-restart-1');
      expect(rehydrated).toBeTruthy();
      expect(rehydrated!.symbol).toBe('TSLA');
      expect(rehydrated!.tradingBias).toBe('BEARISH');
      expect(rehydrated!.status).toBe('STAGED_FOR_OPEN');
    });

    it('restart recovery never repopulates a durable row that already expired while the process was down - marks it EXPIRED instead of silently re-queueing a stale catalyst', async () => {
      await db.insert(schema.stagedNewsCatalysts).values({
        traceId: 'durable-expired-1', symbol: 'AMD', headline: 'stale', source: 'unit',
        publishedAtMs: Date.now() - 48 * 60 * 60 * 1000, sentiment: 0.5, credibility: 0.9,
        catalystStrength: 'HIGH', tradingBias: 'BULLISH', contribution: 0.5, reasoning: 'r',
        recordedAt: new Date().toISOString(), expectedHorizon: 'INTRADAY', referencePrice: 150,
        status: 'STAGED_FOR_OPEN', expiresAtMs: Date.now() - 60_000, clusterId: null, updatedAtMs: Date.now(),
      });

      await rehydrateStagedCatalystsFromDb();

      expect(listStagedForOpenCatalysts().find((c) => c.traceId === 'durable-expired-1')).toBeUndefined();
      await flushPendingNewsCatalystWritesForTests();
      const rows = await db.select().from(schema.stagedNewsCatalysts).where(eq(schema.stagedNewsCatalysts.traceId, 'durable-expired-1'));
      expect(rows[0].status).toBe('EXPIRED');
    });

    it('markStagedCatalystConsumed/Expired persist the status change durably', async () => {
      const afterClose = Date.parse('2026-08-18T22:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(afterClose);
      recordNewsCatalyst({
        traceId: 'durable-consume-1', symbol: 'GOOG', headline: 'h', source: 'unit', publishedAtMs: afterClose,
        sentiment: 0.6, credibility: 0.9, catalystStrength: 'HIGH', tradingBias: 'BULLISH',
        contribution: 0.5, reasoning: 'r', recordedAt: new Date(afterClose).toISOString(),
        expectedHorizon: 'INTRADAY', referencePrice: 140,
      });
      vi.useRealTimers();
      markStagedCatalystConsumed('durable-consume-1');
      await flushPendingNewsCatalystWritesForTests();
      const rows = await db.select().from(schema.stagedNewsCatalysts).where(eq(schema.stagedNewsCatalysts.traceId, 'durable-consume-1'));
      expect(rows[0].status).toBe('CONSUMED');
    });
  });

  it('INTRADAY TTL extends through next session open window (not overnight expiry)', () => {
    const afterClose = Date.parse('2026-08-18T22:00:00.000Z');
    const expires = computeCatalystExpiresAtMs(afterClose, 'INTRADAY');
    expect(expires).toBeGreaterThan(Date.parse('2026-08-19T13:30:00.000Z'));
  });

  it('confirms bullish staged catalyst when opening price rises', () => {
    const confluence = MarketOpenNewsConfluence.getInstance();
    expect(
      confluence.evaluateConfluence(
        {
          traceId: 't',
          symbol: 'AAPL',
          headline: 'h',
          source: 'u',
          publishedAtMs: 1,
          sentiment: 0.5,
          credibility: 0.9,
          catalystStrength: 'HIGH',
          tradingBias: 'BULLISH',
          contribution: 0.6,
          reasoning: 'r',
          recordedAt: new Date().toISOString(),
          referencePrice: 100,
          status: 'STAGED_FOR_OPEN',
        },
        100.3,
      ),
    ).toBe('CONFIRM');
  });

  it('flags CONTRADICTORY_PRICE_ACTION when opening dump contradicts bullish news', () => {
    const confluence = MarketOpenNewsConfluence.getInstance();
    expect(
      confluence.evaluateConfluence(
        {
          traceId: 't2',
          symbol: 'AAPL',
          headline: 'beat',
          source: 'u',
          publishedAtMs: 1,
          sentiment: 0.5,
          credibility: 0.9,
          catalystStrength: 'HIGH',
          tradingBias: 'BULLISH',
          contribution: 0.6,
          reasoning: 'r',
          recordedAt: new Date().toISOString(),
          referencePrice: 100,
          status: 'STAGED_FOR_OPEN',
        },
        99.5,
      ),
    ).toBe('CONTRADICT');
  });

  it('publishes CONTRADICTORY event with zero ORDER_SUBMITTED (no OMS off-hours path)', () => {
    const contradictEvents: unknown[] = [];
    const omsCalls: unknown[] = [];
    const onContradict = (p: unknown) => contradictEvents.push(p);
    const onOrder = (p: unknown) => omsCalls.push(p);
    eventBus.on(EVENTS.NEWS_OPEN_CONTRADICTORY_PRICE_ACTION, onContradict);
    eventBus.on(EVENTS.ORDER_SUBMITTED, onOrder);

    eventBus.publish(EVENTS.NEWS_OPEN_CONTRADICTORY_PRICE_ACTION, {
      symbol: 'MSFT',
      traceId: 'x',
      tradingBias: 'BULLISH',
      livePrice: 398,
    });

    expect(contradictEvents.length).toBe(1);
    expect(omsCalls.length).toBe(0);
    eventBus.off(EVENTS.NEWS_OPEN_CONTRADICTORY_PRICE_ACTION, onContradict);
    eventBus.off(EVENTS.ORDER_SUBMITTED, onOrder);
  });

  it('NewsEngine.runPipeline can tick when market session is closed', async () => {
    vi.useFakeTimers();
    const sat = Date.parse('2026-08-22T16:00:00.000Z');
    vi.setSystemTime(sat);
    expect(isUsEquityRegularSession(sat)).toBe(false);

    const { newsEngine } = await import('./NewsEngine');
    const fetchSpy = vi.spyOn(newsEngine.providerManager, 'fetchAllLatest').mockResolvedValue([]);
    await (newsEngine as any).runPipeline();
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
