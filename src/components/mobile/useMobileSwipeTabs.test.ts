import { describe, it, expect } from 'vitest';
import { clampTabIndex, mobileTabIndex } from './mobileTabs';

describe('useMobileSwipeTabs helpers', () => {
  it('clamps tab index to valid range', () => {
    expect(clampTabIndex(-1)).toBe(0);
    expect(clampTabIndex(10)).toBe(5);
  });

  it('resolves tab index by id', () => {
    expect(mobileTabIndex('terminal')).toBe(4);
    expect(mobileTabIndex('settings')).toBe(5);
    expect(mobileTabIndex('cockpit')).toBe(0);
  });
});
