import { describe, it, expect } from 'vitest';
import { unwrapTechPayload, isTechnicalEngineCalc, bollingerWidthPct, finiteNum } from './parseTechTelemetry';

describe('parseTechTelemetry', () => {
  it('reads nested CALCULATION_COMPLETED and flat TECHNICAL_ANALYSIS_COMPLETED', () => {
    expect(unwrapTechPayload({ engine: 'TechnicalEngine', symbol: 'SPY', data: { rsi: 61.2 } })?.rsi).toBe(61.2);
    expect(unwrapTechPayload({ rsi: 61.2, macd: 0.01 })?.rsi).toBe(61.2);
    expect(finiteNum('x')).toBeNull();
  });

  it('does not treat AdvancedQuantEngine calc as a Technical Agent RSI point', () => {
    expect(isTechnicalEngineCalc({ engine: 'AdvancedQuantEngine', data: { atr: '1.2' } })).toBe(false);
  });

  it('computes BB width % from real band fields only', () => {
    expect(bollingerWidthPct({ bbUpper: 12, bbLower: 8, currentPrice: 10 })).toBeCloseTo(40, 8);
    expect(bollingerWidthPct({ bbUpper: 12, bbLower: 8 })).toBeNull();
  });
});
