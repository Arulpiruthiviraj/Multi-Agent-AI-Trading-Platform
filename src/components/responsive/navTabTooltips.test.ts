import { describe, expect, it } from 'vitest';
import { ALL_TABS, type AppTabId } from './responsiveNavConfig';
import { MOBILE_TABS } from '../mobile/mobileTabs';
import {
  clampCenteredTooltipLeft,
  MOBILE_TAB_TOOLTIPS,
  NAV_DOMAIN_TOOLTIPS,
  NAV_TAB_TOOLTIPS,
} from './navTabTooltips';

describe('clampCenteredTooltipLeft', () => {
  it('keeps a centered tooltip on-screen near the left edge', () => {
    expect(clampCenteredTooltipLeft(10, 320, 1280, 12)).toBe(12 + 160);
  });

  it('keeps a centered tooltip on-screen near the right edge', () => {
    expect(clampCenteredTooltipLeft(1270, 320, 1280, 12)).toBe(1280 - 12 - 160);
  });

  it('leaves a mid-screen anchor unchanged', () => {
    expect(clampCenteredTooltipLeft(640, 320, 1280, 12)).toBe(640);
  });
});

describe('NAV_TAB_TOOLTIPS', () => {
  it('covers every desktop/compact App tab with scannable copy', () => {
    const ids = ALL_TABS.map((t) => t.id);
    expect(Object.keys(NAV_TAB_TOOLTIPS).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const copy = NAV_TAB_TOOLTIPS[id as AppTabId];
      expect(copy.title.length).toBeGreaterThan(2);
      expect(copy.purpose.length).toBeGreaterThan(24);
    }
  });

  it('covers compact domain buttons and mobile mission tabs', () => {
    expect(Object.keys(NAV_DOMAIN_TOOLTIPS).sort()).toEqual(['agents', 'more', 'quant', 'system', 'trade']);
    expect(Object.keys(MOBILE_TAB_TOOLTIPS).sort()).toEqual([...MOBILE_TABS.map((t) => t.id)].sort());
  });
});
