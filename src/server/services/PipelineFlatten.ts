/**
 * Flatten / close via the live path only: CHIEF_APPROVED_IDEA → RiskAgent → RiskEngine → OMS.
 * Never call broker.closePosition from an HTTP handler — that bypasses RiskEngine.
 */
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from '../core/EventBus';
import { recordConsensusTransaction } from '../core/TransactionRegistry';
import { marketDataWorker } from './MarketDataWorker';

export type FlattenRefusal = { symbol: string; reason: string };
export type FlattenSubmitted = { symbol: string; traceId: string; transactionId: string; currentPrice: number };

/** Shared real-pipeline submit path both submitPipelineSells (full liquidate/flatten) and
 * submitPipelineOrder (PortfolioRebalance.ts's directional rebalance ideas) use - the exact same
 * CHIEF_APPROVED_IDEA emission + TransactionRegistry recording either way, only `side` and
 * `reasoning` differ. Never calls broker.closePosition or any other broker method directly. */
async function submitPipelineIdea(symbol: string, side: 'BUY' | 'SELL', reasoning: string): Promise<FlattenSubmitted | FlattenRefusal> {
  const currentPrice = marketDataWorker.getLatestPrice(symbol);
  if (currentPrice === null) {
    return { symbol, reason: `No live price for ${symbol} — cannot size a ${side} without one. RiskEngine refuses missing prices.` };
  }

  const traceId = `pipeline-${side.toLowerCase()}-${uuidv4()}`;
  const transactionId = await recordConsensusTransaction({
    symbol,
    side,
    weightedConfidence: 1.0,
    threshold: 0,
    approved: true,
    reasoning,
    debateUsed: false,
    evidence: [{
      agent: 'ManualOverride',
      side,
      confidence: 1.0,
      weight: 1.0,
      reasoning,
      currentPrice,
    }],
  });

  eventBus.emit('CHIEF_APPROVED_IDEA', {
    traceId,
    transactionId,
    symbol,
    side,
    confidence: 1.0,
    reasoning,
    agentsContext: 'ManualOverride',
    currentPrice,
  });

  return { symbol, traceId, transactionId, currentPrice };
}

function isRefusal(x: FlattenSubmitted | FlattenRefusal): x is FlattenRefusal {
  return 'reason' in x;
}

export async function submitPipelineSells(symbols: string[]): Promise<{
  submitted: FlattenSubmitted[];
  refused: FlattenRefusal[];
}> {
  const submitted: FlattenSubmitted[] = [];
  const refused: FlattenRefusal[] = [];
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))];

  for (const symbol of unique) {
    const reasoning = 'Operator flatten/liquidate: SELL submitted through ChiefTrader event so RiskEngine and OMS still run. Not a raw broker.closePosition.';
    const result = await submitPipelineIdea(symbol, 'SELL', reasoning);
    if (isRefusal(result)) refused.push(result); else submitted.push(result);
  }

  return { submitted, refused };
}

/** One directional (BUY or SELL) idea per already-deduped/validated symbol, same real
 * pipeline/safety properties as submitPipelineSells. Used by PortfolioRebalance.ts - callers are
 * responsible for deciding direction (this function invents no allocation logic of its own). */
export async function submitPipelineOrder(symbol: string, side: 'BUY' | 'SELL', reasoning: string): Promise<FlattenSubmitted | FlattenRefusal> {
  return submitPipelineIdea(symbol.toUpperCase(), side, reasoning);
}
