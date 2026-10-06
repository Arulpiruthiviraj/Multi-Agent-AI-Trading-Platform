import { describe, it, expect, afterEach } from 'vitest';
import {
  argusBanner,
  badge,
  bar,
  box,
  isPretty,
  kv,
  pnl,
  sectionHeader,
  setPrettyEnabled,
  stripAnsi,
  table,
  tradingModeBadge,
  tradingStateBadge,
  visibleWidth,
} from './cliPretty';

/**
 * Tests for the beautiful colorful CLI output (2026-10-06). Colors are forced
 * on/off explicitly so tests never depend on the ambient TTY or NO_COLOR env.
 */

describe('cliPretty', () => {
  afterEach(() => {
    setPrettyEnabled(false);
  });

  describe('color enablement', () => {
    it('emits ANSI codes when pretty is enabled', () => {
      setPrettyEnabled(true);
      expect(isPretty()).toBe(true);
      expect(badge('LIVE', 'red')).toMatch(/\u001b\[/);
    });

    it('emits plain text when pretty is disabled', () => {
      setPrettyEnabled(false);
      expect(isPretty()).toBe(false);
      expect(badge('LIVE', 'red')).toBe('[LIVE]');
    });
  });

  describe('stripAnsi / visibleWidth', () => {
    it('strips ANSI codes and measures visible width', () => {
      setPrettyEnabled(true);
      const colored = badge('TRADING ENABLED', 'green');
      expect(visibleWidth(colored)).toBe(stripAnsi(colored).length);
      expect(stripAnsi(colored)).toContain('TRADING ENABLED');
    });
  });

  describe('trading state badges', () => {
    it('maps known states to colored badges', () => {
      setPrettyEnabled(false);
      expect(tradingStateBadge('TRADING_ENABLED')).toBe('[TRADING ENABLED]');
      expect(tradingStateBadge('TRADING_PAUSED')).toBe('[TRADING PAUSED]');
      expect(tradingStateBadge('EMERGENCY_STOP')).toBe('[EMERGENCY STOP]');
      expect(tradingStateBadge(undefined)).toBe('[UNKNOWN]');
    });
  });

  describe('trading mode badges', () => {
    it('maps LIVE/PAPER/SIMULATOR', () => {
      setPrettyEnabled(false);
      expect(tradingModeBadge('LIVE')).toBe('[LIVE]');
      expect(tradingModeBadge('PAPER')).toBe('[PAPER]');
      expect(tradingModeBadge('SIMULATOR')).toBe('[SIMULATOR]');
      expect(tradingModeBadge(null)).toBe('[UNKNOWN]');
    });
  });

  describe('pnl', () => {
    it('colors gains green, losses red, flat gray (plain mode)', () => {
      setPrettyEnabled(false);
      expect(pnl('+$10.00', 10)).toBe('+$10.00');
      expect(pnl('-$5.00', -5)).toBe('-$5.00');
      expect(pnl('--', null)).toBe('--');
    });

    it('emits colors for gains/losses when enabled', () => {
      setPrettyEnabled(true);
      expect(pnl('+$10.00', 10)).toMatch(/\u001b\[32m/);
      expect(pnl('-$5.00', -5)).toMatch(/\u001b\[31m/);
    });
  });

  describe('layout primitives', () => {
    it('sectionHeader contains the title', () => {
      setPrettyEnabled(false);
      expect(sectionHeader('Engine')).toContain('Engine');
    });

    it('box wraps lines and shows the title', () => {
      setPrettyEnabled(false);
      const out = box(['a', 'bb'], 'Engine Status');
      expect(out).toContain('Engine Status');
      expect(out).toContain('a');
      expect(out).toContain('bb');
    });

    it('table aligns columns', () => {
      setPrettyEnabled(false);
      const out = table([
        ['Symbol', 'Qty'],
        ['AAPL', '10'],
        ['TSLA', '200'],
      ]);
      const lines = out.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[1].indexOf('10')).toBeGreaterThan(lines[1].indexOf('AAPL'));
    });

    it('bar renders a 0-100% label', () => {
      setPrettyEnabled(false);
      expect(bar(0.75)).toContain('75%');
      expect(bar(0)).toContain('0%');
      expect(bar(1)).toContain('100%');
    });

    it('kv renders key and value', () => {
      setPrettyEnabled(false);
      expect(kv('State', 'ok')).toContain('State');
    });
  });

  describe('argusBanner', () => {
    it('returns a non-empty banner', () => {
      setPrettyEnabled(true);
      expect(stripAnsi(argusBanner()).length).toBeGreaterThan(10);
      setPrettyEnabled(false);
      expect(argusBanner()).toBe('ARGUS');
    });
  });
});
