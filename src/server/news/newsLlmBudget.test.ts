import { describe, it, expect } from 'vitest';
import { tradingSafety } from '../config/tradingSafety';

describe('NewsEngine LLM cycle cap (DEF-14)', () => {
  it('loads newsLlmMaxCallsPerCycle from tradingSafety.json', () => {
    expect(tradingSafety.newsLlmMaxCallsPerCycle).toBeGreaterThan(0);
    expect(Number.isInteger(tradingSafety.newsLlmMaxCallsPerCycle)).toBe(true);
  });

  it('allows LLM spend only while used < cap', () => {
    const cap = tradingSafety.newsLlmMaxCallsPerCycle;
    let used = 0;
    const spend = () => {
      if (used >= cap) return false;
      used += 1;
      return true;
    };
    for (let i = 0; i < cap; i++) expect(spend()).toBe(true);
    expect(spend()).toBe(false);
    expect(used).toBe(cap);
  });
});
