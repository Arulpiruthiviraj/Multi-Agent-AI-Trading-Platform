import { tradingSafety } from '../config/tradingSafety';

export interface ConsensusVoteSnapshot {
  agent: string;
  side: string;
  confidence: number;
}

export interface LastConsensusOutcome {
  at: string;
  symbol: string;
  approved: boolean;
  side: string;
  independentAgreeingAgents: number;
  requiredAgents: number;
  confidence: number;
  threshold: number;
  reason: string;
  agentVotes: ConsensusVoteSnapshot[];
}

export function formatWhyNoTrade(outcome: LastConsensusOutcome | null): string | null {
  if (!outcome) return null;
  const votes = outcome.agentVotes
    .filter((v) => v.agent !== 'ConsensusDebate')
    .map((v) => `${v.agent}: ${v.side}`)
    .join('\n');
  if (outcome.approved) {
    return [
      'CONSENSUS: APPROVED',
      votes,
      `Side: ${outcome.side}`,
      `Weighted confidence: ${(outcome.confidence * 100).toFixed(1)}% (threshold ${(outcome.threshold * 100).toFixed(0)}%).`,
    ].join('\n');
  }
  return [
    'NO TRADE',
    votes || '(no independent agent votes in the last evaluation window)',
    'Consensus: NO APPROVAL',
    `Reason: ${outcome.reason}`,
    `Independent agents agreeing with ${outcome.side}: ${outcome.independentAgreeingAgents}. Required: ${outcome.requiredAgents}.`,
    `Weighted confidence: ${(outcome.confidence * 100).toFixed(1)}% vs ${(outcome.threshold * 100).toFixed(0)}%.`,
  ].join('\n');
}

export function requiredIndependentAgents(): number {
  return tradingSafety.minIndependentAgreeingAgents;
}
