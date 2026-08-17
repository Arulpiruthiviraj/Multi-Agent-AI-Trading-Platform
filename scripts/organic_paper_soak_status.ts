/**
 * Organic paper soak status — read-only. Never invents fills.
 * Usage: npx tsx scripts/organic_paper_soak_status.ts
 */
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const { db } = await import('../src/server/db');
  const { trades } = await import('../src/server/db/schema');
  const { summarizeOrganicPaper } = await import('../src/server/research/organicPaper');
  const { researchSafety } = await import('../src/server/config/researchSafety');
  const { derivePaperSoakStatus } = await import('../src/server/research/paperSoakState');
  const { tradingEngine } = await import('../src/server/engines/TradingEngine');

  let rows: any[] = [];
  try {
    rows = await db.select({
      status: trades.status,
      side: trades.side,
      profitLoss: trades.profitLoss,
      traceId: trades.traceId,
      reasoning: trades.reasoning,
      executionEnvironment: trades.executionEnvironment,
      timestamp: trades.timestamp,
      filledAt: trades.filledAt,
      symbol: trades.symbol,
    }).from(trades);
  } catch {
    rows = [];
  }

  const summary = summarizeOrganicPaper(rows, researchSafety.minPaperTrades);
  const soak = derivePaperSoakStatus({
    closedTradeCount: summary.closedTradeCount,
    sessionCount: summary.sessionCount,
    tradingState: tradingEngine.state.tradingState,
    reconciliationBlocking: tradingEngine.state.tradingState === 'TRADING_PAUSED',
  });
  const out = {
    ok: true,
    live: 'NO-GO' as const,
    canPlaceOrders: false,
    invented: false,
    soak,
    summary,
    note: 'Start supervised PAPER Autobot against real ticks. Do not fabricate trades. Do not arm LIVE.',
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
