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
    }).from(trades);
  } catch {
    rows = [];
  }

  const summary = summarizeOrganicPaper(rows, researchSafety.minPaperTrades);
  const closed = summary.closedTradeCount;
  const sessions = summary.sessionCount;
  const out = {
    ok: true,
    live: 'NO-GO',
    canPlaceOrders: false,
    invented: false,
    soak: {
      status:
        closed >= researchSafety.minPaperTrades && sessions >= researchSafety.minPaperSessions
          ? 'SOAK_FLOOR_MET'
          : 'SOAK_IN_PROGRESS',
      minPaperTrades: researchSafety.minPaperTrades,
      minPaperSessions: researchSafety.minPaperSessions,
      closedTradeCount: closed,
      sessionCount: sessions,
      remainingTrades: Math.max(0, researchSafety.minPaperTrades - closed),
      remainingSessions: Math.max(0, researchSafety.minPaperSessions - sessions),
    },
    summary,
    note: 'Start supervised PAPER Autobot against real ticks. Do not fabricate trades. Do not arm LIVE.',
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
