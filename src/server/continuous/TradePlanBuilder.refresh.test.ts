import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock the pre-market scorer (workstream D owns the real implementation): the real stub throws,
// so the refresh must fall back to the ranking path. Per-test overrides simulate a working scorer.
vi.mock('../premarket/PremarketOpportunityScore', () => ({
  scorePremarketCandidate: vi.fn(() => {
    throw new Error('scorePremarketCandidate not yet implemented (test stub)');
  }),
}));

import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingWallTimeToIso } from '../core/TradingCalendar';
import {
  PREMARKET_PLAN_BUILD_STARTED,
  PREMARKET_PLAN_BUILD_COMPLETED,
  TRADE_PLAN_VERSION_CREATED,
  TRADE_PLAN_UNCHANGED,
  TRADE_PLAN_PROMOTED,
  TRADE_PLAN_DOWNGRADED,
  TRADE_PLAN_EXPIRED,
  PREOPEN_REVALIDATION_STARTED,
  PREOPEN_REVALIDATION_COMPLETED,
  PREMARKET_PLAN_HANDED_TO_RTH,
} from '../premarket/premarketRefreshEvents';
import { scorePremarketCandidate } from '../premarket/PremarketOpportunityScore';
import type { RankedCandidate, RankingInput, ComponentSet } from './ComposableRanking';

function availComp(score: number): ComponentSet[keyof ComponentSet] {
  return { score, available: true };
}
function unavailComp(reason: string): ComponentSet[keyof ComponentSet] {
  return { score: null, available: false, reason };
}
function fullComponents(overrides: Partial<ComponentSet> = {}): ComponentSet {
  return {
    momentum: availComp(0.8), relativeVolume: availComp(0.7), rangeExpansion: availComp(0.5),
    gap: availComp(0.4), liquidity: availComp(0.6),
    newsCatalyst: unavailComp('no cluster'), agentConfidence: unavailComp('no prediction'),
    javaQuantScore: unavailComp('not requested'),
    ...overrides,
  };
}
function ranked(
  symbol: string,
  rank: number,
  promotionRecommendation: RankedCandidate['promotionRecommendation'],
  finalScore = 0.8,
  compOverrides: Partial<ComponentSet> = {},
): RankedCandidate {
  return {
    symbol, components: fullComponents(compOverrides), finalScore, weightsUsed: {},
    rank, previousRank: null, rankDelta: null, promotionRecommendation,
    promotionReason: 'test',
  };
}
function input(symbol: string, overrides: Partial<RankingInput> = {}): RankingInput {
  return {
    symbol, last: 100, prevClose: 95, open: 96, prevOpen: 94,
    minuteHigh: 101, minuteLow: 99, minuteClose: 100,
    dailyVolume: 10_000_000, prevDayVolume: 8_000_000,
    rawMomentumPct: 5.26, rawRelativeVolume: 1.25, rawRangeExpansion: 0.02,
    ...overrides,
  } as RankingInput;
}

const TRADING_DATE = '2026-10-06'; // Tuesday
/** DST-correct ET wall time -> Date (never a hardcoded offset). */
function et(hhmm: string): Date {
  return new Date(tradingWallTimeToIso(TRADING_DATE, hhmm));
}

const flush = () => new Promise((r) => setTimeout(r, 25));

describe('TradePlan premarket lifecycle (workstream B, course-corrected)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let builder: typeof import('./TradePlanBuilder');
  let reservations: typeof import('../premarket/PremarketDataReservation');
  let mockScore: MockedFunction<typeof scorePremarketCandidate>;

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
  const tickInput = (now: Date, candidates: RankedCandidate[], inputs: Map<string, RankingInput>) => ({
    planDate: TRADING_DATE, now, rankedCandidates: candidates, inputsBySymbol: inputs, rescuePort: fakeRescue,
  });

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_tpl_lifecycle_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    builder = await import('./TradePlanBuilder');
    reservations = await import('../premarket/PremarketDataReservation');
    mockScore = vi.mocked(scorePremarketCandidate);
    builder.startPremarketPlanLifecycle();
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
    builder.resetPremarketLifecycleForTests();
    mockScore.mockReset();
    mockScore.mockImplementation(() => {
      throw new Error('scorePremarketCandidate not yet implemented (test stub)');
    });
    fakeRescue.requestTemporaryDataRescue.mockClear();
    const { db } = await import('../db');
    const schema = await import('../db/schema');
    await db.delete(schema.premarketDataReservations);
    await db.delete(schema.tradePlanRevisions);
    await db.delete(schema.tradePlanRevalidations);
    await db.delete(schema.tradePlans);
  });

  it('initial build at a late 08:23 start records evidenceAsof=now, never a 04:00 label', async () => {
    watch(PREMARKET_PLAN_BUILD_STARTED, PREMARKET_PLAN_BUILD_COMPLETED);
    const cands = [
      ranked('TSM', 1, 'PROMOTE', 0.9, { newsCatalyst: availComp(0.8) }),
      ranked('OKTA', 2, 'PROMOTE', 0.85),
      ranked('DELL', 3, 'PROMOTE', 0.82),
      ranked('MRVL', 4, 'PROMOTE', 0.8),
      ranked('HPE', 5, 'PROMOTE', 0.78),
    ];
    const inputs = new Map([
      ['TSM', input('TSM', { last: 100, minuteHigh: 101, minuteLow: 99 })],
      ['OKTA', input('OKTA', { last: 50, minuteHigh: 51, minuteLow: 49 })],
      ['DELL', input('DELL', { last: 48, minuteHigh: 50, minuteLow: 47, rawMomentumPct: -4.1 })],
      ['MRVL', input('MRVL', { last: 200, minuteHigh: 202, minuteLow: 198 })],
      ['HPE', input('HPE', { last: 30, minuteHigh: 31, minuteLow: 29 })],
    ]);
    const summary = await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), cands, inputs));
    expect(summary.ran).toBe(true);
    expect(summary.actions[0].action).toBe('INITIAL_BUILD');

    const plans = await builder.getTradePlansForDate(TRADING_DATE);
    expect(plans).toHaveLength(5);
    const bySym = new Map(plans.map((p) => [p.symbol, p]));
    expect(bySym.get('TSM')!.setupType).toBe('PRIMARY');
    expect(bySym.get('OKTA')!.setupType).toBe('PRIMARY');
    expect(bySym.get('DELL')!.setupType).toBe('PRIMARY');
    expect(bySym.get('DELL')!.direction).toBe('SELL');
    expect(bySym.get('MRVL')!.setupType).toBe('BACKUP');
    expect(bySym.get('HPE')!.setupType).toBe('BACKUP');
    for (const p of plans) {
      expect(p.reasonForRefresh).toBe('INITIAL_BUILD');
      expect(p.evidenceAsof).toBe(et('08:23').toISOString());
      expect(p.sessionPhase).toBe('PRE_MARKET');
      expect(p.refreshVersion).toBe(1);
      expect(p.originalCreatedAt).toBe(p.createdAt);
    }

    const active = await reservations.getActiveReservations();
    expect(active).toHaveLength(3);
    expect(new Set(active.map((r) => r.symbol))).toEqual(new Set(['TSM', 'OKTA', 'DELL']));
    expect(fakeRescue.requestTemporaryDataRescue).toHaveBeenCalledTimes(3);
    const rescueCall = fakeRescue.requestTemporaryDataRescue.mock.calls[0];
    expect(rescueCall[2]).toMatchObject({ requestClass: 'EXPLORATION' });

    expect(events.some((e) => e.name === PREMARKET_PLAN_BUILD_STARTED)).toBe(true);
    const completed = events.find((e) => e.name === PREMARKET_PLAN_BUILD_COMPLETED)!;
    expect(completed.payload.planCount).toBe(5);
    expect(completed.payload.primaryCount).toBe(3);
    expect(completed.payload.evidenceAsof).toBe(et('08:23').toISOString());
  });

  it('mid-morning refresh reconsiders the 08:23 plans: promotion, new entry, invalidation expiry, no churn', async () => {
    watch(TRADE_PLAN_VERSION_CREATED, TRADE_PLAN_PROMOTED, TRADE_PLAN_DOWNGRADED, TRADE_PLAN_EXPIRED, TRADE_PLAN_UNCHANGED);
    const buildCands = [
      ranked('TSM', 1, 'PROMOTE', 0.9, { newsCatalyst: availComp(0.8) }),
      ranked('OKTA', 2, 'PROMOTE', 0.85),
      ranked('DELL', 3, 'PROMOTE', 0.82),
      ranked('MRVL', 4, 'PROMOTE', 0.8),
      ranked('HPE', 5, 'PROMOTE', 0.78),
    ];
    const buildInputs = new Map([
      ['TSM', input('TSM', { last: 100, minuteHigh: 101, minuteLow: 99 })],
      ['OKTA', input('OKTA', { last: 50, minuteHigh: 51, minuteLow: 49 })],
      ['DELL', input('DELL', { last: 48, minuteHigh: 50, minuteLow: 47, rawMomentumPct: -4.1 })],
      ['MRVL', input('MRVL', { last: 200, minuteHigh: 202, minuteLow: 198 })],
      ['HPE', input('HPE', { last: 30, minuteHigh: 31, minuteLow: 29 })],
    ]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), buildCands, buildInputs));

    // 08:40 evidence: MRVL gains a fresh catalyst and rank 3 (promotable); NVDA is a new mover;
    // DELL breaks its invalidation level; TSM/OKTA/HPE are byte-identical (no churn expected).
    const cands40 = [
      ranked('TSM', 1, 'PROMOTE', 0.9, { newsCatalyst: availComp(0.8) }),
      ranked('OKTA', 2, 'PROMOTE', 0.85),
      ranked('MRVL', 3, 'PROMOTE', 0.87, { newsCatalyst: availComp(0.85) }),
      ranked('DELL', 4, 'PROMOTE', 0.82),
      ranked('HPE', 5, 'PROMOTE', 0.78),
      ranked('NVDA', 6, 'PROMOTE', 0.75),
    ];
    const inputs40 = new Map([
      ['TSM', buildInputs.get('TSM')!],
      ['OKTA', buildInputs.get('OKTA')!],
      ['MRVL', buildInputs.get('MRVL')!],
      ['DELL', input('DELL', { last: 51, minuteHigh: 50, minuteLow: 47, rawMomentumPct: -4.1 })],
      ['HPE', buildInputs.get('HPE')!],
      ['NVDA', input('NVDA', { last: 150, minuteHigh: 152, minuteLow: 148 })],
    ]);
    const summary = await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:40'), cands40, inputs40));
    expect(summary.ran).toBe(true);
    expect(summary.actions.some((a) => a.kind === 'MID_MORNING')).toBe(true);

    const plans = await builder.getTradePlansForDate(TRADING_DATE);
    expect(plans).toHaveLength(6);
    const bySym = new Map(plans.map((p) => [p.symbol, p]));
    expect(new Set(plans.map((p) => p.symbol)).size).toBe(6); // no duplicates

    const mrvl = bySym.get('MRVL')!;
    expect(mrvl.setupType).toBe('PRIMARY');
    expect(mrvl.refreshVersion).toBe(2);
    expect(mrvl.reasonForRefresh).toBe('PROMOTED');

    const dell = bySym.get('DELL')!;
    expect(dell.status).toBe('EXPIRED');
    expect(dell.reasonForRefresh).toBe('INVALIDATION_LEVEL_HIT');

    const nvda = bySym.get('NVDA')!;
    expect(nvda.setupType).toBe('BACKUP');
    expect(nvda.refreshVersion).toBe(1);
    expect(nvda.reasonForRefresh).toBe('MID_MORNING_REFRESH');

    for (const s of ['TSM', 'OKTA', 'HPE']) {
      expect(bySym.get(s)!.refreshVersion).toBe(1);
    }
    const { db } = await import('../db');
    const { tradePlanRevisions } = await import('../db/schema');
    const revs = await db.select().from(tradePlanRevisions);
    const revSymbols = new Set(revs.map((r) => r.symbol));
    expect(revSymbols.has('TSM')).toBe(false);
    expect(revSymbols.has('OKTA')).toBe(false);
    expect(revSymbols.has('HPE')).toBe(false);
    expect(revSymbols.has('MRVL')).toBe(true);
    expect(revSymbols.has('DELL')).toBe(true);
    const mrvlRev = revs.find((r) => r.symbol === 'MRVL')!;
    expect(JSON.parse(mrvlRev.deltaSummaryJson!).tierChanged).toEqual({ from: 'BACKUP', to: 'PRIMARY' });
    expect(mrvlRev.refreshVersion).toBe(1); // revision stores the PRIOR version

    expect(events.some((e) => e.name === TRADE_PLAN_PROMOTED && e.payload.symbol === 'MRVL')).toBe(true);
    expect(events.some((e) => e.name === TRADE_PLAN_EXPIRED && e.payload.symbol === 'DELL')).toBe(true);
    expect(events.some((e) => e.name === TRADE_PLAN_UNCHANGED)).toBe(false);

    const active = await reservations.getActiveReservations();
    const activeSyms = new Set(active.map((r) => r.symbol));
    expect(activeSyms.has('MRVL')).toBe(true);
    expect(activeSyms.has('DELL')).toBe(false);
    expect(activeSyms.has('TSM')).toBe(true);
    expect(activeSyms.has('OKTA')).toBe(true);
    expect(activeSyms.has('NVDA')).toBe(false); // BACKUP: no reservation by policy
  });

  it('a refresh with identical evidence writes nothing and emits TRADE_PLAN_UNCHANGED', async () => {
    watch(TRADE_PLAN_UNCHANGED, TRADE_PLAN_VERSION_CREATED, TRADE_PLAN_EXPIRED);
    const cands = [ranked('TSM', 1, 'PROMOTE', 0.9), ranked('OKTA', 2, 'PROMOTE', 0.85)];
    const inputs = new Map([['TSM', input('TSM')], ['OKTA', input('OKTA')]]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), cands, inputs));
    const activeBefore = await reservations.getActiveReservations();
    expect(activeBefore).toHaveLength(2);
    events.length = 0;

    const summary = await builder.maybeRunScheduledPremarketRefresh(tickInput(et('09:05'), cands, inputs));
    expect(summary.ran).toBe(true);
    expect(summary.actions.some((a) => a.kind === 'LATE_REFRESH')).toBe(true);

    const plans = await builder.getTradePlansForDate(TRADING_DATE);
    expect(plans.every((p) => p.refreshVersion === 1)).toBe(true);
    const { db } = await import('../db');
    const { tradePlanRevisions } = await import('../db/schema');
    expect((await db.select().from(tradePlanRevisions)).length).toBe(0);
    expect((await reservations.getActiveReservations()).length).toBe(2); // no duplicate requests
    expect(events.some((e) => e.name === TRADE_PLAN_UNCHANGED)).toBe(true);
    expect(events.some((e) => e.name === TRADE_PLAN_VERSION_CREATED)).toBe(false);
    expect(events.some((e) => e.name === TRADE_PLAN_EXPIRED)).toBe(false);
  });

  it('a stale catalyst demotes the plan off PRIMARY and releases its reservation', async () => {
    watch(TRADE_PLAN_DOWNGRADED, TRADE_PLAN_VERSION_CREATED);
    const cands = [ranked('TSM', 1, 'PROMOTE', 0.9, { newsCatalyst: availComp(0.8) })];
    const inputs = new Map([['TSM', input('TSM')]]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), cands, inputs));
    expect((await reservations.getActiveReservations()).length).toBe(1);

    const cands40 = [ranked('TSM', 1, 'PROMOTE', 0.88, { newsCatalyst: unavailComp('no cluster') })];
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:40'), cands40, inputs));

    const plans = await builder.getTradePlansForDate(TRADING_DATE);
    const tsm = plans[0];
    expect(tsm.setupType).toBe('BACKUP');
    expect(tsm.reasonForRefresh).toBe('DOWNGRADED');
    expect(tsm.refreshVersion).toBe(2);
    expect(events.some((e) => e.name === TRADE_PLAN_DOWNGRADED && e.payload.symbol === 'TSM')).toBe(true);
    expect(events.some((e) => e.name === TRADE_PLAN_DOWNGRADED && e.payload.fromTier === 'PRIMARY' && e.payload.toTier === 'BACKUP')).toBe(true);
    expect((await reservations.getActiveReservations()).length).toBe(0);
  });

  it('HIGH news catalysts queue event-driven triggers; LOW ones do not', async () => {
    const cands = [ranked('TSM', 1, 'PROMOTE', 0.9)];
    const inputs = new Map([['TSM', input('TSM')]]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:10'), cands, inputs));

    eventBus.emit(EVENTS.NEWS_CATALYST, { symbol: 'TSM', catalystStrength: 'LOW' });
    expect(builder.getPendingEventTriggersForTests()).toHaveLength(0);
    eventBus.emit(EVENTS.NEWS_CATALYST, { symbol: 'TSM', catalystStrength: 'HIGH' });
    const triggers = builder.getPendingEventTriggersForTests();
    expect(triggers).toHaveLength(1);
    expect(triggers[0].symbol).toBe('TSM');
    expect(triggers[0].source).toBe('NEWS_CATALYST');
  });

  it('event-driven refresh fires only after the debounce quiet period', async () => {
    watch(TRADE_PLAN_VERSION_CREATED, TRADE_PLAN_UNCHANGED);
    const cands = [ranked('TSM', 1, 'PROMOTE', 0.9)];
    const inputs = new Map([['TSM', input('TSM')]]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:10'), cands, inputs));

    builder.queueEventTriggerForTests('NEWS_CATALYST', 'TSM', et('08:12'));
    const s1 = await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:13'), cands, inputs));
    expect(s1.actions.some((a) => a.kind === 'EVENT_DRIVEN')).toBe(false);
    expect(builder.getPendingEventTriggersForTests()).toHaveLength(1);

    const cands2 = [ranked('TSM', 1, 'PROMOTE', 0.92)];
    const s2 = await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:15'), cands2, inputs));
    expect(s2.actions.some((a) => a.kind === 'EVENT_DRIVEN')).toBe(true);
    expect(builder.getPendingEventTriggersForTests()).toHaveLength(0);
    const plans = await builder.getTradePlansForDate(TRADING_DATE);
    expect(plans[0].refreshVersion).toBe(2);
    expect(plans[0].reasonForRefresh).toBe('EVENT_DRIVEN_MATERIAL');
  });

  it('restart during PREMARKET resumes without duplicating plans', async () => {
    const cands = [ranked('TSM', 1, 'PROMOTE', 0.9), ranked('OKTA', 2, 'PROMOTE', 0.85)];
    const inputs = new Map([['TSM', input('TSM')], ['OKTA', input('OKTA')]]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), cands, inputs));
    expect((await builder.getTradePlansForDate(TRADING_DATE))).toHaveLength(2);

    builder.resetPremarketLifecycleForTests();
    eventBus.emit(EVENTS.PREMARKET_SESSION_STARTED, { tradingDate: TRADING_DATE, at: new Date().toISOString() });
    await flush();
    expect(builder.getPendingEventTriggersForTests().length).toBe(1);

    builder.resetPremarketLifecycleForTests();
    builder.queueEventTriggerForTests('SESSION_START_RESUME', null, et('08:24'));
    const summary = await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:27'), cands, inputs));
    expect(summary.actions.some((a) => a.kind === 'EVENT_DRIVEN')).toBe(true);
    const plans = await builder.getTradePlansForDate(TRADING_DATE);
    expect(plans).toHaveLength(2);
    expect(new Set(plans.map((p) => p.symbol)).size).toBe(2);
    expect(plans.every((p) => p.refreshVersion === 1)).toBe(true);
    const primaries = plans.filter((p) => p.setupType === 'PRIMARY');
    expect(primaries).toHaveLength(2);
  });

  it('leaving PREMARKET emits the handoff and releases reservations without touching plans', async () => {
    watch(PREMARKET_PLAN_HANDED_TO_RTH);
    const cands = [ranked('TSM', 1, 'PROMOTE', 0.9)];
    const inputs = new Map([['TSM', input('TSM')]]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), cands, inputs));
    expect((await reservations.getActiveReservations()).length).toBe(1);

    eventBus.emit(EVENTS.SESSION_LIFECYCLE_STATE_CHANGED, {
      from: { marketPhase: 'PRE_MARKET', appState: 'RESEARCHING' },
      to: { marketPhase: 'REGULAR', appState: 'INTRADAY' },
      tradingDate: TRADING_DATE,
      at: new Date().toISOString(),
    });
    await flush();
    expect((await reservations.getActiveReservations()).length).toBe(0);
    const handoff = events.find((e) => e.name === PREMARKET_PLAN_HANDED_TO_RTH)!;
    expect(handoff).toBeDefined();
    expect(handoff.payload.tradingDate).toBe(TRADING_DATE);
    expect(handoff.payload.releasedReservations).toBe(1);
    const plans = await builder.getTradePlansForDate(TRADING_DATE);
    expect(plans[0].status).not.toBe('EXPIRED');
  });

  it('pre-open validation emits revalidation events and expires on invalidation', async () => {
    watch(PREOPEN_REVALIDATION_STARTED, PREOPEN_REVALIDATION_COMPLETED, TRADE_PLAN_EXPIRED);
    const cands = [ranked('TSM', 1, 'PROMOTE', 0.9)];
    const inputs = new Map([['TSM', input('TSM', { last: 100, minuteHigh: 101, minuteLow: 99 })]]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), cands, inputs));

    const cands2 = [ranked('TSM', 1, 'PROMOTE', 0.9)];
    const inputs2 = new Map([['TSM', input('TSM', { last: 98, minuteHigh: 101, minuteLow: 99 })]]);
    const summary = await builder.maybeRunScheduledPremarketRefresh(tickInput(et('09:25'), cands2, inputs2));
    expect(summary.actions.some((a) => a.kind === 'PREOPEN_VALIDATION')).toBe(true);
    expect(events.some((e) => e.name === PREOPEN_REVALIDATION_STARTED)).toBe(true);
    expect(events.some((e) => e.name === PREOPEN_REVALIDATION_COMPLETED)).toBe(true);
    const completed = events.find((e) => e.name === PREOPEN_REVALIDATION_COMPLETED)!;
    expect(completed.payload.expiredCount).toBe(1);
    const plans = await builder.getTradePlansForDate(TRADING_DATE);
    expect(plans[0].status).toBe('EXPIRED');
    expect(plans[0].reasonForRefresh).toBe('INVALIDATION_LEVEL_HIT');
  });

  it('a working scorer stores the decomposition and participates in no-churn', async () => {
    const breakdown = {
      symbol: 'TSM',
      components: {
        overnightGap: 0.5, preMarketPctChange: 0.6, catalystPresence: 0, catalystRecency: 0,
        signedSentiment: 0, liquidity: 0.7, spreadQuality: 0.5, sectorRelativeStrength: 0,
        marketRelativeStrength: 0, strategyApplicability: 0,
      },
      total: 0.55,
      weights: {
        overnightGap: 0.1, preMarketPctChange: 0.1, catalystPresence: 0.1, catalystRecency: 0.1,
        signedSentiment: 0.1, liquidity: 0.1, spreadQuality: 0.1, sectorRelativeStrength: 0.1,
        marketRelativeStrength: 0.1, strategyApplicability: 0.1,
      },
      scoredAt: '2026-10-06T12:40:00.000Z',
      inputsAvailable: ['overnightGap'],
      inputsMissing: ['catalyst'],
    };
    mockScore.mockImplementation((() => breakdown) as unknown as typeof scorePremarketCandidate);
    const cands = [ranked('TSM', 1, 'PROMOTE', 0.9)];
    const inputs = new Map([['TSM', input('TSM')]]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), cands, inputs));

    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:40'), cands, inputs));
    // The scorer runs inside the refresh (not the initial build) and is called per plan.
    expect(mockScore).toHaveBeenCalled();
    expect((mockScore.mock.calls[0][0] as { symbol: string }).symbol).toBe('TSM');
    const plans = await builder.getTradePlansForDate(TRADING_DATE);
    expect(plans[0].refreshVersion).toBe(2);
    expect(JSON.parse(plans[0].scoreDecompositionJson!).total).toBe(0.55);

    // Same deterministic breakdown again: no churn.
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('09:05'), cands, inputs));
    const plans2 = await builder.getTradePlansForDate(TRADING_DATE);
    expect(plans2[0].refreshVersion).toBe(2);
  });

  it('getPremarketLifecycleStatus reports the lifecycle shape workstream D consumes', async () => {
    const cands = [ranked('TSM', 1, 'PROMOTE', 0.9), ranked('MRVL', 4, 'PROMOTE', 0.8)];
    const inputs = new Map([['TSM', input('TSM')], ['MRVL', input('MRVL')]]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), cands, inputs));

    const s = builder.getPremarketLifecycleStatus(TRADING_DATE, et('08:23'));
    expect(s.tradingDate).toBe(TRADING_DATE);
    expect(s.sessionPhase).toBe('PRE_MARKET');
    expect(s.lastBuildAt).toBe(et('08:23').toISOString());
    expect(s.lastBuildVersion).toBe(1);
    expect(s.evidenceAsof).toBe(et('08:23').toISOString());
    expect(s.planCounts).toEqual({ PRIMARY: 1, BACKUP: 1, WATCH: 0, DOWNGRADED: 0, EXPIRED: 0 });
    expect(s.oldestPlanAgeMinutes).toBeGreaterThanOrEqual(0);
    expect(s.nextRefreshKind).toBe('MID_MORNING');
    expect(s.nextRefreshAt).toBe(tradingWallTimeToIso(TRADING_DATE, '08:30'));
    expect(s.refreshDue).toBe(false);

    const due = builder.getPremarketLifecycleStatus(TRADING_DATE, et('08:40'));
    expect(due.nextRefreshKind).toBe('MID_MORNING');
    expect(due.refreshDue).toBe(true);
  });

  it('getPremarketLifecycleStatus on an empty date is null-safe', () => {
    const s = builder.getPremarketLifecycleStatus('2026-10-07', et('08:23'));
    expect(s.tradingDate).toBe('2026-10-07');
    expect(s.lastBuildAt).toBeNull();
    expect(s.lastBuildVersion).toBe(0);
    expect(s.evidenceAsof).toBeNull();
    expect(s.planCounts).toEqual({ PRIMARY: 0, BACKUP: 0, WATCH: 0, DOWNGRADED: 0, EXPIRED: 0 });
    expect(s.oldestPlanAgeMinutes).toBeNull();
  });

  it('refresh perf is measured, logged, and bounded', async () => {
    const cands = [
      ranked('TSM', 1, 'PROMOTE', 0.9),
      ranked('OKTA', 2, 'PROMOTE', 0.85),
      ranked('DELL', 3, 'PROMOTE', 0.82),
    ];
    const inputs = new Map([
      ['TSM', input('TSM')], ['OKTA', input('OKTA')], ['DELL', input('DELL')],
    ]);
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:23'), cands, inputs));
    const cands2 = [
      ranked('TSM', 1, 'PROMOTE', 0.93),
      ranked('OKTA', 2, 'PROMOTE', 0.85),
      ranked('DELL', 3, 'PROMOTE', 0.82),
    ];
    await builder.maybeRunScheduledPremarketRefresh(tickInput(et('08:40'), cands2, inputs));

    const perf = builder.getLastRefreshPerf()!;
    expect(perf).not.toBeNull();
    expect(perf.kind).toBe('MID_MORNING_REFRESH');
    expect(perf.symbolsRanked).toBe(3);
    expect(perf.plansProcessed).toBe(3);
    expect(Number.isFinite(perf.durationMs)).toBe(true);
    expect(Number.isFinite(perf.eventLoopLagMsBefore)).toBe(true);
    expect(Number.isFinite(perf.eventLoopLagMsAfter)).toBe(true);
    expect(perf.dbQueries).toBeGreaterThan(0);
    // Linear bound: no unbounded synchronous scans — queries scale with plans, not with time.
    expect(perf.dbQueries).toBeLessThanOrEqual(15 * perf.plansProcessed + 30);
    console.log(
      `[perf] kind=${perf.kind} durationMs=${perf.durationMs.toFixed(1)} dbQueries=${perf.dbQueries} `
      + `symbolsRanked=${perf.symbolsRanked} lagBeforeMs=${perf.eventLoopLagMsBefore.toFixed(2)} `
      + `lagAfterMs=${perf.eventLoopLagMsAfter.toFixed(2)}`,
    );
  });
});
