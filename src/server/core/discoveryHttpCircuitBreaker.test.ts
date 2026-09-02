import { describe, it, expect, afterEach, vi } from 'vitest';
import { withDiscoveryCircuitBreaker, DiscoveryCircuitOpenError, resetDiscoveryCircuitBreakersForTests } from './discoveryHttpCircuitBreaker';
import { tradingSafety } from '../config/tradingSafety';

describe('withDiscoveryCircuitBreaker', () => {
  afterEach(() => {
    resetDiscoveryCircuitBreakersForTests();
  });

  it('a single failure does not open the circuit - the very next call still attempts the real fetch', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('one-off failure')).mockResolvedValueOnce('ok');
    await expect(withDiscoveryCircuitBreaker('test-breaker', fn)).rejects.toThrow('one-off failure');
    await expect(withDiscoveryCircuitBreaker('test-breaker', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2); // both real attempts were made - breaker never opened
  });

  it('opens after the reviewed consecutive-failure threshold and fails fast without attempting the real call', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('sustained outage'));
    for (let i = 0; i < tradingSafety.alpacaCircuitBreakerFailureThreshold; i++) {
      await expect(withDiscoveryCircuitBreaker('test-breaker-2', fn)).rejects.toThrow('sustained outage');
    }
    expect(fn).toHaveBeenCalledTimes(tradingSafety.alpacaCircuitBreakerFailureThreshold);

    // The circuit is now open - the NEXT call must fail fast, never touching fn again.
    await expect(withDiscoveryCircuitBreaker('test-breaker-2', fn)).rejects.toThrow(DiscoveryCircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(tradingSafety.alpacaCircuitBreakerFailureThreshold); // unchanged - fn was never called this time
  });

  it('a real success resets the consecutive-failure counter, so an isolated blip never trips the breaker', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('blip 1'))
      .mockResolvedValueOnce('recovered')
      .mockRejectedValueOnce(new Error('blip 2'));
    await expect(withDiscoveryCircuitBreaker('test-breaker-3', fn)).rejects.toThrow('blip 1');
    await expect(withDiscoveryCircuitBreaker('test-breaker-3', fn)).resolves.toBe('recovered');
    // Counter reset by the success above - a second isolated failure alone must not open the circuit.
    await expect(withDiscoveryCircuitBreaker('test-breaker-3', fn)).rejects.toThrow('blip 2');
    await expect(withDiscoveryCircuitBreaker('test-breaker-3', fn.mockResolvedValueOnce('still open'))).resolves.toBe('still open');
  });

  it('two independently-named breakers never interfere with each other - a broad-universe outage does not also trip the movers breaker', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('outage'));
    for (let i = 0; i < tradingSafety.alpacaCircuitBreakerFailureThreshold; i++) {
      await expect(withDiscoveryCircuitBreaker('broad-universe', failing)).rejects.toThrow('outage');
    }
    await expect(withDiscoveryCircuitBreaker('broad-universe', failing)).rejects.toThrow(DiscoveryCircuitOpenError);

    const healthy = vi.fn().mockResolvedValue('fine');
    await expect(withDiscoveryCircuitBreaker('movers', healthy)).resolves.toBe('fine');
  });
});
