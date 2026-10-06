/**
 * Tests for the pre-market focus report (workstream D): tiering from fixture
 * plans, honest missing-input handling, persistence round-trip (the CLI's
 * read path), per-candidate event emission, and the defensive refresh
 * subscriber. DB-isolated via a temp ARGUS_DB_PATH (same convention as
 * SessionLifecycle.test.ts) — never touches the real data/argus.db.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildFocusReport,
  getPersistedFocusReport,
  tierForTotal,
  type TradePlanRow,
} from './PremarketFocusReport';
import { installPremarketFocusSubscribers, PREMARKET_CANDIDATE_SCORED, PREMARKET_REFRESH_COMPLETED } from './premarketFocusEvents';
import { eventBus } from '../core/EventBus';
import { premarketFocusConfig } from '../config/premarketFocus';
import type { PremarketCandidateInput, PremarketScoreBreakdown } from './PremarketOpportunityScore';

const TRADING_DATE = '2026-10-06';
const NOW = new Date('2026-10-06T12:00:00.000Z'); // 08:00 ET
const VALID_UNTIL = '2026-10-06T20:00:00.000Z'; // 16:00 ET
const CREATED_AT = '2026-10-06T08:00:00.000Z';

function planRow(overrides: Partial<TradePlanRow> = {}): TradePlanRow {
  return {
    id: `plan-${overrides.symbol ?? 'X'}`,
    symbol: 'X',
    planDate: TRADING_DATE,
    setupType: 'WATCHLIST',
    direction: 'BUY',
    thesis: 'fixture thesis',
    catalysts: null,
    entryZoneLow: null,
    entryZoneHigh: null,
    invalidationLevel: null,
    targetConcept: null,
    confidence: 0.5,
    confluenceScore: 0.5,
    evidenceQuality: 0.5,
    rankAtCreation: 99,
    componentScoresJson: null,
    status: 'READY',
    createdAt: CREATED_AT,
    validUntil: VALID_UNTIL,
    validUntilConfidence: null,
    refreshVersion: 1,
    refreshedAt: null,
    reasonForRefresh: null,
    originalCreatedAt: null,
    scoreDecompositionJson: null,
    ...overrides,
  };
}

function persistedBreakdown(symbol: string, total: number): string {
  const zero = {
    overnightGap: 0, preMarketPctChange: 0, catalystPresence: 0, catalystRecency: 0,
    signedSentiment: 0, liquidity: 0, spreadQuality: 1, sectorRelativeStrength: 0,
    marketRelativeStrength: 0, strategyApplicability: 0,
  };
  const breakdown: PremarketScoreBreakdown = {
    symbol,
    components: zero,
    total,
    weights: { ...premarketFocusConfig.weights },
    scoredAt: NOW.toISOString(),
    inputsAvailable: ['dataFresh', 'spreadBps'],
    inputsMissing: ['catalyst'],
  };
  return JSON.stringify(breakdown);
}

function fixturePlans(): TradePlanRow[] {
  return [
    planRow({
      id: 'plan-aaa', symbol: 'AAA', setupType: 'PRIMARY', rankAtCreation: 1,
      catalysts: JSON.stringify(['earnings beat']), catalystType: 'EARNINGS', catalystSourceCount: 3,
      confluenceScore: 0.8, confidence: 0.85,
    }),
    planRow({
      id: 'plan-bbb', symbol: 'BBB', setupType: 'BACKUP', rankAtCreation: 4,
      catalysts: JSON.stringify(['analyst upgrade']), catalystType: 'ANALYST', catalystSourceCount: 1,
      confluenceScore: 0.6,
    }),
    planRow({
      id: 'plan-ccc', symbol: 'CCC', setupType: 'WATCHLIST', rankAtCreation: 9,
      catalysts: JSON.stringify([]), confluenceScore: 0.4,
    }),
    // DDD: no explicit candidate inputs -> default honest-missing derivation.
    planRow({ id: 'plan-ddd', symbol: 'DDD', rankAtCreation: 12, confluenceScore: 0.3 }),
    // EEE: persisted breakdown from workstream B's refresh -> used as-is.
    planRow({
      id: 'plan-eee', symbol: 'EEE', setupType: 'PRIMARY', rankAtCreation: 2,
      scoreDecompositionJson: persistedBreakdown('EEE', 0.9),
    }),
    // FFF: corrupt persisted breakdown -> falls back to default derivation, never throws.
    planRow({ id: 'plan-fff', symbol: 'FFF', rankAtCreation: 15, scoreDecompositionJson: 'not-json{{{' }),
  ];
}

/** Rich inputs: total ≈ 0.866 -> PRIMARY. Moderate: ≈ 0.542 -> SECONDARY. Weak: ≈ 0.358 -> WATCH. */
function fixtureInputs(): Map<string, PremarketCandidateInput> {
  return new Map<string, PremarketCandidateInput>([
    ['AAA', {
      symbol: 'AAA', overnightGapPct: 4, preMarketPctChange: 3,
      catalyst: { sentiment: 1, confidence: 0.9, recencyMinutes: 30, source: 'rss:test', impactMagnitude: 0.8 },
      dollarVolume: 60_000_000, spreadBps: 5,
      sectorRelativeStrength: 0.8, marketRelativeStrength: 0.7,
      strategyApplicability: ['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'TREND_FOLLOWING'],
      dataFresh: true,
    }],
    ['BBB', {
      symbol: 'BBB', overnightGapPct: 3, preMarketPctChange: 1.5,
      catalyst: { sentiment: 0, confidence: 0.5, recencyMinutes: 120, source: 'rss:test', impactMagnitude: 0.4 },
      dollarVolume: 20_000_000, spreadBps: null,
      sectorRelativeStrength: 0.5, marketRelativeStrength: 0.5,
      strategyApplicability: ['MOMENTUM_BREAKOUT'],
      dataFresh: true,
    }],
    ['CCC', {
      symbol: 'CCC', overnightGapPct: 1, preMarketPctChange: 0.5,
      catalyst: { sentiment: 0, confidence: 0.3, recencyMinutes: 700, source: 'rss:test', impactMagnitude: 0.2 },
      dollarVolume: 10_000_000, spreadBps: null,
      sectorRelativeStrength: 0.9, marketRelativeStrength: 0.9,
      strategyApplicability: [],
      dataFresh: true,
    }],
  ]);
}

describe('tierForTotal', () => {
  it('tiers from the config cutoffs (tests read the same config as production)', () => {
    const { primary, secondary, watch } = premarketFocusConfig.tierCutoffs;
    expect(tierForTotal(primary)).toBe('PRIMARY');
    expect(tierForTotal(primary - 0.001)).toBe('SECONDARY');
    expect(tierForTotal(secondary)).toBe('SECONDARY');
    expect(tierForTotal(watch)).toBe('WATCH');
    expect(tierForTotal(watch - 0.001)).toBe('REJECTED');
    expect(tierForTotal(0)).toBe('REJECTED');
  });
});

describe('buildFocusReport — tiering from fixture plans', () => {
  let tmpDbPath: string;
  let sqliteDb: { close(): void };
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_premarket_focus_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    const dbMod = await import('../db');
    sqliteDb = dbMod.sqliteDb as { close(): void };
    const schema = await import('../db/schema');
    await dbMod.db.insert(schema.tradePlans).values(fixturePlans());
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emit');
  });

  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('tiers candidates PRIMARY / SECONDARY / WATCH / REJECTED from fixture plans', async () => {
    const report = await buildFocusReport(TRADING_DATE, 1, {
      plans: fixturePlans(),
      candidateInputs: fixtureInputs(),
      now: NOW,
      refreshedAt: '2026-10-06T12:05:00.000Z',
    });

    expect(report.tradingDate).toBe(TRADING_DATE);
    expect(report.refreshVersion).toBe(1);
    expect(report.tiers.PRIMARY.map((e) => e.symbol)).toEqual(['EEE', 'AAA']); // total desc
    expect(report.tiers.SECONDARY.map((e) => e.symbol)).toEqual(['BBB']);
    expect(report.tiers.WATCH.map((e) => e.symbol)).toEqual(['CCC']);
    expect(report.tiers.REJECTED.map((e) => e.symbol)).toEqual(['FFF', 'DDD']);

    const aaa = report.tiers.PRIMARY.find((e) => e.symbol === 'AAA')!;
    expect(aaa.total).toBeCloseTo(0.8658, 3);
    expect(aaa.total).toBeGreaterThanOrEqual(premarketFocusConfig.tierCutoffs.primary);
    const bbb = report.tiers.SECONDARY[0];
    expect(bbb.total).toBeCloseTo(0.5417, 3);
    const ccc = report.tiers.WATCH[0];
    expect(ccc.total).toBeCloseTo(0.3578, 3);
  });

  it('per-symbol entries carry why-selected, catalyst, freshness, strategy applicability, data readiness, subscription state — and no direction', async () => {
    const report = await buildFocusReport(TRADING_DATE, 1, {
      plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW,
    });
    const aaa = report.tiers.PRIMARY.find((e) => e.symbol === 'AAA')!;

    expect(aaa.whySelected.length).toBeGreaterThan(0);
    expect(aaa.whySelected.some((r) => r.includes('overnight gap +4.00%'))).toBe(true);
    expect(aaa.catalyst).toMatchObject({ labels: ['earnings beat'], type: 'EARNINGS', sourceCount: 3, scored: true });
    expect(aaa.freshness).toMatchObject({ planStatus: 'READY', dataFresh: true });
    expect(aaa.freshness.planAgeMinutes).toBe(240); // 08:00 -> 12:00 UTC
    expect(aaa.strategyApplicability).toHaveLength(3);
    expect(aaa.dataReadiness.completeness).toBe(1);
    expect(['SUBSCRIBED_ANCHOR', 'SUBSCRIBED_DYNAMIC', 'NOT_SUBSCRIBED', 'UNKNOWN']).toContain(aaa.subscriptionState);

    // Never actionable: no direction/side anywhere in the entry or its JSON.
    const serialized = JSON.stringify(aaa);
    expect(serialized).not.toContain('BUY');
    expect(serialized).not.toContain('SELL');
    expect('direction' in aaa).toBe(false);
    expect('side' in aaa).toBe(false);
  });

  it('default derivation (no explicit inputs) is honest: REJECTED with missing inputs listed', async () => {
    const report = await buildFocusReport(TRADING_DATE, 1, { plans: fixturePlans(), now: NOW });
    const ddd = report.tiers.REJECTED.find((e) => e.symbol === 'DDD')!;
    // Only the fail-open spread contributes: 0.05 x 1.0.
    expect(ddd.total).toBeCloseTo(premarketFocusConfig.weights.spreadQuality, 10);
    expect(ddd.inputsMissing).toContain('overnightGapPct');
    expect(ddd.inputsMissing).toContain('catalyst');
    expect(ddd.inputsMissing).toContain('dollarVolume');
    expect(ddd.whySelected[0]).toContain('below WATCH cutoff');
    expect(ddd.dataReadiness.completeness).toBeLessThan(0.5);
  });

  it('uses the persisted refresh breakdown when present; corrupt JSON falls back without throwing', async () => {
    const report = await buildFocusReport(TRADING_DATE, 1, { plans: fixturePlans(), now: NOW });
    const eee = report.tiers.PRIMARY.find((e) => e.symbol === 'EEE')!;
    expect(eee.total).toBe(0.9);
    expect(eee.whySelected).toContain('score from persisted refresh breakdown');
    const fff = report.tiers.REJECTED.find((e) => e.symbol === 'FFF')!;
    expect(fff.total).toBeCloseTo(premarketFocusConfig.weights.spreadQuality, 10);
  });

  it('emits one bounded PREMARKET_CANDIDATE_SCORED per candidate', async () => {
    await buildFocusReport(TRADING_DATE, 1, { plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW });
    const scored = emitSpy.mock.calls.filter(([event]) => event === PREMARKET_CANDIDATE_SCORED);
    expect(scored).toHaveLength(6);
    for (const [, payload] of scored) {
      expect(typeof payload.symbol).toBe('string');
      expect(typeof payload.total).toBe('number');
      expect(payload.topContributions.length).toBeLessThanOrEqual(premarketFocusConfig.report.topContributionsKept);
      expect(Array.isArray(payload.inputsMissing)).toBe(true);
    }
    const aaaPayload = scored.find(([, p]) => p.symbol === 'AAA')![1];
    expect(aaaPayload.tier).toBe('PRIMARY');
    expect(aaaPayload.tradingDate).toBe(TRADING_DATE);
    expect(aaaPayload.refreshVersion).toBe(1);
  });

  it('persists the report; getPersistedFocusReport (the CLI read path) returns it', async () => {
    const built = await buildFocusReport(TRADING_DATE, 7, {
      plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW,
      refreshedAt: '2026-10-06T12:05:00.000Z',
    });
    const read = await getPersistedFocusReport(TRADING_DATE, 7);
    expect(read).not.toBeNull();
    expect(read!.tradingDate).toBe(TRADING_DATE);
    expect(read!.refreshVersion).toBe(7);
    expect(read!.refreshedAt).toBe('2026-10-06T12:05:00.000Z');
    expect(read!.tiers.PRIMARY.map((e) => e.symbol)).toEqual(built.tiers.PRIMARY.map((e) => e.symbol));
    expect(read!.tiers.REJECTED.map((e) => e.symbol)).toEqual(built.tiers.REJECTED.map((e) => e.symbol));
    expect(read!.metrics.candidateCount).toBe(6);
    expect(read!.sources.symbolsScored).toBe(6);
    // The persisted JSON never implies actionable either.
    expect(JSON.stringify(read)).not.toContain('BUY');
    expect(JSON.stringify(read)).not.toContain('SELL');
  });

  it('rebuild for the same (date, version) upserts instead of duplicating', async () => {
    await buildFocusReport(TRADING_DATE, 9, { plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW });
    await buildFocusReport(TRADING_DATE, 9, { plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW });
    const read = await getPersistedFocusReport(TRADING_DATE, 9);
    expect(read).not.toBeNull();
    expect(read!.metrics.candidateCount).toBe(6);
  });

  it('returns null when no report exists for the date', async () => {
    expect(await getPersistedFocusReport('2099-01-01')).toBeNull();
  });
});

describe('installPremarketFocusSubscribers — defensive refresh handling', () => {
  let tmpDbPath: string;
  let sqliteDb: { close(): void };
  let unsubscribe: () => void;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_premarket_focus_sub_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    const dbMod = await import('../db');
    sqliteDb = dbMod.sqliteDb as { close(): void };
    const schema = await import('../db/schema');
    await dbMod.db.insert(schema.tradePlans).values(fixturePlans());
    unsubscribe = installPremarketFocusSubscribers();
  });

  afterAll(() => {
    unsubscribe();
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('regenerates the report on PREMARKET_REFRESH_COMPLETED without throwing', async () => {
    expect(() =>
      eventBus.emit(PREMARKET_REFRESH_COMPLETED, {
        tradingDate: TRADING_DATE,
        refreshVersion: 2,
        refreshedAt: '2026-10-06T13:00:00.000Z',
        planCount: 6,
        at: '2026-10-06T13:00:00.000Z',
      }),
    ).not.toThrow();

    // The subscriber builds async; poll for the persisted v2 report.
    let read = null;
    for (let i = 0; i < 50 && !read; i++) {
      await new Promise((r) => setTimeout(r, 100));
      read = await getPersistedFocusReport(TRADING_DATE, 2);
    }
    expect(read).not.toBeNull();
    expect(read!.metrics.candidateCount).toBe(6);
    expect(read!.refreshedAt).toBe('2026-10-06T13:00:00.000Z');
  });

  it('ignores malformed refresh payloads without throwing', () => {
    expect(() => eventBus.emit(PREMARKET_REFRESH_COMPLETED, null)).not.toThrow();
    expect(() => eventBus.emit(PREMARKET_REFRESH_COMPLETED, { tradingDate: 'not-a-date' })).not.toThrow();
    expect(() => eventBus.emit(PREMARKET_REFRESH_COMPLETED, { tradingDate: TRADING_DATE, refreshVersion: -1 })).not.toThrow();
  });
});
