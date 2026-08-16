/**
 * ==========================================================
 * Module: PositionSizing
 *
 * Purpose:
 * Phase 2A of FINAL_ANALYSIS.md's 4-phase remediation plan - the exact real position-sizing math
 * RiskEngine.ts uses live, extracted into a pure function so BacktestEngine can use the identical
 * logic instead of its previous flat-10%-of-initial-cash rule (a real, previously-documented
 * inconsistency - FINAL_ANALYSIS.md 15.9 - that meant a backtest "pass" would not have predicted
 * live sizing behavior even if the underlying edge were real).
 *
 * Deliberately NOT done by having BacktestEngine call the live RiskEngine.evaluateRisk()
 * singleton directly: that method reads the REAL live broker portfolio/current-time market clock
 * and writes REAL rows to risk_assessments/risk_gate_results plus emits REAL EventBus events that
 * ChiefTraderAgent/the WebSocket broadcast/TransactionLifecycleTracker all react to. Calling it
 * from inside a backtest loop would corrupt the live audit trail with simulated data and emit
 * phantom "live" events during a backtest. This module instead takes accountEquity/buyingPower/
 * existingPositions/getRecentCloses as plain inputs, so the caller (live RiskEngine or
 * BacktestEngine) supplies its own real-for-its-context state - live state for RiskEngine,
 * point-in-time simulated state for BacktestEngine - while the sizing math itself is identical.
 * ==========================================================
 */

import { tradingSafety } from '../config/tradingSafety';
import { INVALID_ACCOUNT_EQUITY, isPositiveFiniteMoney } from './AccountEquity';

export const MAX_SINGLE_SYMBOL_CONCENTRATION_PCT = tradingSafety.maxSingleSymbolConcentrationPct;
export const MAX_SECTOR_CONCENTRATION_PCT = tradingSafety.maxSectorConcentrationPct;
export const CORRELATION_MIN_OVERLAP = tradingSafety.correlationMinOverlap;
export const CORRELATION_THRESHOLD = tradingSafety.correlationThreshold;
export const MAX_CORRELATED_EXPOSURE_PCT = tradingSafety.maxCorrelatedExposurePct;
export const STOP_LOSS_ASSUMPTION_PCT = tradingSafety.stopLossAssumptionPct;

// Same real (if coarse) GICS-style sector map RiskEngine.ts uses - kept here as the single source
// so both the live engine and the backtest engine sector-cap against identical sector groupings.
export const SECTOR_MAP: Record<string, string> = {
  AAPL: 'Technology', MSFT: 'Technology', NVDA: 'Technology', AMD: 'Technology',
  AVGO: 'Technology', CRM: 'Technology', ORCL: 'Technology', ADBE: 'Technology', INTC: 'Technology',
  GOOGL: 'Communication Services', GOOG: 'Communication Services', META: 'Communication Services',
  NFLX: 'Communication Services', DIS: 'Communication Services', TMUS: 'Communication Services',
  AMZN: 'Consumer Discretionary', TSLA: 'Consumer Discretionary', HD: 'Consumer Discretionary',
  NKE: 'Consumer Discretionary', SBUX: 'Consumer Discretionary', MCD: 'Consumer Discretionary',
  JPM: 'Financials', BAC: 'Financials', GS: 'Financials', WFC: 'Financials', MS: 'Financials', V: 'Financials', MA: 'Financials',
  XOM: 'Energy', CVX: 'Energy', COP: 'Energy', SLB: 'Energy',
  JNJ: 'Healthcare', PFE: 'Healthcare', UNH: 'Healthcare', LLY: 'Healthcare', MRK: 'Healthcare', ABBV: 'Healthcare',
  WMT: 'Consumer Staples', PG: 'Consumer Staples', KO: 'Consumer Staples', PEP: 'Consumer Staples', COST: 'Consumer Staples',
  BA: 'Industrials', CAT: 'Industrials', GE: 'Industrials', UPS: 'Industrials', HON: 'Industrials',
  SPY: 'Diversified ETF', QQQ: 'Diversified ETF', VOO: 'Diversified ETF', VTI: 'Diversified ETF', DIA: 'Diversified ETF', IWM: 'Diversified ETF',
};

export function getSector(symbol: string): string | null {
  const sector = SECTOR_MAP[symbol.toUpperCase()];
  if (!sector || sector === 'Diversified ETF') return null;
  return sector;
}

/** Real Pearson correlation of daily returns (not raw prices). Null on too little overlap. */
export function returnCorrelation(closesA: number[], closesB: number[]): number | null {
  const n = Math.min(closesA.length, closesB.length);
  if (n < CORRELATION_MIN_OVERLAP + 1) return null;
  const a = closesA.slice(-n), b = closesB.slice(-n);
  const retA = a.slice(1).map((v, i) => v / a[i] - 1);
  const retB = b.slice(1).map((v, i) => v / b[i] - 1);
  const meanA = retA.reduce((s, v) => s + v, 0) / retA.length;
  const meanB = retB.reduce((s, v) => s + v, 0) / retB.length;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < retA.length; i++) {
    const da = retA[i] - meanA, db = retB[i] - meanB;
    cov += da * db; varA += da * da; varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

export interface ExistingPosition {
  symbol: string;
  quantity: number;
}

export interface SizingContext {
  side: 'BUY' | 'SELL';
  symbol: string;
  currentPrice: number;
  accountEquity: number;
  buyingPower: number;
  maxTradeSizeDollar: number;
  maxPortfolioRiskPct: number;
  existingPositions: ExistingPosition[];
  maxOpenPositions: number;
  /** E2B - optional, additive. Defaults to 'FIXED_DOLLAR' (today's exact behavior: the order-
   * notional cap is maxTradeSizeDollar, a flat number). 'PERCENT_OF_EQUITY' instead derives the
   * order-notional cap from accountEquity * (percentOfEquityPct / 100), so it scales with the
   * account instead of staying flat - every other cap (risk-based, buying-power, concentration,
   * correlation) is unaffected by this setting and still applies on top of it. */
  sizingMode?: 'FIXED_DOLLAR' | 'PERCENT_OF_EQUITY';
  /** Only read when sizingMode='PERCENT_OF_EQUITY'. */
  percentOfEquityPct?: number;
  /** LIVE: skipped correlation/sector history is FAIL (UNKNOWN), not PASS. Paper keeps SKIPPED. */
  failClosedUnknownInputs?: boolean;
  /** Real recent daily closes for correlation, or null if unavailable - caller supplies the
   * right point-in-time source (live: Alpaca-backed cache; backtest: bars already visible up to
   * the simulated clock, never a future bar). */
  getRecentCloses: (symbol: string) => Promise<number[] | null>;
}

export interface SizingGateResult {
  gate: string;
  passed: boolean;
  detail: any;
}

type SizingHonesty = 'PASS' | 'CLAMPED' | 'FAIL' | 'UNKNOWN' | 'SKIPPED';

export interface SizingResult {
  maxQuantity: number;
  gates: SizingGateResult[];
}

/**
 * The exact real sizing math RiskEngine.ts evaluates live (order-notional cap, single-symbol
 * concentration, open-positions cap, sector concentration, correlation-based exposure, sufficient-
 * size) - extracted verbatim in logic, parameterized on inputs instead of live DB/broker state.
 */
export async function calculatePositionSizing(ctx: SizingContext): Promise<SizingResult> {
  const gates: SizingGateResult[] = [];
  const record = (gate: string, passed: boolean, detail: any) => gates.push({ gate, passed, detail });

  if (!isPositiveFiniteMoney(ctx.accountEquity)) {
    record(INVALID_ACCOUNT_EQUITY, false, { accountEquity: ctx.accountEquity });
    record('sufficient_size', false, { maxQuantity: 0, reason: 'INVALID_ACCOUNT_EQUITY' });
    return { maxQuantity: 0, gates };
  }

  const riskPerShare = ctx.currentPrice * STOP_LOSS_ASSUMPTION_PCT;
  const maxRiskAmount = ctx.accountEquity * ctx.maxPortfolioRiskPct;

  // E2B - the order-notional cap's dollar figure depends on sizingMode. FIXED_DOLLAR (default,
  // unchanged behavior) uses maxTradeSizeDollar verbatim; PERCENT_OF_EQUITY derives it from
  // current equity instead, so the cap scales as the account grows/shrinks rather than staying
  // flat. Every other cap below (risk-based, buying-power, concentration, correlation) is
  // computed exactly as before and still applies on top of whichever notional cap wins here.
  const sizingMode = ctx.sizingMode ?? 'FIXED_DOLLAR';
  const effectiveNotionalCapDollar = sizingMode === 'PERCENT_OF_EQUITY'
    ? ctx.accountEquity * ((ctx.percentOfEquityPct ?? tradingSafety.defaultPercentOfEquityPct) / 100)
    : ctx.maxTradeSizeDollar;

  const maxSharesByRisk = Math.floor(maxRiskAmount / riskPerShare);
  const maxSharesByCapital = Math.floor(effectiveNotionalCapDollar / ctx.currentPrice);
  const maxSharesByBuyingPower = Math.floor(ctx.buyingPower / ctx.currentPrice);

  const orderNotionalIsBinding = maxSharesByCapital <= maxSharesByRisk && maxSharesByCapital <= maxSharesByBuyingPower;
  const notionalStatus: SizingHonesty = maxSharesByCapital <= 0 ? 'FAIL' : orderNotionalIsBinding ? 'CLAMPED' : 'PASS';
  record('order_notional_cap', maxSharesByCapital > 0, {
    status: notionalStatus,
    sizingMode, effectiveNotionalCapDollar,
    maxTradeSizeDollar: ctx.maxTradeSizeDollar, percentOfEquityPct: ctx.percentOfEquityPct,
    maxSharesByCapital, maxSharesByRisk, maxSharesByBuyingPower, isBinding: orderNotionalIsBinding,
  });

  let maxQuantity = Math.min(maxSharesByRisk, maxSharesByCapital, maxSharesByBuyingPower);

  if (ctx.side === 'BUY') {
    const existingPosition = ctx.existingPositions.find(p => p.symbol === ctx.symbol);
    const existingValue = existingPosition ? existingPosition.quantity * ctx.currentPrice : 0;
    const maxPositionValue = ctx.accountEquity * MAX_SINGLE_SYMBOL_CONCENTRATION_PCT;
    const remainingRoom = Math.max(0, maxPositionValue - existingValue);
    const maxSharesByConcentration = Math.floor(remainingRoom / ctx.currentPrice);
    const beforeConcentration = maxQuantity;
    maxQuantity = Math.min(maxQuantity, maxSharesByConcentration);
    const concentrationFail = maxSharesByConcentration <= 0 && remainingRoom <= 0;
    record('symbol_concentration', !concentrationFail, {
      status: concentrationFail ? 'FAIL' : (beforeConcentration !== maxQuantity ? 'CLAMPED' : 'PASS'),
      existingValue, maxPositionValue, capPct: MAX_SINGLE_SYMBOL_CONCENTRATION_PCT,
      boundQuantity: beforeConcentration !== maxQuantity ? maxQuantity : null,
    });
    if (concentrationFail) maxQuantity = 0;

    const isNewPosition = !existingPosition;
    const openPositionsPassed = !isNewPosition || ctx.existingPositions.length < ctx.maxOpenPositions;
    record('open_positions_cap', openPositionsPassed, { currentOpenPositions: ctx.existingPositions.length, maxOpenPositions: ctx.maxOpenPositions, isNewPosition });
    if (!openPositionsPassed) maxQuantity = 0;

    const proposalSector = getSector(ctx.symbol);
    if (proposalSector) {
      const sectorValue = ctx.existingPositions.reduce((sum, p) => getSector(p.symbol) === proposalSector ? sum + p.quantity * ctx.currentPrice : sum, 0);
      const maxSectorValue = ctx.accountEquity * MAX_SECTOR_CONCENTRATION_PCT;
      const remainingSectorRoom = Math.max(0, maxSectorValue - sectorValue);
      const maxSharesBySector = Math.floor(remainingSectorRoom / ctx.currentPrice);
      const beforeSector = maxQuantity;
      maxQuantity = Math.min(maxQuantity, maxSharesBySector);
      record('sector_concentration', true, { sector: proposalSector, sectorValue, maxSectorValue, capPct: MAX_SECTOR_CONCENTRATION_PCT, boundQuantity: beforeSector !== maxQuantity ? maxQuantity : null });
    } else {
      record('sector_concentration', true, { skipped: true, reason: 'symbol not in sector map' });
    }

    if (ctx.existingPositions.length > 0) {
      const proposalCloses = await ctx.getRecentCloses(ctx.symbol);
      if (proposalCloses) {
        let correlatedValue = 0;
        for (const p of ctx.existingPositions) {
          if (p.symbol === ctx.symbol) { correlatedValue += p.quantity * ctx.currentPrice; continue; }
          const otherCloses = await ctx.getRecentCloses(p.symbol);
          if (!otherCloses) continue;
          const corr = returnCorrelation(proposalCloses, otherCloses);
          if (corr !== null && corr > CORRELATION_THRESHOLD) correlatedValue += p.quantity * ctx.currentPrice;
        }
        const maxCorrelatedValue = ctx.accountEquity * MAX_CORRELATED_EXPOSURE_PCT;
        const remainingCorrelatedRoom = Math.max(0, maxCorrelatedValue - correlatedValue);
        const maxSharesByCorrelation = Math.floor(remainingCorrelatedRoom / ctx.currentPrice);
        const beforeCorr = maxQuantity;
        maxQuantity = Math.min(maxQuantity, maxSharesByCorrelation);
        record('correlation_exposure', true, { correlatedValue, maxCorrelatedValue, capPct: MAX_CORRELATED_EXPOSURE_PCT, boundQuantity: beforeCorr !== maxQuantity ? maxQuantity : null });
      } else {
        record('correlation_exposure', true, { skipped: true, reason: 'no real price history for this symbol' });
      }
    } else {
      record('correlation_exposure', true, { skipped: true, reason: 'no existing positions to correlate against' });
    }
  }

  const sufficientSizePassed = maxQuantity > 0;
  record('sufficient_size', sufficientSizePassed, { maxQuantity, buyingPower: ctx.buyingPower });

  return { maxQuantity: Math.max(0, maxQuantity), gates };
}
