/**
 * Evidence-triggered scheduler (Section 17/31). Explicitly NOT time-triggered — "Do not run
 * evolution after every trade. Instead use a minimum evidence threshold... Evolution should be
 * evidence-triggered, not simply time-triggered." Reuses researchSafety.minPaperTrades (the same
 * real floor AlphaEdgeResearch.ts/MonteCarloResearch.ts already gate on this session) rather than
 * inventing a new threshold. Also reuses the self-improvement-loop audit's own organic-environment
 * filter (NON_LIVE_OPENING_TRADE_ENVS) so REPLAY/BACKTEST volume can never satisfy this gate —
 * the exact contamination class that audit found and fixed elsewhere must not resurface here.
 */
import { db } from '../../db';
import { trades } from '../../db/schema';
import { researchSafety } from '../../config/researchSafety';
import { NON_LIVE_OPENING_TRADE_ENVS } from '../../services/omsEntryPrice';

export interface EvolutionReadiness {
  ready: boolean;
  organicTradeCount: number;
  required: number;
  reason: string;
}

export async function checkEvolutionReadiness(): Promise<EvolutionReadiness> {
  const allTrades = await db.select().from(trades).all();
  const organic = allTrades.filter(
    (t) => t.status === 'FILLED' && !NON_LIVE_OPENING_TRADE_ENVS.has(String(t.executionEnvironment || '').toUpperCase()),
  );
  const required = researchSafety.minPaperTrades;
  const ready = organic.length >= required;
  return {
    ready,
    organicTradeCount: organic.length,
    required,
    reason: ready
      ? `${organic.length} organic closed trades >= required ${required} — evolution cycle may run.`
      : `Only ${organic.length} organic closed trades (< required ${required}) — evolution cycle withheld, not run on insufficient evidence.`,
  };
}
