import { describe, it, expect } from 'vitest';
import { clampTabIndex, mobileTabIndex } from './mobileTabs';

describe('useMobileSwipeTabs helpers', () => {
  it('clamps tab index to valid range', () => {
    expect(clampTabIndex(-1)).toBe(0);
    expect(clampTabIndex(10)).toBe(4);
  });

  it('resolves tab index by id', () => {
    expect(mobileTabIndex('terminal')).toBe(4);
    expect(mobileTabIndex('cockpit')).toBe(0);
  });
});
