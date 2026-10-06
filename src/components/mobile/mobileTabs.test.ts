import { describe, it, expect } from 'vitest';
import { MOBILE_TABS, mobileTabIndex, clampTabIndex, type MobileTabId } from './mobileTabs';

/**
 * mobileTabs tests (2026-10-06). The tab registry drives mobile navigation —
 * every tab id must resolve to a valid index, and swipe-driven index math must
 * never escape the tab array bounds.
 */

describe('MOBILE_TABS registry', () => {
  it('has six tabs with unique ids', () => {
    expect(MOBILE_TABS).toHaveLength(6);
    const ids = MOBILE_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('every tab has a label, short label, and icon', () => {
    for (const tab of MOBILE_TABS) {
      expect(tab.label.length).toBeGreaterThan(0);
      expect(tab.shortLabel.length).toBeGreaterThan(0);
      expect(tab.icon).toBeTruthy();
    }
  });
});

describe('mobileTabIndex', () => {
  it('resolves every registered tab id to its position', () => {
    const ids: MobileTabId[] = ['cockpit', 'positions', 'brain', 'risk', 'terminal', 'settings'];
    ids.forEach((id, expected) => {
      expect(mobileTabIndex(id)).toBe(expected);
    });
  });
});

describe('clampTabIndex', () => {
  it('passes through in-range indices unchanged', () => {
    expect(clampTabIndex(0)).toBe(0);
    expect(clampTabIndex(3)).toBe(3);
    expect(clampTabIndex(5)).toBe(5);
  });

  it('clamps swipe overshoot to the array bounds - never an out-of-range tab', () => {
    expect(clampTabIndex(-1)).toBe(0);
    expect(clampTabIndex(-100)).toBe(0);
    expect(clampTabIndex(6)).toBe(5);
    expect(clampTabIndex(100)).toBe(5);
  });
});
