import { describe, it, expect } from 'vitest';
import { deriveMarketDataLineState, summarizeMarketDataLines } from './marketDataLineState';

describe('deriveMarketDataLineState', () => {
  it('REQUESTED: no local subscribedAt record at all', () => {
    const d = deriveMarketDataLineState({ subscribedAtMs: null, tickCount: 0, latestPriceAgeMs: null, marketDataError: null });
    expect(d.state).toBe('REQUESTED');
    expect(d.receiving).toBe(false);
  });

  it('SUBSCRIPTION_ACTIVE: allocated locally, zero ticks, no error - "90/90 allocated" must never imply usable data on its own', () => {
    const d = deriveMarketDataLineState({ subscribedAtMs: Date.now(), tickCount: 0, latestPriceAgeMs: null, marketDataError: null });
    expect(d.state).toBe('SUBSCRIPTION_ACTIVE');
    expect(d.receiving).toBe(false);
  });

  it('ERROR: a recorded IBKR error (entitlement code 10089) takes precedence even if a tick exists', () => {
    const d = deriveMarketDataLineState({
      subscribedAtMs: Date.now(), tickCount: 3, latestPriceAgeMs: 100,
      marketDataError: { code: 10089, message: 'additional subscription required', atMs: Date.now() },
    });
    expect(d.state).toBe('ERROR');
  });

  it('RECEIVING_FRESH: ticks present and within the freshness window', () => {
    const d = deriveMarketDataLineState({ subscribedAtMs: Date.now(), tickCount: 5, latestPriceAgeMs: 1000, marketDataError: null });
    expect(d.state).toBe('RECEIVING_FRESH');
    expect(d.receiving).toBe(true);
  });

  it('RECEIVING_STALE: ticks present but the most recent one is too old', () => {
    const d = deriveMarketDataLineState({ subscribedAtMs: Date.now(), tickCount: 5, latestPriceAgeMs: 10_000_000, marketDataError: null });
    expect(d.state).toBe('RECEIVING_STALE');
    expect(d.receiving).toBe(true);
  });

  it('passes through optional contractResolution/historyReady/featureReady, defaulting to UNKNOWN', () => {
    const d1 = deriveMarketDataLineState({ subscribedAtMs: null, tickCount: 0, latestPriceAgeMs: null, marketDataError: null });
    expect(d1.contractResolution).toBe('UNKNOWN');
    expect(d1.historyReady).toBe('UNKNOWN');
    expect(d1.featureReady).toBe('UNKNOWN');

    const d2 = deriveMarketDataLineState(
      { subscribedAtMs: null, tickCount: 0, latestPriceAgeMs: null, marketDataError: null },
      { contractResolution: 'NO', historyReady: 'YES', featureReady: 'NO' },
    );
    expect(d2.contractResolution).toBe('NO');
    expect(d2.historyReady).toBe('YES');
    expect(d2.featureReady).toBe('NO');
  });
});

describe('summarizeMarketDataLines', () => {
  it('distinguishes allocated lines from receiving/fresh lines - the core "90/90 != 90 usable" proof', () => {
    const now = Date.now();
    const summary = summarizeMarketDataLines([
      { symbol: 'AAPL', input: { subscribedAtMs: now, tickCount: 0, latestPriceAgeMs: null, marketDataError: { code: 10089, message: 'x', atMs: now } } },
      { symbol: 'MSFT', input: { subscribedAtMs: now, tickCount: 0, latestPriceAgeMs: null, marketDataError: { code: 354, message: 'x', atMs: now } } },
      { symbol: 'BRK.B', input: { subscribedAtMs: now, tickCount: 0, latestPriceAgeMs: null, marketDataError: { code: 200, message: 'no security definition', atMs: now } } },
      { symbol: 'SPY', input: { subscribedAtMs: now, tickCount: 10, latestPriceAgeMs: 500, marketDataError: null } },
      { symbol: 'QQQ', input: { subscribedAtMs: now, tickCount: 10, latestPriceAgeMs: 10_000_000, marketDataError: null } },
      { symbol: 'GLD', input: { subscribedAtMs: now, tickCount: 0, latestPriceAgeMs: null, marketDataError: null } },
    ]);

    expect(summary.allocatedLines).toBe(6);
    expect(summary.receivingLines).toBe(2); // SPY, QQQ
    expect(summary.freshLines).toBe(1); // SPY
    expect(summary.staleLines).toBe(1); // QQQ
    expect(summary.errorLines).toBe(3); // AAPL, MSFT, BRK.B
    expect(summary.entitlementFailures).toBe(2); // AAPL (10089), MSFT (354)
    expect(summary.contractFailures).toBe(1); // BRK.B (200)
    expect(summary.bySymbol.GLD.state).toBe('SUBSCRIPTION_ACTIVE');
  });

  it('an empty line set summarizes to all zeros, never a fabricated count', () => {
    const summary = summarizeMarketDataLines([]);
    expect(summary).toMatchObject({
      allocatedLines: 0, receivingLines: 0, freshLines: 0, staleLines: 0, errorLines: 0,
      entitlementFailures: 0, contractFailures: 0,
    });
  });
});
