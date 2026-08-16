import { describe, it, expect } from 'vitest';
import { assertBrokerEnvironmentAllowsOrder, classifyBrokerEnvironment } from './brokerEnvironment';
import { evaluateLiveReadiness } from './liveReadinessEngine';
import { researchSafety } from '../config/researchSafety';

describe('LIVE readiness engine and broker environment', () => {
  it('LIVE + paperMode true is UNKNOWN and cannot order', () => {
    expect(classifyBrokerEnvironment({ tradingMode: 'LIVE', paperMode: true })).toBe('UNKNOWN');
    expect(assertBrokerEnvironmentAllowsOrder({ tradingMode: 'LIVE', paperMode: true }).ok).toBe(false);
  });

  it('PAPER + paperMode true is PAPER and may order on the paper path', () => {
    expect(classifyBrokerEnvironment({ tradingMode: 'Paper', paperMode: true })).toBe('PAPER');
    expect(assertBrokerEnvironmentAllowsOrder({ tradingMode: 'Paper', paperMode: true }).ok).toBe(true);
  });

  it('SQLite integer paperMode 0 with LIVE is LIVE classification only', () => {
    expect(classifyBrokerEnvironment({ tradingMode: 'LIVE', paperMode: 0 })).toBe('LIVE');
  });

  it('PAPER + paperMode false is UNKNOWN', () => {
    expect(classifyBrokerEnvironment({ tradingMode: 'Paper', paperMode: false })).toBe('UNKNOWN');
    expect(assertBrokerEnvironmentAllowsOrder({ tradingMode: 'Paper', paperMode: false }).ok).toBe(false);
  });

  it('LIVE + paperMode false is LIVE classification only — not a LIVE_READY certificate', () => {
    expect(classifyBrokerEnvironment({ tradingMode: 'LIVE', paperMode: false })).toBe('LIVE');
    const r = evaluateLiveReadiness();
    expect(r.result).toBe('LIVE_NO_GO');
  });

  it('evaluateLiveReadiness is LIVE_NO_GO with edge 8 and Canadian BLOCKED', () => {
    const r = evaluateLiveReadiness();
    expect(r.result).toBe('LIVE_NO_GO');
    expect(r.tradingEdgeScore).toBe(8);
    expect(r.organicPaper).toBe('NOT_ESTABLISHED');
    expect(r.canadianLive).toBe('NOT_AVAILABLE');
    expect(r.canPlaceOrdersViaResearch).toBe(false);
    expect(r.failedMandatory).toContain('PAPER');
    expect(r.failedMandatory).toContain('OOS');
    expect(r.failedMandatory).toContain('LEGAL_CA');
    expect(r.gates.find((g) => g.id === 'LEGAL_CA')?.verdict).toBe('BLOCKED');
    expect(r.gates.find((g) => g.id === 'STRATEGY_CORE')?.verdict).toBe('FAIL');
    expect(researchSafety.coreStrategyIds).toHaveLength(5);
  });

  it('cannot return LIVE_READY while CORE is UNTESTED and paper is empty', () => {
    const r = evaluateLiveReadiness();
    expect(r.gates.every((g) => g.verdict === 'PASS')).toBe(false);
  });
});
