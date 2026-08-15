import { describe, it, expect } from 'vitest';
import { buildDiagnostic, diagnosticFromBacktestError } from './buildDiagnostic';
import { interpolate } from './types';

describe('diagnostic catalog', () => {
  it('interpolates live facts and does not invent a PID', () => {
    const d = buildDiagnostic('MOD-001', {
      endpoint: 'http://localhost:8008',
      detail: 'fetch failed',
    });
    expect(d.userMessage).toContain('http://localhost:8008');
    expect(d.userMessage).toContain('fetch failed');
    expect(d.tradingBlocked).toBe(false);
    expect(d.canContinueSafely).toBe(true);
    expect(d.tradingImpact).toMatch(/OPTIONAL/);
    expect(JSON.stringify(d.facts)).not.toMatch(/PID/);
  });

  it('marks stale market data as blocking new orders using RiskEngine\'s 5-minute window', () => {
    const d = buildDiagnostic('MD-001', {
      symbol: 'MSFT',
      ageSeconds: 47,
      thresholdSeconds: 300,
      cause: 'No MARKET_DATA tick',
    });
    expect(d.tradingBlocked).toBe(true);
    expect(d.userMessage).toContain('47');
    expect(d.userMessage).toContain('300');
  });

  it('does not tell the user to add an API key when news is an empty match', () => {
    const d = buildDiagnostic('NEWS-001', {});
    expect(d.status).toBe('EMPTY_RESULT');
    expect(d.severity).toBe('INFO');
    expect(d.recommendedFix.toLowerCase()).not.toContain('api key');
  });

  it('blames Argus allocation, not the broker, for CAP-001', () => {
    const d = buildDiagnostic('CAP-001', {
      requested: 30, remaining: 25, allocated: 100, used: 75, brokerBuyingPower: 2137,
    });
    expect(d.userMessage).toMatch(/NOT the reason/);
    expect(d.title).toMatch(/not by the broker/i);
  });

  it('maps corporate-action backtest errors to BT-002', () => {
    const d = diagnosticFromBacktestError('CORPORATE_ACTION_DETECTED: AAPL raw vs adjusted');
    expect(d.code).toBe('BT-002');
    expect(d.severity).toBe('CRITICAL');
  });

  it('leaves unknown placeholders as an honest not-reported token', () => {
    expect(interpolate('PID {pid}', {})).toContain('not reported');
  });
});
