import { describe, it, expect } from 'vitest';
import { escalatedProviderCooldownMs, AIRouter } from './AIRouter';
import { tradingSafety } from '../config/tradingSafety';

describe('escalatedProviderCooldownMs', () => {
  const base = 300_000;
  const cap = 1_800_000;
  it('first failed episode uses the base cooldown (existing behavior preserved)', () => {
    expect(escalatedProviderCooldownMs(base, 1, cap)).toBe(base);
  });
  it('doubles per consecutive failed episode', () => {
    expect(escalatedProviderCooldownMs(base, 2, cap)).toBe(600_000);
    expect(escalatedProviderCooldownMs(base, 3, cap)).toBe(1_200_000);
  });
  it('never exceeds the cap, however long the streak', () => {
    expect(escalatedProviderCooldownMs(base, 4, cap)).toBe(cap);
    expect(escalatedProviderCooldownMs(base, 10_000, cap)).toBe(cap);
  });
  it('never drops below the base (invalid streak or cap smaller than base)', () => {
    expect(escalatedProviderCooldownMs(base, 0, cap)).toBe(base);
    expect(escalatedProviderCooldownMs(base, -5, cap)).toBe(base);
    expect(escalatedProviderCooldownMs(base, 3, 1)).toBe(base);
  });
});

describe('AIRouter timeout cooldown escalates per failed episode (2026-10-13)', () => {
  const timeout = () => new Error("AI provider 'p-dead' did not respond within 8000ms");
  it('a provider that keeps timing out is probed less and less often (60s -> 120s -> 240s ... capped), and a success resets the streak', () => {
    const router: any = AIRouter.getInstance();
    const id = 'p-dead';
    router.skipUntil.delete(id); router.transientFailureStreak.delete(id);
    const base = tradingSafety.aiProviderTimeoutSkipCooldownMs;
    const cooldownAfterFailure = () => {
      router.noteProviderSkipFromError(id, timeout());
      return router.skipUntil.get(id) - Date.now();
    };
    const first = cooldownAfterFailure();
    expect(first).toBeLessThanOrEqual(base);
    expect(first).toBeGreaterThan(base - 2_000);
    // same burst (still inside the active cooldown) must not inflate the streak
    cooldownAfterFailure();
    expect(router.transientFailureStreak.get(id)).toBe(1);
    // cooldown expires, provider is tried again, fails again -> a NEW episode, doubled cooldown
    router.skipUntil.set(id, Date.now() - 1);
    const second = cooldownAfterFailure();
    expect(second).toBeGreaterThan(base * 2 - 2_000);
    router.skipUntil.set(id, Date.now() - 1);
    const third = cooldownAfterFailure();
    expect(third).toBeGreaterThan(base * 4 - 2_000);
    // many more episodes never exceed the long cap
    for (let i = 0; i < 20; i++) { router.skipUntil.set(id, Date.now() - 1); cooldownAfterFailure(); }
    expect(router.skipUntil.get(id) - Date.now()).toBeLessThanOrEqual(tradingSafety.aiProviderQuotaExceededCooldownMs + 1_000);
    // success path clears the streak (the router deletes it on a successful call)
    router.transientFailureStreak.delete(id); router.skipUntil.delete(id);
    expect(cooldownAfterFailure()).toBeLessThanOrEqual(base);
  });
});
