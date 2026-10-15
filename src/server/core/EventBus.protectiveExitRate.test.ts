/**
 * Integration: the idea rate cap in EventBus.emit must never deny a GENUINE protective exit, and must still deny a spoofed one
 * (agent name alone, or origin alone). Production evidence 2026-10-15: the first-come 120/min window was saturated and dropped 28-33% of ideas.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';
import { allowTradeIdea, getPipelineRateSnapshot, resetPipelineRateLimitForTests } from './pipelineRateLimit';
import { tradingSafety } from '../config/tradingSafety';
import { agentWeightConfig } from '../config/agentWeights';

afterEach(() => resetPipelineRateLimitForTests());

function idea(over: Record<string, unknown>) {
  const id = Math.random().toString(36).slice(2);
  return { traceId: 'trace_AAPL_' + id, symbol: 'AAPL', side: 'SELL', confidence: 0.9, reasoning: 'test', agent: 'TestAgent', currentPrice: 200, ...over };
}

describe('EventBus protective-exit rate-limit exemption', () => {
  it('delivers a genuine risk exit while the window is saturated, and rate-limits spoofed exits', () => {
    const delivered: string[] = [];
    const limited: string[] = [];
    const onIdea = (p: any) => delivered.push(p.traceId);
    const onLimited = (p: any) => limited.push(p.traceId);
    eventBus.on(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    eventBus.on(EVENTS.IDEA_RATE_LIMITED, onLimited);
    try {
      for (let i = 0; i < tradingSafety.maxTradeIdeasPerMinute; i++) allowTradeIdea(Date.now(), { agent: 'KronosEngine' }); // saturate

      const genuine = idea({ agent: agentWeightConfig.riskExitAgent, origin: 'PORTFOLIO_EXIT', side: 'SELL' });
      const spoofedAgentOnly = idea({ agent: agentWeightConfig.riskExitAgent, origin: 'AGENT_IDEA', side: 'SELL' });
      const spoofedOriginOnly = idea({ agent: 'KronosEngine', origin: 'PORTFOLIO_EXIT', side: 'SELL' });
      const exitShapedBuy = idea({ agent: agentWeightConfig.riskExitAgent, origin: 'PORTFOLIO_EXIT', side: 'BUY' });
      const ordinary = idea({ agent: 'TechnicalAgent', side: 'BUY' });

      eventBus.emitTradeIdea(genuine);
      for (const x of [spoofedAgentOnly, spoofedOriginOnly, exitShapedBuy, ordinary]) eventBus.emitTradeIdea(x);

      expect(delivered).toContain(genuine.traceId);
      for (const x of [spoofedAgentOnly, spoofedOriginOnly, exitShapedBuy, ordinary]) {
        expect(delivered).not.toContain(x.traceId);
        expect(limited).toContain(x.traceId);
      }
      expect(getPipelineRateSnapshot().protectiveExitsExempted).toBe(1);
    } finally {
      eventBus.off(EVENTS.TRADE_IDEA_GENERATED, onIdea);
      eventBus.off(EVENTS.IDEA_RATE_LIMITED, onLimited);
    }
  });
});
