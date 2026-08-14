import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlphaVantageNewsProvider } from './AlphaVantageNewsProvider';

// Real test coverage for the Phase 8 hardening fix. AlphaVantage's API has no header-auth
// alternative, so the key must stay in the URL - the real protection here is that a caught fetch
// error never leaks it into the logs.
describe('AlphaVantageNewsProvider - secret leakage (Phase 8 hardening)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.ALPHAVANTAGE_API_KEY = 'av-real-secret-55555';
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fetchSpy?.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('never logs the real API key when a caught fetch error message happens to include the request URL', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(
      new Error('fetch failed: https://www.alphavantage.co/query?function=NEWS_SENTIMENT&limit=10&apikey=av-real-secret-55555')
    );

    const provider = new AlphaVantageNewsProvider();
    const result = await provider.fetchLatest();

    expect(result).toEqual([]); // never fabricates a result on a real fetch failure
    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedText = consoleErrorSpy.mock.calls[0][1] as string;
    expect(loggedText).not.toContain('av-real-secret-55555');
    expect(loggedText).toContain('fetch failed');
  });
});
