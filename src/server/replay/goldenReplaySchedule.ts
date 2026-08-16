/**
 * Deterministic UNIT_FIXTURE decision schedule for golden_replay path testing.
 * Not REAL_MARKET_DATA. Not promotion evidence. Confidence is fixture-authored so
 * ChiefTrader vote math can pass when the schedule says BUY/SELL — then RiskEngine+OMS still decide.
 */
import type { ResearchBar } from '../research/ohlcvTypes';

export type GoldenScheduleSide = 'BUY' | 'SELL' | 'HOLD';

export interface GoldenScheduleSignal {
  barIndex: number;
  side: GoldenScheduleSide;
  confidence: number;
  stopPct: number;
  targetPct: number;
  reason: string;
}

/** BUY at bar 65, SELL at bar 74. Other bars HOLD → NO_TRADE / strategy path. */
export function goldenReplaySchedule(): GoldenScheduleSignal[] {
  return [
    {
      barIndex: 65,
      side: 'BUY',
      confidence: 0.88,
      stopPct: 0.03,
      targetPct: 0.06,
      reason: 'UNIT_FIXTURE schedule BUY — path correctness only',
    },
    {
      barIndex: 74,
      side: 'SELL',
      confidence: 0.88,
      stopPct: 0,
      targetPct: 0,
      reason: 'UNIT_FIXTURE schedule SELL — path correctness only',
    },
  ];
}

export function scheduleSignalAtBar(bars: ResearchBar[], barTimestamp: number): GoldenScheduleSignal | null {
  const idx = bars.findIndex((b) => b.timestamp === barTimestamp);
  if (idx < 0) return null;
  return goldenReplaySchedule().find((s) => s.barIndex === idx) ?? null;
}

export function buildHighConfidenceAgreeingIdeas(opts: {
  side: 'BUY' | 'SELL';
  confidence: number;
  publishedAtMs: number;
  strategyId: string;
}) {
  const conf = Math.max(0.8, Math.min(1, opts.confidence));
  return [
    { kind: 'AGENT_REASONING', agent: 'QuantEngine', side: opts.side, confidence: conf, publishedAtMs: opts.publishedAtMs, payloadJson: opts.strategyId },
    { kind: 'AGENT_REASONING', agent: 'TechnicalAgent', side: opts.side, confidence: conf, publishedAtMs: opts.publishedAtMs, payloadJson: 'UNIT_FIXTURE_TECH_CONFIRM' },
  ];
}
