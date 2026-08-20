import { describe, it, expect } from 'vitest';
import { clusterByTimeGap, wilsonInterval, rawVsEffectiveDirectional, type ClusterableRow } from './effectiveSampleSize';

function row(symbol: string, agent: string, side: string, timestampMs: number, outcome: ClusterableRow['outcome']): ClusterableRow {
  return { symbol, agent, side, timestampMs, outcome };
}

describe('clusterByTimeGap', () => {
  it('collapses tightly-spaced same-symbol/agent/side rows into one cluster', () => {
    const rows = [0, 1000, 2000, 3000].map((t) => row('SPY', 'TechnicalAgent', 'BUY', t, 'WIN'));
    const clusters = clusterByTimeGap(rows, 60000);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].rows).toHaveLength(4);
  });

  it('splits into separate clusters once the gap exceeds the threshold', () => {
    const rows = [
      row('SPY', 'TechnicalAgent', 'BUY', 0, 'WIN'),
      row('SPY', 'TechnicalAgent', 'BUY', 1000, 'WIN'),
      row('SPY', 'TechnicalAgent', 'BUY', 120000, 'LOSS'), // 119s gap > 60s threshold
    ];
    const clusters = clusterByTimeGap(rows, 60000);
    expect(clusters).toHaveLength(2);
  });

  it('keeps different symbols, agents, and sides in separate series entirely', () => {
    const rows = [
      row('SPY', 'TechnicalAgent', 'BUY', 0, 'WIN'),
      row('QQQ', 'TechnicalAgent', 'BUY', 0, 'WIN'),
      row('SPY', 'KronosEngine', 'BUY', 0, 'WIN'),
      row('SPY', 'TechnicalAgent', 'SELL', 0, 'LOSS'),
    ];
    const clusters = clusterByTimeGap(rows, 60000);
    expect(clusters).toHaveLength(4);
  });

  it('grades each cluster by its own last row, not an average', () => {
    const rows = [
      row('SPY', 'TechnicalAgent', 'BUY', 0, 'LOSS'),
      row('SPY', 'TechnicalAgent', 'BUY', 1000, 'LOSS'),
      row('SPY', 'TechnicalAgent', 'BUY', 2000, 'WIN'),
    ];
    const clusters = clusterByTimeGap(rows, 60000);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].outcome).toBe('WIN');
  });
});

describe('wilsonInterval', () => {
  it('returns nulls for n=0 rather than dividing by zero', () => {
    const result = wilsonInterval(0, 0);
    expect(result.pointEstimate).toBeNull();
    expect(result.lower).toBeNull();
    expect(result.upper).toBeNull();
  });

  it('produces a wide interval for a small sample that comfortably includes 50%', () => {
    const result = wilsonInterval(1, 2); // 1 win out of 2 - maximally uninformative
    expect(result.pointEstimate).toBe(0.5);
    expect(result.lower).toBeLessThan(0.5);
    expect(result.upper).toBeGreaterThan(0.5);
    expect(result.lower).toBeLessThan(0.3); // genuinely wide, not falsely tight
  });

  it('produces a tight interval for a large sample at a stable win rate', () => {
    const result = wilsonInterval(500, 1000);
    expect(result.pointEstimate).toBe(0.5);
    expect(result.upper! - result.lower!).toBeLessThan(0.07); // tight at real n=1000
  });

  it('excludes 50% when a large sample has a real, non-chance win rate', () => {
    const result = wilsonInterval(650, 1000); // 65% observed at real n=1000
    expect(result.lower).toBeGreaterThan(0.5);
  });
});

describe('rawVsEffectiveDirectional', () => {
  it('reports a large inflation factor when many correlated rows collapse to few real clusters', () => {
    const rows: ClusterableRow[] = [];
    // 100 tightly-spaced rows (pseudo-replicated) all within one 60s cluster, mostly losses -
    // raw N would look like a large, sub-random sample; effective N should reveal it is really 1.
    for (let i = 0; i < 100; i++) {
      rows.push(row('SPY', 'TechnicalAgent', 'BUY', i * 100, i < 40 ? 'WIN' : 'LOSS'));
    }
    const result = rawVsEffectiveDirectional(rows, 60000);
    expect(result.rawN).toBe(100);
    expect(result.effectiveN).toBe(1);
    expect(result.inflationFactor).toBe(100);
    // Raw CI at n=100, 40% win rate excludes 50% on the low side; effective n=1 cannot exclude
    // anything meaningfully.
    expect(result.rawInterval.upper).toBeLessThan(0.5);
    expect(result.effectiveInterval.lower).toBe(0);
  });

  it('excludes N_A (HOLD-style) rows from both raw and effective counts', () => {
    const rows: ClusterableRow[] = [
      row('SPY', 'FundamentalAgent', 'HOLD', 0, 'N_A'),
      row('SPY', 'FundamentalAgent', 'HOLD', 1000, 'N_A'),
    ];
    const result = rawVsEffectiveDirectional(rows, 60000);
    expect(result.rawN).toBe(0);
    expect(result.effectiveN).toBe(0);
  });

  it('does not inflate when rows are genuinely spread far apart in time', () => {
    const rows: ClusterableRow[] = [
      row('SPY', 'TechnicalAgent', 'BUY', 0, 'WIN'),
      row('SPY', 'TechnicalAgent', 'BUY', 3600_000, 'LOSS'),
      row('SPY', 'TechnicalAgent', 'BUY', 7200_000, 'WIN'),
    ];
    const result = rawVsEffectiveDirectional(rows, 60000);
    expect(result.rawN).toBe(3);
    expect(result.effectiveN).toBe(3);
    expect(result.inflationFactor).toBe(1);
  });
});
