/**
 * TEST C - PRODUCTION_FAILURE_REPLAY: D1 (2026-10-15).
 *
 * Production fact: in 09:30-10:00 ET the first-come 120 ideas/min cap in EventBus.emit was saturated by research traffic (Kronos ~105/min, Macro ~29/min,
 * Technical ~19/min, Quant/Java ~6/min) and dropped 28-33% of every agent's ideas, protective exits included.
 * Why yesterday's certification missed it (see docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_GAP_ANALYSIS.md): synthetic sessions disabled MacroAgent and ran no Kronos, so the
 * limiter was never saturated; and the exit oracle tolerates a 15 min grace, so a dropped-then-retried exit still passed.
 *
 * This replay drives the REAL EventBus.emit + real limiter + real contract gate with production-equivalent traffic on a controlled clock, injects genuine protective
 * exits exactly as PortfolioMonitor.emitRiskExit shapes them, and asserts what actually matters: DELIVERY AT THE BOUNDARY, in the same tick, with the saturation
 * precondition proven (so the test cannot silently become vacuous).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../../core/EventBus';
import { EVENTS } from '../../core/eventNames';
import { getPipelineRateSnapshot, resetPipelineRateLimitForTests } from '../../core/pipelineRateLimit';
import { tradingSafety } from '../../config/tradingSafety';
import { agentWeightConfig } from '../../config/agentWeights';

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'TSLA', 'GOOGL', 'AMZN', 'INTC', 'MU', 'DELL', 'ARM'];
let seq = 0;
function research(agent: string, side: 'BUY' | 'SELL' | 'HOLD', confidence: number) {
  const symbol = SYMBOLS[seq % SYMBOLS.length];
  return { traceId: `trace_${symbol}_${seq++}_${Math.random().toString(36).slice(2, 6)}`, symbol, side, confidence, reasoning: 'production-equivalent research traffic', agent, currentPrice: 100 };
}
function protectiveExit(symbol: string) {
  return { traceId: `trace_${symbol}_exit_${seq++}_${Math.random().toString(36).slice(2, 6)}`, symbol, side: 'SELL' as const, confidence: 0.99, reasoning: 'stop breached', agent: agentWeightConfig.riskExitAgent, origin: 'PORTFOLIO_EXIT', currentPrice: 95 };
}

describe('TEST C / D1: protective exits under production-equivalent idea saturation', () => {
  const delivered = new Set<string>();
  const limited = new Set<string>();
  const onIdea = (p: any) => delivered.add(p.traceId);
  const onLimited = (p: any) => limited.add(p.traceId);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T13:30:00Z'));
    resetPipelineRateLimitForTests();
    delivered.clear(); limited.clear();
    eventBus.on(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    eventBus.on(EVENTS.IDEA_RATE_LIMITED, onLimited);
  });
  afterEach(() => {
    eventBus.off(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    eventBus.off(EVENTS.IDEA_RATE_LIMITED, onLimited);
    vi.useRealTimers();
    resetPipelineRateLimitForTests();
  });

  it('delivers every genuine protective exit in the same tick across 5 simulated minutes at ~170 research ideas/minute, and rate-limits spoofed exits', () => {
    const MINUTES = 5;
    const perMinute = { KronosEngine: 105, MacroAgent: 29, TechnicalAgent: 19, QuantEngine: 6, JavaCoreEnsemble: 3 } as const;
    expect(Object.values(perMinute).reduce((a, b) => a + b, 0)).toBeGreaterThan(tradingSafety.maxTradeIdeasPerMinute); // production-equivalent load exceeds the cap
    const exits: string[] = [];
    const spoofs: string[] = [];
    let researchEmitted = 0;

    for (let m = 0; m < MINUTES; m++) {
      for (const [agent, n] of Object.entries(perMinute)) {
        for (let i = 0; i < n; i++) {
          const side = agent === 'MacroAgent' ? 'HOLD' : (i % 3 === 0 ? 'SELL' : 'BUY');
          eventBus.emitTradeIdea(research(agent, side as any, agent === 'MacroAgent' ? 0.01 : 0.6));
          researchEmitted++;
          vi.advanceTimersByTime(Math.floor(60_000 / 162)); // spread across the minute so the sliding window behaves as in production
        }
      }
      // PRECONDITION (anti-vacuity): the cap is genuinely saturated and dropping research ideas right now.
      const snap = getPipelineRateSnapshot();
      expect(snap.ideasInWindow).toBe(tradingSafety.maxTradeIdeasPerMinute);
      expect(snap.ideasDropped).toBeGreaterThan(0);

      const ex = protectiveExit(SYMBOLS[m % SYMBOLS.length]);
      const spoofAgentOnly = { ...protectiveExit(SYMBOLS[(m + 1) % SYMBOLS.length]), origin: 'AGENT_IDEA' };
      const spoofOriginOnly = { ...protectiveExit(SYMBOLS[(m + 2) % SYMBOLS.length]), agent: 'KronosEngine' };
      exits.push(ex.traceId); spoofs.push(spoofAgentOnly.traceId, spoofOriginOnly.traceId);
      eventBus.emitTradeIdea(ex);
      eventBus.emitTradeIdea(spoofAgentOnly);
      eventBus.emitTradeIdea(spoofOriginOnly);
      // DELIVERY AT THE BOUNDARY, same tick - no waiting for a retry cycle.
      expect(delivered.has(ex.traceId)).toBe(true);
    }

    for (const id of exits) { expect(delivered.has(id)).toBe(true); expect(limited.has(id)).toBe(false); }
    for (const id of spoofs) { expect(delivered.has(id)).toBe(false); expect(limited.has(id)).toBe(true); }
    const snap = getPipelineRateSnapshot();
    expect(snap.protectiveExitsExempted).toBe(MINUTES);
    // research traffic is still governed by the cap (the cap itself is unchanged) and the drops are attributable per agent
    expect(snap.ideasDropped).toBeGreaterThan(researchEmitted * 0.15);
    expect(Object.keys(snap.ideasDroppedByAgent)).toContain('KronosEngine');
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
  });
});
