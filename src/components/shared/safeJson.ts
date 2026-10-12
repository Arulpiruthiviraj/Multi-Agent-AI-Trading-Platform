/**
 * safeJson — crash-safe JSON parsing helpers for the Argus frontend.
 *
 * Why this exists: several backend columns (notably news `symbols`) are
 * free-text in SQLite and may hold a plain ticker ("AAPL"), valid JSON, or
 * garbage. A bare `JSON.parse` in a render body turns one bad row into a
 * thrown SyntaxError that unmounts the whole panel (or, outside the tab
 * boundary, the entire terminal). These helpers never throw.
 */

/**
 * Parse a symbols payload that may be a JSON array string, a bare ticker
 * string, null/undefined, or garbage. Always returns a string array.
 */
export function safeParseSymbols(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === 'string');
    }
    // A JSON-encoded bare string like "\"AAPL\"" — treat as one symbol.
    if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim()];
    return [];
  } catch {
    // Not JSON at all — treat the raw text as a single ticker symbol
    // (matches the server's parseStoredSymbols fallback), unless it
    // contains whitespace/punctuation that marks it as garbage.
    return /^[\w.\-^=]+$/.test(trimmed) ? [trimmed] : [];
  }
}

/**
 * Parse arbitrary JSON without throwing. Returns `fallback` on any failure.
 */
export function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}
