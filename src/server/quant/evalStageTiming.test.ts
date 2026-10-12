import { describe, it, expect } from 'vitest';
import { createQuantEvalStageTimer, classifyQuantEvalError } from './evalStageTiming';

describe('createQuantEvalStageTimer', () => {
  it('attributes elapsed time to the stage that just ended and accumulates repeats', () => {
    let t = 1000;
    const timer = createQuantEvalStageTimer(() => t);
    t = 1100; timer.mark('primaryBars');
    t = 1100 + 300_000; timer.mark('marketContext');
    t += 50; timer.mark('primaryBars');
    expect(timer.stageMs()).toEqual({ primaryBars: 150, marketContext: 300_000 });
    expect(timer.totalMs()).toBe(300_150);
    expect(timer.openStageAfter()).toBe('primaryBars');
  });

  it('never reports negative durations if the clock steps backward', () => {
    let t = 5000;
    const timer = createQuantEvalStageTimer(() => t);
    t = 4000; timer.mark('x');
    expect(timer.stageMs().x).toBe(0);
    expect(timer.totalMs()).toBe(0);
  });
});

describe('classifyQuantEvalError', () => {
  it.each([
    ['[HistoricalDataGateway] COALESCE_CALLER_TIMEOUT for AAPL (1Day): waiter exceeded 300000ms', 'COALESCE_CALLER_TIMEOUT'],
    ['IBKR historicalData timeout for MSFT (1Day)', 'IBKR_HISTORICAL_TIMEOUT'],
    ['IBKR historicalData error code=162: pacing violation', 'IBKR_HISTORICAL_ERROR'],
    ['IBKR socket session is not connected for historical bars.', 'IBKR_NOT_CONNECTED'],
    ['DATA_STALE: SPY (1Day) - provider refresh did not move a stale cache tail', 'DATA_STALE'],
    ['Alpaca bars request rate-limited until 2026-10-12T14:00:00Z', 'RATE_LIMITED'],
    ['Historical backfill requires ALPACA_API_KEY/ALPACA_SECRET_KEY', 'PROVIDER_CREDENTIALS_MISSING'],
    ['The database connection is not open', 'DB_NOT_OPEN'],
    ['something entirely new', 'UNKNOWN_ERROR'],
  ])('%s -> %s', (msg, code) => {
    expect(classifyQuantEvalError(new Error(msg))).toBe(code);
  });

  it('never leaks message text, URLs or secrets into the code', () => {
    const code = classifyQuantEvalError(new Error('fetch https://x.test/?apiKey=SECRET123 failed'));
    expect(code).toBe('UNKNOWN_ERROR');
    expect(code).not.toMatch(/SECRET|https/);
  });

  it('handles non-Error throwables', () => {
    expect(classifyQuantEvalError(undefined)).toBe('UNKNOWN_ERROR');
    expect(classifyQuantEvalError('COALESCE_CALLER_TIMEOUT x')).toBe('COALESCE_CALLER_TIMEOUT');
  });
});
