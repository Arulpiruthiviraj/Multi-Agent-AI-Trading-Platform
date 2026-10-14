/**
 * Policy DATA shared by the oracle drivers. Sector membership is a policy table (not arithmetic): the oracle's independence is in the cap
 * ARITHMETIC (riskOracle.ts), while WHICH sector a symbol belongs to must match the table the policy uses, or the oracle grades Argus against a
 * different policy (found 2026-10-13: a hand-copied "everything is TECH" table made correct approvals look like over-exposure). This is a copy so
 * driver scripts never import the DB-opening PositionSizing module; src/server/engines/oraclePolicy.test.ts asserts it equals getSector().
 * Diversified ETFs have no sector cap (getSector returns null), so they are absent here.
 */
export const ORACLE_SECTORS: Record<string, string> = {
  AAPL: 'Technology', MSFT: 'Technology', NVDA: 'Technology', AMD: 'Technology', AVGO: 'Technology', CRM: 'Technology', ORCL: 'Technology', ADBE: 'Technology', INTC: 'Technology',
  GOOGL: 'Communication Services', GOOG: 'Communication Services', META: 'Communication Services', NFLX: 'Communication Services', DIS: 'Communication Services', TMUS: 'Communication Services',
  AMZN: 'Consumer Discretionary', TSLA: 'Consumer Discretionary', HD: 'Consumer Discretionary', NKE: 'Consumer Discretionary', SBUX: 'Consumer Discretionary', MCD: 'Consumer Discretionary',
  JPM: 'Financials', BAC: 'Financials', GS: 'Financials', WFC: 'Financials', MS: 'Financials', V: 'Financials', MA: 'Financials',
  XOM: 'Energy', CVX: 'Energy', COP: 'Energy', SLB: 'Energy',
  JNJ: 'Healthcare', PFE: 'Healthcare', UNH: 'Healthcare', LLY: 'Healthcare', MRK: 'Healthcare', ABBV: 'Healthcare',
  WMT: 'Consumer Staples', PG: 'Consumer Staples', KO: 'Consumer Staples', PEP: 'Consumer Staples', COST: 'Consumer Staples',
  BA: 'Industrials', CAT: 'Industrials', GE: 'Industrials', UPS: 'Industrials', HON: 'Industrials',
};

export const sectorOf = (symbol: string): string | null => ORACLE_SECTORS[symbol.toUpperCase()] ?? null;
