/**
 * 2026-10-13 protective-exit single-flight matrix (cases A-H). A rejected protective close must free ONLY its own
 * trace's ownership so the next normal PortfolioMonitor review can retry; a live close must never be duplicated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { continuousIntelligence } from '../config/continuousIntelligence';
import {
  canEmitPortfolioExitIdea,
  reconcileExitOwnership,
  getExitOwnerTrace,
  pruneExitCooldownsForFlatSymbols,
  resetPortfolioIntelForTests,
} from './portfolioIntel';

const FLAG = 'ARGUS_PORTFOLIO_INTEL_ENABLED';
const T0 = 10_000_000;
const MONITOR_CYCLE_MS = 60_000;
const COOLDOWN = () => continuousIntelligence.exitIdeaCooldownMs;

describe('protective exit trace ownership', () => {
  beforeEach(() => { process.env[FLAG] = 'true'; resetPortfolioIntelForTests(); });
  afterEach(() => { delete process.env[FLAG]; resetPortfolioIntelForTests(); });

  it('CASE A: Risk rejection releases exact ownership; next monitor cycle (60s later, far inside the 5-min cooldown) may emit', () => {
    expect(COOLDOWN()).toBeGreaterThan(MONITOR_CYCLE_MS * 2);
    expect(canEmitPortfolioExitIdea('S', T0, 'a1')).toBe(true);
    expect(canEmitPortfolioExitIdea('S', T0 + 1_000, 'a-dup')).toBe(false);
    eventBus.emit(EVENTS.RISK_ASSESSMENT_COMPLETED, { traceId: 'a1', symbol: 'S', side: 'SELL', approved: false });
    expect(canEmitPortfolioExitIdea('S', T0 + MONITOR_CYCLE_MS, 'a2')).toBe(true);
  });

  it('CASE B: an approved close that is still PENDING stays single-flight far beyond the cooldown', () => {
    expect(canEmitPortfolioExitIdea('S', T0, 'b1')).toBe(true);
    eventBus.emit(EVENTS.RISK_ASSESSMENT_COMPLETED, { traceId: 'b1', symbol: 'S', side: 'SELL', approved: true });
    eventBus.emit(EVENTS.ORDER_EXECUTED, { traceId: 'b1', symbol: 'S', side: 'SELL', status: 'PENDING' });
    for (const offset of [COOLDOWN() + 1, COOLDOWN() * 3, 3_600_000]) {
      expect(canEmitPortfolioExitIdea('S', T0 + offset, 'b-dup')).toBe(false);
    }
    // the evidence-based backstop never releases a live order, however old
    expect(reconcileExitOwnership('S', 'NON_TERMINAL', T0 + 86_400_000)).toBe('KEPT');
    expect(getExitOwnerTrace('S')).toBe('b1');
  });

  it('CASE C: PARTIALLY_FILLED keeps single-flight', () => {
    expect(canEmitPortfolioExitIdea('S', T0, 'c1')).toBe(true);
    eventBus.emit(EVENTS.ORDER_EXECUTED, { traceId: 'c1', symbol: 'S', side: 'SELL', status: 'PARTIALLY_FILLED' });
    expect(canEmitPortfolioExitIdea('S', T0 + COOLDOWN() + 1, 'c-dup')).toBe(false);
  });

  it.each(['REJECTED', 'CANCELED'])('CASE D: broker %s releases exact ownership', (status) => {
    expect(canEmitPortfolioExitIdea('S', T0, 'd1')).toBe(true);
    eventBus.emit(EVENTS.ORDER_EXECUTED, { traceId: 'd1', symbol: 'S', side: 'SELL', status });
    expect(canEmitPortfolioExitIdea('S', T0 + MONITOR_CYCLE_MS, 'd2')).toBe(true);
  });

  it('CASE E: an unrelated SELL trace (any terminal signal) cannot release the protective owner', () => {
    expect(canEmitPortfolioExitIdea('S', T0, 'e-owner')).toBe(true);
    eventBus.emit(EVENTS.RISK_ASSESSMENT_COMPLETED, { traceId: 'discretionary', symbol: 'S', side: 'SELL', approved: false });
    eventBus.emit(EVENTS.ORDER_EXECUTED, { traceId: 'discretionary', symbol: 'S', side: 'SELL', status: 'FILLED' });
    eventBus.emit(EVENTS.DESK_NO_TRADE, { traceId: 'discretionary', symbol: 'S' });
    eventBus.emit(EVENTS.TRADE_IDEA_REJECTED, { traceId: 'discretionary', symbol: 'S' });
    expect(getExitOwnerTrace('S')).toBe('e-owner');
    expect(canEmitPortfolioExitIdea('S', T0 + COOLDOWN() + 1, 'e-dup')).toBe(false);
  });

  it.each([
    [EVENTS.TRADE_IDEA_REJECTED, 'contract/asset gate'],
    [EVENTS.IDEA_RATE_LIMITED, 'rate limit'],
    [EVENTS.DESK_NO_TRADE, 'ChiefTrader NO_TRADE'],
  ])('CASE F: pre-Risk terminal (%s - %s) releases exact ownership', (eventName) => {
    expect(canEmitPortfolioExitIdea('S', T0, 'f1')).toBe(true);
    eventBus.emit(eventName as any, { traceId: 'f1', symbol: 'S' });
    expect(canEmitPortfolioExitIdea('S', T0 + MONITOR_CYCLE_MS, 'f2')).toBe(true);
  });

  it('CASE G: a flat symbol is pruned (ownership and cooldown) so a later position starts clean', () => {
    expect(canEmitPortfolioExitIdea('S', T0, 'g1')).toBe(true);
    pruneExitCooldownsForFlatSymbols(new Set(['AAPL']));
    expect(getExitOwnerTrace('S')).toBeNull();
    expect(canEmitPortfolioExitIdea('S', T0 + 1, 'g2')).toBe(true);
  });

  it('CASE H: Risk persistence failure (RISK_BLOCK carrying the trace) does not leave ownership stuck', () => {
    expect(canEmitPortfolioExitIdea('S', T0, 'h1')).toBe(true);
    eventBus.emit(EVENTS.RISK_BLOCK, { traceId: 'h1', symbol: 'S', side: 'SELL', gate: 'risk_assessment_persist' });
    expect(canEmitPortfolioExitIdea('S', T0 + MONITOR_CYCLE_MS, 'h2')).toBe(true);
  });

  it('backstop: a lost terminal event cannot strand the symbol - orphan (no order row) released only after the grace', () => {
    const grace = continuousIntelligence.exitOwnershipOrphanGraceMs;
    expect(canEmitPortfolioExitIdea('S', T0, 'x1')).toBe(true);
    expect(reconcileExitOwnership('S', 'NONE', T0 + grace - 1)).toBe('KEPT');
    expect(reconcileExitOwnership('S', 'NONE', T0 + grace)).toBe('RELEASED');
    expect(canEmitPortfolioExitIdea('S', T0 + grace + 1, 'x2')).toBe(true);
  });

  it('backstop: a terminal order row releases immediately', () => {
    expect(canEmitPortfolioExitIdea('S', T0, 'y1')).toBe(true);
    expect(reconcileExitOwnership('S', 'TERMINAL', T0 + 1)).toBe('RELEASED');
  });

  it('FILLED releases (position closed), so no stale owner remains', () => {
    expect(canEmitPortfolioExitIdea('S', T0, 'z1')).toBe(true);
    eventBus.emit(EVENTS.ORDER_EXECUTED, { traceId: 'z1', symbol: 'S', side: 'SELL', status: 'FILLED' });
    expect(getExitOwnerTrace('S')).toBeNull();
  });
});
