import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { redactSecrets, logErrorSafely } from './SecretRedaction';

describe('redactSecrets', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.ALPHAVANTAGE_API_KEY = 'AV-real-secret-key-12345';
    process.env.FMP_API_KEY = 'fmp-real-secret-key-67890';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('redacts a real configured secret value wherever it appears in a string', () => {
    const text = `fetch failed: https://www.alphavantage.co/query?function=OVERVIEW&apikey=AV-real-secret-key-12345`;
    expect(redactSecrets(text)).toBe('fetch failed: https://www.alphavantage.co/query?function=OVERVIEW&apikey=[REDACTED]');
  });

  it('redacts multiple different configured secrets in the same string', () => {
    const text = 'AV-real-secret-key-12345 and also fmp-real-secret-key-67890 appeared';
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('AV-real-secret-key-12345');
    expect(redacted).not.toContain('fmp-real-secret-key-67890');
    expect(redacted).toBe('[REDACTED] and also [REDACTED] appeared');
  });

  it('leaves unrelated text completely unchanged', () => {
    const text = 'Normal error: connection refused';
    expect(redactSecrets(text)).toBe(text);
  });

  it('does not redact when the env var is unset', () => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    const text = 'some text with AV-real-secret-key-12345 in it';
    expect(redactSecrets(text)).toBe(text);
  });

  it('does not over-redact on a short/trivial env value (avoids false-positive matches on common substrings)', () => {
    process.env.APP_PASSWORD = 'abc'; // below MIN_SECRET_LENGTH
    const text = 'this text mentions abc casually, not a secret leak';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('logErrorSafely', () => {
  const ORIGINAL_ENV = { ...process.env };
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.ALPHAVANTAGE_API_KEY = 'AV-real-secret-key-12345';
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    consoleErrorSpy.mockRestore();
  });

  it('redacts a real secret embedded in a caught Error message before logging', () => {
    const err = new Error('fetch failed for https://www.alphavantage.co/query?apikey=AV-real-secret-key-12345');
    logErrorSafely('[TestProvider] Error fetching news', err);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const loggedText = consoleErrorSpy.mock.calls[0][1] as string;
    expect(loggedText).not.toContain('AV-real-secret-key-12345');
    expect(loggedText).toContain('fetch failed for');
  });

  it('handles a non-Error thrown value without crashing', () => {
    logErrorSafely('[TestProvider] Error', 'a plain string error containing AV-real-secret-key-12345');
    const loggedText = consoleErrorSpy.mock.calls[0][1] as string;
    expect(loggedText).not.toContain('AV-real-secret-key-12345');
  });
});
