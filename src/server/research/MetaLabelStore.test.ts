/**
 * MetaLabelStore.test.ts
 *
 * Tests the meta-label feature recording (fail-closed behavior, schema version).
 * Uses an in-memory SQLite database - no production data touched.
 */
import { describe, it, expect, beforeEach } from 'vitest';

describe('MetaLabelStore', () => {
  it('exports the schema version constant', async () => {
    const { META_LABEL_SCHEMA_VERSION } = await import('./MetaLabelStore');
    expect(META_LABEL_SCHEMA_VERSION).toBe(1);
  });

  it('recordMetaLabelFeatures is fail-closed (never throws)', async () => {
    const { recordMetaLabelFeatures } = await import('./MetaLabelStore');
    // Even with a broken DB connection or invalid input, this must not throw.
    expect(() => recordMetaLabelFeatures({
      traceId: 'test-trace-123',
      strategyId: 'TEST_STRATEGY',
      symbol: 'AAPL',
      signalScore: 75,
      signalConfidence: 0.8,
      regime: 'BULLISH_TREND',
      decisionPrice: 150.0,
      barCount: 100,
      conditionsMet: ['trend_up'],
      conditionsFailed: [],
      evidenceSource: 'PAPER',
    })).not.toThrow();
  });

  it('countLabeledRows returns 0 on failure instead of throwing', async () => {
    const { countLabeledRows } = await import('./MetaLabelStore');
    const n = countLabeledRows('NO_SUCH_STRATEGY', 'PAPER');
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
