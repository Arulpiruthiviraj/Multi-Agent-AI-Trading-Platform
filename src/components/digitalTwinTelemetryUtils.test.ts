import { describe, expect, it } from 'vitest';
import {
  buildPipelineSteps,
  buildTransactions,
  classifyEventLog,
  getNodeMicroMetric,
  matchesLogFilter,
  MAX_TRACE_BUFFER,
} from './digitalTwinTelemetryUtils';

describe('digitalTwinTelemetryUtils', () => {
  it('buildTransactions caps at MAX_TRACE_BUFFER traces', () => {
    const evts = Array.from({ length: 60 }, (_, i) => ({
      type: 'TRADE_IDEA_GENERATED',
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      payload: { traceId: `trace-${i}`, symbol: 'AAPL', agent: 'TechnicalAgent', side: 'BUY', confidence: 0.5 },
    }));
    expect(buildTransactions(evts).length).toBe(MAX_TRACE_BUFFER);
  });

  it('buildPipelineSteps computes relative latency from first stage', () => {
    const t0 = '2026-08-17T14:00:00.000Z';
    const tx = buildTransactions([
      { type: 'TRADE_IDEA_GENERATED', timestamp: t0, payload: { traceId: 't1', symbol: 'AAPL', agent: 'TechnicalAgent', side: 'BUY', confidence: 0.8, currentPrice: 224.5 } },
      { type: 'CHIEF_APPROVED_IDEA', timestamp: '2026-08-17T14:00:00.042Z', payload: { traceId: 't1', symbol: 'AAPL', side: 'BUY', confidence: 0.84 } },
      { type: 'ORDER_EXECUTED', timestamp: '2026-08-17T14:00:00.285Z', payload: { traceId: 't1', symbol: 'AAPL', side: 'BUY', price: 224.52 } },
    ])[0];
    const steps = buildPipelineSteps(tx);
    expect(steps[0].offsetMs).toBe(0);
    expect(steps[1].offsetMs).toBe(42);
    expect(steps[2].offsetMs).toBe(285);
    expect(steps[1].label).toMatch(/Chief consensus/);
  });

  it('classifies NO_CONSENSUS and execution events', () => {
    expect(classifyEventLog('ORDER_EXECUTED')).toBe('EXECUTION');
    expect(classifyEventLog('DESK_NO_TRADE')).toBe('REJECT');
    expect(classifyEventLog('MARKET_DATA')).toBe('INFO');
  });

  it('filters raw log categories', () => {
    expect(matchesLogFilter('CHIEF_APPROVED_IDEA', 'CONSENSUS')).toBe(true);
    expect(matchesLogFilter('ORDER_EXECUTED', 'CONSENSUS')).toBe(false);
    expect(matchesLogFilter('RISK_ASSESSMENT_COMPLETED', 'RISK')).toBe(true);
  });

  it('getNodeMicroMetric extracts RSI and chief confidence', () => {
    expect(getNodeMicroMetric('technical-engine', {
      eventType: 'CALCULATION_COMPLETED',
      payload: { data: { rsi: 48.2 } },
    })).toBe('RSI 48.2');
    expect(getNodeMicroMetric('chief-trader', {
      eventType: 'CHIEF_APPROVED_IDEA',
      payload: { confidence: 0.82, side: 'BUY' },
    })).toBe('82% BUY');
  });
});
