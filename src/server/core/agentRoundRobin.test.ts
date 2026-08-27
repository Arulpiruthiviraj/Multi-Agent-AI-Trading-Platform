import { describe, it, expect } from 'vitest';
import { selectPriorityRoundRobinSymbol } from './agentRoundRobin';

describe('selectPriorityRoundRobinSymbol', () => {
  it('cycles over the fresh-symbol pool when it is non-empty', () => {
    const universe = ['A', 'B', 'C', 'D', 'E'];
    const fresh = ['B', 'D'];
    expect(selectPriorityRoundRobinSymbol(universe, fresh, 60000, 0)).toBe('B');
    expect(selectPriorityRoundRobinSymbol(universe, fresh, 60000, 60000)).toBe('D');
    expect(selectPriorityRoundRobinSymbol(universe, fresh, 60000, 120000)).toBe('B');
  });

  it('falls back to the full universe when no symbol currently has fresh data', () => {
    const universe = ['A', 'B', 'C'];
    expect(selectPriorityRoundRobinSymbol(universe, [], 60000, 0)).toBe('A');
    expect(selectPriorityRoundRobinSymbol(universe, [], 60000, 60000)).toBe('B');
  });

  it('is deterministic for the same inputs (no randomness)', () => {
    const universe = ['A', 'B', 'C'];
    const fresh = ['A', 'C'];
    const now = 1787840000000;
    const first = selectPriorityRoundRobinSymbol(universe, fresh, 75000, now);
    const second = selectPriorityRoundRobinSymbol(universe, fresh, 75000, now);
    expect(first).toBe(second);
  });
});
