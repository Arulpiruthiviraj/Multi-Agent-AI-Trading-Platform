import { describe, expect, it } from 'vitest';
import { parseIngestArgs } from './ingest_research_warehouse';
import { researchSafety } from '../src/server/config/researchSafety';

describe('ingest_research_warehouse CLI args', () => {
  it('defaults to multi-year daily lookback and benchmark symbols', () => {
    const opts = parseIngestArgs([]);
    expect(opts.timeframe).toBe('1Day');
    expect(opts.lookbackDays).toBe(researchSafety.ingestDailyLookbackDays);
    expect(opts.lookbackDays).toBeGreaterThanOrEqual(1260);
    expect(opts.symbols).toEqual(researchSafety.ingestDefaultSymbols);
    expect(opts.years).toBeNull();
  });

  it('accepts --timeframe 5Min and intraday lookback default', () => {
    const opts = parseIngestArgs(['--timeframe', '5Min']);
    expect(opts.timeframe).toBe('5Min');
    expect(opts.lookbackDays).toBe(researchSafety.ingestIntradayLookbackDays);
  });

  it('accepts --years 10 as calendar-day lookback', () => {
    const opts = parseIngestArgs(['--years', '10', '--symbols=SPY,QQQ']);
    expect(opts.years).toBe(10);
    expect(opts.lookbackDays).toBe(3650);
    expect(opts.symbols).toEqual(['SPY', 'QQQ']);
  });

  it('accepts explicit lookback and symbols', () => {
    const opts = parseIngestArgs(['--timeframe=1Hour', '--lookback-days=90', '--symbols=SPY,QQQ']);
    expect(opts).toEqual({ timeframe: '1Hour', lookbackDays: 90, symbols: ['SPY', 'QQQ'], years: null });
  });
});
