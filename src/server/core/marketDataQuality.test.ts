import { describe, it, expect } from 'vitest';
import { evaluateQuoteFreshness } from './marketDataQuality';
import { tradingSafety } from '../config/tradingSafety';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

describe('MarketDataQualityEngine', () => {
  it('treats null tick age as UNKNOWN and not passed', () => {
    const r = evaluateQuoteFreshness({ priceAgeMs: null, staleThresholdMs: tradingSafety.stalePriceThresholdMs });
    expect(r.grade).toBe('UNKNOWN');
    expect(r.passed).toBe(false);
  });

  it('treats age above stale threshold as RED', () => {
    const r = evaluateQuoteFreshness({
      priceAgeMs: tradingSafety.stalePriceThresholdMs + 1,
      staleThresholdMs: tradingSafety.stalePriceThresholdMs,
    });
    expect(r.grade).toBe('RED');
    expect(r.passed).toBe(false);
  });

  it('treats a fresh tick as passed GREEN or YELLOW', () => {
    const r = evaluateQuoteFreshness({ priceAgeMs: 1000, staleThresholdMs: tradingSafety.stalePriceThresholdMs });
    expect(r.passed).toBe(true);
    expect(['GREEN', 'YELLOW']).toContain(r.grade);
  });
});

describe('sizingModels.json', () => {
  it('does not mark ATR as the live sizing model', () => {
    const cfg = loadRepoConfigJson<{ liveModelId: string; models: Record<string, { status: string }> }>('sizingModels.json');
    expect(cfg.liveModelId).toBe('FIXED_DOLLAR_STOP_ASSUMPTION_PCT');
    expect(cfg.models.ATR.status).toBe('NOT_LIVE');
  });
});
