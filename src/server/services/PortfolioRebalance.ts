/**
 * Real target-allocation rebalance. POST /api/v1/portfolio/rebalance used to be a permanent 501
 * refusal - its own error message explained why the obvious implementation (loop over positions,
 * call broker.closePosition/placeOrder directly to hit target weights) is forbidden: it bypasses
 * RiskEngine entirely. This is the real, safe version: for each named symbol, compares real
 * current position value against the requested target (both against real broker equity/price),
 * and - only when the drift exceeds rebalanceMinDriftPctOfEquity - submits ONE directional idea
 * (BUY or SELL) through the exact same CHIEF_APPROVED_IDEA → RiskAgent → RiskEngine → OMS path
 * submitPipelineSells (liquidate) already uses. Never calls a broker method directly.
 *
 * Honest limitation, by design: this module decides DIRECTION only (over/under target), never a
 * target quantity - RiskEngine/PositionSizing's own independent caps (order-notional, risk,
 * buying-power, concentration, sufficient_size, held-quantity for SELL) are what actually size
 * the resulting order, exactly as for every other real order in this system. A rebalance request
 * is therefore a real, safe nudge toward the requested weights, not a guarantee of landing exactly
 * on them in one pass - CLAUDE.md's "AI interprets quant evidence; it does not replace it or
 * invent prices/EV" applies here too: this module never invents a share quantity.
 */
import { BrokerManager } from '../../brokers/BrokerManager';
import { marketDataWorker } from './MarketDataWorker';
import { submitPipelineOrder, FlattenSubmitted, FlattenRefusal } from './PipelineFlatten';
import { tradingSafety } from '../config/tradingSafety';

export interface TargetAllocationRequest {
  symbol: string;
  targetPct: number;
}

export type RebalanceSkipped = { symbol: string; reason: string; driftPct: number };

export interface RebalanceResult {
  submitted: (FlattenSubmitted & { side: 'BUY' | 'SELL'; driftPct: number })[];
  refused: FlattenRefusal[];
  skipped: RebalanceSkipped[];
}

export function validateTargetAllocations(input: unknown): { ok: true; targets: TargetAllocationRequest[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: 'targetAllocations must be a non-empty array of { symbol, targetPct }.' };
  }
  const targets: TargetAllocationRequest[] = [];
  const seen = new Set<string>();
  let totalPct = 0;
  for (const raw of input) {
    const symbol = typeof raw?.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
    const targetPct = Number(raw?.targetPct);
    if (!symbol) return { ok: false, error: 'Every entry needs a non-empty symbol.' };
    if (!Number.isFinite(targetPct) || targetPct < 0 || targetPct > 100) {
      return { ok: false, error: `${symbol}: targetPct must be a finite number between 0 and 100, got ${JSON.stringify(raw?.targetPct)}.` };
    }
    if (seen.has(symbol)) return { ok: false, error: `${symbol} appears more than once in targetAllocations.` };
    seen.add(symbol);
    totalPct += targetPct;
    targets.push({ symbol, targetPct });
  }
  if (totalPct > 100) {
    return { ok: false, error: `targetAllocations sum to ${totalPct.toFixed(2)}%, which exceeds 100% of equity.` };
  }
  return { ok: true, targets };
}

export async function executeRebalance(targets: TargetAllocationRequest[]): Promise<RebalanceResult> {
  const broker = BrokerManager.getInstance().getActiveBroker();
  const portfolio = await broker.portfolio();
  const equity = portfolio.equity;

  const submitted: RebalanceResult['submitted'] = [];
  const refused: FlattenRefusal[] = [];
  const skipped: RebalanceSkipped[] = [];

  for (const { symbol, targetPct } of targets) {
    const existing = portfolio.positions.find((p) => p.symbol === symbol);
    const currentPrice = marketDataWorker.getLatestPrice(symbol) ?? existing?.currentPrice ?? null;
    if (currentPrice === null || !Number.isFinite(equity) || equity <= 0) {
      refused.push({ symbol, reason: `No live price and/or invalid account equity for ${symbol} - cannot evaluate real drift without both.` });
      continue;
    }
    const currentValue = existing?.marketValue ?? 0;
    const targetValue = equity * (targetPct / 100);
    const driftPct = ((currentValue - targetValue) / equity) * 100;

    if (Math.abs(driftPct) < tradingSafety.rebalanceMinDriftPctOfEquity) {
      skipped.push({ symbol, reason: `Already within ${tradingSafety.rebalanceMinDriftPctOfEquity}% of target (drift ${driftPct.toFixed(2)}%).`, driftPct });
      continue;
    }

    const side: 'BUY' | 'SELL' = currentValue > targetValue ? 'SELL' : 'BUY';
    if (side === 'SELL' && !existing) {
      // Should not happen (currentValue would be 0), but fail closed rather than emit a SELL
      // with nothing held.
      skipped.push({ symbol, reason: 'No existing position to sell.', driftPct });
      continue;
    }
    const reasoning = `Operator rebalance: ${symbol} real value $${currentValue.toFixed(2)} vs target $${targetValue.toFixed(2)} (${targetPct}% of $${equity.toFixed(2)} equity, drift ${driftPct.toFixed(2)}%). Direction only - submitted through ChiefTrader event so RiskEngine/OMS still run and size it; not a raw broker call.`;
    const result = await submitPipelineOrder(symbol, side, reasoning);
    if ('reason' in result) {
      refused.push(result);
    } else {
      submitted.push({ ...result, side, driftPct });
    }
  }

  return { submitted, refused, skipped };
}
