import { describe, it, expect } from 'vitest';
import { canadianMarketReadiness } from './canadianReadiness';

describe('canadianMarketReadiness', () => {
  it('states live execution is not available and lists TSX/TSXV/CSE', () => {
    const r = canadianMarketReadiness();
    expect(r.liveExecution).toBe('NOT_AVAILABLE');
    expect(r.banner).toBe('CANADIAN LIVE EXECUTION: NOT AVAILABLE');
    expect(r.exchanges).toEqual(expect.arrayContaining(['TSX', 'TSXV', 'CSE']));
    expect(r.currency).toBe('CAD');
    expect(r.routing).toMatch(/BLOCKED/);
  });
});
