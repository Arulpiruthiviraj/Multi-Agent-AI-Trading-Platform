import { describe, it, expect } from 'vitest';
import {
  latestCycleIsMatch,
  parseReconMismatches,
  selectUnackedFilledOrphans,
} from './reconciliationOperatorSnapshot';

describe('reconciliationOperatorSnapshot', () => {
  it('treats matches=true with empty mismatches as MATCH', () => {
    expect(latestCycleIsMatch({ matches: true, mismatches: null })).toBe(true);
    expect(latestCycleIsMatch({ matches: 1, mismatches: null })).toBe(true);
    expect(latestCycleIsMatch({ matches: false, mismatches: '[]' })).toBe(false);
    expect(latestCycleIsMatch({ matches: true, mismatches: '[{"type":"MISSING_LOCALLY"}]' })).toBe(false);
  });

  it('parses mismatch JSON fail-closed', () => {
    expect(parseReconMismatches(null)).toEqual([]);
    expect(parseReconMismatches('not-json')).toEqual([]);
    expect(parseReconMismatches('[{"type":"FILLED_ORDER_MISSING_LOCALLY"}]')).toHaveLength(1);
  });

  it('selects only unacked FILLED broker orders missing locally', () => {
    const orphans = selectUnackedFilledOrphans({
      filledBrokerOrders: [
        { id: 'keep', symbol: 'GLD', quantity: 1 },
        { id: 'local', symbol: 'NVDA', quantity: 1 },
        { id: 'acked', symbol: 'AAPL', quantity: 2 },
        { id: '', symbol: 'MSFT', quantity: 1 },
      ],
      localBrokerOrderIds: ['local'],
      acknowledgedOrderIds: ['acked'],
    });
    expect(orphans).toEqual([
      expect.objectContaining({ brokerOrderId: 'keep', symbol: 'GLD', quantity: 1 }),
    ]);
  });
});
