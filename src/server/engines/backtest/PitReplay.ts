/**
 * Point-in-time decision snapshots for research replay.
 * Does not call live RiskEngine/OMS. LLM debate is NOT replayed (would require stored prompts).
 */
import { Evidence, EvidenceAggregator } from '../../services/EvidenceAggregator';
import { tradingSafety } from '../../config/tradingSafety';

export interface PitBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PitSnapshot {
  asOfMs: number;
  symbol: string;
  bar: PitBar;
  newsFinbertScore: number | null;
  quantIndicators: Record<string, unknown>;
  evidence: Evidence[];
}

const snapshots: PitSnapshot[] = [];

export function recordPitSnapshot(snapshot: PitSnapshot): void {
  snapshots.push(snapshot);
}

export function listPitSnapshots(): readonly PitSnapshot[] {
  return snapshots;
}

export function clearPitSnapshots(): void {
  snapshots.length = 0;
}

export interface PitConsensusReplay {
  debateReplayed: false;
  side: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  independentAgreeingAgents: number;
  approved: boolean;
  reason: string;
}

/** Deterministic ChiefTrader vote math only (EvidenceAggregator + min agents + threshold). */
export function replayChiefTraderFromPit(snapshot: PitSnapshot): PitConsensusReplay {
  const agg = EvidenceAggregator.aggregate(snapshot.evidence);
  const independent = new Set(agg.agreements.map(e => e.agent)).size;
  const minAgents = tradingSafety.minIndependentAgreeingAgents;
  const bar = tradingSafety.consensusApprovalThreshold;
  const agentsOk = independent >= minAgents;
  const confOk = agg.confidence >= bar;
  const approved = agg.side !== 'HOLD' && agentsOk && confOk;
  return {
    debateReplayed: false,
    side: agg.side,
    confidence: agg.confidence,
    independentAgreeingAgents: independent,
    approved,
    reason: approved
      ? `PIT consensus ${agg.side} conf=${agg.confidence.toFixed(3)} agents=${independent}`
      : `NO_TRADE: agents ${independent}/${minAgents}, conf ${agg.confidence.toFixed(3)} vs ${bar}, debate not replayed`,
  };
}
