import { describe, it, expect } from 'vitest';
import {
  ALL_TABS,
  NAV_DOMAINS,
  tabsForDomain,
  domainForTab,
  tabDef,
  type AppTabId,
  type NavDomain,
} from './responsiveNavConfig';

/**
 * responsiveNavConfig tests (2026-10-06). This registry drives all app
 * navigation — a tab id in the AppTabId union without a registry entry (or
 * vice versa) is a silent navigation hole. These tests pin the two together.
 */

const ALL_TAB_IDS: AppTabId[] = [
  'dashboard', 'command', 'portfolio', 'arena', 'news', 'opportunities',
  'scanner', 'agents', 'evaluation', 'kronos', 'learning', 'premarket',
  'memory', 'observatory', 'activity', 'diagnostics', 'audit', 'validation',
  'settings', 'documentation',
];

describe('ALL_TABS registry consistency', () => {
  it('covers every AppTabId in the type union exactly once', () => {
    const registered = ALL_TABS.map((t) => t.id);
    expect(new Set(registered).size).toBe(registered.length); // no duplicates
    for (const id of ALL_TAB_IDS) {
      expect(registered, `AppTabId '${id}' must have a registry entry`).toContain(id);
    }
    expect(registered).toHaveLength(ALL_TAB_IDS.length); // no extras either
  });

  it('every tab has a label, icon, and valid domain', () => {
    const domains: NavDomain[] = ['trade', 'agents', 'quant', 'system'];
    for (const tab of ALL_TABS) {
      expect(tab.label.length).toBeGreaterThan(0);
      expect(tab.icon).toBeTruthy();
      expect(domains).toContain(tab.domain);
    }
  });

  it('every nav domain defaultTab resolves to a real tab', () => {
    for (const domain of NAV_DOMAINS) {
      expect(tabDef(domain.defaultTab), `domain '${domain.id}' defaultTab`).toBeTruthy();
      expect(domainForTab(domain.defaultTab)).toBe(domain.id);
    }
  });
});

describe('tabsForDomain / domainForTab / tabDef', () => {
  it('tabsForDomain returns only tabs in that domain', () => {
    for (const domain of NAV_DOMAINS) {
      const tabs = tabsForDomain(domain.id);
      expect(tabs.length).toBeGreaterThan(0);
      for (const t of tabs) expect(t.domain).toBe(domain.id);
    }
  });

  it('domainForTab round-trips through tabsForDomain', () => {
    for (const id of ALL_TAB_IDS) {
      const domain = domainForTab(id);
      expect(tabsForDomain(domain).map((t) => t.id)).toContain(id);
    }
  });

  it('tabDef returns undefined for unknown ids (never throws)', () => {
    expect(tabDef('no-such-tab' as AppTabId)).toBeUndefined();
  });
});
