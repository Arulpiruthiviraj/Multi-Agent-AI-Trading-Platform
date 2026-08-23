/**
 * Resolve quantStrategyId / agent origin for campaign attribution.
 * Prefer opening BUY.trades.quantStrategyId; fall back to quantInvalidationJson,
 * agent_predictions / reasoning parse, then AGENT:<name>. Never invents CORE strategy ids.
 */
import { and, desc, eq, lte } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '../db/schema';
import { replaySafety } from '../replay/replaySafety';

export const UNATTRIBUTED_STRATEGY_ID = 'UNATTRIBUTED';

const CORE_STRATEGY_IDS = [
  'MOMENTUM_BREAKOUT',
  'PULLBACK_CONTINUATION',
  'MEAN_REVERSION',
  'TREND_FOLLOWING',
  'RANGE_REVERSION',
] as const;

const NON_LIVE_ENVS = new Set([
  'REPLAY', 'BACKTEST', 'SIMULATION', 'HISTORICAL_REPLAY', 'HISTORICAL_SIMULATION', 'TELEMETRY_PULSE', 'DIAGNOSTIC',
]);

function normalizeStrategyId(raw: string | null | undefined): string {
  const id = (raw ?? '').trim();
  return id.length > 0 ? id : UNATTRIBUTED_STRATEGY_ID;
}

function extractCoreStrategyFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  for (const id of CORE_STRATEGY_IDS) {
    if (upper.includes(id)) return id;
  }
  // JSON strategy field
  const m = text.match(/"strategy"\s*:\s*"([A-Z0-9_]+)"/i);
  if (m && CORE_STRATEGY_IDS.includes(m[1].toUpperCase() as typeof CORE_STRATEGY_IDS[number])) {
    return m[1].toUpperCase();
  }
  return null;
}

export function parseStrategyFromOpeningTrade(row: {
  quantStrategyId?: string | null;
  quantInvalidationJson?: string | null;
  reasoning?: string | null;
}): string {
  const direct = normalizeStrategyId(row.quantStrategyId);
  if (direct !== UNATTRIBUTED_STRATEGY_ID) return direct;
  const fromInv = extractCoreStrategyFromText(row.quantInvalidationJson);
  if (fromInv) return fromInv;
  const fromReason = extractCoreStrategyFromText(row.reasoning);
  if (fromReason) return fromReason;
  return UNATTRIBUTED_STRATEGY_ID;
}

/**
 * Opening FILLED BUY for symbol at/before cutoff. Excludes REPLAY/DIAGNOSTIC opens when possible.
 */
export async function lookupOpeningBuyTrade(symbol: string, sellCutoff: string) {
  const candidates = await db.select().from(schema.trades).where(
    and(
      eq(schema.trades.symbol, symbol),
      eq(schema.trades.side, 'BUY'),
      eq(schema.trades.status, 'FILLED'),
      lte(schema.trades.filledAt, sellCutoff),
    ),
  ).orderBy(desc(schema.trades.filledAt)).limit(40);

  return candidates.find((t) => {
    const env = String(t.executionEnvironment || '').toUpperCase();
    if (NON_LIVE_ENVS.has(env)) return false;
    if (t.traceId && String(t.traceId).startsWith(replaySafety.replayTracePrefix)) return false;
    return true;
  }) ?? candidates[0] ?? null;
}

async function resolveFromAgentPredictions(traceId: string | null | undefined, symbol: string): Promise<string> {
  if (!traceId) return UNATTRIBUTED_STRATEGY_ID;
  try {
    const rows = await db.select().from(schema.agentPredictions).where(
      and(
        eq(schema.agentPredictions.traceId, traceId),
        eq(schema.agentPredictions.symbol, symbol),
      ),
    ).orderBy(desc(schema.agentPredictions.timestamp)).limit(12);

    for (const row of rows) {
      if (row.agentName === 'QuantEngine') {
        const fromReason = extractCoreStrategyFromText(row.reasoning);
        if (fromReason) return fromReason;
      }
    }
    const agent = rows.find((r) => r.agentName && r.prediction !== 'HOLD');
    if (agent?.agentName) return `AGENT:${agent.agentName}`;
  } catch (e) {
    console.warn('[campaignAttribution] agent_predictions lookup failed', e);
  }
  return UNATTRIBUTED_STRATEGY_ID;
}

/** Resolve strategy id for a SELL or open holding from the opening BUY / agent trail. */
export async function resolveOpeningStrategyId(symbol: string, sellCutoff: string): Promise<string> {
  const opening = await lookupOpeningBuyTrade(symbol, sellCutoff);
  if (!opening) return UNATTRIBUTED_STRATEGY_ID;

  const fromTrade = parseStrategyFromOpeningTrade(opening);
  if (fromTrade !== UNATTRIBUTED_STRATEGY_ID) return fromTrade;

  return resolveFromAgentPredictions(opening.traceId, symbol);
}
