import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { redactSecrets, logErrorSafely, redactSecretsDeep } from './SecretRedaction';

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

describe('redactSecrets - JWT / Bearer / query / objects', () => {
  it('redacts Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaabbbbbbbb.ccccccccdddddddd';
    const out = redactSecrets(text);
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toMatch(/Bearer eyJ/);
  });

  it('redacts compact JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpartxx.signaturepartxxxx';
    expect(redactSecrets(`token=${jwt}`)).toContain('[REDACTED_JWT]');
    expect(redactSecrets(`token=${jwt}`)).not.toContain('payloadpartxx');
  });

  it('redacts apikey query parameters', () => {
    expect(redactSecrets('https://x.test/q?apikey=supersecretvalue')).toContain('apikey=[REDACTED]');
    expect(redactSecrets('https://x.test/q?apikey=supersecretvalue')).not.toContain('supersecretvalue');
  });

  it('redacts sensitive object keys recursively', () => {
    const out = redactSecretsDeep({
      symbol: 'AAPL',
      apiKey: 'should-not-leak',
      nested: { authorization: 'Bearer abc', price: 10 },
    }) as any;
    expect(out.symbol).toBe('AAPL');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.nested.authorization).toBe('[REDACTED]');
    expect(out.nested.price).toBe(10);
  });

  it('real bug found and fixed: redacts camelCase compound key names actually used for broker credentials (secretKey, apiSecret), not just exact "secret"/"token"', () => {
    // BrokerManager.ts's authenticate() call passes {apiKey, secretKey}; CoinbaseBroker.ts reads
    // credentials?.apiSecret - neither matched the old exact-match-only SENSITIVE_KEY regex, and
    // decrypted DB-stored broker credentials never populate process.env, so the value-matching
    // fallback in redactSecrets() didn't catch them either.
    const out = redactSecretsDeep({
      apiKey: 'pub-key-value',
      secretKey: 'should-not-leak-secret-key',
      apiSecret: 'should-not-leak-api-secret',
      clientSecret: 'should-not-leak-client-secret',
      refreshToken: 'should-not-leak-refresh-token',
      symbol: 'AAPL',
    }) as any;
    expect(out.secretKey).toBe('[REDACTED]');
    expect(out.apiSecret).toBe('[REDACTED]');
    expect(out.clientSecret).toBe('[REDACTED]');
    expect(out.refreshToken).toBe('[REDACTED]');
    expect(out.symbol).toBe('AAPL');
  });

  it('real bug found and fixed: redacts Basic auth credentials, not just Bearer', () => {
    const out = redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==');
    expect(out).toContain('Basic [REDACTED]');
    expect(out).not.toContain('dXNlcjpwYXNzd29yZA==');
  });

  it('real bug found and fixed: redacts client_secret query parameters (a common OAuth param name), not just secret', () => {
    const out = redactSecrets('https://x.test/oauth/token?client_secret=supersecretvalue&grant_type=refresh_token');
    expect(out).toContain('client_secret=[REDACTED]');
    expect(out).not.toContain('supersecretvalue');
  });
});
