import { describe, it, expect, afterEach } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import {
  evaluateMomentumCandidate,
  isMomentumRotationWindow,
  resetMomentumScanForTests,
  getMomentumScanUniverse,
} from './MomentumUniverseScanner';

afterEach(() => {
  resetMomentumScanForTests();
});

describe('MomentumUniverseScanner', () => {
  it('loads a liquid REST universe larger than the WebSocket cap', () => {
    const universe = getMomentumScanUniverse();
    expect(universe.length).toBeGreaterThan(continuousIntelligence.maxActiveSubscriptions);
    expect(universe.length).toBeGreaterThanOrEqual(80);
  });

  it('passes high RVOL + abs change candidates and scores news as a soft boost', () => {
    const pass = evaluateMomentumCandidate({
      symbol: 'NVDA',
      price: 120,
      prevClose: 100,
      todaysVolume: 4e7,
      prevDayVolume: 1e7,
      changePct: 0.2,
      rvol: 4,
      hasNewsCatalyst: true,
    });
    expect(pass.pass).toBe(true);
    expect(pass.score).toBeGreaterThan(0);
    expect(pass.reasons).toContain('NEWS_CATALYST');

    const fail = evaluateMomentumCandidate({
      symbol: 'SLOW',
      price: 50,
      prevClose: 50.1,
      todaysVolume: 1e6,
      prevDayVolume: 1e6,
      changePct: 0.002,
      rvol: 1.0,
      hasNewsCatalyst: false,
    });
    expect(fail.pass).toBe(false);
    expect(fail.score).toBe(0);
  });

  it('rotation window matches configured ET bounds', () => {
    // 09:30 America/New_York on 2026-08-21 = 13:30 UTC (EDT)
    expect(isMomentumRotationWindow(new Date('2026-08-21T13:30:00.000Z'))).toBe(true);
    // 10:00 ET = 14:00 UTC — outside 09:25–09:35
    expect(isMomentumRotationWindow(new Date('2026-08-21T14:00:00.000Z'))).toBe(false);
    // 09:20 ET = 13:20 UTC
    expect(isMomentumRotationWindow(new Date('2026-08-21T13:20:00.000Z'))).toBe(false);
  });

  it('anchors stay within the hard streaming cap', () => {
    expect(continuousIntelligence.coreStreamingSymbols).toEqual(['SPY', 'QQQ', 'GLD']);
    expect(continuousIntelligence.protectedSymbols).toEqual(['SPY', 'QQQ', 'GLD']);
    expect(continuousIntelligence.coreStreamingSymbols.length).toBeLessThan(
      continuousIntelligence.maxActiveSubscriptions,
    );
    expect(continuousIntelligence.maxActiveSubscriptions).toBe(12);
  });
});
