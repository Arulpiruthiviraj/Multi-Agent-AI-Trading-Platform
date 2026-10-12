import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mintProtectiveExitSeal,
  verifyAndConsumeProtectiveExitSeal,
  resetProtectiveExitSealsForTests,
  protectiveExitSealRegistrySizeForTests,
  PROTECTIVE_EXIT_AUTHORIZED_MINTER,
} from './protectiveExitSeal';
import { tradingSafety } from '../config/tradingSafety';

/**
 * Unit tests for the tamper-evident protective-exit provenance behind the news_veto
 * exemption (2026-10-12). The exemption must only trigger for ideas that actually
 * traveled the verified protective path - a bare boolean flag settable by any caller is
 * explicitly NOT acceptable, so these tests assert every spoof shape fails closed.
 */
describe('protectiveExitSeal', () => {
  beforeEach(() => {
    resetProtectiveExitSealsForTests();
    vi.useRealTimers();
  });
  afterEach(() => {
    resetProtectiveExitSealsForTests();
    vi.useRealTimers();
  });

  function mint(traceId = 'trace-1', symbol = 'AAPL'): string {
    return mintProtectiveExitSeal({ traceId, symbol, mintedBy: PROTECTIVE_EXIT_AUTHORIZED_MINTER });
  }

  it('mint -> verify round-trip succeeds for the exact (traceId, symbol, SELL) idea', () => {
    const seal = mint('trace-abc', 'AAPL');
    expect(typeof seal).toBe('string');
    expect(seal.length).toBeGreaterThan(0);
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-abc', symbol: 'AAPL', side: 'SELL' }),
    ).toBe(true);
  });

  it('seals are single-use: a second verify of the same seal fails (no replay)', () => {
    const seal = mint('trace-replay', 'AAPL');
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-replay', symbol: 'AAPL', side: 'SELL' }),
    ).toBe(true);
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-replay', symbol: 'AAPL', side: 'SELL' }),
    ).toBe(false);
  });

  it('rejects a seal presented for a different traceId (cross-idea copy fails)', () => {
    const seal = mint('trace-genuine', 'AAPL');
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-other', symbol: 'AAPL', side: 'SELL' }),
    ).toBe(false);
  });

  it('rejects a seal presented for a different symbol', () => {
    const seal = mint('trace-sym', 'AAPL');
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-sym', symbol: 'MSFT', side: 'SELL' }),
    ).toBe(false);
  });

  it('rejects a seal presented for a BUY (direction-aware: SELL only)', () => {
    const seal = mint('trace-buy', 'AAPL');
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-buy', symbol: 'AAPL', side: 'BUY' }),
    ).toBe(false);
  });

  it('rejects a forged seal string that was never minted', () => {
    expect(
      verifyAndConsumeProtectiveExitSeal('forged-seal-0000-0000', {
        traceId: 'trace-x',
        symbol: 'AAPL',
        side: 'SELL',
      }),
    ).toBe(false);
  });

  it('rejects non-string / missing seals - a bare boolean flag never verifies', () => {
    expect(verifyAndConsumeProtectiveExitSeal(undefined, { traceId: 't', symbol: 'AAPL', side: 'SELL' })).toBe(false);
    expect(verifyAndConsumeProtectiveExitSeal(null, { traceId: 't', symbol: 'AAPL', side: 'SELL' })).toBe(false);
    expect(verifyAndConsumeProtectiveExitSeal(true, { traceId: 't', symbol: 'AAPL', side: 'SELL' })).toBe(false);
    expect(verifyAndConsumeProtectiveExitSeal('', { traceId: 't', symbol: 'AAPL', side: 'SELL' })).toBe(false);
    expect(verifyAndConsumeProtectiveExitSeal(12345, { traceId: 't', symbol: 'AAPL', side: 'SELL' })).toBe(false);
  });

  it('a failed spoof attempt does NOT consume the genuine seal', () => {
    const seal = mint('trace-nospoof', 'AAPL');
    // Attacker presents the genuine seal with the wrong traceId - fails...
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-attacker', symbol: 'AAPL', side: 'SELL' }),
    ).toBe(false);
    // ...and the genuine idea can still verify afterwards.
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-nospoof', symbol: 'AAPL', side: 'SELL' }),
    ).toBe(true);
  });

  it('mint throws for any minter other than PortfolioMonitor.emitRiskExit', () => {
    expect(() =>
      mintProtectiveExitSeal({ traceId: 't', symbol: 'AAPL', mintedBy: 'SomeDiscretionaryEmitter' }),
    ).toThrow(/unauthorized minter/);
    expect(protectiveExitSealRegistrySizeForTests()).toBe(0);
  });

  it('mint throws on missing traceId / symbol (fail-fast at the verified call site)', () => {
    expect(() =>
      mintProtectiveExitSeal({ traceId: '', symbol: 'AAPL', mintedBy: PROTECTIVE_EXIT_AUTHORIZED_MINTER }),
    ).toThrow();
    expect(() =>
      mintProtectiveExitSeal({ traceId: 't', symbol: '', mintedBy: PROTECTIVE_EXIT_AUTHORIZED_MINTER }),
    ).toThrow();
  });

  it('an expired seal fails verification (TTL-bounded, fail-closed)', () => {
    const ttl = (tradingSafety as { protectiveExitSealTtlMs: number }).protectiveExitSealTtlMs;
    expect(ttl).toBeGreaterThan(0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const seal = mint('trace-ttl', 'AAPL');
    vi.setSystemTime(new Date(new Date('2026-10-12T12:00:00Z').getTime() + ttl + 1000));
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-ttl', symbol: 'AAPL', side: 'SELL' }),
    ).toBe(false);
  });

  it('a seal verified just inside the TTL still passes', () => {
    const ttl = (tradingSafety as { protectiveExitSealTtlMs: number }).protectiveExitSealTtlMs;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const seal = mint('trace-ttl-ok', 'AAPL');
    vi.setSystemTime(new Date(new Date('2026-10-12T12:00:00Z').getTime() + ttl - 1000));
    expect(
      verifyAndConsumeProtectiveExitSeal(seal, { traceId: 'trace-ttl-ok', symbol: 'AAPL', side: 'SELL' }),
    ).toBe(true);
  });

  it('minted seals are unguessable nonces (two mints never collide)', () => {
    const a = mint('trace-u1', 'AAPL');
    const b = mint('trace-u2', 'AAPL');
    expect(a).not.toBe(b);
    expect(protectiveExitSealRegistrySizeForTests()).toBe(2);
  });
});
