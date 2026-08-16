import { describe, it, expect } from 'vitest';
import { clusterCoversSymbol, newsImpactOnVetoScale } from './newsClusterMatch';

describe('newsClusterMatch', () => {
  it('scales 0–1 impact onto the 0–100 veto threshold', () => {
    expect(newsImpactOnVetoScale(0.9)).toBe(90);
    expect(newsImpactOnVetoScale(0.5)).toBe(50);
    expect(newsImpactOnVetoScale(81)).toBe(81);
  });

  it('matches JSON symbol arrays strictly (A does not match AAPL)', () => {
    expect(clusterCoversSymbol('["AAPL","MSFT"]', 'AAPL')).toBe(true);
    expect(clusterCoversSymbol('["AAPL","MSFT"]', 'A')).toBe(false);
    expect(clusterCoversSymbol('["AAPL"]', 'AAPL')).toBe(true);
    expect(clusterCoversSymbol('not-json', 'AAPL')).toBe(false);
  });
});
