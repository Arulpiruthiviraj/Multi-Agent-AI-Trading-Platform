import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendServerLogLine,
  getRecentLogLines,
  installServerLogBuffer,
  resetServerLogBufferForTests,
} from './ServerLogBuffer';

describe('ServerLogBuffer dev noise filtering', () => {
  beforeEach(() => {
    resetServerLogBufferForTests();
    installServerLogBuffer();
  });

  it('does not buffer vite HMR lines', () => {
    console.log('\x1b[36m[vite]\x1b[39m (client) hmr update /src/App.tsx');
    const lines = getRecentLogLines(20);
    expect(lines.some((l) => l.text.includes('[vite]'))).toBe(false);
  });

  it('compacts RSS fetch errors to a single line', () => {
    console.error('[RssNewsProvider] Failed to fetch feed CNBC Top News: Error: Status code 503\n    at ClientRequest.<anonymous> (parser.js:88:25)');
    const lines = getRecentLogLines(5);
    const hit = lines.find((l) => l.text.includes('[RssNewsProvider]'));
    expect(hit).toBeDefined();
    expect(hit!.text).toContain('503');
    expect(hit!.text).toContain('stack truncated');
    expect(hit!.text).not.toContain('ClientRequest');
  });

  it('still buffers trading lines', () => {
    appendServerLogLine({
      level: 'log',
      text: '[PortfolioWorker] Reviewing 2 active positions.',
      source: 'console',
      category: 'TRADING',
    });
    expect(getRecentLogLines(5).some((l) => l.text.includes('PortfolioWorker'))).toBe(true);
  });
});
