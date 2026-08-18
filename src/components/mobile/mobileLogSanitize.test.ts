import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  isDevNoiseLogLine,
  compactLogLine,
  matchesMobileLogFilter,
} from './mobileLogSanitize';

describe('mobileLogSanitize', () => {
  it('stripAnsi removes vite color codes', () => {
    const raw = '\x1b[2m10:05:17 p.m.\x1b[22m \x1b[36m[vite]\x1b[39m hmr update';
    expect(stripAnsi(raw)).not.toContain('\x1b[');
    expect(stripAnsi(raw)).toContain('[vite]');
  });

  it('isDevNoiseLogLine flags vite and babel spam', () => {
    expect(isDevNoiseLogLine('[vite] (client) hmr update /src/App.tsx')).toBe(true);
    expect(isDevNoiseLogLine('[BABEL] Note: deoptimised styling')).toBe(true);
    expect(isDevNoiseLogLine('[PortfolioWorker] Reviewing 2 active positions.')).toBe(false);
  });

  it('compactLogLine truncates stack traces', () => {
    const stack = '[RssNewsProvider] Failed: Error: Status code 503\n    at ClientRequest.<anonymous>';
    expect(compactLogLine(stack)).toBe('[RssNewsProvider] Failed: Error: Status code 503 (stack truncated)');
  });

  it('matchesMobileLogFilter routes trading and risk lines', () => {
    expect(matchesMobileLogFilter('ORDER_EXECUTED AAPL', 'log', 'TRADING', 'TRADES')).toBe(true);
    expect(matchesMobileLogFilter('[AIRouter] Agent NewsAgent routing', 'log', 'SYSTEM', 'AI_DECISIONS')).toBe(true);
    expect(matchesMobileLogFilter('CIRCUIT BREAKER: Emergency Stop', 'warn', 'TRADING', 'RISK_REJECTS')).toBe(true);
    expect(matchesMobileLogFilter('[vite] hmr update', 'log', 'SYSTEM', 'ALL')).toBe(false);
  });
});
