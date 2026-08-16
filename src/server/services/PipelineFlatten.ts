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

export async function submitPipelineSells(symbols: string[]): Promise<{
  submitted: FlattenSubmitted[];
  refused: FlattenRefusal[];
}> {
  const submitted: FlattenSubmitted[] = [];
  const refused: FlattenRefusal[] = [];
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))];

  for (const symbol of unique) {
    const currentPrice = marketDataWorker.getLatestPrice(symbol);
    if (currentPrice === null) {
      refused.push({
        symbol,
        reason: `No live price for ${symbol} — cannot size a SELL without one. RiskEngine refuses missing prices.`,
      });
      continue;
    }

    const traceId = `pipeline-flatten-${uuidv4()}`;
    const reasoning = 'Operator flatten/liquidate: SELL submitted through ChiefTrader event so RiskEngine and OMS still run. Not a raw broker.closePosition.';
    const transactionId = await recordConsensusTransaction({
      symbol,
      side: 'SELL',
      weightedConfidence: 1.0,
      threshold: 0,
      approved: true,
      reasoning,
      debateUsed: false,
      evidence: [{
        agent: 'ManualOverride',
        side: 'SELL',
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
      side: 'SELL',
      confidence: 1.0,
      reasoning,
      agentsContext: 'ManualOverride',
      currentPrice,
    });

    submitted.push({ symbol, traceId, transactionId, currentPrice });
  }

  return { submitted, refused };
}
