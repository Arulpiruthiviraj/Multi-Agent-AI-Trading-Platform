import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import {
  buildTradePlanDrafts,
  persistTradePlanDrafts,
  revalidateTradePlan,
  persistRevalidation,
  getTradePlansForDate,
  type TradePlanStatus,
} from './TradePlanBuilder';
import { getRefinedSnapshot, evaluateSessionLifecycle } from '../premarket/SessionLifecycle';
import type { RankedCandidate, RankingInput, ComponentSet } from './ComposableRanking';

/**
 * Mission §21 follow-up (docs/audits/ARGUS_PREMARKET_TRADING_IMPLEMENTATION.md §4/§10): the
 * original mission asked for explicit RTH-handoff scenario tests. The exact scenario text from
 * that mission specification is not preserved verbatim in this repository, so this file is
 * reasonable, real coverage of the RTH handoff itself rather than a byte-exact reproduction of a
 * document that no longer exists in context: it wires the REAL pipeline functions together
 * end-to-end (build -> persist -> PRE_MARKET plan -> REGULAR revalidation cycles -> terminal
 * state), which each already-existing unit test suite (TradePlanBuilder.test.ts,
 * SessionLifecycle.test.ts) exercises only in isolation, one function or one hand-crafted DB row
 * at a time - never the full sequence a real trading day actually produces.
 */

/** All times below are UTC instants landing at the stated America/New_York clock time on a known
 *  weekday (2026-08-27 is a Thursday; EDT is UTC-4 that week), so this test is not sensitive to
 *  the host machine's own timezone. */
function etOnThursday(hh: number, mm: number): Date {
  return new Date(`2026-08-27T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);
}

const PLAN_DATE = '2026-08-27';

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
function ranked(symbol: string, rank: number, promotionRecommendation: RankedCandidate['promotionRecommendation'], finalScore = 0.8): RankedCandidate {
  return {
    symbol, components: fullComponents(), finalScore, weightsUsed: {},
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
  };
}

/** Builds and persists one READY plan for `symbol` as of PRE_MARKET, mirroring exactly what
 *  SnapshotScanner.refreshSnapshotRanks() does at 'PRE_MARKET' with no existing plan for the day. */
async function buildAndPersistPlan(symbol: string, direction: 'BUY' | 'SELL' = 'BUY'): Promise<string> {
  const rawMomentumPct = direction === 'BUY' ? 5.26 : -5.26;
  const candidates = [ranked(symbol, 1, 'PROMOTE')];
  const inputs = new Map([[symbol, input(symbol, { rawMomentumPct })]]);
  const drafts = buildTradePlanDrafts(candidates, inputs, PLAN_DATE, etOnThursday(8, 0));
  await persistTradePlanDrafts(drafts);
  return drafts[0].id;
}

async function currentStatus(planId: string): Promise<string> {
  const [row] = await db.select().from(schema.tradePlans).where(eq(schema.tradePlans.id, planId)).limit(1);
  return row.status;
}

describe('RTH handoff integration: PRE_MARKET plan -> REGULAR revalidation -> terminal state', () => {
  beforeEach(async () => {
    await db.delete(schema.tradePlans);
    await db.delete(schema.tradePlanRevalidations);
    await db.delete(schema.agentPredictions);
  });
  afterEach(async () => {
    await db.delete(schema.tradePlans);
    await db.delete(schema.tradePlanRevalidations);
    await db.delete(schema.agentPredictions);
  });

  it('scenario A: a PRE_MARKET plan that keeps clearing PROMOTE reaches VALID, session refines to OPEN_REVALIDATION, and a shadow prediction is recorded exactly once', async () => {
    const planId = await buildAndPersistPlan('HANDA');
    expect(await currentStatus(planId)).toBe('READY');

    // PRE_MARKET: session refines to PLAN_READY (a real plan already exists for today).
    const premarketSnap = evaluateSessionLifecycle(etOnThursday(8, 0));
    expect((await getRefinedSnapshot(premarketSnap)).appState).toBe('PLAN_READY');

    // REGULAR-session revalidation cycle 1: still PROMOTE-tier -> REVALIDATED -> VALID.
    const plan = (await getTradePlansForDate(PLAN_DATE))[0];
    const outcome1 = revalidateTradePlan(
      { direction: plan.direction, invalidationLevel: plan.invalidationLevel, validUntil: plan.validUntil },
      input('HANDA', { last: 101 }),
      ranked('HANDA', 1, 'PROMOTE'),
      etOnThursday(10, 0),
    );
    expect(outcome1.result).toBe('REVALIDATED');
    await persistRevalidation(plan.id, outcome1, etOnThursday(10, 0), plan.status as TradePlanStatus, { symbol: 'HANDA', direction: 'BUY', confidence: plan.confidence });
    expect(await currentStatus(planId)).toBe('VALID');

    // Session now refines to OPEN_REVALIDATION - a real open plan still needs revalidating.
    const regularSnap = evaluateSessionLifecycle(etOnThursday(10, 0));
    expect((await getRefinedSnapshot(regularSnap)).appState).toBe('OPEN_REVALIDATION');

    // Shadow-tracking recorded the FIRST VALID transition exactly once.
    const shadowRows = await db.select().from(schema.agentPredictions).where(eq(schema.agentPredictions.agentName, 'TradePlanShadowTracker'));
    expect(shadowRows.filter((r) => r.symbol === 'HANDA')).toHaveLength(1);

    // REGULAR-session revalidation cycle 2 (still VALID, still PROMOTE): status stays VALID, no
    // second shadow prediction (previousStatus was already VALID this time).
    const planAfter1 = (await getTradePlansForDate(PLAN_DATE))[0];
    const outcome2 = revalidateTradePlan(
      { direction: planAfter1.direction, invalidationLevel: planAfter1.invalidationLevel, validUntil: planAfter1.validUntil },
      input('HANDA', { last: 102 }),
      ranked('HANDA', 1, 'PROMOTE'),
      etOnThursday(10, 30),
    );
    await persistRevalidation(planAfter1.id, outcome2, etOnThursday(10, 30), planAfter1.status as TradePlanStatus, { symbol: 'HANDA', direction: 'BUY', confidence: planAfter1.confidence });
    expect(await currentStatus(planId)).toBe('VALID');
    const shadowRowsAfter = await db.select().from(schema.agentPredictions).where(eq(schema.agentPredictions.agentName, 'TradePlanShadowTracker'));
    expect(shadowRowsAfter.filter((r) => r.symbol === 'HANDA')).toHaveLength(1); // still exactly one
  });

  it('scenario B: a downgraded (HOLD-tier) candidate moves the plan to REVALIDATING, and the session stays in OPEN_REVALIDATION (still not terminal)', async () => {
    const planId = await buildAndPersistPlan('HANDB');
    const plan = (await getTradePlansForDate(PLAN_DATE))[0];

    const outcome = revalidateTradePlan(
      { direction: plan.direction, invalidationLevel: plan.invalidationLevel, validUntil: plan.validUntil },
      input('HANDB', { last: 100.5 }),
      ranked('HANDB', 20, 'HOLD', 0.4),
      etOnThursday(10, 0),
    );
    expect(outcome.result).toBe('DOWNGRADED');
    await persistRevalidation(plan.id, outcome, etOnThursday(10, 0), plan.status as TradePlanStatus);
    expect(await currentStatus(planId)).toBe('REVALIDATING');

    const regularSnap = evaluateSessionLifecycle(etOnThursday(10, 0));
    expect((await getRefinedSnapshot(regularSnap)).appState).toBe('OPEN_REVALIDATION');

    // No shadow prediction - the plan never reached VALID in this scenario.
    const shadowRows = await db.select().from(schema.agentPredictions).where(eq(schema.agentPredictions.agentName, 'TradePlanShadowTracker'));
    expect(shadowRows.filter((r) => r.symbol === 'HANDB')).toHaveLength(0);
  });

  it('scenario C: a real stop-level breach invalidates the plan, and the session reverts to unrefined (INTRADAY) once no open plan remains', async () => {
    const planId = await buildAndPersistPlan('HANDC', 'BUY');
    const plan = (await getTradePlansForDate(PLAN_DATE))[0];
    expect(plan.invalidationLevel).not.toBeNull();

    const belowStop = (plan.invalidationLevel as number) - 1;
    const outcome = revalidateTradePlan(
      { direction: plan.direction, invalidationLevel: plan.invalidationLevel, validUntil: plan.validUntil },
      input('HANDC', { last: belowStop }),
      ranked('HANDC', 1, 'PROMOTE'),
      etOnThursday(10, 0),
    );
    expect(outcome.result).toBe('INVALIDATED');
    await persistRevalidation(plan.id, outcome, etOnThursday(10, 0), plan.status as TradePlanStatus);
    expect(await currentStatus(planId)).toBe('INVALIDATED');

    const regularSnap = evaluateSessionLifecycle(etOnThursday(10, 0));
    expect((await getRefinedSnapshot(regularSnap)).appState).toBe('INTRADAY'); // unrefined - no open plan left
  });

  it('scenario D: a plan past its validUntil expires regardless of current price/rank, and the session reverts to unrefined', async () => {
    const planId = await buildAndPersistPlan('HANDD');
    const plan = (await getTradePlansForDate(PLAN_DATE))[0];

    const afterClose = new Date(plan.validUntil);
    afterClose.setUTCHours(afterClose.getUTCHours() + 1); // safely past validUntil
    const outcome = revalidateTradePlan(
      { direction: plan.direction, invalidationLevel: plan.invalidationLevel, validUntil: plan.validUntil },
      input('HANDD', { last: 105 }),
      ranked('HANDD', 1, 'PROMOTE'),
      afterClose,
    );
    expect(outcome.result).toBe('EXPIRED');
    await persistRevalidation(plan.id, outcome, afterClose, plan.status as TradePlanStatus);
    expect(await currentStatus(planId)).toBe('EXPIRED');

    const regularSnap = evaluateSessionLifecycle(etOnThursday(10, 0));
    expect((await getRefinedSnapshot(regularSnap)).appState).toBe('INTRADAY');
  });

  it('scenario E: OPEN_REVALIDATION persists while ANY plan for the day is still open, even after a sibling plan reaches a terminal state', async () => {
    const openPlanId = await buildAndPersistPlan('HANDE1');
    const terminalPlanId = await buildAndPersistPlan('HANDE2');

    const terminalPlan = (await getTradePlansForDate(PLAN_DATE)).find((p) => p.id === terminalPlanId)!;
    const belowStop = (terminalPlan.invalidationLevel as number) - 1;
    const terminalOutcome = revalidateTradePlan(
      { direction: terminalPlan.direction, invalidationLevel: terminalPlan.invalidationLevel, validUntil: terminalPlan.validUntil },
      input('HANDE2', { last: belowStop }),
      ranked('HANDE2', 1, 'PROMOTE'),
      etOnThursday(10, 0),
    );
    await persistRevalidation(terminalPlan.id, terminalOutcome, etOnThursday(10, 0), terminalPlan.status as TradePlanStatus);
    expect(await currentStatus(terminalPlanId)).toBe('INVALIDATED');
    expect(await currentStatus(openPlanId)).toBe('READY'); // untouched - still open

    // One plan is now terminal, one is still READY (open) - session must still report OPEN_REVALIDATION.
    const regularSnap = evaluateSessionLifecycle(etOnThursday(10, 0));
    expect((await getRefinedSnapshot(regularSnap)).appState).toBe('OPEN_REVALIDATION');
  });
});
