/**
 * On-demand multi-agent co-evaluation for Opportunity Feed CONFIRM BUY/SELL.
 * Emits agent ideas into the normal ChiefTrader → RiskEngine → OMS spine.
 * Never places orders. Never lowers consensus floors (0.75 / min-2).
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { generateTraceId } from '../core/traceId';
import { tradingSafety } from '../config/tradingSafety';
import { marketDataWorker } from './MarketDataWorker';
import { technicalAgent } from './TechnicalAgent';
import { quantSignalAgent } from './QuantSignalAgent';
import { kronosForecastAgent } from './KronosForecastAgent';
import { chiefTrader } from './ChiefTraderAgent';

export type ManualCoEvalResult = {
  ok: boolean;
  approved: boolean;
  traceId: string;
  symbol: string;
  requestedSide: 'BUY' | 'SELL';
  consensusSide?: string;
  confidence?: number;
  reason: string;
  agentBreakdown: Array<{ agent: string; side: string; confidence: number }>;
  source: 'MANUAL_CONSENSUS';
};

function waitForConsensusCompleted(
  symbol: string,
  requestTraceId: string,
  timeoutMs: number,
): Promise<{
  approved: boolean;
  side: string;
  confidence: number;
  traceId: string;
  reason?: string;
}> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      const last = chiefTrader.getLastConsensusOutcome();
      if (last && last.symbol === symbol) {
        resolve({
          approved: last.approved,
          side: last.side,
          confidence: last.confidence,
          traceId: requestTraceId,
          reason: last.reason,
        });
        return;
      }
      resolve({
        approved: false,
        side: 'HOLD',
        confidence: 0,
        traceId: requestTraceId,
        reason: `Consensus evaluation timed out after ${timeoutMs}ms — agents may still be warming (need ≥2 independent agreeing votes at ≥${tradingSafety.consensusApprovalThreshold}).`,
      });
    }, timeoutMs);

    const onDone = (payload: any) => {
      if (!payload || payload.symbol !== symbol) return;
      cleanup();
      resolve({
        approved: !!payload.approved,
        side: String(payload.side || 'HOLD'),
        confidence: Number(payload.confidence) || 0,
        traceId: String(payload.traceId || requestTraceId),
        reason: payload.reason,
      });
    };

    const onRejected = (payload: any) => {
      if (!payload || payload.symbol !== symbol) return;
      cleanup();
      resolve({
        approved: false,
        side: String(payload.side || 'HOLD'),
        confidence: Number(payload.confidence) || 0,
        traceId: String(payload.traceId || requestTraceId),
        reason: String(payload.reason || 'TRADE_REJECTED_CONSENSUS'),
      });
    };

    const cleanup = () => {
      clearTimeout(timer);
      eventBus.off(EVENTS.CHIEF_CONSENSUS_COMPLETED, onDone);
      eventBus.off(EVENTS.TRADE_REJECTED_CONSENSUS, onRejected);
    };

    eventBus.on(EVENTS.CHIEF_CONSENSUS_COMPLETED, onDone);
    eventBus.on(EVENTS.TRADE_REJECTED_CONSENSUS, onRejected);
  });
}

/**
 * Operator CONFIRM BUY/SELL: co-eval online agents, then require full ChiefTrader consensus
 * (same floors as autonomous). RiskEngine still runs only after CHIEF_APPROVED_IDEA.
 */
export async function runManualTradeCoEvaluation(opts: {
  symbol: string;
  side: 'BUY' | 'SELL';
}): Promise<ManualCoEvalResult> {
  const symbol = opts.symbol.trim().toUpperCase();
  const requestedSide = opts.side;
  const traceId = `manual-consensus-${generateTraceId(symbol)}`;
  const currentPrice = marketDataWorker.getLatestPrice(symbol);
  const timeoutMs = tradingSafety.manualTradeCoEvalTimeoutMs;
  const startedAt = Date.now();

  eventBus.emit(EVENTS.MANUAL_TRADE_EVALUATION_REQUESTED, {
    traceId,
    symbol,
    side: requestedSide,
    currentPrice,
    timestamp: new Date().toISOString(),
  });

  chiefTrader.registerManualSideExpectation(symbol, requestedSide, timeoutMs);

  // Listen before agents emit so we cannot miss CHIEF_CONSENSUS_COMPLETED.
  const consensusPromise = waitForConsensusCompleted(symbol, traceId, timeoutMs);

  const agentNotes: string[] = [];
  await Promise.allSettled([
    (async () => {
      try {
        const r = await technicalAgent.evaluateOnDemand(symbol);
        agentNotes.push(`TechnicalAgent:${r.status}`);
      } catch (e: any) {
        agentNotes.push(`TechnicalAgent:error:${e?.message || e}`);
      }
    })(),
    (async () => {
      try {
        if (!quantSignalAgent.isEnabledPublic()) {
          agentNotes.push('QuantEngine:disabled');
          return;
        }
        const r = await quantSignalAgent.evaluateSymbol(symbol);
        agentNotes.push(r ? 'QuantEngine:evaluated' : 'QuantEngine:no_bars_or_idea');
      } catch (e: any) {
        agentNotes.push(`QuantEngine:error:${e?.message || e}`);
      }
    })(),
    (async () => {
      try {
        const r = await kronosForecastAgent.evaluateOnDemand(symbol);
        agentNotes.push(`KronosEngine:${r.status}`);
      } catch (e: any) {
        agentNotes.push(`KronosEngine:error:${e?.message || e}`);
      }
    })(),
  ]);

  // Give ChiefTrader the aggregation window; if still no outcome, fail-closed (do not wait full timeout).
  await new Promise((r) => setTimeout(r, tradingSafety.consensusAggregationWindowMs + 100));
  const early = chiefTrader.getLastConsensusOutcome();
  const earlyFresh = early && early.symbol === symbol && Date.parse(early.at) >= startedAt - 50;
  if (!earlyFresh) {
    eventBus.emit(EVENTS.TRADE_REJECTED_CONSENSUS, {
      traceId,
      symbol,
      side: 'HOLD',
      requestedSide,
      confidence: 0,
      reason: `TRADE_REJECTED_CONSENSUS — no ChiefTrader outcome after co-eval (need ≥${tradingSafety.minIndependentAgreeingAgents} independent agents at ≥${tradingSafety.consensusApprovalThreshold}). Co-eval: ${agentNotes.join(', ')}`,
      agentBreakdown: [],
    });
  }

  const consensus = await consensusPromise;
  const outcome = chiefTrader.getLastConsensusOutcome();
  const breakdown = (outcome?.agentVotes || []).map((e) => ({
    agent: e.agent,
    side: e.side,
    confidence: e.confidence,
  }));

  if (
    consensus.approved
    && consensus.side === requestedSide
    && consensus.confidence >= tradingSafety.consensusApprovalThreshold
  ) {
    eventBus.emit(EVENTS.TRADE_APPROVED, {
      traceId: consensus.traceId,
      symbol,
      side: consensus.side,
      confidence: consensus.confidence,
      source: 'MANUAL_CONSENSUS',
    });
    return {
      ok: true,
      approved: true,
      traceId: consensus.traceId,
      symbol,
      requestedSide,
      consensusSide: consensus.side,
      confidence: consensus.confidence,
      reason: `TRADE_APPROVED — consensus ${(consensus.confidence * 100).toFixed(1)}% on ${consensus.side}; forwarded to RiskEngine (24 gates) → OMS. Co-eval: ${agentNotes.join(', ')}`,
      agentBreakdown: breakdown,
      source: 'MANUAL_CONSENSUS',
    };
  }

  const reason =
    consensus.reason
    || `TRADE_REJECTED_CONSENSUS — need ≥${tradingSafety.minIndependentAgreeingAgents} independent agents at ≥${tradingSafety.consensusApprovalThreshold}; got side=${consensus.side} conf=${(consensus.confidence * 100).toFixed(1)}% (requested ${requestedSide}). Co-eval: ${agentNotes.join(', ')}`;

  eventBus.emit(EVENTS.TRADE_REJECTED_CONSENSUS, {
    traceId: consensus.traceId,
    symbol,
    side: consensus.side,
    requestedSide,
    confidence: consensus.confidence,
    reason,
    agentBreakdown: breakdown,
  });

  return {
    ok: true,
    approved: false,
    traceId: consensus.traceId,
    symbol,
    requestedSide,
    consensusSide: consensus.side,
    confidence: consensus.confidence,
    reason,
    agentBreakdown: breakdown,
    source: 'MANUAL_CONSENSUS',
  };
}
