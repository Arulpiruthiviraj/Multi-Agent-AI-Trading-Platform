import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PolygonNewsProvider } from './PolygonNewsProvider';

// Real test coverage for the Phase 8 hardening fix: Polygon.io supports header-based auth, so the
// real API key must never appear in the request URL (unlike AlphaVantage/FMP, which have no
// header alternative and are covered by SecretRedaction.test.ts instead).
describe('PolygonNewsProvider - secret leakage (Phase 8 hardening)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.POLYGON_API_KEY = 'polygon-real-secret-99999';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    } as any);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fetchSpy.mockRestore();
  });

  it('sends the API key as an Authorization header, never in the request URL', async () => {
    const provider = new PolygonNewsProvider();
    await provider.fetchLatest();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(String(url)).not.toContain('polygon-real-secret-99999');
    expect(String(url)).not.toContain('apiKey=');
    expect((options as any).headers.Authorization).toBe('Bearer polygon-real-secret-99999');
  });

  it('logs a caught fetch error without ever including the key (defense-in-depth, though it is no longer in the URL)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockRejectedValue(new Error('network error contacting https://api.polygon.io/v2/reference/news'));

    const provider = new PolygonNewsProvider();
    const result = await provider.fetchLatest();

    expect(result).toEqual([]); // never fabricates a result on a real fetch failure
    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedText = consoleErrorSpy.mock.calls[0][1] as string;
    expect(loggedText).not.toContain('polygon-real-secret-99999');
    consoleErrorSpy.mockRestore();
  });
});
