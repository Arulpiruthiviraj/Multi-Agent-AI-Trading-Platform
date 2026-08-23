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
} from '../services/NewsCatalystStore';
import { MarketOpenNewsConfluence } from './MarketOpenNewsConfluence';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';

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
