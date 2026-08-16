/**
 * Read-only organic paper count from SQLite. Never inserts trades.
 */
import dotenv from 'dotenv';
dotenv.config();
import { db } from '../src/server/db';
import { trades } from '../src/server/db/schema';
import { summarizeOrganicPaper } from '../src/server/research/organicPaper';
import { researchSafety } from '../src/server/config/researchSafety';

async function main() {
  const rows = await db.select({
    status: trades.status,
    side: trades.side,
    profitLoss: trades.profitLoss,
    traceId: trades.traceId,
    reasoning: trades.reasoning,
    executionEnvironment: trades.executionEnvironment,
    timestamp: trades.timestamp,
    filledAt: trades.filledAt,
  }).from(trades);
  const summary = summarizeOrganicPaper(rows, researchSafety.minPaperTrades);
  console.log(JSON.stringify({
    ...summary,
    minPaperTrades: researchSafety.minPaperTrades,
    minPaperSessions: researchSafety.minPaperSessions,
    meetsPaperFloor: summary.closedTradeCount >= researchSafety.minPaperTrades && summary.sessionCount >= researchSafety.minPaperSessions,
    live: 'NO-GO',
    enableLiveTrading: false,
    invented: false,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
