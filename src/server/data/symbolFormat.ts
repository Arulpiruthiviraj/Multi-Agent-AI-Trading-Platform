/**
 * symbolFormat.ts - cheap, conservative format gate for symbols before they reach a historical-data provider.
 *
 * 2026-10-13: ten IBKR "No security definition" rejections came from news-derived company names (INTEL, SMSC,
 * WALMART, ARCHER AVIATION, RNO, KWMN) reaching reqHistoricalData. A format check cannot prove a string is a real
 * security (INTEL is five plain letters), so this only rejects what can NEVER be a ticker - spaces, punctuation, empty,
 * absurdly long - and the IBKR contract-resolution negative cache (recordIbkrContractNotFound)
 * catches the rest after the first rejection. Legitimate formats stay valid: AAPL, BRK.B, BF-B, 1-6 character
 * symbols with an optional share-class/pair suffix.
 */
const TICKER_FORMAT = /^[A-Z0-9]{1,16}([./-][A-Z0-9]{1,16})?$/;

/** Stricter check for rows read back from storage: Argus normalizes symbols to upper case on ingestion, so a
 *  mixed-case value ("Walmart", " Archer Aviation") is a legacy pre-DEF-24 extraction, never a real ticker. */
export function isCanonicalStoredSymbol(raw: unknown): boolean {
  return typeof raw === 'string' && raw === raw.toUpperCase() && isPlausibleHistoricalSymbol(raw);
}

export function isPlausibleHistoricalSymbol(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  if (raw !== raw.trim()) return false; // leading/trailing whitespace is a malformed extraction, not a ticker
  return TICKER_FORMAT.test(raw.toUpperCase());
}
