import { describe, it, expect } from 'vitest';
import { escalatedProviderCooldownMs } from './AIRouter';

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
