/**
 * Builds INITIAL_STATE_SNAPSHOT for WebSocket clients on connect.
 * Mobile Mission Control hydrates from this before REST polling completes.
 */
import { desc, eq } from 'drizzle-orm';
import { BrokerManager } from '../../brokers/BrokerManager';
import { tradingEngine } from '../engines/TradingEngine';
import { db } from '../db';
import { settings, transactions, consensusDecisions } from '../db/schema';
import { tradingSafety } from '../config/tradingSafety';

const CONSENSUS_THRESHOLD = tradingSafety.consensusApprovalThreshold;

export type InitialStateSnapshotPayload = {
  portfolio: {
    available: boolean;
    equity: number | null;
    cash: number | null;
    budget: number | null;
    intradayPl: number | null;
    drawdownPct: number | null;
    peakValuation: number | null;
    positions: Array<{
      symbol: string;
      quantity: number;
      marketValue?: number;
      unrealizedPl?: number;
      currentPrice?: number;
    }>;
  };
  settings: {
    trading_mode: string;
    trading_state: string;
    auto_bot_enabled: boolean;
    maxPortfolioDrawdownPct: number | null;
  };
  positions: Array<{
    symbol: string;
    quantity: number;
    marketValue?: number;
    unrealizedPl?: number;
    currentPrice?: number;
  }>;
  consensus: {
    side: string | null;
    weightedConfidence: number | null;
    threshold: number | null;
    approved: boolean | null;
  };
  autobot: {
    emergencyStopActive: boolean;
    scheduleWindow: ReturnType<typeof tradingEngine.getScheduleWindowStatus>;
  };
};

export async function buildInitialStateSnapshot(): Promise<InitialStateSnapshotPayload> {
  const settingsRows = await db.select().from(settings).limit(1);
  const settingsRow = settingsRows[0] ?? null;
  const budget = Number(settingsRow?.budget ?? tradingEngine.state.budget ?? null) || null;
  const maxPortfolioDrawdownPct = settingsRow?.maxPortfolioDrawdownPct ?? 0.15;

  let portfolioBlock: InitialStateSnapshotPayload['portfolio'] = {
    available: false,
    equity: null,
    cash: null,
    budget,
    intradayPl: null,
    drawdownPct: null,
    peakValuation: settingsRow?.peakEquity ?? null,
    positions: [],
  };

  try {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const pf = await broker.portfolio();
    const peak = Math.max(settingsRow?.peakEquity ?? 0, pf.equity ?? 0);
    const drawdownPct = peak > 0 && pf.equity != null
      ? Number(((peak - pf.equity) / peak).toFixed(4))
      : null;
    const positions = (pf.positions ?? []).map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      marketValue: p.marketValue,
      unrealizedPl: p.unrealizedPnl,
      currentPrice: p.currentPrice,
    }));
    portfolioBlock = {
      available: true,
      equity: pf.equity ?? null,
      cash: pf.cash ?? null,
      budget,
      intradayPl: pf.dailyPnl ?? null,
      drawdownPct,
      peakValuation: peak || null,
      positions,
    };
  } catch {
    // Partial snapshot — mobile REST fallback may still hydrate.
  }

  let consensusBlock: InitialStateSnapshotPayload['consensus'] = {
    side: null,
    weightedConfidence: null,
    threshold: CONSENSUS_THRESHOLD,
    approved: null,
  };

  try {
    const latestTx = await db.select().from(transactions).orderBy(desc(transactions.openedAt)).limit(1);
    const tx = latestTx[0];
    if (tx) {
      const cd = await db.select().from(consensusDecisions)
        .where(eq(consensusDecisions.transactionId, tx.id))
        .limit(1);
      const row = cd[0];
      if (row) {
        consensusBlock = {
          side: row.side ?? null,
          weightedConfidence: row.weightedConfidence ?? null,
          threshold: row.threshold ?? CONSENSUS_THRESHOLD,
          approved: tx.finalDecision === 'APPROVED' ? true : tx.finalDecision === 'REJECTED' ? false : null,
        };
      }
    }
  } catch {
    // Non-fatal
  }

  return {
    portfolio: portfolioBlock,
    settings: {
      trading_mode: tradingEngine.state.tradingMode ?? settingsRow?.tradingMode ?? 'PAPER',
      trading_state: tradingEngine.state.tradingState ?? 'TRADING_ENABLED',
      auto_bot_enabled: tradingEngine.state.enabled === true,
      maxPortfolioDrawdownPct,
    },
    positions: portfolioBlock.positions,
    consensus: consensusBlock,
    autobot: {
      emergencyStopActive: tradingEngine.state.emergencyStopActive === true,
      scheduleWindow: tradingEngine.getScheduleWindowStatus(),
    },
  };
}
