import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FMPNewsProvider } from './FMPNewsProvider';

// Real test coverage for the Phase 8 hardening fix - identical shape to
// AlphaVantageNewsProvider.test.ts, since FMP's API has the same key-in-query-string-only
// constraint.
describe('FMPNewsProvider - secret leakage (Phase 8 hardening)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.FMP_API_KEY = 'fmp-real-secret-44444';
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fetchSpy?.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('never logs the real API key when a caught fetch error message happens to include the request URL', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(
      new Error('fetch failed: https://financialmodelingprep.com/api/v3/fmp/articles?page=0&size=10&apikey=fmp-real-secret-44444')
    );

    const provider = new FMPNewsProvider();
    const result = await provider.fetchLatest();

    expect(result).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedText = consoleErrorSpy.mock.calls[0][1] as string;
    expect(loggedText).not.toContain('fmp-real-secret-44444');
    expect(loggedText).toContain('fetch failed');
  });
});
