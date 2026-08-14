import { describe, it, expect, vi, afterEach } from 'vitest';
import { wsUpgradeLimiter } from './RateLimiters';

describe('wsUpgradeLimiter (WebSocket connection-creation rate limit)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows connections up to the configured limit, then blocks the next one from the same IP', () => {
    const ip = `1.2.3.4-${Math.random()}`;
    for (let i = 0; i < 20; i++) {
      expect(wsUpgradeLimiter.allow(ip)).toBe(true);
    }
    expect(wsUpgradeLimiter.allow(ip)).toBe(false);
  });

  it('tracks each IP independently', () => {
    const ipA = `10.0.0.1-${Math.random()}`;
    const ipB = `10.0.0.2-${Math.random()}`;
    for (let i = 0; i < 20; i++) wsUpgradeLimiter.allow(ipA);
    expect(wsUpgradeLimiter.allow(ipA)).toBe(false);
    expect(wsUpgradeLimiter.allow(ipB)).toBe(true);
  });

  it('allows new connections again once the window has fully elapsed', () => {
    vi.useFakeTimers();
    const ip = `172.16.0.1-${Math.random()}`;
    for (let i = 0; i < 20; i++) expect(wsUpgradeLimiter.allow(ip)).toBe(true);
    expect(wsUpgradeLimiter.allow(ip)).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(wsUpgradeLimiter.allow(ip)).toBe(true);
  });
});
