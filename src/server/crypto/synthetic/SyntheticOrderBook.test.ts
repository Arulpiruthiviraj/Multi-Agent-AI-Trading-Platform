import { describe, it, expect } from 'vitest';
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import { generateOrderBookSnapshot, generateOneSidedBook } from './SyntheticOrderBook';

describe('generateOrderBookSnapshot', () => {
  it('is deterministic given the same seed and inputs', () => {
    const a = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 1.0);
    const b = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 1.0);
    expect(a).toEqual(b);
  });

  it('bestBid is always below bestAsk', () => {
    const snapshot = generateOrderBookSnapshot(new SyntheticRandom(2), 50000, 'LARGE_CAP', 1.0);
    expect(snapshot.bestBid).toBeLessThan(snapshot.bestAsk);
  });

  it('a large-cap book is tighter and deeper than a micro-cap book under the same volatility', () => {
    const large = generateOrderBookSnapshot(new SyntheticRandom(3), 100, 'LARGE_CAP', 1.0);
    const micro = generateOrderBookSnapshot(new SyntheticRandom(3), 100, 'MICRO_CAP', 1.0);
    expect(large.spreadPct).toBeLessThan(micro.spreadPct);
    expect(large.totalBidDepth).toBeGreaterThan(micro.totalBidDepth);
  });

  it('higher volatility widens the spread and thins the depth for the same liquidity bucket', () => {
    const calm = generateOrderBookSnapshot(new SyntheticRandom(4), 100, 'MID_CAP', 1.0);
    const stressed = generateOrderBookSnapshot(new SyntheticRandom(4), 100, 'MID_CAP', 3.0);
    expect(stressed.spreadPct).toBeGreaterThan(calm.spreadPct);
    expect(stressed.totalBidDepth).toBeLessThan(calm.totalBidDepth);
  });

  it('produces a decaying (non-flat) depth profile across levels', () => {
    const snapshot = generateOrderBookSnapshot(new SyntheticRandom(5), 100, 'MID_CAP', 1.0);
    // Level 0 should have more size than the last level (decay applied), not identical sizes.
    expect(snapshot.bidLevels[0].size).toBeGreaterThan(snapshot.bidLevels[snapshot.bidLevels.length - 1].size);
  });
});

describe('generateOneSidedBook', () => {
  it('an ASK_ONLY book has no bids and an infinite effective spread', () => {
    const book = generateOneSidedBook(new SyntheticRandom(6), 100, 'SMALL_CAP', 'ASK_ONLY');
    expect(book.bidLevels).toHaveLength(0);
    expect(book.totalBidDepth).toBe(0);
    expect(book.spread).toBe(Number.POSITIVE_INFINITY);
  });

  it('a BID_ONLY book has no asks', () => {
    const book = generateOneSidedBook(new SyntheticRandom(7), 100, 'SMALL_CAP', 'BID_ONLY');
    expect(book.askLevels).toHaveLength(0);
    expect(book.totalAskDepth).toBe(0);
  });
});
