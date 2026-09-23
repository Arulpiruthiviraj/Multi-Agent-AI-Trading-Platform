/**
 * Canonical Cost Model (Argus World-Class Open-Source Quant Expansion roadmap, Priority #2,
 * 2026-09-23, operator-directed - explicitly sequenced BEFORE ojAlgo portfolio optimization, VaR/ES,
 * or any new model/oracle work: "build economic truth first," and explicitly NOT touching consensus,
 * model weights, or promotion).
 *
 * A single, shared cost vocabulary reused by both research (backtest/replay) and real PAPER
 * execution reporting, so the two never silently use different units, sign conventions, or
 * gross/net definitions:
 *   - Research side: `src/server/research/canonicalNextBarEngine.ts`'s own cost formula
 *     (spread+slippage baked into the fill price, commissionPerShare * qty) - unchanged by this
 *     module, cited here only as the reference this module's real-execution side must reconcile
 *     against (see `Ta4jNextOpenExecutionParityTest.java` for the cross-language proof that ta4j's
 *     execution semantics already reconcile with it).
 *   - Real PAPER side (this module): reuses `executionQuality.ts`'s already-real, already-tested
 *     arrival-price-vs-fill-price slippage computation (never recomputed here) and adds the one
 *     component that module explicitly left unmeasured - commission - with an honest, source-
 *     verified quality classification rather than a guess.
 *
 * Sign/unit convention (shared with executionQuality.ts, kept identical on purpose): all cost
 * components are POSITIVE when they reduce the trade's economic outcome, in the same per-share and
 * bps units slippage already uses. `totalCostQuality` is the WORST of its components' qualities -
 * one UNAVAILABLE component makes the total UNAVAILABLE, never silently treated as zero.
 */
import type { ExecutionQualityRow } from './executionQuality';

export const COST_QUALITIES = ['MEASURED', 'ESTIMATED', 'PARTIAL', 'UNAVAILABLE'] as const;
export type CostQuality = typeof COST_QUALITIES[number];

const QUALITY_RANK: Record<CostQuality, number> = { MEASURED: 0, ESTIMATED: 1, PARTIAL: 2, UNAVAILABLE: 3 };

/** Worst (least-certain) quality among the given components - never averages or picks the best. */
export function worstCostQuality(qualities: CostQuality[]): CostQuality {
  if (qualities.length === 0) return 'UNAVAILABLE';
  return qualities.reduce((worst, q) => (QUALITY_RANK[q] > QUALITY_RANK[worst] ? q : worst), qualities[0]);
}

/**
 * Brokers with a real, documented, verifiable $0 commission schedule for standard US equity
 * orders - a fact about that broker's own published fee schedule, not an assumption. Distinct from
 * Alpaca's real (non-zero) crypto trading fees, so this exception is scoped to non-crypto symbols
 * only (checked via the absence of a `/` in the symbol, matching this codebase's existing
 * BTC/USD-style crypto symbol convention - see config/cryptoInstruments.json).
 */
const KNOWN_ZERO_EQUITY_COMMISSION_BROKERS = new Set(['alpaca']);

export interface CommissionClassification {
  commissionTotal: number | null;
  commissionQuality: CostQuality;
}

/**
 * Classifies commission for one trade leg. Never guesses a nonzero value and never silently treats
 * an unknown commission as zero outside the one verified broker/asset-class exception above.
 */
export function classifyCommission(params: {
  brokerId: string | null;
  symbol: string;
  rawCommission: number | null;
}): CommissionClassification {
  const { brokerId, symbol, rawCommission } = params;
  if (rawCommission !== null && Number.isFinite(rawCommission)) {
    return { commissionTotal: rawCommission, commissionQuality: 'MEASURED' };
  }
  const isCrypto = symbol.includes('/');
  if (!isCrypto && brokerId && KNOWN_ZERO_EQUITY_COMMISSION_BROKERS.has(brokerId)) {
    return { commissionTotal: 0, commissionQuality: 'MEASURED' };
  }
  return { commissionTotal: null, commissionQuality: 'UNAVAILABLE' };
}

export interface TradeCostBreakdown {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  brokerId: string | null;
  filledQuantity: number;

  slippagePerShare: number;
  slippageBps: number;
  /** Real arrival-vs-fill evidence already required by executionQuality.ts's own row-inclusion
   *  filter (rows without both are excluded upstream) - always MEASURED for any row reaching here. */
  slippageQuality: CostQuality;

  commissionTotal: number | null;
  commissionQuality: CostQuality;

  /** Null whenever any component's quality is not MEASURED - never a partial estimate presented as real. */
  totalCostPerShare: number | null;
  totalCostBps: number | null;
  totalCostQuality: CostQuality;
}

/** Builds one trade's cost breakdown from an already-real executionQuality.ts row - never
 *  recomputes slippage, only adds commission and the combined total. */
export function buildTradeCostBreakdown(row: ExecutionQualityRow): TradeCostBreakdown {
  const commission = classifyCommission({ brokerId: row.brokerId, symbol: row.symbol, rawCommission: row.rawCommission });
  const totalCostQuality = worstCostQuality(['MEASURED', commission.commissionQuality]); // slippage is always MEASURED here

  const commissionPerShare = commission.commissionTotal !== null && row.filledQuantity > 0
    ? commission.commissionTotal / row.filledQuantity
    : null;

  const totalCostPerShare = totalCostQuality === 'MEASURED' && commissionPerShare !== null
    ? row.slippagePerShare + commissionPerShare
    : null;
  const totalCostBps = totalCostPerShare !== null
    ? (totalCostPerShare / row.arrivalPrice) * 10000
    : null;

  return {
    orderId: row.orderId,
    symbol: row.symbol,
    side: row.side,
    brokerId: row.brokerId,
    filledQuantity: row.filledQuantity,
    slippagePerShare: row.slippagePerShare,
    slippageBps: row.slippageBps,
    slippageQuality: 'MEASURED',
    commissionTotal: commission.commissionTotal,
    commissionQuality: commission.commissionQuality,
    totalCostPerShare,
    totalCostBps,
    totalCostQuality,
  };
}
