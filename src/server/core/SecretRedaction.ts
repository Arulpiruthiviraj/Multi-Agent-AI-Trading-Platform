/**
 * ==========================================================
 * Module: SecretRedaction.ts
 *
 * Hardening pass, Phase 8 (secret leakage). AlphaVantage and Financial Modeling Prep's public
 * APIs only support key-in-query-string auth (no header alternative), so
 * `FundamentalAgent.ts`/`MacroAgent.ts`/`AlphaVantageNewsProvider.ts`/`FMPNewsProvider.ts` embed
 * the real API key directly in the fetch URL - unavoidable for those two providers specifically.
 * The real leak vector isn't the URL construction itself, it's a caught fetch error whose message
 * (Node's undici `fetch` includes the request URL in some error causes, e.g. connection failures)
 * gets logged verbatim via `console.error('[Provider] ...', e)`. `logErrorSafely()` redacts any
 * currently-configured secret value out of the logged text before it reaches the console/log
 * storage, regardless of which error shape actually carried it.
 *
 * Polygon.io DOES support header-based auth (`Authorization: Bearer <key>`), so
 * `PolygonNewsProvider.ts` moved off the query-string pattern entirely rather than relying on
 * redaction alone - redaction is the necessary fallback for the two providers with no header
 * option, not a substitute for using headers where a provider actually supports them.
 * ==========================================================
 */

// Every env var that can plausibly hold a real credential, so a future new call site logging a
// raw error still gets the same protection without having to remember to extend a list.
const SECRET_ENV_VARS = [
  'ALPACA_API_KEY', 'ALPACA_SECRET_KEY',
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MISTRAL_API_KEY',
  'ALPHAVANTAGE_API_KEY', 'POLYGON_API_KEY', 'FMP_API_KEY', 'FINNHUB_API_KEY',
  'ENCRYPTION_SECRET', 'AUTH_SESSION_SECRET', 'APP_PASSWORD', 'AUTH_PASSWORD',
  'DEEPSEEK_API_KEY', 'NVIDIA_API_KEY', 'OPENALICE_MCP_URL',
  'IBKR_GATEWAY_URL', 'QUESTRADE_REFRESH_TOKEN', 'QUESTRADE_ACCESS_TOKEN',
  'COINBASE_API_KEY', 'COINBASE_API_SECRET', 'COINBASE_PRIVATE_KEY',
  'LIVE_ARM_TOKEN', 'WEBHOOK_SECRET',
];

// Real bug found and fixed this pass: this was previously anchored (`^(...)$`), an EXACT match
// only - so a field literally named "secret" or "token" was caught, but the camelCase compound
// names this codebase actually uses for broker credentials ("secretKey" in
// BrokerManager.ts's authenticate() call, "apiSecret" read by CoinbaseBroker.ts) were not, and
// redactSecretsDeep() passed them through untouched. Those same values are also not always in
// currentSecretValues() (decrypted DB-stored broker connection credentials never populate
// process.env), so the value-matching fallback in redactSecrets() didn't catch them either - a
// real, unredacted leak path. Unanchored on purpose: over-redacting an unrelated field that
// happens to contain "token"/"secret" as a substring is the safe direction for a redaction
// function; under-redacting a real credential is not.
const SENSITIVE_KEY = /(authorization|api[_-]?key|apikey|secret|password|token|jwt|private[_-]?key|session)/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const BASIC_AUTH_RE = /Basic\s+[A-Za-z0-9+/]+=*/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const QUERY_SECRET_RE = /([?&](?:api[_-]?key|apikey|token|secret|client_secret|password|access_token|refresh_token|auth)=)([^&\s]+)/gi;

// A short/common env value (e.g. a dev placeholder like "test" or "1") would cause this to
// over-redact unrelated log text - only real, credential-shaped values are worth protecting.
const MIN_SECRET_LENGTH = 6;

function currentSecretValues(): string[] {
  return SECRET_ENV_VARS
    .map(name => process.env[name])
    .filter((v): v is string => !!v && v.length >= MIN_SECRET_LENGTH);
}

// Replaces every occurrence of any currently-configured secret value with a fixed placeholder.
// Reads live env values on each call (not cached at module load) so a key rotated at runtime is
// still caught.
export function redactSecrets(input: string): string {
  let out = input;
  for (const secret of currentSecretValues()) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(BEARER_RE, 'Bearer [REDACTED]');
  out = out.replace(BASIC_AUTH_RE, 'Basic [REDACTED]');
  out = out.replace(JWT_RE, '[REDACTED_JWT]');
  out = out.replace(QUERY_SECRET_RE, '$1[REDACTED]');
  return out;
}

/** Recursively redact strings and sensitive-key fields in JSON-like values. Never throws. */
export function redactSecretsDeep(value: unknown, depth = 0): unknown {
  try {
    if (value == null) return value;
    if (typeof value === 'string') return redactSecrets(value);
    if (typeof value !== 'object' || depth > 8) return value;
    if (Array.isArray(value)) return value.map((v) => redactSecretsDeep(v, depth + 1));
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSecretsDeep(v, depth + 1);
      }
    }
    return out;
  } catch {
    return '[REDACTION_FAILED]';
  }
}

// Drop-in replacement for `console.error(prefix, error)` at any site that might be logging a raw
// caught error containing a request URL. Preserves the real error message/stack (for real
// debuggability) with any live secret value stripped out first.
export function logErrorSafely(prefix: string, error: unknown): void {
  const text = error instanceof Error
    ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
    : typeof error === 'string' ? error : JSON.stringify(error);
  console.error(prefix, redactSecrets(text));
}
